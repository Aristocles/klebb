#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// scripts/migrate-hae-ingest.js
// ---------------------------------------------------------------
// Adds `meta.ingest: { source: "hae", metric: <name> }` to the four
// manifests that were previously ingested into by the hardcoded HAE
// path. After this migration, the dispatcher finds them by walking
// subscribers instead of by hardcoded ID.
//
// Mapping (manifest id -> HAE metric):
//   sleep-hours     -> sleep_analysis
//   steps           -> step_count
//   active-minutes  -> apple_exercise_time
//   workouts        -> workouts         (pseudo-metric, sources from data.workouts[])
//
// Usage:
//   node scripts/migrate-hae-ingest.js [<path/to/data/>] [--dry-run]
//
// Default target: $HEALTH_HOME/data (or ~/.klebb/data if unset).
// Backs up each touched file to <file>.pre-hae-<timestamp>.json.
// Idempotent: re-running is a no-op on already-migrated files.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const MAPPING = {
  'sleep-hours':    'sleep_analysis',
  'steps':          'step_count',
  'active-minutes': 'apple_exercise_time',
  'workouts':       'workouts',
};

const DRY_RUN = process.argv.includes('--dry-run');
const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const TARGET = args[0] || path.join(
  process.env.HEALTH_HOME || path.join(os.homedir(), '.klebb'),
  'data',
);

function log(msg) { process.stdout.write(msg + '\n'); }

if (!fs.existsSync(TARGET)) {
  log(`no data dir at ${TARGET}; nothing to migrate`);
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '');
let touched = 0;
let skipped = 0;

for (const [id, metric] of Object.entries(MAPPING)) {
  const file = path.join(TARGET, `${id}.json`);
  if (!fs.existsSync(file)) {
    skipped += 1;
    log(`skip ${id}: file not present`);
    continue;
  }

  let raw, parsed;
  try {
    raw = fs.readFileSync(file, 'utf8');
    parsed = JSON.parse(raw);
  } catch (e) {
    log(`skip ${id}: could not parse (${e.message})`);
    skipped += 1;
    continue;
  }

  if (!parsed || !parsed.meta) {
    log(`skip ${id}: missing meta block`);
    skipped += 1;
    continue;
  }

  const current = parsed.meta.ingest;
  if (current
      && current.source === 'hae'
      && current.metric === metric) {
    log(`skip ${id}: already migrated`);
    skipped += 1;
    continue;
  }

  // Write ingest at a stable position: after `order` if present, else
  // wherever JSON.stringify puts it. Pass through all existing meta.
  const nextMeta = { ...parsed.meta, ingest: { source: 'hae', metric } };
  const next = { ...parsed, meta: nextMeta };
  const serialised = JSON.stringify(next, null, 2);

  if (DRY_RUN) {
    log(`would migrate ${id}: add meta.ingest = { source: "hae", metric: "${metric}" }`);
    touched += 1;
    continue;
  }

  const backup = `${file}.pre-hae-${stamp}.json`;
  fs.writeFileSync(backup, raw);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, serialised);
  fs.renameSync(tmp, file);
  log(`migrated ${id} -> metric=${metric} (backup: ${path.basename(backup)})`);
  touched += 1;
}

log('');
log(`done. ${touched} ${DRY_RUN ? 'would be migrated' : 'migrated'}, ${skipped} skipped.`);
