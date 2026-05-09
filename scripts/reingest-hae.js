#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// scripts/reingest-hae.js
// ---------------------------------------------------------------
// Walks every manifest in $HEALTH_HOME/data/ with
// meta.ingest.source === 'hae', backs it up, wipes data[], and
// force-replays the raw archive against it. Use after fixing a
// catalogue row shape or dispatcher semantics when you want the
// on-disk data to reflect the new behaviour instead of the historical
// (possibly wrong) state.
//
// Usage:
//   node scripts/reingest-hae.js               # live
//   node scripts/reingest-hae.js --dry-run     # list what would change
//   node scripts/reingest-hae.js --id=<id>     # single manifest
//
// Backs up each touched file to <file>.pre-reingest-<ts>.json before
// writing. Idempotent: re-running gives the same final state.

const fs = require('node:fs');
const path = require('node:path');

const DRY_RUN = process.argv.includes('--dry-run');
const idArg = process.argv.find(a => a.startsWith('--id='));
const onlyId = idArg ? idArg.slice(5) : null;

// Lazy-require the registry + replay so we pick up live config.
const registry = require('../manifests/registry');
const { replayFromArchive } = require('../health-auto-export/replay');

registry.init();

const stamp = new Date().toISOString().replace(/[:.]/g, '');
const cards = registry.list();
const targets = cards.filter(c =>
  c?.meta?.ingest?.source === 'hae' && c?.meta?.ingest?.metric);

if (onlyId) {
  const m = targets.find(c => c.id === onlyId);
  if (!m) {
    console.error(`no HAE-backed manifest with id '${onlyId}'`);
    process.exit(1);
  }
  targets.length = 0;
  targets.push(m);
}

if (targets.length === 0) {
  console.log('no HAE-backed manifests found; nothing to re-ingest');
  process.exit(0);
}

console.log(`${DRY_RUN ? 'would re-ingest' : 're-ingesting'} ${targets.length} manifest(s):`);

let ok = 0;
let failed = 0;

for (const c of targets) {
  const entry = registry.get(c.id);
  if (!entry) { failed += 1; continue; }
  const file = path.join(
    process.env.HEALTH_DATA_DIR ||
      path.join(process.env.HEALTH_HOME || '', 'data'),
    `${c.id}.json`);

  if (DRY_RUN) {
    console.log(`  - ${c.id} (metric=${c.meta.ingest.metric}, currently ${(entry.data || []).length} rows)`);
    continue;
  }

  try {
    // Back up the file verbatim before any writes.
    if (fs.existsSync(file)) {
      fs.copyFileSync(file, `${file}.pre-reingest-${stamp}.json`);
    }

    const summary = replayFromArchive(registry, c.id, { force: true });
    console.log(`  - ${c.id}: rowsWritten=${summary.rowsWritten}, pushesScanned=${summary.pushesScanned}`);
    ok += 1;
  } catch (e) {
    console.error(`  - ${c.id}: FAILED — ${e.message}`);
    failed += 1;
  }
}

console.log('');
console.log(`done. ${ok} succeeded, ${failed} failed.`);
if (!DRY_RUN && ok > 0) {
  console.log(`backups stamped ${stamp}. Restart klebb for the in-memory cache to pick up the new data (fs.watch should pick it up automatically within a second).`);
}
