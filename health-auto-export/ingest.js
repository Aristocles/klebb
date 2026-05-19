// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// health-auto-export/ingest.js
//
// Dispatches iPhone Health Auto Export webhook payloads to whichever
// manifests declare `meta.ingest: { source: "hae", metric: "<name>" }`.
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
// Row shapes, aggregation rules, and parsing for each supported metric
// live in catalogue.js. This file is the dispatcher + aggregators; it
// does not know what a "sleep hour" is.
//
// Failure policy: a missing metric is not an error; an unknown metric
// subscription is not an error. Malformed entries are dropped silently
// per catalogue.row() returning null. The only thing that can fail loudly
// is a filesystem write.

const { toDate, numeric } = require('./helpers');
const catalogue = require('./catalogue');

// --- Subscriber discovery -----------------------------------------------

// Walk the registry and return entries that declare HAE ingest. Shape:
//   [{ id, metric, entry }]
function findSubscribers(registry) {
  const out = [];
  const all = typeof registry.list === 'function' ? registry.list() : [];
  for (const item of all) {
    const ing = item?.meta?.ingest;
    if (!ing || ing.source !== 'hae' || !ing.metric) continue;
    out.push({ id: item.id, metric: ing.metric });
  }
  return out;
}

// --- Merge + aggregation ------------------------------------------------

// Upsert by-date: rows in `newRows` replace matching dates in `existing`;
// other existing dates are preserved. Rows with no `date` are dropped.
function mergeByDate(existing, newRows) {
  const base = Array.isArray(existing) ? existing.slice() : [];
  const byDate = new Map(base.filter(r => r && r.date).map(r => [r.date, r]));
  for (const row of newRows) {
    if (!row || !row.date) continue;
    byDate.set(row.date, row);
  }
  return [...byDate.values()].sort((a, b) =>
    String(a.date).localeCompare(String(b.date)));
}

// Reduce a list of per-entry rows (all with `date`) down to one row per date
// according to the aggregation strategy. Input rows can be arbitrary shapes
// so long as they carry `date`; non-date fields are combined according to
// the strategy.
function aggregate(rows, strategy) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const groups = new Map();
  for (const r of rows) {
    if (!r || !r.date) continue;
    const list = groups.get(r.date) || [];
    list.push(r);
    groups.set(r.date, list);
  }

  const out = [];
  for (const [date, list] of groups) {
    switch (strategy) {
      case 'last-per-date':
        out.push({ ...list[list.length - 1] });
        break;

      case 'sum-per-date': {
        const acc = { date };
        for (const r of list) {
          for (const k of Object.keys(r)) {
            if (k === 'date') continue;
            const n = numeric(r[k]);
            if (n === null) continue;
            acc[k] = (acc[k] ?? 0) + n;
          }
        }
        // Counts are whole numbers; tidy tiny FP residue.
        for (const k of Object.keys(acc)) {
          if (k === 'date') continue;
          acc[k] = Math.round(acc[k]);
        }
        out.push(acc);
        break;
      }

      case 'mean-per-date': {
        const sum = { date };
        const counts = {};
        for (const r of list) {
          for (const k of Object.keys(r)) {
            if (k === 'date') continue;
            const n = numeric(r[k]);
            if (n === null) continue;
            sum[k] = (sum[k] ?? 0) + n;
            counts[k] = (counts[k] ?? 0) + 1;
          }
        }
        const mean = { date };
        for (const k of Object.keys(sum)) {
          if (k === 'date') continue;
          const v = sum[k] / counts[k];
          // Keep one decimal of precision; catalogue entries can re-round
          // at display time via {value:round(N)} if they want.
          mean[k] = Math.round(v * 10) / 10;
        }
        out.push(mean);
        break;
      }

      case 'max-per-date': {
        const acc = { date };
        for (const r of list) {
          for (const k of Object.keys(r)) {
            if (k === 'date') continue;
            const n = numeric(r[k]);
            if (n === null) continue;
            acc[k] = acc[k] === undefined ? n : Math.max(acc[k], n);
          }
        }
        out.push(acc);
        break;
      }

      case 'boolean-any-per-date': {
        // First row wins for scalar fields (e.g. `type`); any row with a
        // truthy `trained` flips the aggregate to `trained: true`.
        const head = list[0];
        const acc = { ...head };
        for (const r of list) {
          for (const k of Object.keys(r)) {
            if (typeof r[k] === 'boolean' && r[k]) acc[k] = true;
          }
        }
        out.push(acc);
        break;
      }

      case 'workouts-merge-per-date': {
        // Multiple workouts on the same date merge to one daily summary,
        // matching Apple Health's own workouts-by-day rollup. Sum the
        // additive measures; keep `type`/`source`/etc as a chronological
        // dedup list; pick max for `maxHr`; weighted mean for `avgHr`;
        // earliest local start time. See #235 for the full rule table.
        const sorted = [...list].sort((a, b) =>
          String(a.startTime || '').localeCompare(String(b.startTime || '')));
        const acc = { date };
        const trained = sorted.some(r => r.trained === true);
        if (trained) acc.trained = true;

        // Chronological dedup list, joined by ", ". For 1-entry days the
        // value is just the single string with no comma.
        const types = [];
        for (const r of sorted) {
          if (r.type && !types.includes(r.type)) types.push(r.type);
        }
        if (types.length) acc.type = types.join(', ');

        const sumIfAny = (key, decimals = 0) => {
          let total = 0;
          let any = false;
          for (const r of sorted) {
            const n = numeric(r[key]);
            if (n === null) continue;
            total += n;
            any = true;
          }
          if (any) acc[key] = decimals === 0
            ? Math.round(total)
            : Math.round(total * Math.pow(10, decimals)) / Math.pow(10, decimals);
        };
        sumIfAny('durationMin', 0);
        sumIfAny('distanceKm', 2);
        sumIfAny('calories', 0);
        sumIfAny('elevationM', 0);

        // Weighted mean HR by duration. If no entry carries duration but
        // some carry HR, fall back to a flat mean so a single watch-tracked
        // walk doesn't silently drop the field.
        let hrNum = 0;
        let hrDen = 0;
        let hrFlatSum = 0;
        let hrFlatCount = 0;
        for (const r of sorted) {
          const hr = numeric(r.avgHr);
          if (hr === null) continue;
          hrFlatSum += hr;
          hrFlatCount += 1;
          const w = numeric(r.durationMin);
          if (w === null || w <= 0) continue;
          hrNum += hr * w;
          hrDen += w;
        }
        if (hrDen > 0) acc.avgHr = Math.round(hrNum / hrDen);
        else if (hrFlatCount > 0) acc.avgHr = Math.round(hrFlatSum / hrFlatCount);

        let maxHrSeen = null;
        for (const r of sorted) {
          const hr = numeric(r.maxHr);
          if (hr === null) continue;
          maxHrSeen = maxHrSeen === null ? hr : Math.max(maxHrSeen, hr);
        }
        if (maxHrSeen !== null) acc.maxHr = Math.round(maxHrSeen);

        // Earliest local start.
        const starts = sorted.map(r => r.startTime).filter(Boolean).sort();
        if (starts.length) acc.startTime = starts[0];

        out.push(acc);
        break;
      }

      default:
        // Unknown strategy: behave like last-per-date so catalogue authors
        // get something vaguely sensible while debugging.
        out.push({ ...list[list.length - 1] });
    }
  }
  return out.sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

// --- Payload slicing ----------------------------------------------------

// Return the array of raw entries from the payload for a given metric,
// consulting the catalogue entry's `from` flag. Returns null if the metric
// is absent from the payload (distinct from "empty array").
function extractEntries(payload, catalogueEntry) {
  const data = payload?.data || payload || {};
  const from = catalogueEntry.from || 'metrics';

  if (from === 'workouts') {
    return Array.isArray(data.workouts) ? data.workouts : null;
  }

  // Default: look inside data.metrics[] for the named stream.
  if (!Array.isArray(data.metrics)) return null;
  for (const m of data.metrics) {
    if (m && typeof m.name === 'string' && m.name === catalogueEntry._metricName) {
      return Array.isArray(m.data) ? m.data : null;
    }
  }
  return null;
}

// Enumerate every metric name actually present in the payload. Used for the
// "available but unsubscribed" diagnostic. For `workouts[]` we report the
// pseudo-name `workouts` so the output space matches catalogue keys.
function metricsPresent(payload) {
  const data = payload?.data || payload || {};
  const names = new Set();
  if (Array.isArray(data.metrics)) {
    for (const m of data.metrics) {
      if (m && typeof m.name === 'string') names.add(m.name);
    }
  }
  if (Array.isArray(data.workouts) && data.workouts.length > 0) {
    names.add('workouts');
  }
  return names;
}

// --- Dispatch -----------------------------------------------------------

// Main entry point. Walks subscribers, routes each to the matching catalogue
// entry, aggregates per date, and upserts into the manifest's data[].
//
// Returns a summary object the caller can echo to the client and/or write
// to disk as a diagnostic:
//   {
//     subscribers: [{ id, metric, rowsWritten, note? }],
//     availableUnsubscribed: [<metric>, ...],
//     warnings: [<string>, ...]
//   }
function dispatch(registry, payload) {
  const summary = {
    subscribers: [],
    availableUnsubscribed: [],
    warnings: [],
  };

  const subs = findSubscribers(registry);
  const presentMetrics = metricsPresent(payload);
  const subscribedMetrics = new Set(subs.map(s => s.metric));

  for (const sub of subs) {
    const metricKey = sub.metric;
    const cat = catalogue[metricKey];

    if (!cat) {
      const note = `unknown metric "${metricKey}" (not in catalogue)`;
      summary.subscribers.push({ id: sub.id, metric: metricKey, rowsWritten: 0, note });
      summary.warnings.push(`[hae] manifest "${sub.id}" subscribes to ${note}`);
      continue;
    }

    // Attach metricKey to the catalogue entry for extractEntries() without
    // mutating the exported catalogue object (shallow copy is fine).
    const entries = extractEntries(payload, { ...cat, _metricName: metricKey });

    if (entries === null) {
      summary.subscribers.push({
        id: sub.id, metric: metricKey, rowsWritten: 0,
        note: 'no entries in payload',
      });
      continue;
    }

    if (entries.length === 0) {
      summary.subscribers.push({
        id: sub.id, metric: metricKey, rowsWritten: 0,
        note: 'metric present but empty',
      });
      continue;
    }

    const mapped = [];
    for (const raw of entries) {
      const row = cat.row(raw);
      if (row && row.date) mapped.push(row);
    }

    if (mapped.length === 0) {
      summary.subscribers.push({
        id: sub.id, metric: metricKey, rowsWritten: 0,
        note: 'all entries malformed',
      });
      continue;
    }

    const aggregated = aggregate(mapped, cat.aggregate);

    const existing = registry.data(sub.id);
    const merged = mergeByDate(existing, aggregated);
    try {
      registry.writeData(sub.id, merged);
      summary.subscribers.push({
        id: sub.id, metric: metricKey, rowsWritten: aggregated.length,
      });
    } catch (e) {
      summary.subscribers.push({
        id: sub.id, metric: metricKey, rowsWritten: 0,
        note: `write failed: ${e.message}`,
      });
      summary.warnings.push(`[hae] write failed for ${sub.id}: ${e.message}`);
    }
  }

  // "Available but unsubscribed" powers the discovery card surface.
  for (const name of presentMetrics) {
    if (!subscribedMetrics.has(name)) summary.availableUnsubscribed.push(name);
  }
  summary.availableUnsubscribed.sort();

  return summary;
}

module.exports = {
  // Core
  dispatch,
  findSubscribers,

  // Helpers (exported for testing + potential future callers)
  toDate,
  mergeByDate,
  aggregate,
  extractEntries,
  metricsPresent,
  catalogue,
};
