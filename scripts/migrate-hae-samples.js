#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// scripts/migrate-hae-samples.js
//
// Fold an existing HAE raw-file archive (data/auto-export/raw/) into the
// deduplicated samples table, then verify every HAE-backed card replays to
// byte-identical rows before the files are removed.
//
// HAE re-sends a rolling window and the old ingest archived each push whole,
// so the archive is ~85% byte-identical re-sends: 404 MB across 482 files on a
// real instance, for 2.5 months of data. The samples table stores each unique
// sample once, keyed by a content hash, and keeps every metric (catalogued or
// not: 19 of 25 metrics a real iPhone pushes have no catalogue entry, and the
// stored samples become their only home).
//
// Modes:
//   --dry-run   Import into a THROWAWAY copy of the database, replay every
//               HAE-backed card from both sources, and deep-equal the two
//               results. Writes nothing anyone keeps: no changes to the live
//               db, no files removed. Run this first.
//
//   (default)   Import into the live database, verify the same deep-equal
//               property, and only then move raw/ aside to
//               raw.migrated-<ts>/. Exits non-zero on any mismatch, leaving
//               the files untouched. Idempotent: each push is recorded under
//               its source filename, so a second run re-imports nothing.
//
//   --prune     After a successful default run, delete the moved-aside
//               directory. Separate step on purpose: the operator decides when
//               the copy stops being insurance.
//
// Usage:
//   node scripts/migrate-hae-samples.js --dry-run
//   node scripts/migrate-hae-samples.js
//   node scripts/migrate-hae-samples.js --prune
//
// Rollback: move raw.migrated-<ts>/ back to raw/ and run
//   DELETE FROM hae_samples; DELETE FROM hae_pushes;
// against $HEALTH_HOME/db/klebb.db, then redeploy the previous image. The
// card rows themselves are not touched by this script.

'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

function parseArgs(argv) {
  const args = { dryRun: false, prune: false, help: false };
  for (const a of argv) {
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--prune') args.prune = true;
    else if (a === '-h' || a === '--help') args.help = true;
    else { console.error(`error: unknown argument: ${a}`); return null; }
  }
  return args;
}

function usage() {
  console.log(`Usage: migrate-hae-samples.js [--dry-run] [--prune]

Fold data/auto-export/raw/ into the deduplicated samples table in
$HEALTH_HOME/db/klebb.db, verifying that every HAE-backed card replays to
identical rows before the files are moved aside.

  --dry-run   Import into a throwaway database copy and verify only.
  --prune     Delete a previously moved-aside raw.migrated-<ts>/ directory.
`);
}

// Replay one metric straight from the files, using the pre-migration
// algorithm, so the comparison is against what the old code actually produced
// rather than against a re-description of it.
function replayFromFiles(rawDir, metric, catalogue, ingest) {
  const cat = catalogue[metric];
  if (!cat) return null;
  let files;
  try {
    files = fs.readdirSync(rawDir).filter(f => f.endsWith('.json')).sort();
  } catch {
    return [];
  }
  let merged = [];
  for (const file of files) {
    let payload;
    try {
      payload = JSON.parse(fs.readFileSync(path.join(rawDir, file), 'utf8'));
    } catch {
      continue;
    }
    const entries = ingest.extractEntries(payload, { ...cat, _metricName: metric });
    if (!entries || entries.length === 0) continue;
    const mapped = [];
    for (const raw of entries) {
      let row = null;
      try { row = cat.row(raw); } catch { continue; }
      if (row && row.date) mapped.push(row);
    }
    if (mapped.length === 0) continue;
    merged = ingest.mergeByDate(merged, ingest.aggregate(mapped, cat.aggregate));
  }
  return merged;
}

function humanBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function dirSize(dir) {
  let total = 0;
  let count = 0;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return { total, count }; }
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    total += fs.statSync(path.join(dir, ent.name)).size;
    count += 1;
  }
  return { total, count };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args) process.exit(2);
  if (args.help) { usage(); return; }

  const PATHS = require('../config/paths');
  const catalogue = require('../health-auto-export/catalogue');
  const ingest = require('../health-auto-export/ingest');

  const rawDir = path.join(PATHS.AUTO_EXPORT_DIR, 'raw');

  if (args.prune) {
    const parent = PATHS.AUTO_EXPORT_DIR;
    const moved = fs.existsSync(parent)
      ? fs.readdirSync(parent).filter(f => f.startsWith('raw.migrated-'))
      : [];
    if (moved.length === 0) {
      console.log('nothing to prune: no raw.migrated-* directory found');
      return;
    }
    for (const name of moved) {
      const target = path.join(parent, name);
      const { total, count } = dirSize(target);
      fs.rmSync(target, { recursive: true, force: true });
      console.log(`pruned ${name} (${count} files, ${humanBytes(total)})`);
    }
    return;
  }

  if (!fs.existsSync(rawDir)) {
    console.log(`no raw archive at ${rawDir}; nothing to migrate`);
    return;
  }

  const files = fs.readdirSync(rawDir).filter(f => f.endsWith('.json')).sort();
  const { total: rawBytes } = dirSize(rawDir);
  console.log(`raw archive: ${files.length} file(s), ${humanBytes(rawBytes)}`);
  if (files.length === 0) {
    console.log('nothing to import');
    return;
  }

  // Dry-run imports into a throwaway copy of the database so the live one is
  // untouched. Copying rather than starting empty keeps the verification
  // honest on an instance that has already recorded live pushes.
  let dbFile = PATHS.DB_FILE;
  let scratchDir = null;
  if (args.dryRun) {
    scratchDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'klebb-hae-dry-'));
    dbFile = path.join(scratchDir, 'klebb.db');
    if (fs.existsSync(PATHS.DB_FILE)) {
      // Copy the WAL and shm too: without them a recently-written live
      // database reads as its last checkpoint, which would verify the wrong
      // starting state.
      for (const suffix of ['', '-wal', '-shm']) {
        const from = `${PATHS.DB_FILE}${suffix}`;
        if (fs.existsSync(from)) fs.copyFileSync(from, `${dbFile}${suffix}`);
      }
    }
    console.log(`dry run: importing into a throwaway copy at ${dbFile}`);
  }

  // Require samples AFTER dbFile is chosen; every entry point takes the file
  // explicitly so the module never latches onto the live path in a dry run.
  const samples = require('../health-auto-export/samples');

  const beforeSamples = samples.sampleCount({ dbFile });
  const beforePushes = samples.pushCount({ dbFile });

  let imported = 0;
  let alreadyDone = 0;
  let unreadable = 0;
  let seen = 0;

  for (const file of files) {
    const full = path.join(rawDir, file);
    let payload;
    try {
      payload = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch {
      unreadable += 1;
      continue;
    }
    // The archive filename is the push's ISO stamp, so it carries both the
    // received time and (as source_file) the idempotency key.
    const receivedAt = file.replace(/\.json$/, '');
    const r = samples.recordPush(payload, { receivedAt, sourceFile: file, dbFile });
    if (r.skipped) alreadyDone += 1;
    else { imported += 1; seen += r.seen; }
  }

  const afterSamples = samples.sampleCount({ dbFile });
  const afterPushes = samples.pushCount({ dbFile });

  console.log('');
  console.log(`pushes imported : ${imported}`);
  if (alreadyDone) console.log(`already present : ${alreadyDone}`);
  if (unreadable) console.log(`unreadable      : ${unreadable} (skipped, left in place)`);
  console.log(`samples seen    : ${seen}`);
  console.log(`unique stored   : ${afterSamples - beforeSamples} new (${afterSamples} total)`);
  console.log(`push rows       : ${afterPushes - beforePushes} new (${afterPushes} total)`);
  if (seen > 0) {
    const dupePct = (100 * (1 - (afterSamples - beforeSamples) / seen)).toFixed(1);
    console.log(`duplication     : ${dupePct}% of imported samples were re-sends`);
  }

  console.log('');
  console.log('per-metric coverage:');
  for (const m of samples.metricSummary({ dbFile })) {
    const known = catalogue[m.metric] ? '' : '  (not in catalogue: stored for later)';
    console.log(`  ${String(m.samples).padStart(8)}  ${m.firstDate || '?'} .. ${m.lastDate || '?'}  ${m.metric}${known}`);
  }

  // The verification that matters: every metric must replay from the table to
  // exactly what it replays from the files. Neither replay writes to a card.
  //
  // Every CATALOGUED metric present in the table is checked, not only the ones
  // a card subscribes to today: a card created later replays the same way, and
  // a metric with no card yet is precisely the case this store exists for. The
  // registry is deliberately not loaded, so a dry run really does write
  // nothing (registry.init() runs the import inbox and would touch card files).
  console.log('');
  console.log('verifying replay equivalence:');
  const { replayMetric } = require('../health-auto-export/replay');
  const metrics = new Set();
  for (const m of samples.metricSummary({ dbFile })) {
    if (catalogue[m.metric]) metrics.add(m.metric);
  }
  // Also every catalogued metric the FILES mention. Deriving the set from the
  // table alone would skip a metric the import dropped entirely, which is the
  // worst failure this gate exists to catch: nothing to compare reads as
  // nothing wrong.
  for (const file of files) {
    let payload;
    try {
      payload = JSON.parse(fs.readFileSync(path.join(rawDir, file), 'utf8'));
    } catch {
      continue;
    }
    for (const name of ingest.metricsPresent(payload)) {
      if (catalogue[name]) metrics.add(name);
    }
  }

  let mismatches = 0;
  if (metrics.size === 0) {
    console.log('  no catalogued metrics to verify');
  }
  for (const metric of [...metrics].sort()) {
    const fromFiles = replayFromFiles(rawDir, metric, catalogue, ingest);
    const fromTable = replayMetric(metric, { dbFile }).rows;
    let ok = true;
    try {
      assert.deepStrictEqual(fromTable, fromFiles);
    } catch {
      ok = false;
      mismatches += 1;
    }
    const n = Array.isArray(fromFiles) ? fromFiles.length : 0;
    console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${metric} (${n} row(s))`);
    if (!ok) {
      const a = JSON.stringify(fromFiles);
      const b = JSON.stringify(fromTable);
      console.log(`        files: ${a.slice(0, 300)}`);
      console.log(`        table: ${b.slice(0, 300)}`);
    }
  }

  samples.close();
  if (scratchDir) fs.rmSync(scratchDir, { recursive: true, force: true });

  console.log('');
  if (mismatches > 0) {
    console.error(`FAILED: ${mismatches} metric(s) do not replay identically. Nothing was removed.`);
    process.exit(1);
  }

  if (args.dryRun) {
    console.log('dry run complete: replay is identical from both sources.');
    console.log('re-run without --dry-run to import into the live database.');
    return;
  }

  // Move rather than delete: the operator prunes once they are satisfied.
  const stamp = new Date().toISOString().replace(/[:.]/g, '');
  const movedTo = path.join(PATHS.AUTO_EXPORT_DIR, `raw.migrated-${stamp}`);
  fs.renameSync(rawDir, movedTo);
  console.log(`migration complete. raw archive moved to ${movedTo}`);
  console.log(`reclaim ${humanBytes(rawBytes)} when ready:`);
  console.log('  node scripts/migrate-hae-samples.js --prune');
}

main();
