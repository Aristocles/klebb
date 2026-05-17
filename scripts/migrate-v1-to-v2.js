#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// scripts/migrate-v1-to-v2.js
// Converts existing legacy data files in $HEALTH_HOME/data/ into v2 manifest shape.
//
// Safe: originals move to $HEALTH_HOME/data/_archive/migration-YYYY-MM-DD/ before
// the new files are written in place. The script is idempotent — running it
// again is a no-op if every file already has $schema.
//
// Usage:
//   node scripts/migrate-v1-to-v2.js              # dry-run by default
//   node scripts/migrate-v1-to-v2.js --apply      # actually make changes
//   node scripts/migrate-v1-to-v2.js --apply --force   # re-migrate everything

const fs = require('fs');
const path = require('path');
const PATHS = require('../config/paths');

const APPLY = process.argv.includes('--apply');
const FORCE = process.argv.includes('--force');

const DATA_DIR = PATHS.DATA_DIR;
const TODAY = new Date().toISOString().slice(0, 10);
const ARCHIVE_DIR = path.join(DATA_DIR, '_archive', `migration-${TODAY}`);

function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

function writeJSON(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function moveToArchive(file) {
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  const base = path.basename(file);
  fs.renameSync(file, path.join(ARCHIVE_DIR, base));
}

function alreadyMigrated(data) {
  return data && typeof data === 'object' && data.$schema === 'klebb.datafile.v1';
}

// Transformer registry: filename -> function(legacyData) -> manifest
const TRANSFORMS = {
  'weight.json': (d) => ({
    $schema: 'klebb.datafile.v1',
    meta: {
      id: 'weight',
      label: 'Weight',
      emoji: '⚖️',
      category: 'vitals',
      order: 20,
      view: {
        enabled: true,
        component: 'generic-card',
        fallbackToLatest: true,
        display: {
          primary: 'latest.kg',
          unit: 'kg',
          subtitle: 'Logged {date}',
        },
      },
      trends: {
        enabled: true,
        component: 'line-chart',
        title: 'Weight over time',
        xAxis: 'date',
        series: [{ field: 'kg', label: 'kg' }],
        yAxisLabel: 'kg',
      },
      writeable: { fromWebapp: true, pastAllowed: true, todayAllowed: true, futureAllowed: false },
    },
    description: "Body weight log. Append entries as { date: 'YYYY-MM-DD', kg: number, source?: string, note?: string }. Keep chronological.",
    data: Array.isArray(d) ? d : [],
  }),

  'mood.json': (d) => ({
    $schema: 'klebb.datafile.v1',
    meta: {
      id: 'mood',
      label: 'Mood',
      emoji: '🙂',
      order: 60,
      view: { enabled: true, component: 'generic-card' },
      calendar: { enabled: true, component: 'day-marker', marker: '🙂' },
      writeable: { fromWebapp: true, pastAllowed: true, todayAllowed: true, futureAllowed: false },
    },
    description: "Daily mood check-ins. Object keyed by date: { 'YYYY-MM-DD': { mood: 1-5 | string, notes?, wakeUps?, time: ISO } }.",
    data: (d && typeof d === 'object' && !Array.isArray(d)) ? d : {},
  }),

  'appointments.json': (d) => ({
    $schema: 'klebb.datafile.v1',
    meta: {
      id: 'appointments',
      label: 'Appointments',
      emoji: '🗓️',
      order: 70,
      view: { enabled: true, component: 'list-card' },
      calendar: { enabled: true, component: 'day-marker', marker: '🗓️' },
      writeable: { fromWebapp: true, pastAllowed: true, todayAllowed: true, futureAllowed: true },
    },
    description: "Medical/health appointments. Array of { date, type, location, status, followUp, note }.",
    data: Array.isArray(d) ? d : [],
  }),

  'bloods.json': (d) => ({
    $schema: 'klebb.datafile.v1',
    meta: {
      id: 'bloods',
      label: 'Blood Tests',
      emoji: '🩸',
      order: 75,
      reports: { enabled: true, component: 'table-list' },
      calendar: { enabled: true, component: 'day-marker', marker: '🩸' },
      writeable: { fromWebapp: false },
    },
    description: "Blood test records. Array of panels with date, tests[], results{}, flags[], and optional report reference.",
    data: Array.isArray(d) ? d : [],
  }),

  'goals.json': (d) => ({
    $schema: 'klebb.datafile.v1',
    meta: {
      id: 'goals',
      label: 'Goals',
      emoji: '🎯',
      order: 65,
      view: { enabled: true, component: 'progress-bars-card', fallbackToLatest: true },
      writeable: { fromWebapp: false },
    },
    description: 'Active goals. Array of { id, description, metric, target, unit, startDate, startValue, status }.',
    data: Array.isArray(d) ? d : [],
  }),

  'supplements.json': (d) => ({
    $schema: 'klebb.datafile.v1',
    meta: {
      id: 'supplements',
      label: 'Supplements',
      emoji: '💊',
      order: 45,
      view: { enabled: true, component: 'checklist-card' },
      writeable: { fromWebapp: true, pastAllowed: true, todayAllowed: true, futureAllowed: false },
    },
    description: 'Supplements catalog. Shape { current: [...], past: [...] } with per-item name, dose, frequency, timing, startDate, notes.',
    data: (d && typeof d === 'object' && !Array.isArray(d)) ? d : { current: [], past: [] },
  }),

  'symptoms.json': (d) => ({
    $schema: 'klebb.datafile.v1',
    meta: {
      id: 'symptoms',
      label: 'Symptoms',
      emoji: '🩹',
      order: 85,
      view: { enabled: true, component: 'list-card', fallbackToLatest: true },
      writeable: { fromWebapp: false },
    },
    description: 'Ongoing symptom log. Array of { date, area, severity, notes }.',
    data: Array.isArray(d) ? d : [],
  }),

  'notes.json': (d) => ({
    $schema: 'klebb.datafile.v1',
    meta: {
      id: 'ad-hoc-notes',
      label: 'Notes archive',
      emoji: '📝',
      order: 90,
      reports: { enabled: true, component: 'table-list' },
      writeable: { fromWebapp: false },
    },
    description: 'Ad-hoc tagged notes from various points in time. Array of { date, note, tags[] }.',
    data: Array.isArray(d) ? d : [],
  }),

  'daily-notes.json': (d) => ({
    $schema: 'klebb.datafile.v1',
    meta: {
      id: 'notes',
      label: 'Daily notes',
      emoji: '📝',
      order: 80,
      view: { enabled: true, component: 'generic-card' },
      writeable: { fromWebapp: true, pastAllowed: true, todayAllowed: true, futureAllowed: true },
    },
    description: "Freeform notes keyed by date. { 'YYYY-MM-DD': { text, updated } } — past/today/future writeable.",
    data: (d && typeof d === 'object' && !Array.isArray(d)) ? d : {},
  }),

  'exercise-manual.json': (d) => ({
    $schema: 'klebb.datafile.v1',
    meta: {
      id: 'exercise-manual',
      label: 'Manual workouts',
      emoji: '🏋️',
      order: 55,
      writeable: { fromWebapp: true, pastAllowed: true, todayAllowed: true, futureAllowed: false },
    },
    description: 'Manually-entered workout log (for workouts not captured by auto-export). Array of entries.',
    data: Array.isArray(d) ? d : [],
  }),

  'peptides.json': (d) => {
    // Merge injection-log.json into each item's doses[] (Option C: self-contained)
    const injectionLogPath = path.join(DATA_DIR, 'injection-log.json');
    let log = {};
    try { log = JSON.parse(fs.readFileSync(injectionLogPath, 'utf8')) || {}; } catch {}

    const items = (d && Array.isArray(d.peptides)) ? d.peptides.map(p => {
      // Build doses[] from the log (keyed by date + peptide name)
      const doses = [];
      for (const [date, entries] of Object.entries(log)) {
        const hit = entries && entries[p.name];
        if (hit && hit.taken) {
          doses.push({ scheduledDate: date, takenAt: hit.time || null });
        }
      }
      doses.sort((a, b) => (a.scheduledDate || '').localeCompare(b.scheduledDate || ''));

      // Preserve original shape but move cycle[] up to the standard field name + add doses[]
      return { ...p, doses };
    }) : [];

    const groups = (d && Array.isArray(d.injection_groups)) ? d.injection_groups.map(g => ({
      id: (g.name || 'group').toLowerCase().replace(/\s+/g, '-'),
      label: g.name,
      timing: g.timing,
      items: g.peptides || [],
      draw_order: g.draw_order,
      max_units: g.max_units,
      notes: g.notes,
    })) : [];

    return {
      $schema: 'klebb.datafile.v1',
      meta: {
        id: 'peptides',
        label: 'Schedule',
        emoji: '💉',
        category: 'health',
        order: 40,
        view: {
          enabled: true,
          component: 'schedule-card',
        },
        trends: {
          enabled: true,
          component: 'schedule-timeline',
          groupBy: 'groups',
          itemsPath: 'items',
        },
        reports: {
          enabled: true,
          component: 'adherence-report',
          showCompliance: true,
          showInventory: true,
        },
        calendar: { enabled: true, component: 'day-marker', marker: '💉' },
        writeable: { fromWebapp: true, pastAllowed: true, todayAllowed: true, futureAllowed: false },
      },
      description: [
        "Scheduled items (injectable or other consumables) with groups, cycles, and dose log.",
        "items[]: each has name, schedule, cycles, doses[]. Append to doses[] as { scheduledDate, takenAt } when logged.",
        "groups[]: id, label, items[] (names). Used by schedule-timeline to stack related items visually.",
      ].join('\n'),
      data: {
        items,
        groups,
        general_notes: d && d.general_notes,
      },
    };
  },
};

function migrateFile(filename) {
  const src = path.join(DATA_DIR, filename);
  if (!fs.existsSync(src)) return { skipped: 'not present' };
  const legacy = readJSON(src);
  if (legacy === null) return { skipped: 'unreadable' };
  if (alreadyMigrated(legacy) && !FORCE) return { skipped: 'already v2' };

  const fn = TRANSFORMS[filename];
  if (!fn) return { skipped: 'no transform' };

  const manifest = fn(legacy);
  if (!APPLY) {
    return { planned: true, dataPreview: summarise(manifest.data) };
  }

  // Archive original, write new in place
  moveToArchive(src);
  writeJSON(src, manifest);
  return { migrated: true, dataPreview: summarise(manifest.data) };
}

function summarise(data) {
  if (Array.isArray(data)) return `array[${data.length}]`;
  if (data && typeof data === 'object') {
    if (Array.isArray(data.items)) return `items[${data.items.length}], groups[${(data.groups||[]).length}]`;
    return `object{${Object.keys(data).length}}`;
  }
  return typeof data;
}

function main() {
  if (!fs.existsSync(DATA_DIR)) {
    console.error(`DATA_DIR does not exist: ${DATA_DIR}`);
    process.exit(1);
  }

  if (!APPLY) {
    console.log('*** DRY RUN *** (re-run with --apply to execute)');
    console.log('');
  } else {
    console.log(`Archiving to: ${ARCHIVE_DIR}`);
    console.log('');
  }

  const files = Object.keys(TRANSFORMS);
  // peptides must go last because it reads injection-log.json
  files.sort((a, b) => (a === 'peptides.json' ? 1 : 0) - (b === 'peptides.json' ? 1 : 0));

  const results = {};
  for (const f of files) {
    results[f] = migrateFile(f);
  }

  // Handle injection-log.json: after peptides migration, it's now empty-of-meaning
  // (doses merged into peptides.doses[]). Archive it too.
  if (APPLY) {
    const log = path.join(DATA_DIR, 'injection-log.json');
    if (fs.existsSync(log)) {
      try {
        moveToArchive(log);
        results['injection-log.json'] = { migrated: true, dataPreview: 'merged into peptides.doses[]' };
      } catch (e) {
        results['injection-log.json'] = { error: e.message };
      }
    }
  } else {
    results['injection-log.json'] = { planned: true, dataPreview: 'will merge into peptides.doses[] and archive' };
  }

  // Pretty print
  console.log(`${'File'.padEnd(28)} ${'Status'.padEnd(18)} Data`);
  console.log(`${'-'.repeat(28)} ${'-'.repeat(18)} ${'-'.repeat(40)}`);
  for (const [f, r] of Object.entries(results)) {
    const status =
      r.migrated ? '✓ migrated' :
      r.planned ? '→ plan' :
      r.skipped ? `skip (${r.skipped})` :
      r.error ? `ERROR: ${r.error}` : '?';
    console.log(`${f.padEnd(28)} ${status.padEnd(18)} ${r.dataPreview || ''}`);
  }

  console.log('');
  if (!APPLY) {
    console.log('Re-run with --apply to execute.');
  } else {
    console.log(`Done. Originals archived at: ${ARCHIVE_DIR}`);
  }
}

main();
