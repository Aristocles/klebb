#!/usr/bin/env node
// scripts/migrate-cards-to-generic.js
//
// Retrofits existing card manifests to use the zero-code generic-card
// renderer. Takes each target card, rewrites meta.view.component,
// meta.view.display, and meta.writeable.inputs based on its ID.
//
// Idempotent: running twice is safe (re-applies the same transformation).
// Preserves: meta.id, meta.label, meta.emoji, meta.order, meta.enabled,
//            meta.trends, meta.reports, meta.calendar, description, data.
//
// Usage:
//   node scripts/migrate-cards-to-generic.js --dir <HEALTH_HOME/data> [--dry-run]
//   node scripts/migrate-cards-to-generic.js --help
//
// Only migrates files whose meta.id matches a RULE below. Unknown ids are
// skipped untouched. To migrate a new card type, add a rule to the RULES
// map and re-run.

const fs = require('fs');
const path = require('path');

// Migration rules keyed by meta.id. Each rule returns a partial meta
// override to merge onto the existing meta (deep-merged for nested keys).
const RULES = {
  weight: {
    view: {
      component: 'generic-card',
      dateContext: 'viewedDate',
      display: {
        template: '{kg:round(1)}',
        unit: 'kg',
        secondary: '{note|}',
        emptyHeadline: 'No weight logged',
        trendArrow: { field: 'kg' },
      },
    },
    writeable: {
      fromWebapp: true,
      todayAllowed: true,
      pastAllowed: true,
      futureAllowed: false,
      maxReadingsPerDay: 1,
      inputs: [
        { key: 'kg',   type: 'number',  label: 'Weight (kg)', min: 0, max: 500, step: 0.1, required: true },
        { key: 'note', type: 'text',    label: 'Note',        placeholder: 'optional' },
      ],
    },
  },
  bp: {
    view: {
      component: 'generic-card',
      dateContext: 'viewedDate',
      display: {
        template: '{systolic}/{diastolic}',
        unit: 'mmHg',
        secondary: '{notes|}',
        emptyHeadline: 'No BP logged',
        thresholds: [
          { ifField: 'systolic', max: 119, colour: '#44ff88', label: 'Optimal' },
          { ifField: 'systolic', max: 129, colour: '#aaaa44', label: 'Elevated' },
          { ifField: 'systolic', max: 139, colour: '#ff7733', label: 'Stage 1' },
          { ifField: 'systolic', max: 999, colour: '#ff3333', label: 'Stage 2' },
        ],
      },
    },
    writeable: {
      fromWebapp: true,
      todayAllowed: true,
      pastAllowed: true,
      futureAllowed: false,
      maxReadingsPerDay: 3,
      inputs: [
        { key: 'systolic',  type: 'number', label: 'Systolic (top)',    min: 50, max: 250, step: 1, required: true },
        { key: 'diastolic', type: 'number', label: 'Diastolic (bottom)', min: 30, max: 200, step: 1, required: true },
        { key: 'hr',        type: 'number', label: 'Heart rate (bpm)',   min: 30, max: 220, step: 1 },
        { key: 'notes',     type: 'text',   label: 'Notes',              placeholder: 'optional' },
      ],
    },
  },
  mood: {
    view: {
      component: 'generic-card',
      dateContext: 'viewedDate',
      display: {
        template: '{mood:emoji}',
        secondary: '{wakeUps|0} wake-ups · {notes|}',
        emptyHeadline: 'How are you feeling?',
        emojiMap: {
          mood: { '1': '😩', '2': '😴', '3': '😐', '4': '🙂', '5': '😄' },
        },
      },
    },
    writeable: {
      fromWebapp: true,
      todayAllowed: true,
      pastAllowed: true,
      futureAllowed: false,
      maxReadingsPerDay: 1,
      inputs: [
        {
          key: 'mood',
          type: 'emoji-picker',
          label: 'Mood',
          emojis: ['😩', '😴', '😐', '🙂', '😄'],
          emitIndex: true,
          required: true,
          autoSubmit: true,
        },
        { key: 'wakeUps', type: 'stepper',  label: 'Wake-ups', min: 0, max: 20, default: 0 },
        { key: 'notes',   type: 'textarea', label: 'Notes',    rows: 2, placeholder: 'optional' },
      ],
    },
  },
  notes: {
    view: {
      component: 'generic-card',
      dateContext: 'viewedDate',
      display: {
        template: '{note:truncate(80)|(no note today)}',
        emptyHeadline: 'No note today',
      },
    },
    writeable: {
      fromWebapp: true,
      todayAllowed: true,
      pastAllowed: true,
      futureAllowed: true,
      maxReadingsPerDay: 1,
      inputs: [
        { key: 'note', type: 'textarea', label: 'Note', rows: 4, placeholder: 'How was the day?' },
      ],
    },
  },
};

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
  console.log(`Usage: migrate-cards-to-generic.js --dir <data-dir> [--dry-run]

Rewrites card manifests in <data-dir> to use the generic-card renderer.
Only files whose meta.id matches a known rule are touched. Unknown ids
are left untouched.

Known ids: ${Object.keys(RULES).join(', ')}

Options:
  --dir <path>   Directory to scan (required; typically $HEALTH_HOME/data)
  --dry-run      Report what would change without writing
  --help         Show this message`);
}

// Deep-merge source onto target. Arrays in source REPLACE arrays in target
// (intentional — we want the rule's inputs to replace existing inputs).
function deepMerge(target, source) {
  if (source === null || typeof source !== 'object') return source;
  if (Array.isArray(source)) return source;
  const out = { ...(target && typeof target === 'object' && !Array.isArray(target) ? target : {}) };
  for (const [key, val] of Object.entries(source)) {
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      out[key] = deepMerge(out[key], val);
    } else {
      out[key] = val;
    }
  }
  return out;
}

function scanDir(dir) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const ent of entries) {
    if (ent.isDirectory()) continue; // don't recurse — card files live at top
    if (!ent.name.endsWith('.json')) continue;
    out.push(path.join(dir, ent.name));
  }
  return out;
}

function migrateFile(file, { dryRun }) {
  let raw, parsed;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return { file, status: 'skipped', reason: 'unreadable' }; }
  try { parsed = JSON.parse(raw); } catch { return { file, status: 'skipped', reason: 'invalid JSON' }; }
  if (!parsed || typeof parsed !== 'object') return { file, status: 'skipped', reason: 'not a manifest' };
  if (parsed.$schema !== 'klebb.datafile.v1') return { file, status: 'skipped', reason: `schema ${parsed.$schema || '<none>'}` };
  const meta = parsed.meta;
  if (!meta || !meta.id) return { file, status: 'skipped', reason: 'no meta.id' };
  const rule = RULES[meta.id];
  if (!rule) return { file, status: 'skipped', reason: `no rule for id "${meta.id}"` };

  // Apply rule via deep merge
  const newMeta = deepMerge(meta, rule);

  // Idempotency check: if already equal, no-op
  if (JSON.stringify(newMeta) === JSON.stringify(meta)) {
    return { file, status: 'already-migrated' };
  }

  const updated = { ...parsed, meta: newMeta };
  if (dryRun) return { file, status: 'would-migrate' };
  const tmp = file + '.klebb-tmp';
  fs.writeFileSync(tmp, JSON.stringify(updated, null, 2));
  fs.renameSync(tmp, file);
  return { file, status: 'migrated' };
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
    for (const r of actioned) console.log(`  ${r.status === 'migrated' ? '✓' : '→'} ${path.relative(dir, r.file)}`);
  }
  return 0;
}

process.exit(main());
