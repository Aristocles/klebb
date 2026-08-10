// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// health-auto-export/replay.js
//
// Backfill a newly-created HAE-backed manifest from the stored sample
// history. The dispatcher only routes to subscribers present at the time of
// a push, so a card created after a push misses data that already arrived.
// This module re-runs the catalogue row() + aggregate pipeline for the
// manifest's metric over every stored sample and upserts the merged rows.
//
// Reads the deduplicated samples table (health-auto-export/samples.js). It
// used to re-parse every file under data/auto-export/raw/, which meant reading
// 404 MB of 85%-duplicate JSON to rebuild one card.
//
// Pure-ish: takes (registry, manifestId), reads the samples table, writes via
// registry.writeData. Idempotent at the caller layer: skip when the manifest
// already has data.

const catalogue = require('./catalogue');
const samples = require('./samples');
const { aggregate } = require('./ingest');

// Rebuild the per-push groups the live dispatcher saw, from rows that each
// exist exactly once.
//
// A sample is stored once, attributed to `last_push`: the most recent push
// that carried it. Grouping by that column and replaying the groups in
// ascending push order reproduces the file-archive result exactly, for every
// aggregation strategy. The argument, because it is not obvious and the whole
// migration rests on it:
//
//   Fix a date D and let P be the highest `last_push` among D's samples.
//   mergeByDate makes a later push replace an earlier one per date, so the old
//   code's final value for D was whatever push P produced for D (P being the
//   last push that mentioned D at all).
//   A sample attributed to P was, by definition, present in push P. And every
//   sample of date D present in push P has `last_push >= P`, so by maximality
//   exactly `= P`. The two sets coincide: group P holds precisely push P's
//   samples for date D, no more and no fewer. Aggregating group P therefore
//   yields push P's value for D, which is the answer.
//
// So `last_push` is load-bearing, not redundant bookkeeping: aggregating a flat
// bag of deduplicated samples in one pass resurrects #168 (5x step counts),
// because content dedupe does not collapse {date:D, qty:1000} and
// {date:D, qty:2000} and a sum-per-date metric would add both.
//
// `push_ord` preserves within-push order, which decides the stored value for
// every `last-per-date` metric. `dup_count` restores a sample the payload
// carried more than once, which a sum-per-date metric must count each time.
function groupsByPush(metric, opts = {}) {
  const rows = samples.forMetric(metric, opts);
  const groups = new Map();
  for (const row of rows) {
    const list = groups.get(row.last_push) || [];
    const sample = JSON.parse(row.doc);
    const copies = Math.max(1, Number(row.dup_count) || 1);
    for (let i = 0; i < copies; i++) list.push(sample);
    groups.set(row.last_push, list);
  }
  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, list]) => list);
}

// Run the catalogue pipeline for one metric over the stored samples and return
// the rows a card for that metric should hold. Split out from
// replayFromArchive so the migration's verification can compare against the
// shipped algorithm rather than a second copy of it that could drift.
//
// Returns { rows, pushesScanned }; rows is null when the metric has no
// catalogue entry (stored for later, nothing to build yet).
function replayMetric(metric, opts = {}) {
  const cat = catalogue[metric];
  if (!cat) return { rows: null, pushesScanned: 0 };

  // One accumulator for the whole replay, rather than mergeByDate() against the
  // running result once per push.
  //
  // The two are equivalent, and the equivalence is worth spelling out because
  // the per-push merge is what the file-scanning version did and the
  // replay-equivalence suite pins this output byte for byte. mergeByDate
  // replaces the row for a date and keeps every other date, and aggregate()
  // emits at most one row per date. So merging group after group is exactly
  // last-writer-wins per date, which is what a single Map gives, and Map keys
  // make sort ties impossible so the final ordering is not sort-stability
  // dependent.
  //
  // It matters because mergeByDate rebuilds a Map of the ENTIRE accumulated
  // result and re-sorts the ENTIRE array on every call (ingest.js), so the
  // chain is O(groups x accumulated dates). That was always true; before the
  // samples table (#546) reading 412 MB of JSON dominated it, and removing the
  // file I/O exposed the asymptote. Measured on synthetic histories at the
  // shape of a real instance: 2.5 months (177 push groups) 16 ms, but 5 years
  // (about 8500 groups) 1084 ms of pure merging, on the single-threaded server,
  // inside POST /api/manifests. With one Map it is flat.
  const byDate = new Map();
  let pushesScanned = 0;
  for (const group of groupsByPush(metric, opts)) {
    pushesScanned += 1;
    const mapped = [];
    for (const raw of group) {
      // Per-sample try/catch for the same reason dispatch() has one: every
      // catalogue row() dereferences its entry immediately, so one wrongly
      // shaped sample would abort the whole replay and leave the card empty.
      let row = null;
      try {
        row = cat.row(raw);
      } catch {
        continue;
      }
      if (row && row.date) mapped.push(row);
    }
    if (mapped.length === 0) continue;
    for (const row of aggregate(mapped, cat.aggregate)) {
      if (row && row.date) byDate.set(row.date, row);
    }
  }
  // Same comparator mergeByDate used, so the row order is unchanged.
  const rows = [...byDate.values()]
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return { rows, pushesScanned };
}

// Replay stored HAE samples into a single manifest.
//
// Returns { rowsWritten, pushesScanned, skipped }.
//   skipped === true if the manifest is not HAE-backed, already has data
//              (unless opts.force), or its metric is not in the catalogue.
//              No writes when skipped.
//   pushesScanned counts push groups that carried samples for this metric,
//              which is what the file-scanning count meant in practice: a
//              push with nothing for this metric contributed nothing.
function replayFromArchive(registry, manifestId, opts = {}) {
  const { force = false } = opts;
  const entry = registry.get(manifestId);
  if (!entry) return { rowsWritten: 0, pushesScanned: 0, skipped: true };

  const ing = entry.meta?.ingest;
  if (!ing || ing.source !== 'hae' || !ing.metric) {
    return { rowsWritten: 0, pushesScanned: 0, skipped: true };
  }
  const cat = catalogue[ing.metric];
  if (!cat) return { rowsWritten: 0, pushesScanned: 0, skipped: true };

  const existing = Array.isArray(entry.data) ? entry.data : [];
  if (existing.length > 0 && !force) {
    return { rowsWritten: 0, pushesScanned: 0, skipped: true };
  }

  const { rows: merged, pushesScanned } = replayMetric(ing.metric);

  // Always write when force is true (callers expect the manifest to reflect
  // the replay's result even if it produced zero rows, so stale data is
  // cleared). Otherwise, skip when nothing was merged.
  if (merged.length === 0 && !force) {
    return { rowsWritten: 0, pushesScanned, skipped: false };
  }

  registry.writeData(manifestId, merged);
  return { rowsWritten: merged.length, pushesScanned, skipped: false };
}

module.exports = { replayFromArchive, replayMetric };
