#!/usr/bin/env node
// scripts/migrate-chuck-md-to-json.js
// One-shot migration of Chuck's markdown-based health files into v2
// manifest JSON files for his eddzhealth instance.
//
// Source: /home/minecraft/onyx/workspace/health/
// Target: $HEALTH_HOME/data/
//
// The transformation is explicit (not regex-parsing free-prose markdown).
// Chuck's current content is transcribed here once. Going forward, Onyx
// writes to $HEALTH_HOME/data/*.json directly via the chuck-health-webapp-chat
// skill (see /home/minecraft/onyx/workspace/skills/chuck-health-webapp-chat/
// SKILL.md after M10).
//
// Usage:
//   node scripts/migrate-chuck-md-to-json.js                # dry-run
//   node scripts/migrate-chuck-md-to-json.js --apply        # execute
//   node scripts/migrate-chuck-md-to-json.js --apply --force
//
// Source files (reference; not parsed):
//   peptides.md  — schedule items
//   blood-pressure.md — BP readings
//   supplements.md    — empty template, currently
//   vitals.md         — BP + HR readings (manual)
//   bloods/2026-03-26.md — blood panel report (goes to reports/, not data/)
//   dna/genome-report.md, parsed-snps.json — reports/ + data/snps.json

const fs = require('fs');
const path = require('path');
const PATHS = require('../config/paths');

const APPLY = process.argv.includes('--apply');
const FORCE = process.argv.includes('--force');

const DATA_DIR = PATHS.DATA_DIR;
const REPORTS_DIR = path.join(PATHS.HEALTH_HOME, 'reports');
const ARCHIVE_DIR = path.join(DATA_DIR, '_archive', `chuck-md-${new Date().toISOString().slice(0, 10)}`);

const CHUCK_SOURCE = '/home/minecraft/onyx/workspace/health';

function writeJSON(file, data) {
  const tmp = file + '.tmp';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function skipIfExists(file) {
  return fs.existsSync(file) && !FORCE;
}

// --- Peptides / scheduled protocols ---

function buildPeptidesManifest() {
  const items = [
    {
      name: 'Retatrutide',
      short_name: 'Reta',
      category: 'metabolic',
      vial_mg: 15,
      dose_mg: 3,
      dose_units: 40,
      reconstitution_ml: 2,
      concentration_mg_ml: 7.5,
      route: 'subQ',
      timing: 'weekly',
      schedule: {
        frequency: 'weekly',
        dayOfWeek: 'saturday',
      },
      cycles: [
        { type: 'on', start: '2026-03-04' } // ongoing
      ],
      doses: [
        { scheduledDate: '2026-04-05', takenAt: '2026-04-05T00:00:00+10:00' },
      ],
      inventory: { vials_ordered: 1, vials_remaining: 1 },
      notes: 'Titration schedule TBD. No defined cycle end. Most recent dose 5 April 2026.',
    },
    // GLOW stack is a single blended injection; represent as three items sharing the on_off schedule
    {
      name: 'BPC-157',
      category: 'repair',
      vial_mg: 10,
      dose_mg: 0.5,
      dose_units: 15,
      reconstitution_ml: 1,
      concentration_mg_ml: 10,
      route: 'subQ',
      schedule: {
        frequency: 'on_off',
        on_days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
        off_days: ['Sat', 'Sun'],
      },
      cycles: [
        { type: 'on', start: '2026-02-18', end: '2026-05-13' },
      ],
      doses: [],
      notes: 'Part of GLOW blend (with TB-500 + GHK-Cu), 0.15ml injected.',
    },
    {
      name: 'TB-500',
      category: 'repair',
      vial_mg: 10,
      dose_mg: 0.5,
      dose_units: 15,
      reconstitution_ml: 1,
      concentration_mg_ml: 10,
      route: 'subQ',
      schedule: {
        frequency: 'on_off',
        on_days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
        off_days: ['Sat', 'Sun'],
      },
      cycles: [
        { type: 'on', start: '2026-02-18', end: '2026-05-13' },
      ],
      doses: [],
      notes: 'Part of GLOW blend.',
    },
    {
      name: 'GHK-Cu',
      category: 'repair',
      vial_mg: 10,
      dose_mg: 0.5,
      dose_units: 15,
      reconstitution_ml: 1,
      concentration_mg_ml: 10,
      route: 'subQ',
      schedule: {
        frequency: 'on_off',
        on_days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
        off_days: ['Sat', 'Sun'],
      },
      cycles: [
        { type: 'on', start: '2026-02-18', end: '2026-05-13' },
      ],
      doses: [],
      notes: 'Part of GLOW blend.',
    },
    {
      name: 'Tesamorelin',
      short_name: 'Tesa',
      category: 'gh',
      vial_mg: 10,
      dose_mg: 1,
      dose_units: 20,
      reconstitution_ml: 2,
      concentration_mg_ml: 5,
      route: 'subQ',
      timing: 'before bed',
      schedule: {
        frequency: 'on_off',
        on_days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
        off_days: ['Sat', 'Sun'],
      },
      cycles: [
        { type: 'on', start: '2026-04-01', end: '2026-06-24' },
      ],
      doses: [],
      notes: 'GHRH. Pairs with Ipamorelin (GHRP) for synergistic GH release.',
    },
    {
      name: 'Epithalon',
      category: 'longevity',
      dose_mg: 5,
      dose_units: 25,
      route: 'subQ',
      schedule: {
        frequency: 'daily',
      },
      cycles: [
        { type: 'on', start: '2026-03-26', end: '2026-04-14' },
      ],
      doses: [],
      notes: 'Longer than standard 10-day Khavinson protocol (20 days). Off period TBD.',
    },
    {
      name: 'Ipamorelin',
      short_name: 'Ipa',
      category: 'gh',
      vial_mg: 10,
      dose_mg: 0.25,
      dose_units: 20,
      reconstitution_ml: 4,
      concentration_mg_ml: 2.5,
      route: 'subQ',
      timing: 'before bed, empty stomach',
      schedule: {
        frequency: 'on_off',
        on_days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
        off_days: ['Sat', 'Sun'],
      },
      cycles: [
        { type: 'on', start: '2026-04-07', end: '2026-06-24' },
      ],
      doses: [],
      inventory: { vials_needed: 1, vials_recommended: 2 },
      notes: 'GHRP — pairs with Tesa (GHRH). Minimal cortisol/prolactin impact vs other GHRPs.',
    },
    {
      name: 'NAD+',
      category: 'metabolic',
      vial_mg: 1000,
      dose_mg: 500,
      dose_units: 20,
      reconstitution_ml: 2,
      concentration_mg_ml: 500,
      route: 'subQ',
      schedule: {
        frequency: 'on_off',
        on_days: ['Mon', 'Wed', 'Fri'],
        off_days: ['Tue', 'Thu', 'Sat', 'Sun'],
      },
      cycles: [
        { type: 'on', start: '2026-04-01', end: '2026-06-01' },
        { type: 'off', start: '2026-06-02', end: '2026-08-01' },
      ],
      doses: [],
      notes: '2 months on, 2 months off. +10 units sodium bicarbonate to buffer sting.',
    },
    {
      name: 'MOTS-c',
      category: 'mitochondrial',
      vial_mg: 40,
      dose_mg: 3.25,
      dose_units: 29,
      reconstitution_ml: 3.5,
      concentration_mg_ml: 11.43,
      route: 'subQ',
      timing: '5:10am fasted, before exercise',
      schedule: {
        frequency: 'on_off',
        on_days: ['Mon', 'Wed', 'Fri'],
        off_days: ['Tue', 'Thu', 'Sat', 'Sun'],
      },
      cycles: [
        { type: 'on', start: '2026-04-13' },
      ],
      doses: [],
      notes: 'Mitochondrial. Take fasted for best efficacy. Watch glucose (already on Reta).',
    },
  ];

  const groups = [
    { id: 'glow-stack',    label: 'GLOW Stack (blended)',    items: ['BPC-157', 'TB-500', 'GHK-Cu'], notes: 'Single 0.15ml subQ injection; 3 peptides pre-blended in one vial set.' },
    { id: 'gh-stack',      label: 'GH Stack (bedtime)',       items: ['Tesamorelin', 'Ipamorelin'], notes: 'GHRH + GHRP synergistic. Empty stomach.' },
    { id: 'weekly',        label: 'Weekly (Saturdays)',       items: ['Retatrutide'] },
    { id: 'daily',         label: 'Daily',                     items: ['Epithalon'] },
    { id: 'mwf',           label: 'Mon/Wed/Fri',               items: ['NAD+', 'MOTS-c'] },
  ];

  return {
    $schema: 'eddzhealth.datafile.v1',
    meta: {
      id: 'peptides',
      label: 'Schedule',
      emoji: '💉',
      category: 'health',
      order: 40,
      view: {
        enabled: true,
        component: 'checklist-card',
        dateContext: 'exact-date',
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
      writeable: {
        fromWebapp: true,
        pastAllowed: true,
        todayAllowed: true,
        futureAllowed: false,
      },
    },
    description: [
      'Scheduled items (injectable or other consumables) with groups, cycles, and dose log.',
      'items[]: each has name, schedule, cycles, doses[]. To log a dose, append to the item\'s doses[] as { scheduledDate, takenAt }.',
      'groups[]: { id, label, items[] (names) }. Groups display stacks together in the schedule-timeline and checklist UIs.',
      'Editing rules: append-only for doses; replace entire items[] entries when schedule changes materially (cycle end, dose change). Keep existing dose history intact.',
    ].join('\n'),
    data: { items, groups },
  };
}

// --- Blood pressure (manual log) ---

function buildBPManifest() {
  // From vitals.md + blood-pressure.md
  const entries = [
    { date: '2026-04-02', time: null,        systolic: 105, diastolic: 68, hr: null, notes: 'Reported via Signal' },
    { date: '2026-04-04', time: 'morning',   systolic: 109, diastolic: 81, hr: null, notes: 'First tracked reading' },
    { date: '2026-04-06', time: 'afternoon', systolic: 119, diastolic: 78, hr: null, notes: 'Via Signal' },
    { date: '2026-04-14', time: 'morning',   systolic: 123, diastolic: 82, hr: null, notes: '' },
  ];
  return {
    $schema: 'eddzhealth.datafile.v1',
    meta: {
      id: 'bp',
      label: 'Blood Pressure',
      emoji: '💓',
      category: 'vitals',
      order: 30,
      view: {
        enabled: true,
        component: 'metric-card',
        dateContext: 'latest',
        display: {
          primary: 'latest.systolic',
          secondary: 'latest.diastolic',
          format: '{systolic}/{diastolic}',
          unit: 'mmHg',
          subtitle: 'Logged {date}',
          thresholds: [
            { max: 120, colour: '#44ff88', label: 'Optimal' },
            { max: 130, colour: '#ffaa00', label: 'Elevated' },
            { max: 180, colour: '#ff4444', label: 'High' },
          ],
        },
      },
      trends: {
        enabled: true,
        component: 'line-chart',
        title: 'Blood pressure',
        xAxis: 'date',
        series: [
          { field: 'systolic',  label: 'Systolic' },
          { field: 'diastolic', label: 'Diastolic' },
        ],
        yAxisLabel: 'mmHg',
      },
      calendar: { enabled: true, component: 'day-marker', marker: '💓' },
      writeable: {
        fromWebapp: true,
        pastAllowed: true,
        todayAllowed: true,
        futureAllowed: false,
      },
    },
    description: 'Blood pressure log. Append entries as { date: "YYYY-MM-DD", time?, systolic: number, diastolic: number, hr?: number, notes?: string }. Append-only — do not modify existing entries.',
    data: entries,
  };
}

// --- Supplements (empty for now; placeholder shell) ---

function buildSupplementsManifest() {
  return {
    $schema: 'eddzhealth.datafile.v1',
    meta: {
      id: 'supplements',
      label: 'Supplements',
      emoji: '💊',
      category: 'health',
      order: 45,
      view: { enabled: true, component: 'checklist-card', dateContext: 'exact-date' },
      writeable: { fromWebapp: true, pastAllowed: true, todayAllowed: true, futureAllowed: false },
    },
    description: 'Supplements list. Structure: { current: [{ name, dose, frequency, timing, startDate, notes }], past: [] }. Chuck has not supplied supplements yet (original source file was a template).',
    data: { current: [], past: [] },
  };
}

// --- Notes (bootstrap empty) ---

function buildNotesManifest() {
  return {
    $schema: 'eddzhealth.datafile.v1',
    meta: {
      id: 'notes',
      label: 'Daily notes',
      emoji: '📝',
      order: 80,
      view: { enabled: true, component: 'notes-card', dateContext: 'exact-date' },
      writeable: { fromWebapp: true, pastAllowed: true, todayAllowed: true, futureAllowed: true },
    },
    description: "Freeform notes keyed by date. Shape: { 'YYYY-MM-DD': { text, updated } }. Past/today/future all writeable.",
    data: {},
  };
}

// --- Greeting banner (seeded with the 100-message set) ---

function buildGreetingManifest() {
  const msgFile = path.join(__dirname, '..', 'data.example', 'greeting-messages.json');
  let msgs = [];
  try { msgs = JSON.parse(fs.readFileSync(msgFile, 'utf8')); } catch {}
  return {
    $schema: 'eddzhealth.datafile.v1',
    meta: {
      id: 'greeting',
      label: 'Greeting',
      order: 1,
      view: { enabled: true, component: 'greeting-banner', slot: 'top' },
    },
    description: "Rotating daily greeting. Each day the top message is shown and rotated to the end of the array.",
    data: msgs,
  };
}

// --- Mood (bootstrap empty; disabled by default for Chuck — no file = no card) ---
// Not created in this migration (Chuck opted out per design discussion).

// --- SNPs (reports-only card + file for Onyx/Chuck to reference) ---

function buildSNPsManifest() {
  const src = path.join(CHUCK_SOURCE, 'dna', 'parsed-snps.json');
  let snps = null;
  try { snps = JSON.parse(fs.readFileSync(src, 'utf8')); } catch {}
  if (!snps) return null;
  return {
    $schema: 'eddzhealth.datafile.v1',
    meta: {
      id: 'snps',
      label: 'Genetic markers',
      emoji: '🧬',
      reports: { enabled: true, component: 'table-list' },
      writeable: { fromWebapp: false },
    },
    description: 'Parsed SNPs of interest from 23andMe-style genome report. Read-only from the webapp.',
    data: snps,
  };
}

// --- Reports: copy markdown files over ---

function copyReportsFromChuck() {
  const results = [];
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const bloodsDir = path.join(CHUCK_SOURCE, 'bloods');
  if (fs.existsSync(bloodsDir)) {
    for (const f of fs.readdirSync(bloodsDir)) {
      if (!f.endsWith('.md')) continue;
      const src = path.join(bloodsDir, f);
      const dst = path.join(REPORTS_DIR, `bloods-${f}`);
      if (skipIfExists(dst)) { results.push({ file: f, skipped: 'exists' }); continue; }
      if (APPLY) fs.copyFileSync(src, dst);
      results.push({ file: f, copied: dst });
    }
  }
  const dnaReport = path.join(CHUCK_SOURCE, 'dna', 'genome-report.md');
  if (fs.existsSync(dnaReport)) {
    const dst = path.join(REPORTS_DIR, 'genome-report.md');
    if (!skipIfExists(dst)) {
      if (APPLY) fs.copyFileSync(dnaReport, dst);
      results.push({ file: 'dna/genome-report.md', copied: dst });
    } else {
      results.push({ file: 'dna/genome-report.md', skipped: 'exists' });
    }
  }
  return results;
}

// --- Driver ---

function writeIfAbsent(relPath, builderFn) {
  const file = path.join(DATA_DIR, relPath);
  if (skipIfExists(file)) return { file: relPath, skipped: 'exists' };
  const manifest = builderFn();
  if (manifest === null) return { file: relPath, skipped: 'source missing' };
  if (!APPLY) return { file: relPath, planned: true };
  writeJSON(file, manifest);
  return { file: relPath, written: true };
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
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
    console.log(`Target: ${DATA_DIR}`);
    console.log(`Reports: ${REPORTS_DIR}`);
    console.log('');
  }

  const results = [];
  results.push(writeIfAbsent('greeting.json', buildGreetingManifest));
  results.push(writeIfAbsent('notes.json', buildNotesManifest));
  results.push(writeIfAbsent('bp.json', buildBPManifest));
  results.push(writeIfAbsent('supplements.json', buildSupplementsManifest));
  results.push(writeIfAbsent('peptides.json', buildPeptidesManifest));
  const snp = buildSNPsManifest();
  if (snp) results.push(writeIfAbsent('snps.json', () => snp));

  const reportResults = copyReportsFromChuck();

  console.log(`${'File'.padEnd(24)} ${'Status'.padEnd(12)}`);
  console.log(`${'-'.repeat(24)} ${'-'.repeat(12)}`);
  for (const r of results) {
    const s = r.written ? '✓ written' : r.planned ? '→ plan' : r.skipped ? `skip (${r.skipped})` : '?';
    console.log(`${r.file.padEnd(24)} ${s}`);
  }
  console.log('');
  console.log(`${'Report'.padEnd(40)} ${'Status'.padEnd(16)}`);
  console.log(`${'-'.repeat(40)} ${'-'.repeat(16)}`);
  for (const r of reportResults) {
    const s = r.copied ? `→ ${path.basename(r.copied)}` : r.skipped ? `skip (${r.skipped})` : '?';
    console.log(`${r.file.padEnd(40)} ${s}`);
  }

  console.log('');
  if (!APPLY) {
    console.log('Re-run with --apply to execute.');
  } else {
    console.log(`Done. Chuck's v2 manifests are in ${DATA_DIR}.`);
    console.log('Reports copied to', REPORTS_DIR);
  }
}

main();
