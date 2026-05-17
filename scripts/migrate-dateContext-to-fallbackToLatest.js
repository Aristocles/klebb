#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// scripts/migrate-dateContext-to-fallbackToLatest.js
// ---------------------------------------------------------------
// Renames meta.view.dateContext (string-enum) to
// meta.view.fallbackToLatest (boolean) on every manifest in a
// $HEALTH_HOME/data/ directory. See #228.
//
// Conversion:
//   meta.view.dateContext === "latest" → fallbackToLatest: true,  drop dateContext
//   meta.view.dateContext === <any other string> → drop dateContext (it was a no-op)
//   meta.view.dateContext absent → no change
//
// Idempotent. Skips backup files (matches the loader's *.bak ignore).
// Backs up each touched file as <file>.pre-fb-<timestamp>.bak before
// writing.
//
// Usage:
//   node scripts/migrate-dateContext-to-fallbackToLatest.js [path/to/data/]
//   node scripts/migrate-dateContext-to-fallbackToLatest.js --dry-run
//
// Default target is HEALTH_HOME/data (respecting env) if no arg given.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DRY_RUN = process.argv.includes('--dry-run');
const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const TARGET = args[0] || path.join(
  process.env.HEALTH_HOME || path.join(os.homedir(), '.klebb'),
  'data',
);

if (!fs.existsSync(TARGET)) {
  console.error(`Target directory not found: ${TARGET}`);
  process.exit(1);
}

const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

function migrateView(view) {
  if (!view || typeof view !== 'object') return { view, changed: false };
  if (!('dateContext' in view)) return { view, changed: false };
  const out = { ...view };
  const wasLatest = out.dateContext === 'latest';
  delete out.dateContext;
  if (wasLatest && typeof out.fallbackToLatest !== 'boolean') {
    out.fallbackToLatest = true;
  }
  return { view: out, changed: true };
}

function migrateFile(full) {
  const raw = fs.readFileSync(full, 'utf8');
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (e) {
    console.log(`  - ${path.basename(full)}: not JSON, skipping`);
    return { touched: false };
  }
  if (!doc || typeof doc !== 'object' || !doc.meta || !doc.meta.view) {
    return { touched: false };
  }
  const { view, changed } = migrateView(doc.meta.view);
  if (!changed) {
    return { touched: false };
  }
  doc.meta.view = view;
  const out = JSON.stringify(doc, null, 2) + '\n';
  if (DRY_RUN) {
    console.log(`  ~ ${path.basename(full)}: WOULD migrate (dry-run)`);
    return { touched: true, dryRun: true };
  }
  const backup = `${full}.pre-fb-${timestamp}.bak`;
  fs.writeFileSync(backup, raw);
  fs.writeFileSync(full, out);
  console.log(`  ✓ ${path.basename(full)}: migrated (backup: ${path.basename(backup)})`);
  return { touched: true };
}

function isManifest(name) {
  if (!name.endsWith('.json')) return false;
  if (name.includes('.bak')) return false;
  if (name.includes('.pre-')) return false;
  if (name.startsWith('.')) return false;
  return true;
}

console.log(`Migrating dateContext → fallbackToLatest in ${TARGET}${DRY_RUN ? ' (dry-run)' : ''}`);
let touched = 0;
let scanned = 0;
for (const entry of fs.readdirSync(TARGET)) {
  const full = path.join(TARGET, entry);
  const stat = fs.statSync(full);
  if (!stat.isFile()) continue;
  if (!isManifest(entry)) continue;
  scanned++;
  const r = migrateFile(full);
  if (r.touched) touched++;
}
console.log(`\nDone. ${touched}/${scanned} file(s) ${DRY_RUN ? 'would change' : 'changed'}.`);
