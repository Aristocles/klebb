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
// Returns { rowsWritten, pushesScanned, skipped }.
//   skipped === true if the manifest is not HAE-backed, has non-empty
//              data[], or its metric is not in the catalogue. No writes.
function replayFromArchive(registry, manifestId) {
  const entry = registry.get(manifestId);
  if (!entry) return { rowsWritten: 0, pushesScanned: 0, skipped: true };

  const ing = entry.meta?.ingest;
  if (!ing || ing.source !== 'hae' || !ing.metric) {
    return { rowsWritten: 0, pushesScanned: 0, skipped: true };
  }
  const cat = catalogue[ing.metric];
  if (!cat) return { rowsWritten: 0, pushesScanned: 0, skipped: true };

  const existing = Array.isArray(entry.data) ? entry.data : [];
  if (existing.length > 0) {
    return { rowsWritten: 0, pushesScanned: 0, skipped: true };
  }

  const files = listRawFilesAscending();
  let mapped = [];
  let pushesScanned = 0;

  for (const file of files) {
    const payload = readJsonSafe(path.join(RAW_DIR, file));
    if (!payload) continue;
    pushesScanned += 1;
    const entries = extractEntries(payload, { ...cat, _metricName: ing.metric });
    if (!entries || entries.length === 0) continue;
    for (const raw of entries) {
      const row = cat.row(raw);
      if (row && row.date) mapped.push(row);
    }
  }

  if (mapped.length === 0) {
    return { rowsWritten: 0, pushesScanned, skipped: false };
  }

  const aggregated = aggregate(mapped, cat.aggregate);
  const merged = mergeByDate([], aggregated);
  registry.writeData(manifestId, merged);
  return { rowsWritten: aggregated.length, pushesScanned, skipped: false };
}

module.exports = { replayFromArchive };
