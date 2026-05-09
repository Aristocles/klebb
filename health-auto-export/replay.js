// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// health-auto-export/replay.js
//
// Backfill a newly-created HAE-backed manifest from the raw-archive
// directory. The dispatcher only routes to subscribers present at the
// time of a push, so a card created after a push misses data that's
// already on disk. This module re-reads every archived payload, runs
// the catalogue row() + aggregate pipeline for the manifest's metric,
// and upserts the merged rows into the manifest's data[].
//
// Pure-ish: takes (registry, manifestId), reads from disk, writes via
// registry.writeData. Idempotent at the caller layer: skip when the
// manifest already has data[].

const fs = require('fs');
const path = require('path');
const PATHS = require('../config/paths');
const catalogue = require('./catalogue');
const { aggregate, mergeByDate, extractEntries } = require('./ingest');

const RAW_DIR = path.join(PATHS.AUTO_EXPORT_DIR, 'raw');

function listRawFilesAscending() {
  try {
    return fs.readdirSync(RAW_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();
  } catch {
    return [];
  }
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Replay archived HAE pushes into a single manifest.
//
// Pushes are processed one at a time — aggregate within a push, then
// mergeByDate the running state against that push's result — so
// overlapping pushes (scheduled HAE exports re-send the current day's
// samples) don't double-count. This mirrors the live dispatcher's
// per-push semantics: the end state matches what would have happened
// if this manifest had existed at the time of each push.
//
// Returns { rowsWritten, pushesScanned, skipped }.
//   skipped === true if the manifest is not HAE-backed, has non-empty
//              data[] (unless opts.force), or its metric is not in the
//              catalogue. No writes when skipped.
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

  const files = listRawFilesAscending();
  let merged = [];
  let pushesScanned = 0;

  for (const file of files) {
    const payload = readJsonSafe(path.join(RAW_DIR, file));
    if (!payload) continue;
    pushesScanned += 1;
    const entries = extractEntries(payload, { ...cat, _metricName: ing.metric });
    if (!entries || entries.length === 0) continue;
    const mapped = [];
    for (const raw of entries) {
      const row = cat.row(raw);
      if (row && row.date) mapped.push(row);
    }
    if (mapped.length === 0) continue;
    const aggregated = aggregate(mapped, cat.aggregate);
    merged = mergeByDate(merged, aggregated);
  }

  // Always write when force is true (callers expect the manifest
  // reflects the replay's result even if it produced zero rows, so
  // stale data is cleared). Otherwise, skip when nothing was merged.
  if (merged.length === 0 && !force) {
    return { rowsWritten: 0, pushesScanned, skipped: false };
  }

  registry.writeData(manifestId, merged);
  return { rowsWritten: merged.length, pushesScanned, skipped: false };
}

module.exports = { replayFromArchive };
