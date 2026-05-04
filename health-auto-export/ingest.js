// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// health-auto-export/ingest.js
//
// Iphone Health Auto Export (HAE) ingest.
//
// Accepts a canonical, intuitive payload (NOT Apple's raw export JSON). The
// caller (typically an iOS Shortcut) is expected to map HAE fields into this
// canonical shape before posting; that mapping is trivial and keeps Klebb
// decoupled from Apple's moving-target export format.
//
// Canonical shape:
//   {
//     "date": "YYYY-MM-DD",
//     "metrics": {
//       <metric-key>: <primitive or nested object>, ...
//     }
//   }
//
// For type="sleep" the recognised metric keys are:
//   hours    (number)  -> fans out to sleep-hours card, row { date, hours }
//   stages   (object { core, rem, deep, awake } in hours)
//                      -> sleep-stages card, row { date, core, rem, deep, awake }
//   bedTime  (string "HH:MM" or ISO) -> sleep-bed-wake card, row.bedTime
//   wakeTime (string "HH:MM" or ISO) -> sleep-bed-wake card, row.wakeTime
//
// For type="activity" the recognised metric keys are:
//   steps            (number)  -> steps card,           row { date, count }
//   activeEnergy     (number)  -> active-energy card,   row { date, kcal }
//   exerciseMinutes  (number)  -> exercise-minutes card, row { date, minutes }
//   standHours       (number)  -> stand-hours card,     row { date, hours }
//
// Unknown metric keys are silently ignored so the shape can grow without
// breaking older clients. Sparse payloads are fine: only the metrics present
// produce writes.
//
// Behaviour per target card:
//   - If the manifest exists, its data[] array is upserted by date (the
//     existing row for that date is replaced; everything else is preserved,
//     and the result is sorted by date ascending).
//   - If the manifest does not exist, it is created from a minimal template
//     baked in below (klebb.datafile.v1 + generic-card + sensible display
//     config). A human can retrofit display / trends config later without
//     touching the data.
//
// Idempotency: posting the same date twice overwrites only that date's row
// in each affected card. All other dates are untouched.

const fs = require('fs');
const path = require('path');

const TYPES = ['sleep', 'activity'];

function isValidIsoDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function toNumber(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

// Each key here produces zero or one target-card writes for a given payload.
// A write is { targetId, row } where row carries `date` plus the card's
// canonical fields.
const FAN_OUT = {
  sleep: {
    hours: (date, v) => {
      const n = toNumber(v);
      if (n === null) return null;
      return { targetId: 'sleep-hours', row: { date, hours: n } };
    },
    stages: (date, v) => {
      if (!v || typeof v !== 'object') return null;
      const row = { date };
      let any = false;
      for (const k of ['core', 'rem', 'deep', 'awake']) {
        const n = toNumber(v[k]);
        if (n !== null) { row[k] = n; any = true; }
      }
      return any ? { targetId: 'sleep-stages', row } : null;
    },
    bedTime:  (date, v) => timeFieldWrite('sleep-bed-wake', date, { bedTime:  v }),
    wakeTime: (date, v) => timeFieldWrite('sleep-bed-wake', date, { wakeTime: v }),
  },
  activity: {
    steps: (date, v) => {
      const n = toNumber(v);
      if (n === null) return null;
      return { targetId: 'steps', row: { date, count: n } };
    },
    activeEnergy: (date, v) => {
      const n = toNumber(v);
      if (n === null) return null;
      return { targetId: 'active-energy', row: { date, kcal: n } };
    },
    exerciseMinutes: (date, v) => {
      const n = toNumber(v);
      if (n === null) return null;
      return { targetId: 'exercise-minutes', row: { date, minutes: n } };
    },
    standHours: (date, v) => {
      const n = toNumber(v);
      if (n === null) return null;
      return { targetId: 'stand-hours', row: { date, hours: n } };
    },
  },
};

function timeFieldWrite(targetId, date, partial) {
  const cleaned = {};
  let any = false;
  for (const [k, v] of Object.entries(partial)) {
    if (typeof v === 'string' && v.trim().length > 0) {
      cleaned[k] = v.trim();
      any = true;
    }
  }
  if (!any) return null;
  return { targetId, row: { date, ...cleaned } };
}

// Minimal manifest templates used when a target doesn't exist on first write.
// Kept intentionally spare: generic-card renderer, simple display template,
// writeable disabled (ingest is the canonical writer), sensible description.
const TEMPLATES = {
  'sleep-hours': {
    $schema: 'klebb.datafile.v1',
    meta: {
      id: 'sleep-hours',
      label: 'Sleep',
      emoji: '😴',
      order: 30,
      view: {
        enabled: true,
        component: 'generic-card',
        display: { template: '{hours:round(1)}', unit: 'hrs', emptyHeadline: 'No sleep logged' },
      },
    },
    description: 'Total sleep duration for the night, in hours. One entry per date. Populated by health-auto-export ingest.',
    data: [],
  },
  'sleep-stages': {
    $schema: 'klebb.datafile.v1',
    meta: {
      id: 'sleep-stages',
      label: 'Sleep Stages',
      emoji: '🌙',
      order: 31,
      view: {
        enabled: true,
        component: 'generic-card',
        display: { template: '{deep:round(1)}h deep, {rem:round(1)}h REM', emptyHeadline: 'No stage data' },
      },
    },
    description: 'Sleep stage durations in hours per date: core, rem, deep, awake. Populated by health-auto-export ingest.',
    data: [],
  },
  'sleep-bed-wake': {
    $schema: 'klebb.datafile.v1',
    meta: {
      id: 'sleep-bed-wake',
      label: 'Bed/Wake',
      emoji: '🛏️',
      order: 33,
      view: {
        enabled: true,
        component: 'generic-card',
        display: { template: '{bedTime} to {wakeTime}', emptyHeadline: 'No times recorded' },
      },
    },
    description: 'Bedtime and wake time for the night, as HH:MM strings. Populated by health-auto-export ingest.',
    data: [],
  },
  'steps': {
    $schema: 'klebb.datafile.v1',
    meta: {
      id: 'steps',
      label: 'Steps',
      emoji: '👣',
      order: 70,
      view: {
        enabled: true,
        component: 'generic-card',
        display: { template: '{count}', unit: 'steps', emptyHeadline: 'No steps logged' },
      },
    },
    description: 'Daily step count. One entry per date. Populated by health-auto-export ingest.',
    data: [],
  },
  'active-energy': {
    $schema: 'klebb.datafile.v1',
    meta: {
      id: 'active-energy',
      label: 'Active Energy',
      emoji: '🔥',
      order: 71,
      view: {
        enabled: true,
        component: 'generic-card',
        display: { template: '{kcal}', unit: 'kcal', emptyHeadline: 'No energy logged' },
      },
    },
    description: 'Active energy burned per day, in kilocalories. Populated by health-auto-export ingest.',
    data: [],
  },
  'exercise-minutes': {
    $schema: 'klebb.datafile.v1',
    meta: {
      id: 'exercise-minutes',
      label: 'Exercise',
      emoji: '🏃',
      order: 73,
      view: {
        enabled: true,
        component: 'generic-card',
        display: { template: '{minutes}', unit: 'min', emptyHeadline: 'No exercise logged' },
      },
    },
    description: 'Minutes of recorded exercise per day. Populated by health-auto-export ingest.',
    data: [],
  },
  'stand-hours': {
    $schema: 'klebb.datafile.v1',
    meta: {
      id: 'stand-hours',
      label: 'Stand Hours',
      emoji: '🧍',
      order: 75,
      view: {
        enabled: true,
        component: 'generic-card',
        display: { template: '{hours}', unit: 'hrs', emptyHeadline: 'No stand hours logged' },
      },
    },
    description: 'Number of hours containing at least one minute of standing activity. Populated by health-auto-export ingest.',
    data: [],
  },
};

// Validate an incoming payload before we act on it. Returns { ok, error, payload }.
function validatePayload(type, body) {
  if (!TYPES.includes(type)) {
    return { ok: false, error: `unsupported type: ${type}` };
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'body must be a JSON object' };
  }
  if (!isValidIsoDate(body.date)) {
    return { ok: false, error: 'body.date must be an ISO date (YYYY-MM-DD)' };
  }
  if (!body.metrics || typeof body.metrics !== 'object' || Array.isArray(body.metrics)) {
    return { ok: false, error: 'body.metrics must be an object' };
  }
  return { ok: true, payload: { date: body.date, metrics: body.metrics } };
}

// Plan the fan-out for a validated payload WITHOUT touching disk or the
// registry. Returns [{ targetId, row }, ...], which the caller then
// applies. Pure; exported for unit tests.
function planWrites(type, payload) {
  const handlers = FAN_OUT[type];
  const writes = [];
  for (const [key, raw] of Object.entries(payload.metrics)) {
    const fn = handlers[key];
    if (typeof fn !== 'function') continue;
    const w = fn(payload.date, raw);
    if (w) writes.push(w);
  }
  return writes;
}

// Upsert one date's row into an array-shaped data block. Returns a new
// array (the caller rewrites the whole data block via registry.writeData).
function upsertRow(data, row) {
  const existing = Array.isArray(data) ? data : [];
  const withoutDate = existing.filter(r => !r || r.date !== row.date);
  const merged = [...withoutDate];
  // Merge with an existing row for that date only if THAT row carried
  // different fields (e.g. bedTime written earlier, wakeTime now). This
  // preserves partial writes across multiple POSTs for the same date.
  const prior = existing.find(r => r && r.date === row.date) || null;
  const finalRow = prior ? { ...prior, ...row } : { ...row };
  merged.push(finalRow);
  merged.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  return merged;
}

// Archive the raw incoming payload at $AUTO_EXPORT_DIR/<type>/<date>.json.
// Mirrors the predecessor app's behaviour so external tooling that reads
// those files (or the existing GET /api/sleep/:date endpoints) keeps working.
function archivePayload(autoExportDir, type, payload, body) {
  const dir = path.join(autoExportDir, type);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${payload.date}.json`);
  // We write the ORIGINAL body (what the caller sent), not the parsed
  // payload, so archival is a true capture of what arrived.
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(body, null, 2));
  fs.renameSync(tmp, target);
  return target;
}

// Apply planned writes against the registry. Creates missing target
// manifests from TEMPLATES on first write. Idempotent.
function applyWrites(registry, writes) {
  const applied = [];
  for (const { targetId, row } of writes) {
    const template = TEMPLATES[targetId];
    if (!template) {
      // Unknown target (should be impossible because FAN_OUT is closed).
      continue;
    }
    const existing = registry.get(targetId);
    if (!existing) {
      // Create with a single-row data[] on first write. Clone so the
      // template object isn't mutated across requests.
      const manifest = JSON.parse(JSON.stringify(template));
      manifest.data = [row];
      registry.createManifest(manifest);
    } else {
      const nextData = upsertRow(existing.data, row);
      registry.writeData(targetId, nextData);
    }
    applied.push(targetId);
  }
  return applied;
}

// Full end-to-end: validate, archive, fan out, apply. Returns either
//   { ok: true, type, date, targets: [<id>, ...], archive: <abs path> }
// or
//   { ok: false, status, error }
// The caller maps { ok: false } onto the HTTP response shape.
function ingest({ type, body, autoExportDir, registry, rawBody = null }) {
  const v = validatePayload(type, body);
  if (!v.ok) {
    return { ok: false, status: 400, error: v.error };
  }
  const writes = planWrites(type, v.payload);
  const archive = archivePayload(autoExportDir, type, v.payload, rawBody ?? body);
  const targets = applyWrites(registry, writes);
  return {
    ok: true,
    type,
    date: v.payload.date,
    targets,
    archive,
  };
}

module.exports = {
  TYPES,
  FAN_OUT,
  TEMPLATES,
  validatePayload,
  planWrites,
  upsertRow,
  archivePayload,
  applyWrites,
  ingest,
};
