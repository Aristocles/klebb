// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// health-auto-export/describe.js
//
// Introspects catalogue.js at runtime to produce a human-readable
// summary of supported HAE metrics + the row fields each one emits.
// Consumed by the chat system prompt so the agent writes display
// templates referencing fields the catalogue actually produces, not
// fields it infers from HAE's raw payload schema.
//
// Introspection strategy: pass a probe entry that exposes common HAE
// field names, plus a broad set of numeric + string fallbacks. The
// catalogue's pure row() maps the probe to the output shape; we then
// read the output keys. This is more accurate than parsing source
// code and stays correct as row() evolves.

const catalogue = require('./catalogue');

// A single probe entry that's generous enough to trigger every field
// any current or plausible-future catalogue row() might copy through.
// Values are chosen so numeric() returns a finite number.
function makeProbe() {
  return {
    // Date fields (different catalogue entries pick different ones).
    date:       '2026-01-01 00:00:00 +0000',
    sleepStart: '2026-01-01 00:00:00 +0000',
    start:      '2026-01-01 09:30:00 +0000',
    end:        '2026-01-01 10:00:00 +0000',

    // Numeric generics.
    qty: 1,

    // Sleep-specific fields. The *End/inBed* stamps are here because
    // sleep_analysis reads them for bedTime/wakeTime; omitting one makes the
    // orphan report flag the field it feeds as never-referenced.
    sleepEnd:   '2026-01-01 06:12:00 +0000',
    inBedStart: '2026-01-01 23:40:00 +0000',
    inBedEnd:   '2026-01-01 06:20:00 +0000',
    totalSleep: 7.5,
    asleep:     7.3,
    inBed:      8.1,
    deep:       1.2,
    rem:        1.5,
    core:       4.3,
    awake:      0.3,

    // Workout-specific fields (HAE v2 wraps numerics as {qty, units}).
    duration:           1800,
    distance:           { qty: 2.5, units: 'km' },
    activeEnergyBurned: { qty: 320, units: 'kcal' },
    avgHeartRate:       { qty: 120, units: 'bpm' },
    maxHeartRate:       { qty: 145, units: 'bpm' },
    elevationUp:        { qty: 30,  units: 'm' },

    // Attribution + labels.
    source: 'probe',
    name:   'probe',
  };
}

function describeMetric(key, entry) {
  const probe = makeProbe();
  let row;
  try {
    row = entry.row(probe);
  } catch {
    row = null;
  }

  const from = entry.from || 'metrics';
  if (!row || typeof row !== 'object') {
    return `${key} (from data.${from}): row shape indeterminate`;
  }

  // Partition keys: `date` is always first; everything else alphabetical.
  const keys = Object.keys(row);
  const rest = keys.filter(k => k !== 'date').sort();
  const orderedKeys = ['date', ...rest];

  const fields = orderedKeys.join(', ');
  const source = from === 'workouts'
    ? 'data.workouts[]'
    : `data.metrics[name="${key}"].data[]`;
  const catLabel = entry.category ? `[${entry.category}] ` : '';
  return `${catLabel}${key} (reads ${source}, ${entry.aggregate}): row = { ${fields} }`;
}

// Produces the full catalogue summary block suitable for inclusion in
// a chat system prompt. Returns a single string with a header, a short
// rule, and one line per catalogue metric.
function describeCatalogue() {
  const lines = [];
  lines.push('## Health Auto Export catalogue');
  lines.push('');
  lines.push('When writing a manifest with `meta.ingest.source: "hae"`, the');
  lines.push('`display.template`, `trends.field`, and any other field');
  lines.push('references MUST only use fields from the row shape below.');
  lines.push('Klebb\'s catalogue is the authoritative source of what fields');
  lines.push('end up in `data[]`; do not invent fields from HAE\'s raw');
  lines.push('payload. Optional fields may be absent on any given row.');
  lines.push('');
  lines.push('Display template guidance for HAE-backed cards:');
  lines.push('- Always use `{field:round(N)}` for numeric values. A bare');
  lines.push('  `{hours}` renders as "7.283333333..."; `{hours:round(1)}`');
  lines.push('  renders as "7.3".');
  lines.push('- Set `view.fallbackToLatest: true` for cards that track a');
  lines.push('  slow-changing daily metric (sleep hours, HRV, RHR, weight,');
  lines.push('  body fat). HAE pushes arrive on schedules, so today\'s row');
  lines.push('  often has not landed yet and a per-day card reads as "No');
  lines.push('  data yet" when yesterday\'s value is fine to show.');
  lines.push('- DO NOT set `fallbackToLatest: true` on workout-style cards');
  lines.push('  (workouts, meditation, exercise minutes) where a non-trained');
  lines.push('  day should clearly read as "No workout today", not show the');
  lines.push('  most recent prior session as if it were today\'s. For boolean-');
  lines.push('  shaped cards prefer `{trained:check} {type}` over `{trained}`');
  lines.push('  so a workout day renders ✅ instead of the literal "true".');
  lines.push('- The `workouts` row is a per-day rollup: when several sessions');
  lines.push('  land on the same date, additive fields (durationMin, distanceKm,');
  lines.push('  calories, elevationM) are summed; `type` becomes a comma-');
  lines.push('  separated chronological dedup list; `avgHr` is duration-');
  lines.push('  weighted; `maxHr` is the max; `startTime` is the earliest;');
  lines.push('  `sessionCount` is how many distinct sessions HAE delivered for');
  lines.push('  that day (always >= 1 on a workout day). A richer template like');
  lines.push('  `{trained:check} {type}` headline + `{durationMin} min ·');
  lines.push('  {distanceKm|} km · {calories} cal` secondary will show daily');
  lines.push('  totals on multi-session days. To track distinct activity');
  lines.push('  sessions per week (e.g. a goalWeekly ring counting walks + runs');
  lines.push('  + cycles regardless of duration), use `accessor: "sessionCount"`');
  lines.push('  on a ring-segment that points at the workouts donor.');
  lines.push('');

  const keys = Object.keys(catalogue).sort();
  for (const key of keys) {
    lines.push(`- ${describeMetric(key, catalogue[key])}`);
  }
  return lines.join('\n');
}

module.exports = { describeCatalogue, describeMetric };
