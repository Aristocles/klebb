// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// health-auto-export/ingest.js
// Parses iPhone Health Auto Export webhook payloads and upserts into
// atomic klebb manifests.
//
// Payload shape (from the HAE app's "REST API" automation):
//
//   {
//     "data": {
//       "metrics":  [ { "name": "<metric>", "data": [ { date, qty, ... } ] }, ... ],
//       "workouts": [ { "name", "start", "end", "duration", ... } ]
//     }
//   }
//
// Metrics the MVP cares about:
//   sleep_analysis        -> sleep-hours  { date, hours }
//   step_count            -> steps        { date, count }
//   apple_exercise_time   -> active-minutes { date, minutes }
//
// Workouts array -> workouts { date, trained: true, type }
//
// Everything else in the payload is ignored but archived verbatim by the
// caller; future follow-ups can add richer manifests without re-writing
// the webhook plumbing.

// --- Date helpers ---

// HAE stamps dates like "2026-05-04 14:23:00 +1000". We only need the
// calendar date for row keying; the timezone suffix is advisory.
function toDate(stamp) {
  if (!stamp || typeof stamp !== 'string') return null;
  const m = stamp.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

// --- Pure parser: payload -> { sleepRows, stepsRows, activeMinutesRows, workoutsRows } ---

function parseHAEPayload(payload) {
  const out = {
    sleepRows: [],          // [{ date, hours, source? }]
    stepsRows: [],          // [{ date, count }]
    activeMinutesRows: [],  // [{ date, minutes }]
    workoutsRows: [],       // [{ date, trained, type? }]
  };

  const data = payload?.data || payload || {};
  const metrics = Array.isArray(data.metrics) ? data.metrics : [];

  // Group metrics by name for targeted extraction.
  const byName = {};
  for (const m of metrics) {
    if (m && typeof m.name === 'string' && Array.isArray(m.data)) {
      byName[m.name] = m.data;
    }
  }

  // Sleep: HAE's sleep_analysis rows carry an explicit per-night `asleep`
  // or `totalSleep` field. We pick whichever is present, preferring the
  // more inclusive value. One row per calendar date (last wins).
  const sleepByDate = {};
  for (const entry of byName.sleep_analysis || []) {
    const date = toDate(entry.date || entry.sleepStart);
    if (!date) continue;
    const hours = Number(
      entry.totalSleep ?? entry.asleep ?? entry.inBed ?? entry.qty
    );
    if (!Number.isFinite(hours)) continue;
    sleepByDate[date] = { date, hours };
    if (entry.source) sleepByDate[date].source = entry.source;
  }
  out.sleepRows = Object.values(sleepByDate);

  // Steps: HAE sends per-sample entries with `qty`. Sum per calendar date.
  const stepsByDate = {};
  for (const entry of byName.step_count || []) {
    const date = toDate(entry.date);
    if (!date) continue;
    const qty = Number(entry.qty);
    if (!Number.isFinite(qty)) continue;
    stepsByDate[date] = (stepsByDate[date] || 0) + qty;
  }
  out.stepsRows = Object.entries(stepsByDate)
    .map(([date, count]) => ({ date, count: Math.round(count) }));

  // Active minutes: each apple_exercise_time sample is one minute (qty=1).
  // Sum per date.
  const activeByDate = {};
  for (const entry of byName.apple_exercise_time || []) {
    const date = toDate(entry.date);
    if (!date) continue;
    const qty = Number(entry.qty);
    if (!Number.isFinite(qty)) continue;
    activeByDate[date] = (activeByDate[date] || 0) + qty;
  }
  out.activeMinutesRows = Object.entries(activeByDate)
    .map(([date, minutes]) => ({ date, minutes: Math.round(minutes) }));

  // Workouts: boolean "did the user train that day?" derived from the
  // workouts[] array. Type = first workout's name.
  const workoutsByDate = {};
  for (const w of Array.isArray(data.workouts) ? data.workouts : []) {
    const date = toDate(w.start || w.date);
    if (!date) continue;
    if (!workoutsByDate[date]) {
      workoutsByDate[date] = { date, trained: true };
      if (w.name) workoutsByDate[date].type = w.name;
    }
  }
  out.workoutsRows = Object.values(workoutsByDate);

  return out;
}

// --- Upsert: merge each new row into the target manifest by date ---

// Merge newRows into existing (array of {date, ...}), replacing rows whose
// `date` matches. Rows in newRows with no `date` are dropped.
function mergeByDate(existing, newRows) {
  const base = Array.isArray(existing) ? existing.slice() : [];
  const byDate = new Map(base.filter(r => r && r.date).map(r => [r.date, r]));
  for (const row of newRows) {
    if (!row || !row.date) continue;
    byDate.set(row.date, row);
  }
  return [...byDate.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

// Upsert a single target manifest. If the manifest doesn't exist yet, create
// it from the minimal template so the first push doesn't require the user
// to pre-create files.
function upsertOne(registry, id, rows, templateFn) {
  if (!rows || rows.length === 0) return 0;
  const existing = registry.get(id);
  if (!existing) {
    registry.createManifest(templateFn(rows));
    return rows.length;
  }
  const existingRows = Array.isArray(existing.data) ? existing.data : [];
  const merged = mergeByDate(existingRows, rows);
  registry.writeData(id, merged);
  return rows.length;
}

// Minimal templates used only when a target manifest is absent. Users can
// edit freely after first creation.
const TEMPLATES = {
  'sleep-hours': rows => ({
    $schema: 'klebb.datafile.v1',
    meta: {
      id: 'sleep-hours', label: 'Sleep', emoji: '😴', order: 30,
      view: { enabled: true, component: 'generic-card',
              display: { template: '{hours:round(1)}', unit: 'hrs' } },
      writeable: { fromWebapp: false },
    },
    description: 'Total sleep duration for the night. Populated by Health Auto Export.',
    data: rows,
  }),
  'steps': rows => ({
    $schema: 'klebb.datafile.v1',
    meta: {
      id: 'steps', label: 'Steps', emoji: '👣', order: 70,
      view: { enabled: true, component: 'generic-card',
              display: { template: '{count}', unit: 'steps' } },
      writeable: { fromWebapp: false },
    },
    description: 'Daily step count. Populated by Health Auto Export.',
    data: rows,
  }),
  'active-minutes': rows => ({
    $schema: 'klebb.datafile.v1',
    meta: {
      id: 'active-minutes', label: 'Active Minutes', emoji: '⏱️', order: 74,
      view: { enabled: true, component: 'generic-card',
              display: { template: '{minutes}', unit: 'min' } },
      writeable: { fromWebapp: false },
    },
    description: 'Daily active minutes (Apple Exercise Time). Populated by Health Auto Export.',
    data: rows,
  }),
  'workouts': rows => ({
    $schema: 'klebb.datafile.v1',
    meta: {
      id: 'workouts', label: 'Workout Today', emoji: '🏋️', order: 72,
      view: { enabled: true, component: 'generic-card',
              display: { template: '{trained?✅ Trained:❌ Rest}', secondary: '{type|}' } },
      writeable: { fromWebapp: false },
    },
    description: 'Simple yes/no training tracker. Populated by Health Auto Export.',
    data: rows,
  }),
};

// Apply a parsed payload to the registry. Returns per-target counts.
function upsertInto(registry, parsed) {
  const summary = {
    'sleep-hours': upsertOne(registry, 'sleep-hours', parsed.sleepRows, TEMPLATES['sleep-hours']),
    'steps': upsertOne(registry, 'steps', parsed.stepsRows, TEMPLATES['steps']),
    'active-minutes': upsertOne(registry, 'active-minutes', parsed.activeMinutesRows, TEMPLATES['active-minutes']),
    'workouts': upsertOne(registry, 'workouts', parsed.workoutsRows, TEMPLATES['workouts']),
  };
  return summary;
}

module.exports = {
  toDate,
  parseHAEPayload,
  mergeByDate,
  upsertInto,
  TEMPLATES,
};
