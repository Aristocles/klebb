#!/usr/bin/env node
// scripts/migrate-schedule-vocabulary.js
// ---------------------------------------------------------------
// Unifies the schedule-block vocabulary across all manifests.
//
// Canonical schema:
//   schedule: {
//     type: 'daily' | 'weekly' | 'every_n_days' | 'on_off' | 'phased' | 'as_needed',
//     on_days: [...],            // weekly / on_off
//     off_days: [...],           // on_off only, optional
//     interval_days: N,          // every_n_days
//     times_per_day: N,          // optional, default 1
//     start_date: 'YYYY-MM-DD',  // every_n_days anchor; optional
//     loading: { days, duration_weeks },    // phased
//     maintenance: { days, duration_weeks } // phased
//   }
//
// Converts:
//   - schedule.frequency → schedule.type
//   - schedule.nDays | schedule.every → schedule.interval_days
//   - schedule.startDate → schedule.start_date
//   - schedule.dayOfWeek (single day) → schedule.on_days: [dayName]
//   - flat item.frequency (supplements) → item.schedule.type
//     - "daily" → { type: 'daily' }
//     - "as needed" → { type: 'as_needed' }
//     - "weekly" (with item.day?) → { type: 'weekly', on_days: [...] }
//     - "every N days" → { type: 'every_n_days', interval_days: N }
//
// Usage:
//   node scripts/migrate-schedule-vocabulary.js <path/to/data/>
//   node scripts/migrate-schedule-vocabulary.js <path/to/data/> --dry-run
//
// Default target is HEALTH_HOME/data (respecting env) if no arg given.
// Backs up each touched file to <file>.pre-d-<timestamp>.json before
// writing.

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

const FILES_TO_MIGRATE = ['peptides.json', 'medication-schedule.json', 'supplements.json'];
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

function toDayShort(s) {
  if (!s) return null;
  const lower = String(s).toLowerCase();
  const map = { sun:'Sun', mon:'Mon', tue:'Tue', wed:'Wed', thu:'Thu', fri:'Fri', sat:'Sat',
    sunday:'Sun', monday:'Mon', tuesday:'Tue', wednesday:'Wed', thursday:'Thu', friday:'Fri', saturday:'Sat' };
  return map[lower.slice(0, 3)] || map[lower] || null;
}

function migrateScheduleObj(s) {
  if (!s || typeof s !== 'object') return { schedule: s, changed: false };
  const out = { ...s };
  let changed = false;

  // frequency → type (keep type if both set; drop frequency)
  if ('frequency' in out && !('type' in out)) {
    out.type = out.frequency;
    changed = true;
  }
  if ('frequency' in out && out.frequency === out.type) {
    delete out.frequency;
    changed = true;
  } else if ('frequency' in out) {
    // type present and differs from frequency — trust type (more canonical), drop frequency
    delete out.frequency;
    changed = true;
  }

  // nDays | every → interval_days
  if (('nDays' in out || 'every' in out) && !('interval_days' in out)) {
    out.interval_days = out.nDays || out.every;
    changed = true;
  }
  if ('nDays' in out) { delete out.nDays; changed = true; }
  if ('every' in out) { delete out.every; changed = true; }

  // startDate → start_date
  if ('startDate' in out && !('start_date' in out)) {
    out.start_date = out.startDate;
    changed = true;
  }
  if ('startDate' in out) { delete out.startDate; changed = true; }

  // dayOfWeek → on_days array
  if ('dayOfWeek' in out && !('on_days' in out)) {
    const d = toDayShort(out.dayOfWeek);
    if (d) out.on_days = [d];
    changed = true;
  }
  if ('dayOfWeek' in out) { delete out.dayOfWeek; changed = true; }

  return { schedule: out, changed };
}

function migrateItem(item) {
  if (!item || typeof item !== 'object') return { item, changed: false };
  let changed = false;
  const out = { ...item };

  // Existing schedule object: normalise keys
  if (out.schedule && typeof out.schedule === 'object') {
    const { schedule: migrated, changed: c } = migrateScheduleObj(out.schedule);
    if (c) {
      out.schedule = migrated;
      changed = true;
    }
  }

  // Flat item.frequency (supplements-style): lift into schedule
  if (typeof out.frequency === 'string' && !out.schedule) {
    const f = out.frequency.toLowerCase().trim();
    const newSched = {};
    if (f === 'daily') {
      newSched.type = 'daily';
    } else if (f === 'as needed' || f === 'as_needed' || f === 'prn') {
      newSched.type = 'as_needed';
    } else if (f === 'weekly') {
      newSched.type = 'weekly';
      const d = toDayShort(out.day);
      if (d) newSched.on_days = [d];
    } else if (/^every\s+(\d+)\s*days?$/.test(f)) {
      const n = Number(f.match(/^every\s+(\d+)/)[1]);
      newSched.type = 'every_n_days';
      newSched.interval_days = n;
    } else {
      // Unknown frequency string — treat as daily with a comment so the
      // user sees it. Non-destructive; the data file keeps frequency too.
      console.warn(`  ! unknown flat frequency on "${out.name || '?'}": "${out.frequency}" — left as daily`);
      newSched.type = 'daily';
    }
    out.schedule = newSched;
    delete out.frequency;
    if ('day' in out) delete out.day;
    changed = true;
  }

  // startDate on the item itself (supplements): leave it — it's a
  // historical reference, not a schedule anchor.

  return { item: out, changed };
}

function migrateFile(file) {
  const full = path.join(TARGET, file);
  if (!fs.existsSync(full)) {
    console.log(`  - ${file}: not present, skipping`);
    return { touched: false };
  }
  const raw = fs.readFileSync(full, 'utf8');
  const doc = JSON.parse(raw);
  const data = doc.data;

  // Find the items array: supports three known shapes
  let items = null;
  let listPath = null;
  if (Array.isArray(data)) {
    items = data;
  } else if (data && Array.isArray(data.items)) {
    items = data.items; listPath = 'items';
  } else if (data && Array.isArray(data.current)) {
    items = data.current; listPath = 'current';
  }

  if (!items) {
    console.log(`  - ${file}: unrecognised data shape, skipping`);
    return { touched: false };
  }

  let anyChanged = false;
  const newItems = items.map(it => {
    const { item, changed } = migrateItem(it);
    if (changed) anyChanged = true;
    return item;
  });

  if (!anyChanged) {
    console.log(`  = ${file}: no changes`);
    return { touched: false };
  }

  // Attach back
  if (listPath) doc.data = { ...data, [listPath]: newItems };
  else doc.data = newItems;

  const out = JSON.stringify(doc, null, 2) + '\n';
  if (DRY_RUN) {
    console.log(`  ~ ${file}: WOULD update ${newItems.length} items (dry-run)`);
    return { touched: true, dryRun: true };
  }
  const backup = path.join(TARGET, `${file}.pre-d-${timestamp}.bak`);
  fs.writeFileSync(backup, raw);
  fs.writeFileSync(full, out);
  console.log(`  ✓ ${file}: migrated ${newItems.length} items (backup: ${path.basename(backup)})`);
  return { touched: true };
}

console.log(`Migrating schedule vocabulary in ${TARGET}${DRY_RUN ? ' (dry-run)' : ''}`);
let count = 0;
for (const f of FILES_TO_MIGRATE) {
  const r = migrateFile(f);
  if (r.touched) count++;
}
console.log(`\nDone. ${count}/${FILES_TO_MIGRATE.length} file(s) ${DRY_RUN ? 'would change' : 'changed'}.`);
