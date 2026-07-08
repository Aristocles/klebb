#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// scripts/reingest-hae.js
// ---------------------------------------------------------------
// Walks every manifest in $HEALTH_HOME/data/ with
// meta.ingest.source === 'hae', backs it up, and force-replays the raw
// archive against it. Use after fixing a catalogue row shape or
// dispatcher semantics when you want the stored data to reflect the new
// behaviour instead of the historical (possibly wrong) state.
//
// Usage:
//   node scripts/reingest-hae.js               # live
//   node scripts/reingest-hae.js --dry-run     # list what would change
//   node scripts/reingest-hae.js --id=<id>     # single manifest
//
// Backs up each manifest to <file>.pre-reingest-<ts>.json with the
// card's current data re-embedded, so restoring the backup restores the
// rows via the import inbox. Idempotent: re-running gives the same
// final state.

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
    // Back up a restorable snapshot: the manifest envelope with the card's
    // current data re-embedded (the file itself is meta-only; rows live in
    // the datastore). Restoring = copy the backup over <id>.json and the
    // import inbox re-imports the data block on the next reload.
    if (fs.existsSync(file)) {
      const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
      const current = registry.data(c.id);
      if (current !== null) envelope.data = current;
      fs.writeFileSync(`${file}.pre-reingest-${stamp}.json`,
        JSON.stringify(envelope, null, 2));
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
  console.log(`backups stamped ${stamp}. Restart klebb: a running instance serves data from its own in-memory copy and will not see rows written by this script until it reloads the datastore.`);
}
