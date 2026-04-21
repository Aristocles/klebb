#!/usr/bin/env node
// scripts/migrate-date-keyed-to-array.js
//
// Converts date-keyed object data into an array of dated rows. Some v1
// cards (mood, notes) store entries as { "YYYY-MM-DD": {...} }; the
// current generic renderer expects an array of { date: "YYYY-MM-DD", ... }.
//
// Given:
//   { "2026-04-20": { mood: 4, notes: "ok", time: "..." } }
// Produces:
//   [ { date: "2026-04-20", mood: 4, notes: "ok", time: "..." } ]
//
// Rows are sorted ascending by date. All other fields are preserved.
//
// Usage:
//   node scripts/migrate-date-keyed-to-array.js --dir <data-dir> [--dry-run]
//
// Scope:
//   Only touches files matching meta.id in the KNOWN list (to avoid
//   accidentally converting unrelated object-shaped data such as
//   schedule cards' { items: [...] } payloads).
//
// Idempotent: files already in array shape are left untouched.

const fs = require('fs');
const path = require('path');

// IDs whose data SHOULD be an array-of-dated-rows. Extend as we migrate
// more cards away from the date-keyed shape.
const KNOWN_IDS = new Set([
  'mood',
  'notes',
  'daily-notes',   // an older alias for the notes card
]);

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
  console.log(`Usage: migrate-date-keyed-to-array.js --dir <data-dir> [--dry-run]

Converts { 'YYYY-MM-DD': {...} } data into [{date:'YYYY-MM-DD', ...}]
for cards whose meta.id is one of: ${Array.from(KNOWN_IDS).join(', ')}.

Options:
  --dir <path>   Directory to scan (required)
  --dry-run      Report only
  --help         Show this message`);
}

// Pure function. Given a date-keyed object, produce an array of rows.
// Returns { ok, data, reason }.
function convertDateKeyedToArray(obj) {
  if (!obj || typeof obj !== 'object') return { ok: false, reason: 'not an object' };
  if (Array.isArray(obj)) return { ok: false, reason: 'already an array' };
  const keys = Object.keys(obj);
  if (keys.length === 0) return { ok: true, data: [] };
  // Confirm every key looks like a date (YYYY-MM-DD). If any don't, skip.
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  const nonDateKey = keys.find(k => !dateRe.test(k));
  if (nonDateKey) return { ok: false, reason: `non-date key present: "${nonDateKey}"` };
  // Confirm each value is an object (not primitive) — otherwise we can't
  // safely spread its fields into a row.
  for (const k of keys) {
    const v = obj[k];
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      return { ok: false, reason: `value at "${k}" is not an object` };
    }
  }
  const rows = keys
    .sort()  // ascending YYYY-MM-DD sorts lexically too
    .map(date => ({ ...obj[date], date }));
  return { ok: true, data: rows };
}

function scanDir(dir) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    if (!ent.name.endsWith('.json')) continue;
    out.push(path.join(dir, ent.name));
  }
  return out;
}

function migrateFile(file, { dryRun }) {
  let raw, parsed;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return { file, status: 'skipped', reason: 'unreadable' }; }
  try { parsed = JSON.parse(raw); } catch { return { file, status: 'skipped', reason: 'invalid JSON' }; }
  if (parsed?.$schema !== 'klebb.datafile.v1') return { file, status: 'skipped', reason: 'not klebb.datafile.v1' };
  const id = parsed.meta?.id;
  if (!id || !KNOWN_IDS.has(id)) return { file, status: 'skipped', reason: `id "${id}" not in known set` };
  if (Array.isArray(parsed.data)) return { file, status: 'already-migrated' };

  const conversion = convertDateKeyedToArray(parsed.data);
  if (!conversion.ok) return { file, status: 'skipped', reason: conversion.reason };

  if (dryRun) return { file, status: 'would-migrate', rows: conversion.data.length };

  const updated = { ...parsed, data: conversion.data };
  const tmp = file + '.klebb-tmp';
  fs.writeFileSync(tmp, JSON.stringify(updated, null, 2));
  fs.renameSync(tmp, file);
  return { file, status: 'migrated', rows: conversion.data.length };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { usage(); return 0; }
  if (!args.dir) { console.error('error: --dir is required'); usage(); return 2; }
  const dir = path.resolve(args.dir);
  if (!fs.existsSync(dir)) { console.error(`error: no such directory: ${dir}`); return 2; }

  const files = scanDir(dir);
  const results = files.map(f => migrateFile(f, { dryRun: args.dryRun }));

  const counts = {};
  for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;

  console.log(`Scanned ${files.length} file(s) under ${dir}${args.dryRun ? ' (dry-run)' : ''}`);
  for (const [status, count] of Object.entries(counts)) console.log(`  ${status}: ${count}`);

  const actioned = results.filter(r => r.status === 'migrated' || r.status === 'would-migrate');
  if (actioned.length) {
    console.log('\nFiles:');
    for (const r of actioned) console.log(`  ${r.status === 'migrated' ? '✓' : '→'} ${path.relative(dir, r.file)} (${r.rows} rows)`);
  }
  return 0;
}

// Expose the pure function for tests
if (require.main === module) {
  process.exit(main());
} else {
  module.exports = { convertDateKeyedToArray, KNOWN_IDS };
}
