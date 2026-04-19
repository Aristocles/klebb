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

const SUPPORTED_SCHEMAS = ['eddzhealth.datafile.v1'];
const RESERVED_DIR_PREFIX = '_';

let _entries = new Map();   // id -> { meta, description, schema, data, source, version }
let _errors = [];           // [{file, error}]
let _watcher = null;

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
    found.push(path.join(dir, ent.name));
  }
  return found;
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
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    // Bare arrays / primitives are legacy non-manifest data files. Skip silently.
    return { skip: 'legacy format (not a manifest object)' };
  }
  const schema = parsed.$schema;
  if (!schema) {
    // Not a manifest file — legacy data. Skip silently.
    return { skip: 'no $schema' };
  }
  if (!SUPPORTED_SCHEMAS.includes(schema)) {
    return { error: `unsupported $schema: ${schema}` };
  }
  if (!parsed.meta || typeof parsed.meta !== 'object') {
    return { error: 'missing meta block' };
  }
  if (!parsed.meta.id || typeof parsed.meta.id !== 'string') {
    return { error: 'meta.id required' };
  }
  if (!parsed.meta.label || typeof parsed.meta.label !== 'string') {
    return { error: 'meta.label required' };
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
    arr.push({ id, meta: entry.meta, description: entry.description, hasData: entry.data !== null });
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

// Write full file back with updated data block. Preserves meta/description/schema.
// Uses atomic tmp+rename to avoid partial writes.
function writeData(id, newData) {
  const entry = _entries.get(id);
  if (!entry) throw new Error(`unknown manifest: ${id}`);
  const full = {
    $schema: entry.version,
    meta: entry.meta,
  };
  if (entry.description) full.description = entry.description;
  if (entry.schema) full.schema = entry.schema;
  full.data = newData;

  const tmp = entry.source + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(full, null, 2));
  fs.renameSync(tmp, entry.source);
  entry.data = newData;
  return true;
}

// Has a card opted into a particular view?
function isEnabledIn(entry, viewName) {
  const v = entry.meta[viewName];
  return !!(v && v.enabled === true && v.component);
}

// Filter for a specific view, returning shape the frontend can consume directly.
function listForView(viewName) {
  const result = [];
  for (const entry of _entries.values()) {
    if (!isEnabledIn(entry, viewName)) continue;
    // Card is enabled in this view, but still hidden if no data (empty files = no card).
    if (!_hasRenderableData(entry, viewName)) continue;
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

function _hasRenderableData(entry, viewName) {
  // Virtual cards (source:) are always renderable — they compute from other cards
  if (entry.meta[viewName] && entry.meta[viewName].source) return true;
  const d = entry.data;
  if (d === null || d === undefined) return false;
  if (Array.isArray(d)) return d.length > 0;
  if (typeof d === 'object') {
    if (Object.keys(d).length === 0) return false;
    // For schedule-type data (items array), check that too
    if (Array.isArray(d.items) && d.items.length === 0) return false;
    return true;
  }
  // Primitive (string/number) — count as renderable
  return true;
}

module.exports = {
  init,
  reload,
  list,
  listForView,
  get,
  data,
  writeData,
  errors,
};
