// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// lib/import/validate.js
// Read-only dry run over an extracted export tree (docs/EXPORT-FORMAT.md),
// plus an optional target-freshness probe. Never writes anything: every
// check records a finding or passes silently, and the caller decides what
// to do with the result.
//
//   const { validateTree } = require('./lib/import/validate');
//   const { ok, findings, plan } = validateTree(treePath, { targetHome });
//
// ok is true when no finding is a refusal. Each finding is
//   { phase: 'validate', severity, scope, ref, code, message }
// with severity 'refusal' | 'warning' | 'info' and scope one of
// 'tree' | 'card' | 'samples' | 'config' | 'reports' | 'file' | 'target'.
// plan describes what an import would do:
//   { cards: [{id, file, data, label, rows, hae}], samplesPushes, reports,
//     config }
//
// opts.targetHome: absolute path to a $HEALTH_HOME; when present the target
// is probed for freshness. opts.caps overrides the KLEBB_IMPORT_MAX_* env
// defaults from config/env.js: { maxTreeMB, maxFileMB, maxFiles,
// maxRowsPerCard, maxPushes }.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { isDeepStrictEqual } = require('node:util');

const ENV = require('../../config/env');
const registry = require('../../manifests/registry');
const { decompose, reconstruct } = require('../datastore/shape');

const EXPORT_FORMAT = 'klebb.export.v1';
const SUPPORTED_FORMAT_VERSION = 1;
const MANIFEST_NAME = 'klebb-export.json';
const SAMPLES_FILE = 'data/auto-export/samples.json';
const MB = 1024 * 1024;

// The loader prefers these legacy locations over the modern credential
// subdirs when they exist (config/paths.js), so a crafted archive carrying
// either would plant credentials on the importing instance.
const FORBIDDEN_DATA_NAMES = new Set([
  'webauthn-credentials.json',
  'webauthn-sessions.json',
]);

const DATA_STATES = new Set(['embedded', 'inline', 'null', 'none']);

function finding(severity, scope, ref, code, message) {
  return { phase: 'validate', severity, scope, ref, code, message };
}

function readJSON(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { error: `read failed: ${e.message}` };
  }
  try {
    return { value: JSON.parse(raw) };
  } catch (e) {
    return { error: `invalid JSON: ${e.message}` };
  }
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

// Row count via the datastore's own decomposition, matching the export
// writer: container row lengths summed. A doc, null, or absent value has no
// rows, and a doc's single __doc__ row deliberately counts as none.
function countRows(value) {
  const { shape, containers } = decompose(value);
  if (shape.kind !== 'array' && shape.kind !== 'object') return 0;
  let rows = 0;
  for (const arr of Object.values(containers)) rows += arr.length;
  return rows;
}

function isStrayName(name) {
  return name.endsWith('.tmp') || registry.BACKUP_NAME_RE.test(name);
}

// Recursive lstat walk. Symlinks are refused and never followed: an archive
// is attacker-suppliable, and a followed link can read or (on a later copy
// step) write outside the tree. Returns regular files as
// { rel, name, size } with forward-slash relative paths.
function walkTree(root, findings) {
  const files = [];
  (function recurse(relDir) {
    const absDir = relDir ? path.join(root, relDir) : root;
    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const ent of entries) {
      const rel = relDir ? `${relDir}/${ent.name}` : ent.name;
      if (ent.isSymbolicLink()) {
        findings.push(finding('refusal', 'file', rel, 'VAL_SYMLINK',
          'symlink in the archive; an export tree never contains symlinks'));
        continue;
      }
      if (ent.isDirectory()) {
        recurse(rel);
        continue;
      }
      if (!ent.isFile()) continue;
      let size = 0;
      try {
        size = fs.statSync(path.join(root, rel)).size;
      } catch {}
      files.push({ rel, name: ent.name, size });
    }
  })('');
  return files;
}

// Freshness = three legs, all required: no non-welcome card files in data/,
// no non-welcome ids in the cards table (orphaned rows count as data), and
// zero HAE pushes. A missing db or an empty home passes trivially.
function checkTargetFresh(targetHome, findings) {
  let cardFiles = 0;
  const dataDir = path.join(targetHome, 'data');
  let entries = [];
  try {
    entries = fs.readdirSync(dataDir, { withFileTypes: true });
  } catch {}
  for (const ent of entries) {
    if (ent.isDirectory()) continue;
    if (!registry.isCardFileName(ent.name)) continue;
    let id = null;
    const res = readJSON(path.join(dataDir, ent.name));
    if (!res.error && res.value && typeof res.value === 'object' && !Array.isArray(res.value)) {
      id = res.value.meta && res.value.meta.id;
    }
    // A file that will not parse still holds bytes we would clobber: count it.
    if (id !== 'welcome') cardFiles += 1;
  }

  let cardRows = 0;
  let haePushes = 0;
  const dbFile = path.join(targetHome, 'db', 'klebb.db');
  if (fs.existsSync(dbFile)) {
    // Read-only on purpose: the probe must never create db/ or touch a live
    // instance's WAL. An unreadable or table-less db counts as empty here;
    // an actual import would surface the underlying error itself.
    try {
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(dbFile, { readOnly: true });
      try {
        try {
          cardRows = Number(db.prepare(
            "SELECT COUNT(*) AS n FROM cards WHERE card_id <> 'welcome'").get().n);
        } catch {}
        try {
          haePushes = Number(db.prepare(
            'SELECT COUNT(*) AS n FROM hae_pushes').get().n);
        } catch {}
      } finally {
        db.close();
      }
    } catch {}
  }

  if (cardFiles || cardRows || haePushes) {
    const legs = [];
    if (cardFiles) legs.push(`${cardFiles} non-welcome card file(s) in data/`);
    if (cardRows) legs.push(`${cardRows} non-welcome card(s) in the datastore`);
    if (haePushes) legs.push(`${haePushes} HAE push(es) recorded`);
    findings.push(finding('refusal', 'target', targetHome, 'VAL_TARGET_NOT_FRESH',
      `target instance is not fresh: ${legs.join(', ')}; import only writes into a fresh instance`));
  }
}

function validateTree(treePath, opts = {}) {
  const findings = [];
  const plan = { cards: [], samplesPushes: 0, reports: [], config: 'none' };
  const caps = {
    maxTreeMB: ENV.IMPORT_MAX_TREE_MB,
    maxFileMB: ENV.IMPORT_MAX_FILE_MB,
    maxFiles: ENV.IMPORT_MAX_FILES,
    maxRowsPerCard: ENV.IMPORT_MAX_ROWS_PER_CARD,
    maxPushes: ENV.IMPORT_MAX_PUSHES,
    ...(opts.caps || {}),
  };
  const root = path.resolve(treePath);

  let hasDataDir = false;
  try {
    hasDataDir = fs.statSync(path.join(root, 'data')).isDirectory();
  } catch {}
  if (!hasDataDir) {
    findings.push(finding('refusal', 'tree', 'data', 'VAL_NO_DATA_DIR',
      'archive has no data/ directory; not a Klebb export tree'));
  }

  // formatVersion is the only compatibility gate; everything else in the
  // manifest is inventory. A manifest that is absent, unparseable, wrongly
  // formatted, or missing its integer formatVersion is treated as no
  // manifest at all: the export writes it last, so its absence means torn.
  const manifestRes = readJSON(path.join(root, MANIFEST_NAME));
  const m = manifestRes.value;
  const manifest = (m && typeof m === 'object' && !Array.isArray(m)
    && m.format === EXPORT_FORMAT && Number.isInteger(m.formatVersion)) ? m : null;
  let inventoryUsable = false;
  if (!manifest) {
    findings.push(finding('refusal', 'tree', MANIFEST_NAME, 'VAL_NO_MANIFEST',
      'no klebb-export.json manifest: not a Klebb export tree, or an incomplete one; re-export from the source instance'));
  } else if (manifest.formatVersion > SUPPORTED_FORMAT_VERSION) {
    findings.push(finding('refusal', 'tree', MANIFEST_NAME, 'VAL_FORMAT_NEWER',
      `archive format v${manifest.formatVersion} is newer than this instance supports (v${SUPPORTED_FORMAT_VERSION}); update the instance or re-export from a matching version`));
  } else {
    inventoryUsable = true;
  }

  if (hasDataDir) {
    const files = walkTree(root, findings);

    const strays = new Set();
    for (const f of files) {
      if (isStrayName(f.name)) {
        strays.add(f.rel);
        findings.push(finding('warning', 'file', f.rel, 'VAL_STRAY_BACKUP',
          'backup or tmp file; it will be skipped at import'));
      }
    }

    for (const f of files) {
      if (f.rel.startsWith('data/') && FORBIDDEN_DATA_NAMES.has(f.name)) {
        findings.push(finding('refusal', 'file', f.rel, 'VAL_FORBIDDEN_FILE',
          `${f.name} would override this instance's credentials (the loader prefers the legacy location when present) and is never part of an export`));
      }
    }

    if (files.length > caps.maxFiles) {
      findings.push(finding('refusal', 'tree', 'tree', 'VAL_CAP',
        `tree has ${files.length} files; the cap is ${caps.maxFiles} (KLEBB_IMPORT_MAX_FILES)`));
    }
    let totalBytes = 0;
    for (const f of files) {
      totalBytes += f.size;
      if (f.size > caps.maxFileMB * MB) {
        findings.push(finding('refusal', 'file', f.rel, 'VAL_CAP',
          `file is ${f.size} bytes; the per-file cap is ${caps.maxFileMB} MB (KLEBB_IMPORT_MAX_FILE_MB)`));
      }
    }
    if (totalBytes > caps.maxTreeMB * MB) {
      findings.push(finding('refusal', 'tree', 'tree', 'VAL_CAP',
        `tree is ${totalBytes} bytes; the cap is ${caps.maxTreeMB} MB (KLEBB_IMPORT_MAX_TREE_MB)`));
    }

    // Inventory card entries, for the plan's data state (the writer knows
    // embedded vs inline; the file alone cannot tell them apart).
    const invCards = new Map();
    if (inventoryUsable && manifest.inventory && typeof manifest.inventory === 'object'
        && Array.isArray(manifest.inventory.cards)) {
      for (const e of manifest.inventory.cards) {
        if (e && typeof e === 'object' && typeof e.file === 'string') invCards.set(e.file, e);
      }
    }

    // Cards live at data/ top level only, enumerated with the registry's own
    // scan rules; subdirectories are walked above but never hold cards.
    const seenIds = new Map(); // id -> rel of first declaring file
    const cardFiles = files.filter(
      f => /^data\/[^/]+$/.test(f.rel) && registry.isCardFileName(f.name));
    for (const f of cardFiles) {
      const res = readJSON(path.join(root, f.rel));
      if (res.error) {
        findings.push(finding('refusal', 'card', f.rel, 'VAL_BAD_JSON',
          'card file is not valid JSON'));
        continue;
      }
      const parsed = res.value;
      // Legacy shapes and $schema-less files are skipped by the loader, so
      // they are inert data here, not cards.
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      if (!parsed.$schema) continue;
      if (!registry.SUPPORTED_SCHEMAS.includes(parsed.$schema)) {
        findings.push(finding('refusal', 'card', f.rel, 'VAL_SCHEMA_UNSUPPORTED',
          `unsupported $schema "${parsed.$schema}"; this instance supports ${registry.SUPPORTED_SCHEMAS.join(', ')}`));
        continue;
      }
      try {
        registry.validateManifestShape(parsed);
      } catch (e) {
        findings.push(finding('refusal', 'card', f.rel, 'VAL_BAD_CARD',
          `not a valid card manifest: ${e.message}`));
        continue;
      }
      const id = parsed.meta.id;
      if (seenIds.has(id)) {
        findings.push(finding('refusal', 'card', f.rel, 'VAL_DUP_ID',
          `duplicate meta.id "${id}": ${seenIds.get(id)} and ${f.rel} both declare it; the second would never load or import`));
        continue;
      }
      seenIds.set(id, f.rel);

      let dataState = 'none';
      let rows = 0;
      if (hasOwn(parsed, 'data')) {
        dataState = parsed.data === null ? 'null' : 'inline';
        rows = countRows(parsed.data);
        if (rows > caps.maxRowsPerCard) {
          findings.push(finding('refusal', 'card', f.rel, 'VAL_CAP',
            `card has ${rows} data rows; the cap is ${caps.maxRowsPerCard} (KLEBB_IMPORT_MAX_ROWS_PER_CARD)`));
        }
        // Both sides JSON-normalised so numeric edge cases (-0, lost object
        // key order) compare as the store would actually persist them.
        let roundTrips = false;
        try {
          const rebuilt = reconstruct(decompose(parsed.data));
          roundTrips = isDeepStrictEqual(
            JSON.parse(JSON.stringify(rebuilt)),
            JSON.parse(JSON.stringify(parsed.data)));
        } catch {}
        if (!roundTrips) {
          findings.push(finding('refusal', 'card', f.rel, 'VAL_ROUNDTRIP',
            'card data does not survive the datastore decompose/reconstruct round trip; the store would corrupt it'));
          continue;
        }
      }

      const invEntry = invCards.get(f.rel);
      const state = invEntry && DATA_STATES.has(invEntry.data) ? invEntry.data : dataState;
      // label/rows/hae describe the card for a selective import's preview
      // (lib/import/selection.js). Recorded here because this is the one pass
      // that has the manifest parsed and its rows counted.
      plan.cards.push({
        id,
        file: f.rel,
        data: state,
        label: parsed.meta.label,
        rows,
        hae: !!(parsed.meta.ingest && parsed.meta.ingest.source === 'hae'),
      });
    }

    const samplesAbs = path.join(root, SAMPLES_FILE);
    if (fs.existsSync(samplesAbs)) {
      const res = readJSON(samplesAbs);
      const s = res.value;
      const shapeOk = !res.error && s && typeof s === 'object' && !Array.isArray(s)
        && Array.isArray(s.pushes) && (s.version === undefined || s.version === 1);
      if (!shapeOk) {
        findings.push(finding('refusal', 'samples', SAMPLES_FILE, 'VAL_SAMPLES_SHAPE',
          'samples.json is not a valid HAE history file; expected an object with a pushes array'));
      } else {
        if (s.pushes.length > caps.maxPushes) {
          findings.push(finding('refusal', 'samples', SAMPLES_FILE, 'VAL_CAP',
            `samples.json has ${s.pushes.length} pushes; the cap is ${caps.maxPushes} (KLEBB_IMPORT_MAX_PUSHES)`));
        }
        const empty = s.pushes.filter(p => !p || !p.payload).length;
        if (empty > 0) {
          findings.push(finding('warning', 'samples', SAMPLES_FILE, 'VAL_SAMPLES_EMPTY_PUSH',
            `${empty} push(es) have no payload and will be skipped at import`));
        }
        plan.samplesPushes = s.pushes.length - empty;
      }
    }

    const cfgAbs = path.join(root, 'config.json');
    if (fs.existsSync(cfgAbs)) {
      const res = readJSON(cfgAbs);
      if (res.error) {
        findings.push(finding('warning', 'config', 'config.json', 'VAL_CONFIG_INVALID',
          'config.json is not valid JSON and will not be imported'));
      } else {
        const cfg = res.value;
        const hasSecrets = cfg && typeof cfg === 'object' && !Array.isArray(cfg)
          && ((cfg.hae && typeof cfg.hae === 'object' && cfg.hae.token)
            || (cfg.auth && typeof cfg.auth === 'object' && cfg.auth.invites));
        if (hasSecrets) {
          findings.push(finding('warning', 'config', 'config.json', 'VAL_CONFIG_SECRETS',
            'config.json carries secrets (hae.token or auth.invites); they will be imported verbatim'));
        }
        plan.config = opts.targetHome && fs.existsSync(path.join(opts.targetHome, 'config.json'))
          ? 'keep-existing' : 'write';
      }
    }

    for (const f of files) {
      if (f.rel.startsWith('reports/') && !strays.has(f.rel)) plan.reports.push(f.rel);
    }

    // Inventory reconciliation. Skipped when the manifest is unusable or
    // newer than this reader: a v2 inventory may mean something else, and
    // comparing against nothing would mislabel every file as extra.
    if (inventoryUsable) {
      const expected = new Map(); // rel -> sha256 hex (or null when unlisted)
      const inv = manifest.inventory;
      if (inv && typeof inv === 'object' && !Array.isArray(inv)) {
        const add = (e) => {
          if (e && typeof e === 'object' && typeof e.file === 'string') {
            expected.set(e.file, typeof e.sha256 === 'string' ? e.sha256.toLowerCase() : null);
          }
        };
        if (Array.isArray(inv.cards)) inv.cards.forEach(add);
        add(inv.samples);
        if (Array.isArray(inv.reports)) inv.reports.forEach(add);
        if (Array.isArray(inv.other)) inv.other.forEach(add);
      }
      const present = new Set(files.map(f => f.rel));
      for (const [rel, sha] of expected) {
        if (!present.has(rel)) {
          findings.push(finding('refusal', 'file', rel, 'VAL_INVENTORY_MISSING',
            'listed in klebb-export.json but missing from the tree; the archive is incomplete'));
          continue;
        }
        if (sha && sha256(path.join(root, rel)) !== sha) {
          findings.push(finding('warning', 'file', rel, 'VAL_CHECKSUM',
            'checksum does not match klebb-export.json; the file was changed after export (hand edits are supported)'));
        }
      }
      for (const f of files) {
        if (f.rel === MANIFEST_NAME) continue; // the manifest never lists itself
        if (strays.has(f.rel)) continue;
        if (!expected.has(f.rel)) {
          findings.push(finding('warning', 'file', f.rel, 'VAL_INVENTORY_EXTRA',
            'not listed in klebb-export.json; it will be imported as found'));
        }
      }
    }
  }

  if (opts.targetHome) {
    checkTargetFresh(path.resolve(opts.targetHome), findings);
  }

  const ok = findings.every(f => f.severity !== 'refusal');
  return { ok, findings, plan };
}

module.exports = { validateTree };
