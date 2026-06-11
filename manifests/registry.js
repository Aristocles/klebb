// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// manifests/registry.js
// Discovers, loads, validates, and serves manifest-schema data files under $HEALTH_HOME/data/.
//
// Usage:
//   const registry = require('./manifests/registry');
//   registry.init();                      // scan + cache
//   registry.list();                      // returns [{id, meta}, ...]
//   registry.get(id);                     // returns full { meta, data, source }
//   registry.data(id);                    // returns data only
//   registry.writeData(id, newData);      // full rewrite of data block
//   registry.reload();                    // re-scan (call on fs.watch events)

const fs = require('fs');
const path = require('path');
const PATHS = require('../config/paths');
const { mergePatch, isPlainObject } = require('./merge-patch');
const { parsePath, resolvePath } = require('./path');

const { isValidCategory } = require('../config/categories');
const { validateNotifications } = require('./notifications-schema');

const SUPPORTED_SCHEMAS = ['klebb.datafile.v1'];
const RESERVED_DIR_PREFIX = '_';

// Id sanitisation rules — shared between the create endpoint and any caller
// that wants to validate a manifest shape without hitting disk.
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const ID_MAX_LENGTH = 64;
const RESERVED_IDS = new Set([
  '_archive', '_virtual', '_meta', 'auto-export', 'reports', 'index',
]);

let _entries = new Map();   // id -> { meta, description, schema, data, source, version }
let _errors = [];           // [{file, error}]
let _watcher = null;
const _deleteHooks = [];    // (id) => void; called after a manifest is deleted

// Register a callback to fire after deleteManifest succeeds. Used by
// notifications-state to prune sidecar entries for a removed card.
function onDelete(fn) {
  if (typeof fn === 'function') _deleteHooks.push(fn);
}

// Backup files created by scripts/migrate-* and scripts/reingest-hae
// land beside the canonical manifest with a timestamped suffix before
// the final `.json` — e.g. `mood.json.pre-reingest-2026-05-10T...json`.
// The shared shape is "two .json segments in the filename", which this
// regex captures without hard-coding every known suffix. See #197.
const BACKUP_NAME_RE = /\.json\.[^/\\]+\.json$/i;

function _scanDir(dir) {
  const found = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue;
    if (ent.isDirectory()) {
      if (ent.name.startsWith(RESERVED_DIR_PREFIX)) continue; // _virtual, _archive, _meta
      // No recursion for now — manifest files live at data/ top level.
      // Sub-dirs (auto-export/etc) are handled separately.
      continue;
    }
    if (!ent.name.endsWith('.json')) continue;
    if (BACKUP_NAME_RE.test(ent.name)) continue;
    found.push(path.join(dir, ent.name));
  }
  return found;
}

// Validate the shape of a parsed manifest object. Shared by the on-disk load
// path (`_parse`) and the HTTP create endpoint. Structural failures throw
// with a prefix the server handler maps to 400/422:
//   "missing $schema" / "unsupported $schema:" / "missing meta" / "missing
//   meta.id" / "missing meta.label"          -> 400
//   "invalid id: format" / "invalid id: reserved"  -> 422
// `opts.strictId` applies the id-format sanitiser (filename-safe, reserved
// names, length). Load-time validation is lenient about id format so legacy
// files keep loading; the create path sets strictId:true.
function validateManifestShape(parsed, opts = {}) {
  const { strictId = false, strictNotifications = strictId } = opts;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('missing $schema');
  }
  const schema = parsed.$schema;
  if (!schema) throw new Error('missing $schema');
  if (!SUPPORTED_SCHEMAS.includes(schema)) {
    throw new Error(`unsupported $schema: ${schema}`);
  }
  if (!parsed.meta || typeof parsed.meta !== 'object' || Array.isArray(parsed.meta)) {
    throw new Error('missing meta block');
  }
  if (!parsed.meta.id || typeof parsed.meta.id !== 'string') {
    throw new Error('missing meta.id');
  }
  if (strictId) {
    if (parsed.meta.id.length > ID_MAX_LENGTH) {
      throw new Error('invalid id: format (too long)');
    }
    if (!ID_PATTERN.test(parsed.meta.id)) {
      throw new Error('invalid id: format (must match /^[a-z0-9][a-z0-9._-]*$/)');
    }
    if (RESERVED_IDS.has(parsed.meta.id)) {
      throw new Error('invalid id: reserved name');
    }
  }
  if (!parsed.meta.label || typeof parsed.meta.label !== 'string') {
    throw new Error('missing meta.label');
  }
  // meta.category is optional but constrained to a known enum. Unknown
  // values are silently dropped so the chat agent can't fragment the
  // clustering signal by inventing values like 'wellness'.
  if (parsed.meta.category !== undefined && !isValidCategory(parsed.meta.category)) {
    delete parsed.meta.category;
  }

  // meta.notifications is optional. Lenient at load (drop bad items),
  // strict at create/PATCH (throw "invalid notifications: ...").
  if (parsed.meta.notifications !== undefined) {
    const cleaned = validateNotifications(parsed.meta.notifications, { strict: strictNotifications });
    if (cleaned === undefined) {
      delete parsed.meta.notifications;
    } else {
      parsed.meta.notifications = cleaned;
    }
  }

  return parsed;
}

function _parse(filepath) {
  let raw;
  try {
    raw = fs.readFileSync(filepath, 'utf8');
  } catch (e) {
    return { error: `read failed: ${e.message}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { error: `invalid JSON: ${e.message}` };
  }
  // Silently skip legacy shapes that pre-date the manifest schema.
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { skip: 'legacy format (not a manifest object)' };
  }
  if (!parsed.$schema) {
    return { skip: 'no $schema' };
  }
  try {
    validateManifestShape(parsed);
  } catch (e) {
    // Translate internal messages to the legacy error strings callers + tests
    // expect. Keeps backwards-compatible error text.
    const msg = e.message;
    if (msg.startsWith('unsupported $schema')) return { error: msg };
    if (msg === 'missing meta block') return { error: 'missing meta block' };
    if (msg === 'missing meta.id') return { error: 'meta.id required' };
    if (msg === 'missing meta.label') return { error: 'meta.label required' };
    return { error: msg };
  }
  return { manifest: parsed };
}

function _loadAll() {
  _entries = new Map();
  _errors = [];
  const dataDir = PATHS.DATA_DIR;
  const files = _scanDir(dataDir);
  for (const file of files) {
    const res = _parse(file);
    if (res.skip) continue;
    if (res.error) {
      _errors.push({ file: path.basename(file), error: res.error });
      console.warn(`[manifest] skip ${path.basename(file)}: ${res.error}`);
      continue;
    }
    const m = res.manifest;
    if (_entries.has(m.meta.id)) {
      _errors.push({ file: path.basename(file), error: `duplicate id: ${m.meta.id}` });
      console.warn(`[manifest] duplicate id ${m.meta.id} in ${path.basename(file)}`);
      continue;
    }
    _entries.set(m.meta.id, {
      meta: m.meta,
      description: m.description || null,
      schema: m.schema || null,
      data: m.data === undefined ? null : m.data,
      source: file,
      version: m.$schema,
    });
  }
}

function init() {
  _loadAll();
  // Watch for changes (debounced)
  try {
    if (_watcher) { _watcher.close(); _watcher = null; }
    _watcher = fs.watch(PATHS.DATA_DIR, { persistent: false }, _onFsChange);
  } catch (e) {
    // fs.watch can fail on some filesystems; fall back to manual reload calls
    console.warn('[manifest] fs.watch unavailable:', e.message);
  }
  return { count: _entries.size, errors: _errors.length };
}

let _reloadTimer = null;
function _onFsChange() {
  if (_reloadTimer) return;
  _reloadTimer = setTimeout(() => {
    _reloadTimer = null;
    reload();
  }, 250);
}

function reload() {
  _loadAll();
  return { count: _entries.size, errors: _errors.length };
}

function list() {
  const arr = [];
  for (const [id, entry] of _entries) {
    arr.push({
      id,
      meta: entry.meta,
      description: entry.description,
      hasData: entry.data !== null,
      enabled: entry.meta.enabled !== false,
    });
  }
  // Sort by meta.order asc, then label
  arr.sort((a, b) => {
    const oa = a.meta.order ?? 1000;
    const ob = b.meta.order ?? 1000;
    if (oa !== ob) return oa - ob;
    return (a.meta.label || '').localeCompare(b.meta.label || '');
  });
  return arr;
}

function get(id) {
  const e = _entries.get(id);
  if (!e) return null;
  return { meta: e.meta, description: e.description, schema: e.schema, data: e.data, version: e.version };
}

function data(id) {
  const e = _entries.get(id);
  return e ? e.data : null;
}

function errors() {
  return [..._errors];
}

// Reject (or rescue) a `data` value that arrived as a JSON-encoded string,
// which is what happens when an upstream caller has stringified twice. If
// the parsed result is a structured value, accept it and warn so the
// offending writer is traceable; if it stays scalar, throw — there's no
// safe interpretation. See #342.
function _coerceWriteData(id, newData) {
  if (typeof newData !== 'string') return newData;
  let parsed;
  try {
    parsed = JSON.parse(newData);
  } catch {
    throw new Error(`writeData(${id}): data is a string and not valid JSON; pass an object/array, not a pre-serialised string`);
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error(`writeData(${id}): data must be an object or array, got string that parsed to ${parsed === null ? 'null' : typeof parsed}`);
  }
  console.warn(`[manifest] writeData(${id}): rescued double-serialised data (caller passed a JSON string); accepting parsed value`);
  return parsed;
}

// Sanity-check the runtime shape of `newData` against the manifest's
// declared `schema.type`, when present. Catches a wider class of writer
// bugs (bare value where an array is expected, etc.) without pulling a
// full JSON-Schema validator. See #342.
function _assertSchemaShape(id, schema, newData) {
  if (!schema || typeof schema !== 'object' || typeof schema.type !== 'string') return;
  const declared = schema.type;
  const actual = Array.isArray(newData)
    ? 'array'
    : newData === null
      ? 'null'
      : typeof newData;
  if (declared === 'array' && actual !== 'array') {
    throw new Error(`writeData(${id}): schema declares type "array" but received ${actual}`);
  }
  if (declared === 'object' && actual !== 'object') {
    throw new Error(`writeData(${id}): schema declares type "object" but received ${actual}`);
  }
  if (declared !== 'array' && declared !== 'object' && actual !== declared) {
    throw new Error(`writeData(${id}): schema declares type "${declared}" but received ${actual}`);
  }
}

// Build the on-disk JSON envelope for an entry. When a 2-arg form is used,
// the override is set unconditionally (so callers can emit data:null
// deliberately). When the 1-arg form is used, falls back to entry.data and
// skips the key when null/undefined (matches setMasterEnabled / patchManifest
// pre-existing behaviour). Caller is responsible for any pre-write validation.
function _buildEntryEnvelope(entry, ...rest) {
  const overridden = rest.length > 0;
  const full = {
    $schema: entry.version,
    meta: entry.meta,
  };
  if (entry.description) full.description = entry.description;
  if (entry.schema) full.schema = entry.schema;
  if (overridden) {
    full.data = rest[0];
  } else if (entry.data !== null && entry.data !== undefined) {
    full.data = entry.data;
  }
  return full;
}

// Atomic write of a fully-formed envelope to entry.source via tmp+rename.
function _persistEnvelope(entry, envelope) {
  const tmp = entry.source + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(envelope, null, 2));
  fs.renameSync(tmp, entry.source);
}

// Write full file back with updated data block. Preserves meta/description/schema.
// Uses atomic tmp+rename to avoid partial writes.
function writeData(id, newData) {
  const entry = _entries.get(id);
  if (!entry) throw new Error(`unknown manifest: ${id}`);

  newData = _coerceWriteData(id, newData);
  _assertSchemaShape(id, entry.schema, newData);

  _persistEnvelope(entry, _buildEntryEnvelope(entry, newData));
  entry.data = newData;
  return true;
}

// Resolve a path against a manifest's data block. Pure read, no I/O.
// pathString is parsed via manifests/path.js; opts.allowMultiple plumbs
// through. Throws BadPath / NoMatch / Ambiguous / WrongType (each carries
// a `code` field), or Error('unknown manifest: <id>') if id is unknown.
function readRows(id, pathString, opts) {
  const entry = _entries.get(id);
  if (!entry) throw new Error(`unknown manifest: ${id}`);
  const segments = parsePath(pathString || '');
  return resolvePath(entry.data, segments, opts);
}

// Apply a path-targeted mutation to entry.data atomically. Caller supplies
// a `mutate(stagedData) -> result` callback that mutates a deep clone in
// place and returns the result the registry should bubble out to its
// caller. After the callback returns, the rebuilt envelope is shape-checked
// and persisted via tmp+rename. On any error before rename, the on-disk
// file and in-memory cache are unchanged.
function _mutateData(id, mutate) {
  const entry = _entries.get(id);
  if (!entry) throw new Error(`unknown manifest: ${id}`);
  if (entry.data === null || entry.data === undefined) {
    throw new Error(`${id} has no data block to address`);
  }
  // Deep clone so a mid-mutation throw can't leave the cache half-edited.
  const staged = JSON.parse(JSON.stringify(entry.data));
  const result = mutate(staged);
  _assertSchemaShape(id, entry.schema, staged);
  _persistEnvelope(entry, _buildEntryEnvelope(entry, staged));
  entry.data = staged;
  return result;
}

// Append one row to the array at pathString. Throws WRONG_TYPE if the
// resolved target isn't an array. NO_MATCH / BAD_PATH bubble up from the
// path module unchanged.
function appendRow(id, pathString, value) {
  return _mutateData(id, (staged) => {
    const segments = parsePath(pathString || '');
    const r = resolvePath(staged, segments);
    if (!Array.isArray(r.value)) {
      const err = new Error(`appendRow target at "${pathString}" is not an array`);
      err.code = 'WRONG_TYPE';
      throw err;
    }
    r.value.push(value);
    return { added: 1, totalAfter: r.value.length };
  });
}

// Apply RFC 7396 JSON Merge Patch to the single row at pathString. The
// resolved target must be a plain object. Path must resolve unambiguously
// (no allowMultiple here): an AMBIGUOUS error is what we want.
function updateRow(id, pathString, changes) {
  if (!isPlainObject(changes)) {
    const err = new Error('updateRow changes must be a plain object');
    err.code = 'WRONG_TYPE';
    throw err;
  }
  return _mutateData(id, (staged) => {
    const segments = parsePath(pathString || '');
    const r = resolvePath(staged, segments);
    if (r.container === null) {
      const err = new Error('updateRow cannot patch the root data value (use writeData)');
      err.code = 'WRONG_TYPE';
      throw err;
    }
    if (!isPlainObject(r.value)) {
      const err = new Error(`updateRow target at "${pathString}" is not a plain object`);
      err.code = 'WRONG_TYPE';
      throw err;
    }
    const before = r.value;
    const after = mergePatch(before, changes);
    r.container[r.key] = after;
    return { updated: 1, before, after };
  });
}

// Splice the single row at pathString out of its parent array. Path must
// resolve unambiguously and the parent must be an array (i.e. the leaf
// segment was a filter, or the parent is an items[] / rows[] container).
function removeRow(id, pathString) {
  return _mutateData(id, (staged) => {
    const segments = parsePath(pathString || '');
    const r = resolvePath(staged, segments);
    if (r.container === null) {
      const err = new Error('removeRow cannot remove the root data value (use writeData)');
      err.code = 'WRONG_TYPE';
      throw err;
    }
    if (!Array.isArray(r.container)) {
      const err = new Error(`removeRow target at "${pathString}" is not an element of an array`);
      err.code = 'WRONG_TYPE';
      throw err;
    }
    const removed = r.container[r.key];
    r.container.splice(r.key, 1);
    return { removed, totalAfter: r.container.length };
  });
}

// Has a card opted into a particular view? Respects the master meta.enabled
// switch (when explicitly set to false, card is hidden everywhere).
function isEnabledIn(entry, viewName) {
  // Master disable: meta.enabled: false hides the card from ALL views.
  // Absent or true: fall through to per-view enabled check.
  if (entry.meta.enabled === false) return false;
  const v = entry.meta[viewName];
  return !!(v && v.enabled === true && v.component);
}

// Is the card master-enabled (visible anywhere)? Used for Settings listing.
function isMasterEnabled(entry) {
  return entry.meta.enabled !== false;
}

// Toggle the master meta.enabled flag on a card and persist to disk.
// Preserves all other meta + data + description. Returns the new state.
function setMasterEnabled(id, enabled) {
  const entry = _entries.get(id);
  if (!entry) throw new Error(`unknown manifest: ${id}`);
  entry.meta = { ...entry.meta, enabled: !!enabled };
  _persistEnvelope(entry, _buildEntryEnvelope(entry));
  return !!enabled;
}

// Reorder cards by assigning sparse meta.order values (100, 200, 300, …)
// following the sequence in `ids`. Cards whose id is not listed keep their
// existing meta.order untouched. Ids that don't exist in the registry cause
// the whole operation to fail with no writes performed.
//
// Returns { updated: [...ids in new order] }.
function reorderByIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error('ids must be a non-empty array');
  }
  // Validate up-front — fail fast if anything's wrong
  const seen = new Set();
  for (const id of ids) {
    if (typeof id !== 'string' || !id) {
      throw new Error('ids must be non-empty strings');
    }
    if (seen.has(id)) {
      throw new Error(`duplicate id in order: ${id}`);
    }
    if (!_entries.has(id)) {
      throw new Error(`unknown manifest: ${id}`);
    }
    seen.add(id);
  }
  // All good. Write each one with its sparse order value.
  const SPACING = 100;
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const entry = _entries.get(id);
    const newOrder = (i + 1) * SPACING;
    // Skip if unchanged (idempotent)
    if (entry.meta.order === newOrder) continue;
    entry.meta = { ...entry.meta, order: newOrder };
    const full = {
      $schema: entry.version,
      meta: entry.meta,
    };
    if (entry.description) full.description = entry.description;
    if (entry.schema) full.schema = entry.schema;
    if (entry.data !== null) full.data = entry.data;
    const tmp = entry.source + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(full, null, 2));
    fs.renameSync(tmp, entry.source);
  }
  return { updated: [...ids] };
}

// Filter for a specific view, returning shape the frontend can consume directly.
// Only `enabled` flags gate visibility — empty data renders as the card's
// empty state (generic-card's emptyHeadline etc.) so a newly-created card
// remains visible and loggable before the first entry lands.
function listForView(viewName) {
  const result = [];
  for (const entry of _entries.values()) {
    if (!isEnabledIn(entry, viewName)) continue;
    result.push({
      id: entry.meta.id,
      meta: entry.meta,
      viewConfig: entry.meta[viewName],
    });
  }
  result.sort((a, b) => {
    const oa = a.viewConfig.order ?? a.meta.order ?? 1000;
    const ob = b.viewConfig.order ?? b.meta.order ?? 1000;
    if (oa !== ob) return oa - ob;
    return (a.meta.label || '').localeCompare(b.meta.label || '');
  });
  return result;
}

// Create a brand-new manifest from a caller-supplied object. Writes it to
// $HEALTH_HOME/data/<meta.id>.json atomically and populates the in-memory
// cache so the card is visible immediately (the fs.watch reload will
// converge later, idempotently). Throws with a prefix the HTTP handler
// maps to a status code:
//   "missing *" / "unsupported $schema:"  -> 400
//   "invalid id: *"                        -> 422
//   "duplicate id: *"                      -> 409
// Pass-through: every other field (meta.view, meta.writeable, meta.reports,
// meta.schedule, data, description, etc.) is stored verbatim. Unknown
// renderer names are allowed on purpose — the frontend falls back to
// eh-unknown-card so the card still persists and a human can retrofit.
function createManifest(manifestObj) {
  const parsed = validateManifestShape(manifestObj, { strictId: true });
  const id = parsed.meta.id;
  if (_entries.has(id)) {
    throw new Error(`duplicate id: ${id}`);
  }

  // Auto-populate meta.category for HAE-backed manifests when the author
  // didn't set one. The catalogue entry knows the category already; no
  // point asking the chat agent to repeat it. Explicit user-set values
  // win (after validation by validateManifestShape).
  const ingForCat = parsed.meta?.ingest;
  if (!parsed.meta.category && ingForCat?.source === 'hae' && ingForCat.metric) {
    try {
      const haeCatalogue = require('../health-auto-export/catalogue');
      const catEntry = haeCatalogue[ingForCat.metric];
      if (catEntry?.category) parsed.meta.category = catEntry.category;
    } catch {}
  }
  const targetPath = path.join(PATHS.DATA_DIR, id + '.json');
  // Defence-in-depth: ID_PATTERN already blocks path separators, but
  // double-check the resolved path doesn't escape DATA_DIR.
  const resolved = path.resolve(targetPath);
  const dataDirResolved = path.resolve(PATHS.DATA_DIR);
  if (!resolved.startsWith(dataDirResolved + path.sep)) {
    throw new Error('invalid id: path escapes data dir');
  }
  if (fs.existsSync(targetPath)) {
    // A file exists on disk that wasn't in _entries — likely a parse error
    // on load. Don't overwrite it silently.
    throw new Error(`duplicate id: file already exists on disk`);
  }
  const tmp = targetPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(parsed, null, 2));
  fs.renameSync(tmp, targetPath);
  _entries.set(id, {
    meta: parsed.meta,
    description: parsed.description || null,
    schema: parsed.schema || null,
    data: parsed.data === undefined ? null : parsed.data,
    source: targetPath,
    version: parsed.$schema,
  });
  // One-time welcome-card auto-hide. When any other card is created, the
  // welcome card disables itself and records that the auto-hide has fired,
  // so a user who later re-enables it in Settings won't have the system
  // fight them on their next Add Card.
  const autoHidden = maybeAutoHideWelcome(id);

  // Backfill HAE-backed manifests from the raw archive. The dispatcher
  // only routes to subscribers present at push time, so a card created
  // after a push would otherwise miss data already on disk. Lazy-require
  // to avoid circular imports; idempotent (skips if data[] is non-empty).
  let replayed = null;
  const ing = parsed.meta?.ingest;
  if (ing && ing.source === 'hae' && ing.metric) {
    try {
      const { replayFromArchive } = require('../health-auto-export/replay');
      const summary = replayFromArchive(module.exports, id);
      if (!summary.skipped && summary.rowsWritten > 0) {
        replayed = summary;
        // Graduate the metric out of discoveries, same as a live push would.
        try {
          const discoveries = require('../health-auto-export/discoveries');
          discoveries.sync({
            seen: [],
            subscribed: [ing.metric],
          });
        } catch (e) {
          console.warn('[hae] discovery sync after replay failed:', e.message);
        }
      }
    } catch (e) {
      console.warn('[hae] replay on createManifest failed:', e.message);
    }
  }

  return { id, source: targetPath, welcomeAutoHidden: autoHidden, replayed };
}

function maybeAutoHideWelcome(createdId) {
  if (createdId === 'welcome') return false;
  const welcome = _entries.get('welcome');
  if (!welcome) return false;
  const wmeta = welcome.meta.welcome;
  if (wmeta && wmeta.autoHideApplied === true) return false;
  if (welcome.meta.enabled === false) return false;
  welcome.meta = {
    ...welcome.meta,
    enabled: false,
    welcome: { ...(wmeta || {}), autoHideApplied: true },
  };
  const full = {
    $schema: welcome.version,
    meta: welcome.meta,
  };
  if (welcome.description) full.description = welcome.description;
  if (welcome.schema) full.schema = welcome.schema;
  if (welcome.data !== null) full.data = welcome.data;
  const tmp = welcome.source + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(full, null, 2));
    fs.renameSync(tmp, welcome.source);
    return true;
  } catch (e) {
    console.warn('[welcome] auto-hide write failed:', e.message);
    return false;
  }
}

// Apply a JSON Merge Patch (RFC 7396) to an existing manifest's meta and/or
// description. `data` and `$schema` are preserved verbatim; `meta.id` cannot
// change. The full merged manifest is re-validated before writing.
//
// Patch shape: { meta?: {...}, description?: "..." }
//   - Nested objects under meta deep-merge per RFC 7396.
//   - Arrays replace wholesale (e.g. meta.writeable.inputs replaces).
//   - `null` in patch removes the key from the target.
//
// Throws:
//   "unknown manifest: <id>"              -> handler maps to 404
//   "patch touches protected field: ..."  -> 400
//   "missing meta.id" / "invalid id: *"   -> 400/422 (from validation)
function patchManifest(id, patch) {
  const entry = _entries.get(id);
  if (!entry) throw new Error(`unknown manifest: ${id}`);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('patch must be an object');
  }
  // Protected fields: reject patches that try to rename or re-version.
  if ('$schema' in patch) {
    throw new Error('patch touches protected field: $schema');
  }
  if (isPlainObject(patch.meta) && 'id' in patch.meta) {
    throw new Error('patch touches protected field: meta.id');
  }
  if ('data' in patch) {
    throw new Error('patch touches protected field: data (use writeData)');
  }

  const newMeta = isPlainObject(patch.meta)
    ? mergePatch(entry.meta, patch.meta)
    : entry.meta;
  let newDescription = entry.description || null;
  // description: patch can set (string) or remove (null). Undefined = keep.
  if ('description' in patch) {
    if (patch.description === null) {
      newDescription = null;
    } else if (typeof patch.description === 'string') {
      newDescription = patch.description;
    } else {
      throw new Error('description must be a string or null');
    }
  }

  const stagedEntry = {
    ...entry,
    meta: newMeta,
    description: newDescription,
  };
  const merged = _buildEntryEnvelope(stagedEntry);

  // Re-validate. strictId:false so we don't reject legacy ids that already
  // loaded; we already blocked id changes above. Notifications get strict
  // validation though - the agent shouldn't be able to patch in malformed
  // items lenient-mode just because the manifest's id is grandfathered.
  validateManifestShape(merged, { strictId: false, strictNotifications: true });

  _persistEnvelope(entry, merged);
  entry.meta = merged.meta;
  entry.description = merged.description || null;
  return { id };
}

// Remove a manifest's file and drop its entry from the cache. Throws if the
// id is unknown (map to 404 in the handler).
function deleteManifest(id) {
  const entry = _entries.get(id);
  if (!entry) throw new Error(`unknown manifest: ${id}`);
  try {
    fs.unlinkSync(entry.source);
  } catch (e) {
    // If the file's already gone, drop the cache entry anyway so we
    // converge to the right state.
    if (e.code !== 'ENOENT') {
      throw new Error(`delete failed: ${e.message}`);
    }
  }
  _entries.delete(id);
  for (const fn of _deleteHooks) {
    try { fn(id); } catch (e) {
      console.warn(`[registry] onDelete hook error for ${id}: ${e.message}`);
    }
  }
  return { id, removed: entry.source };
}

module.exports = {
  init,
  reload,
  list,
  listForView,
  get,
  data,
  writeData,
  readRows,
  appendRow,
  updateRow,
  removeRow,
  errors,
  isMasterEnabled,
  setMasterEnabled,
  reorderByIds,
  createManifest,
  patchManifest,
  deleteManifest,
  validateManifestShape,
  onDelete,
};
