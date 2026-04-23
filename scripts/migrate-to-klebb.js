#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// scripts/migrate-to-klebb.js
//
// Rewrites any legacy data files with $schema: "eddzhealth.datafile.v1"
// to the current klebb.datafile.v1 schema. Everything else is preserved
// verbatim (meta, description, data).
//
// Usage:
//   node scripts/migrate-to-klebb.js               # uses $HEALTH_HOME/data
//   node scripts/migrate-to-klebb.js --dir /path   # explicit directory
//   node scripts/migrate-to-klebb.js --dry-run     # report without writing
//
// Safe to run multiple times (idempotent — only rewrites files with the
// old schema string, skips files that are already on klebb.datafile.v1 or
// anything else).

const fs = require('fs');
const path = require('path');

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
  console.log(`Usage: migrate-to-klebb.js [options]

Rewrites data files with $schema = "eddzhealth.datafile.v1" to
"klebb.datafile.v1". Other shapes are untouched.

Options:
  --dir <path>   Directory to scan (default: $HEALTH_HOME/data)
  --dry-run      Report what would change without writing
  --help         Show this message`);
}

function scanDir(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    // Skip the reserved archive dir and anything hidden
    if (ent.isDirectory()) {
      if (ent.name.startsWith('_') || ent.name.startsWith('.')) continue;
      scanDir(full, out);
    } else if (ent.isFile() && ent.name.endsWith('.json')) {
      out.push(full);
    }
  }
  return out;
}

function migrateFile(file, { dryRun }) {
  const raw = fs.readFileSync(file, 'utf8');
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return { file, status: 'skipped', reason: 'invalid JSON' }; }
  if (!parsed || typeof parsed !== 'object') return { file, status: 'skipped', reason: 'not an object' };
  const schema = parsed.$schema;
  if (schema === 'klebb.datafile.v1') return { file, status: 'already-migrated' };
  if (schema !== 'eddzhealth.datafile.v1') return { file, status: 'skipped', reason: `unknown/unsupported $schema: ${schema ?? '<none>'}` };

  const updated = { ...parsed, $schema: 'klebb.datafile.v1' };
  if (dryRun) {
    return { file, status: 'would-migrate' };
  }
  const tmp = file + '.klebb-tmp';
  fs.writeFileSync(tmp, JSON.stringify(updated, null, 2));
  fs.renameSync(tmp, file);
  return { file, status: 'migrated' };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { usage(); return 0; }

  let dir = args.dir;
  if (!dir) {
    const home = process.env.HEALTH_HOME;
    if (!home) {
      console.error('error: no --dir provided and $HEALTH_HOME is unset');
      usage();
      return 2;
    }
    dir = path.join(home, 'data');
  }
  dir = path.resolve(dir);

  if (!fs.existsSync(dir)) {
    console.error(`error: directory not found: ${dir}`);
    return 2;
  }

  const files = scanDir(dir);
  const results = files.map(f => migrateFile(f, { dryRun: args.dryRun }));

  const counts = {};
  for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;

  console.log(`Scanned ${files.length} file(s) under ${dir}${args.dryRun ? ' (dry-run)' : ''}`);
  for (const [status, count] of Object.entries(counts)) {
    console.log(`  ${status}: ${count}`);
  }
  const actioned = results.filter(r => r.status === 'migrated' || r.status === 'would-migrate');
  if (actioned.length > 0) {
    console.log('\nFiles:');
    for (const r of actioned) console.log(`  ${r.status === 'migrated' ? '✓' : '→'} ${path.relative(dir, r.file)}`);
  }
  const skipped = results.filter(r => r.status === 'skipped');
  if (skipped.length > 0 && process.env.VERBOSE) {
    console.log('\nSkipped:');
    for (const r of skipped) console.log(`  - ${path.relative(dir, r.file)}: ${r.reason}`);
  }
  return 0;
}

process.exit(main());
