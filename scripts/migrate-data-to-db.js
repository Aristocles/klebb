#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// scripts/migrate-data-to-db.js
//
// Operator wrapper for the card-data → datastore migration (#494). The
// server self-migrates on boot: registry.init() imports every manifest's
// inline `data` block into $HEALTH_HOME/db/klebb.db and strips the key from
// the file (see manifests/registry.js + lib/datastore/import.js). This script
// exists for pre-checks and rollback drills, not because the migration needs
// a separate trigger.
//
// Modes:
//   --dry-run   Scan data/*.json, round-trip each card's inline data through
//               the shape kernel (decompose -> reconstruct) and deep-equal it
//               against the original. Reports per-card row counts and the
//               files it skipped. WRITES NOTHING: no db, no backups, no strip.
//               Run this first, on a COPY of a live data dir, before touching
//               anything.
//
//   (default)   Perform the migration: capture each file's inline data, run
//               the same import path the server runs on boot, then verify the
//               datastore serves a value deep-equal to what the file held.
//               Idempotent — a second run finds no data keys and reports
//               everything already-migrated. Exits non-zero on any mismatch.
//
// Usage:
//   node scripts/migrate-data-to-db.js --dry-run [--dir <data-dir>]
//   node scripts/migrate-data-to-db.js           [--dir <data-dir>]
//
// --dir defaults to $HEALTH_HOME/data (via config/paths.js). Passing --dir
// sets HEALTH_HOME to its parent so the datastore lands in the sibling db/.
//
// Rollback: restore each `<name>.json.pre-import-<ts>.json` backup over its
// manifest file and delete $HEALTH_HOME/db/. The next boot re-imports from
// the restored files, so the revert is complete.

'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const { decompose, reconstruct } = require('../lib/datastore/shape');

const BACKUP_NAME_RE = /\.json\.[^/\\]+\.json$/i;

function parseArgs(argv) {
  const args = { dir: null, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '-h' || a === '--help') args.help = true;
    else if (a === '--dir') args.dir = argv[++i];
    else if (a.startsWith('--dir=')) args.dir = a.slice(6);
  }
  return args;
}

function usage() {
  console.log(`Usage: migrate-data-to-db.js [--dry-run] [--dir <data-dir>]

Card-data -> embedded datastore migration (#494).

  --dry-run    Round-trip-verify every card's inline data through the shape
               kernel and report; write nothing. Run this first.
  (default)    Migrate: import inline data into the datastore, strip the file,
               and verify the served value deep-equals the original.
  --dir <path> Data directory (default: $HEALTH_HOME/data).
  --help       Show this message.

Rollback: restore the *.json.pre-import-*.json backups and delete db/.`);
}

// A file is a migration candidate when it parses as a klebb manifest object
// carrying a `data` key. Everything else (config.json, legacy injection-log,
// no-$schema files) is reported as a skip so the operator can eyeball the
// list. Backup files and subdirectories are never candidates.
function classifyFile(file) {
  const base = path.basename(file);
  if (BACKUP_NAME_RE.test(base)) return { status: 'skipped', reason: 'backup file' };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { status: 'skipped', reason: `unreadable/invalid JSON: ${e.message}` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 'skipped', reason: 'not a manifest object' };
  }
  if (parsed.$schema !== 'klebb.datafile.v1') {
    return { status: 'skipped', reason: 'no klebb.datafile.v1 $schema' };
  }
  const id = parsed.meta && parsed.meta.id;
  if (!id || typeof id !== 'string') {
    return { status: 'skipped', reason: 'missing meta.id' };
  }
  if (!Object.prototype.hasOwnProperty.call(parsed, 'data')) {
    return { status: 'already-migrated', id };
  }
  return { status: 'candidate', id, data: parsed.data };
}

function listManifestFiles(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return { error: `cannot read ${dir}: ${e.message}` };
  }
  const files = [];
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue;
    if (ent.isDirectory()) continue;          // subdirs are not top-level cards
    if (!ent.name.endsWith('.json')) continue;
    files.push(path.join(dir, ent.name));
  }
  return { files };
}

// Count the rows a card decomposes into, for the report. An array card is its
// length; an object card is the sum of its container lengths; a doc/null is 0.
function rowCount(value) {
  const { shape, containers } = decompose(value);
  if (shape.kind === 'null') return 0;
  if (shape.kind === 'doc') return 0;
  let n = 0;
  for (const name of Object.keys(containers)) n += containers[name].length;
  return n;
}

// --dry-run: pure, no IO beyond reads. Round-trips each candidate through the
// shape kernel and deep-equals against the original. Returns per-file results.
function dryRun(files) {
  const results = [];
  for (const file of files) {
    const c = classifyFile(file);
    if (c.status !== 'candidate') { results.push({ file, ...c }); continue; }
    try {
      const rebuilt = reconstruct(decompose(c.data));
      assert.deepStrictEqual(rebuilt, JSON.parse(JSON.stringify(c.data)));
      results.push({ file, status: 'ok', id: c.id, rows: rowCount(c.data) });
    } catch (e) {
      results.push({ file, status: 'MISMATCH', id: c.id, reason: e.message });
    }
  }
  return results;
}

// Real run: capture inline data, then run the server's own import path
// (registry.init) and verify the datastore serves a deep-equal value. Must be
// called after HEALTH_HOME is set for the target dir.
function migrate(files) {
  // Capture BEFORE init strips the files.
  const captured = new Map();       // id -> pre-migration value (JSON-normalised)
  const results = [];
  for (const file of files) {
    const c = classifyFile(file);
    if (c.status === 'candidate') {
      captured.set(c.id, JSON.parse(JSON.stringify(c.data)));
      results.push({ file, status: 'candidate', id: c.id });
    } else {
      results.push({ file, ...c });
    }
  }

  // registry.init() opens the datastore, imports every data-carrying file
  // (full replace), strips it, and populates the served value from the store.
  const registry = require('../manifests/registry');
  registry.init();

  const verified = [];
  for (const [id, before] of captured) {
    let after;
    try {
      after = registry.get(id) ? registry.get(id).data : undefined;
      assert.deepStrictEqual(after, before);
      verified.push({ id, status: 'migrated', rows: rowCount(before) });
    } catch (e) {
      verified.push({ id, status: 'MISMATCH', reason: e.message });
    }
  }
  return { results, verified };
}

function resolveDataDir(argDir) {
  if (argDir) {
    const dir = path.resolve(argDir);
    // Point HEALTH_HOME at the parent so the datastore + backups land in the
    // sibling db/ the server would use, before requiring config/paths.
    process.env.HEALTH_HOME = path.dirname(dir);
    return dir;
  }
  const PATHS = require('../config/paths');
  return PATHS.DATA_DIR;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { usage(); return 0; }

  const dir = resolveDataDir(args.dir);
  const listed = listManifestFiles(dir);
  if (listed.error) { console.error(`error: ${listed.error}`); return 2; }
  const { files } = listed;

  console.log(`Scanning ${files.length} file(s) under ${dir}${args.dryRun ? ' (dry-run)' : ''}`);

  if (args.dryRun) {
    const results = dryRun(files);
    const counts = {};
    for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
    for (const [status, count] of Object.entries(counts)) console.log(`  ${status}: ${count}`);
    for (const r of results.filter(x => x.status === 'ok')) {
      console.log(`  ✓ ${r.id} (${r.rows} row(s)) round-trips`);
    }
    const mismatches = results.filter(r => r.status === 'MISMATCH');
    for (const r of mismatches) console.error(`  ✗ ${r.id}: ${r.reason}`);
    for (const r of results.filter(x => x.status === 'skipped')) {
      console.log(`  - skipped ${path.basename(r.file)}: ${r.reason}`);
    }
    if (mismatches.length) {
      console.error(`\n${mismatches.length} card(s) do NOT round-trip. Do not migrate; extend the shape kernel + fixtures (fork F2).`);
      return 1;
    }
    console.log('\nAll candidates round-trip. Safe to migrate.');
    return 0;
  }

  const { results, verified } = migrate(files);
  const skipCount = results.filter(r => r.status === 'skipped').length;
  const alreadyCount = results.filter(r => r.status === 'already-migrated').length;
  console.log(`  candidates: ${verified.length}, already-migrated: ${alreadyCount}, skipped: ${skipCount}`);
  for (const r of results.filter(x => x.status === 'skipped')) {
    console.log(`  - skipped ${path.basename(r.file)}: ${r.reason}`);
  }
  const mismatches = verified.filter(v => v.status === 'MISMATCH');
  for (const v of verified.filter(x => x.status === 'migrated')) {
    console.log(`  ✓ ${v.id} (${v.rows} row(s)) migrated + verified`);
  }
  for (const v of mismatches) console.error(`  ✗ ${v.id}: ${v.reason}`);
  if (mismatches.length) {
    console.error(`\n${mismatches.length} card(s) failed post-migration verification. Restore the *.pre-import-* backups and delete db/, then investigate (fork F2).`);
    return 1;
  }
  console.log('\nMigration complete: every card served deep-equal to its pre-migration value.');
  return 0;
}

if (require.main === module) {
  process.exit(main());
} else {
  module.exports = { classifyFile, dryRun, rowCount, listManifestFiles };
}
