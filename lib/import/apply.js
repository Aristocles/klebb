// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// lib/import/apply.js
// Execute an import of an extracted export tree (docs/EXPORT-FORMAT.md)
// into a fresh $HEALTH_HOME, then verify the result against the pristine
// tree. Driven by scripts/import-tree.js --apply.
//
//   const { applyTree } = require('./lib/import/apply');
//   const { status, findings, verified } = await applyTree(treePath, targetHome);
//
// status is 'ok' | 'refused' | 'partial' | 'failed'. Findings extend the
// validate taxonomy with phase 'apply', 'verify' and 'select'; verified is
// { cards, pushes, reports } counts, or null when nothing was written.
//
// opts.selection restores part of the archive (lib/import/selection.js):
// { cards: [id], reports: [key], history: bool }. Omitted, the whole archive
// is imported, byte for byte what this function did before selection existed.
//
// Ordering mirrors a real boot of a restored tree: validate (incl. the
// fresh gate), prove the datastore is not held by a running server, delete
// the seeded welcome card, config per plan, copy the tree, drain the HAE
// samples inbox, import each card file through the boot import inbox, then
// verify every card/push/report against the tree. Backups the import
// created are swept only on full success; on anything less they stay, and
// the next boot re-imports any card file still carrying its data key.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { isDeepStrictEqual } = require('node:util');

const registry = require('../../manifests/registry');
const datastore = require('../datastore');
const { createImporter } = require('../datastore/import');
const { validateTree } = require('./validate');
const {
  buildItems, normaliseSelection, filterPlan, copySets, accepts,
} = require('./selection');

const MANIFEST_NAME = 'klebb-export.json';
const WELCOME_FILENAME = 'welcome.klebb.json';

// Short on purpose: the probe is a liveness question, not a queue. A held
// write lock that outlasts this is a running server, not a slow writer.
const PROBE_BUSY_TIMEOUT_MS = 500;

function finding(phase, severity, scope, ref, code, message) {
  return { phase, severity, scope, ref, code, message };
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function jsonNorm(value) {
  return JSON.parse(JSON.stringify(value === undefined ? null : value));
}

function isStrayName(name) {
  return name.endsWith('.tmp') || registry.BACKUP_NAME_RE.test(name);
}

// BEGIN IMMEDIATE takes the write lock, so it fails fast when a live server
// (or any other process) holds one. A quiet open handle passes: the guard
// proves nobody is writing, and the operator instruction covers the rest.
function datastoreHeldElsewhere(dbFile) {
  const { DatabaseSync } = require('node:sqlite');
  let db = null;
  try {
    db = new DatabaseSync(dbFile);
    db.exec(`PRAGMA busy_timeout=${PROBE_BUSY_TIMEOUT_MS};`);
    db.exec('BEGIN IMMEDIATE');
    db.exec('ROLLBACK');
    return false;
  } catch {
    return true;
  } finally {
    if (db) { try { db.close(); } catch {} }
  }
}

// The samples inbox resolves its file from config/paths at require time, so
// a fresh copy of the chain is required with HEALTH_HOME pointed at the
// target. The fresh copies keep the target paths for their lifetime; the
// ambient cache entries and env are restored so nothing else in the process
// moves.
function freshSamplesModules(targetHome) {
  const ids = [
    require.resolve('../../config/paths'),
    require.resolve('../../health-auto-export/samples'),
    require.resolve('../../health-auto-export/samples-inbox'),
  ];
  const savedCache = new Map();
  for (const id of ids) {
    savedCache.set(id, require.cache[id]);
    delete require.cache[id];
  }
  const savedEnv = process.env.HEALTH_HOME;
  process.env.HEALTH_HOME = targetHome;
  try {
    const inbox = require('../../health-auto-export/samples-inbox');
    const samples = require('../../health-auto-export/samples');
    return { inbox, samples };
  } finally {
    if (savedEnv === undefined) delete process.env.HEALTH_HOME;
    else process.env.HEALTH_HOME = savedEnv;
    for (const [id, entry] of savedCache) {
      if (entry === undefined) delete require.cache[id];
      else require.cache[id] = entry;
    }
  }
}

function readParsed(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// An HAE-backed card legitimately grows data its tree file never carried:
// replay backfills it from the samples table, so recorded data on a card the
// plan lists as data-less is expected, not a mismatch.
function isHaeBackedInTree(root, relFile) {
  try {
    const parsed = readParsed(path.join(root, ...relFile.split('/')));
    return !!(parsed && parsed.meta && parsed.meta.ingest
      && parsed.meta.ingest.source === 'hae');
  } catch {
    return false;
  }
}

// Per-card / pushes / reports verification against the pristine tree, per the
// validation plan. Shared with lib/import/wizard.js. The caller rebuilds
// durable state first (store.load()): the comparison is against SQLite, not
// the setData echo. `pushes` is the count the target now holds. Appends
// findings in place and returns { cards, pushes, reports } counts.
function verifyAgainstTree({ root, home, plan, store, pushes, findings }) {
  const verified = { cards: 0, pushes: 0, reports: 0 };

  for (const card of plan.cards) {
    const targetFile = path.join(home, ...card.file.split('/'));
    if (card.data === 'none') {
      const exists = fs.existsSync(targetFile);
      if (exists && (store.dataUpdatedAt(card.id) === null || isHaeBackedInTree(root, card.file))) {
        verified.cards += 1;
      } else {
        findings.push(finding('verify', 'refusal', 'card', card.file, 'VERIFY_CARD_MISMATCH',
          `card "${card.id}" carries no data in the tree but the target recorded some (or the file is missing)`));
      }
      continue;
    }
    const want = readParsed(path.join(root, ...card.file.split('/'))).data;
    const got = store.getData(card.id);
    if (store.dataUpdatedAt(card.id) !== null
        && isDeepStrictEqual(jsonNorm(got), jsonNorm(want))) {
      verified.cards += 1;
    } else {
      findings.push(finding('verify', 'refusal', 'card', card.file, 'VERIFY_CARD_MISMATCH',
        `card "${card.id}": the stored value does not deep-equal the tree's value`));
    }
  }

  verified.pushes = pushes;
  if (verified.pushes !== plan.samplesPushes) {
    findings.push(finding('verify', 'refusal', 'samples', 'data/auto-export/samples.json',
      'VERIFY_PUSHES_MISMATCH',
      `the datastore holds ${verified.pushes} HAE push(es) but the plan expected ${plan.samplesPushes}`));
  }

  for (const rel of plan.reports) {
    const targetFile = path.join(home, ...rel.split('/'));
    if (fs.existsSync(targetFile)
        && sha256(targetFile) === sha256(path.join(root, ...rel.split('/')))) {
      verified.reports += 1;
    } else {
      findings.push(finding('verify', 'refusal', 'reports', rel, 'VERIFY_REPORT_MISMATCH',
        'report bytes in the target do not match the tree (or the file is missing)'));
    }
  }

  return verified;
}

// Delete the seeded welcome card so the archive fully defines post-import
// state: the well-known filename, any card file declaring meta.id 'welcome',
// and its datastore rows. Backup strays are left alone; they never load.
function deleteWelcome(home, store) {
  const dataDir = path.join(home, 'data');
  const removed = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dataDir, { withFileTypes: true });
  } catch {}
  for (const ent of entries) {
    if (!ent.isFile() || !registry.isCardFileName(ent.name)) continue;
    const file = path.join(dataDir, ent.name);
    let isWelcome = ent.name === WELCOME_FILENAME;
    if (!isWelcome) {
      try {
        const parsed = readParsed(file);
        isWelcome = !!parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          && parsed.meta && parsed.meta.id === 'welcome';
      } catch {}
    }
    if (isWelcome) {
      fs.rmSync(file, { force: true });
      removed.push(ent.name);
    }
  }
  const hadRows = store.deleteCard('welcome');
  return { removed, hadRows };
}

// Recursive verbatim copy of one top-level tree directory, skipping strays
// (backup/tmp names). The validator has already refused symlinks; anything
// that is neither a directory nor a regular file is skipped regardless.
//
// accept is the optional selection predicate (lib/import/selection.js), taking
// the file's tree-relative POSIX path. Absent, every file is copied, which is
// the whole-archive path every caller had before selection existed.
function copyDir(srcRoot, dstRoot, relDir, accept = null) {
  const absSrc = path.join(srcRoot, relDir);
  let entries;
  try {
    entries = fs.readdirSync(absSrc, { withFileTypes: true });
  } catch {
    return;
  }
  fs.mkdirSync(path.join(dstRoot, relDir), { recursive: true });
  for (const ent of entries) {
    const rel = path.join(relDir, ent.name);
    if (ent.isDirectory()) {
      copyDir(srcRoot, dstRoot, rel, accept);
    } else if (ent.isFile()) {
      if (isStrayName(ent.name)) continue;
      if (accept && !accept(rel.split(/[\\/]/).join('/'))) continue;
      fs.copyFileSync(path.join(srcRoot, rel), path.join(dstRoot, rel));
    }
  }
}

async function applyTree(treePath, targetHome, opts = {}) {
  const root = path.resolve(treePath);
  const home = path.resolve(targetHome);

  const validation = validateTree(root, { targetHome: home });
  const findings = [...validation.findings];
  const fullPlan = validation.plan;
  if (!validation.ok) {
    return { status: 'refused', findings, verified: null };
  }

  // A selection narrows what the archive restores; absent, plan and filtered
  // plan are the same object and no predicate reaches the copy.
  const items = buildItems(root, fullPlan);
  const norm = normaliseSelection(items, opts.selection);
  if (norm.errors.length) {
    findings.push(...norm.errors);
    return { status: 'refused', findings, verified: null };
  }
  const selection = norm.selection;
  const plan = filterPlan(fullPlan, items, selection);
  const sets = copySets(fullPlan, plan, selection);
  const accept = selection ? (rel => accepts(sets, rel)) : null;

  const dbFile = path.join(home, 'db', 'klebb.db');
  if (fs.existsSync(dbFile) && datastoreHeldElsewhere(dbFile)) {
    findings.push(finding('apply', 'refusal', 'target', dbFile, 'APPLY_DB_BUSY',
      'the datastore is held by another process (a running server?); stop the server first, then re-run the import'));
    return { status: 'refused', findings, verified: null };
  }

  let store = null;
  let samplesMods = null;
  const backups = [];
  let cardsImported = 0;
  try {
    store = datastore.open(dbFile);
    store.load();

    const welcome = deleteWelcome(home, store);
    if (welcome.removed.length || welcome.hadRows) {
      findings.push(finding('apply', 'info', 'target', 'welcome', 'APPLY_WELCOME_REMOVED',
        'seeded welcome card removed; the archive defines post-import state'));
    }

    if (plan.config === 'write') {
      fs.copyFileSync(path.join(root, 'config.json'), path.join(home, 'config.json'));
    } else if (plan.config === 'keep-existing') {
      findings.push(finding('apply', 'info', 'config', 'config.json', 'APPLY_CONFIG_KEPT',
        "target already has a config.json; keeping it (the tree's copy was not imported)"));
    }

    copyDir(root, home, 'data', accept);
    copyDir(root, home, 'reports', accept);
    fs.copyFileSync(path.join(root, MANIFEST_NAME), path.join(home, MANIFEST_NAME));

    // Samples first, matching boot order: registry-driven replay reads the
    // samples table, so it has to be populated before any card import. With
    // history deselected the copy above never lands the file, so there is
    // nothing here to gate.
    const samplesTarget = path.join(home, 'data', 'auto-export', 'samples.json');
    if (fs.existsSync(samplesTarget)) {
      samplesMods = freshSamplesModules(home);
      await samplesMods.inbox.drain();
    }

    // The boot import inbox, per card file: backup, setData in one
    // transaction, strip via tmp+rename. Exactly what registry.init() runs.
    const importer = createImporter(store);
    const dataDir = path.join(home, 'data');
    for (const ent of fs.readdirSync(dataDir, { withFileTypes: true })) {
      if (!ent.isFile() || !registry.isCardFileName(ent.name)) continue;
      const file = path.join(dataDir, ent.name);
      const parsed = readParsed(file);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      if (!parsed.$schema || !parsed.meta || !parsed.meta.id) continue;
      const result = importer.importParsedFile(file, parsed);
      if (result.imported) {
        cardsImported += 1;
        backups.push(result.backup);
      }
    }

    // Verify against durable state, not the setData echo: rebuild the
    // served values from SQLite before comparing.
    store.load();
    const verified = verifyAgainstTree({
      root, home, plan, store,
      pushes: samplesMods ? Number(samplesMods.samples.pushCount()) : 0,
      findings,
    });

    const fullSuccess = findings.every(f => f.severity !== 'refusal');
    if (fullSuccess) {
      // Exactly the paths the importer returned; never a glob or a
      // timestamp window, so a pre-existing backup in the home survives.
      for (const backup of backups) fs.rmSync(backup, { force: true });
      if (backups.length) {
        findings.push(finding('apply', 'info', 'target', 'data', 'APPLY_BACKUPS_SWEPT',
          `import verified; removed the ${backups.length} .pre-import backup(s) this run created`));
      }
      return { status: 'ok', findings, verified };
    }

    findings.push(finding('apply', 'warning', 'target', home, 'APPLY_BACKUPS_KEPT',
      `verification failed: the ${backups.length} .pre-import backup(s) are left in place, and the next boot re-imports any card file still carrying its data key`));
    return { status: cardsImported > 0 ? 'partial' : 'failed', findings, verified };
  } catch (e) {
    findings.push(finding('apply', 'refusal', 'tree', root, 'APPLY_ERROR',
      `import failed: ${e.message}; backups are left in place, and the next boot re-imports any card file still carrying its data key`));
    return { status: cardsImported > 0 ? 'partial' : 'failed', findings, verified: null };
  } finally {
    // Tests spawn servers on the same home afterwards; a held WAL handle
    // makes them flake, so every handle this run opened closes here.
    if (samplesMods) { try { samplesMods.samples.close(); } catch {} }
    if (store) { try { store.close(); } catch {} }
  }
}

module.exports = {
  applyTree,
  // Shared with lib/import/wizard.js so the live pipeline and the offline CLI
  // can never disagree on what gets copied or what counts as verified.
  copyDir,
  isStrayName,
  verifyAgainstTree,
  MANIFEST_NAME,
};
