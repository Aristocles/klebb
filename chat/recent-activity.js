// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// chat/recent-activity.js
// Server-computed per-card activity summary for the Klebbius agent. One pass
// over the registry so the agent gets recency/staleness signals without N+1
// reading every card. Shared by the get_recent_activity tool and (later) the
// hygiene checks, so the freshness derivation lives in exactly one place.

// Resolve the per-row date key for a card. Authors can override via
// meta.view.dateField; otherwise we use the de-facto `date` convention.
function dateFieldFor(meta) {
  const override = meta && meta.view && typeof meta.view.dateField === 'string'
    ? meta.view.dateField.trim()
    : '';
  return override || 'date';
}

// Pull the sorted (ascending) list of row date strings present on an array
// data block, using the resolved date field. Non-array data (single-doc
// cards, schedule blocks) yields []. Only string dates are kept.
function rowDates(data, dateField) {
  if (!Array.isArray(data)) return [];
  return data
    .map(r => (r && typeof r === 'object' ? r[dateField] : null))
    .filter(d => typeof d === 'string' && d)
    .sort((a, b) => a.localeCompare(b));
}

// Whole-day difference between two ISO (YYYY-MM-DD) dates, today - then.
// Both are treated as calendar dates in the same zone (the caller passes a
// server-local `today`), so this is a plain UTC-midnight subtraction and is
// not affected by wall-clock time or DST.
function ageInDays(today, then) {
  const a = Date.parse(`${today}T00:00:00Z`);
  const b = Date.parse(`${then}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((a - b) / 86400000);
}

// Build the activity summary for every card the registry knows about.
//
// deps:
//   registry : the manifest registry (needs list() + get(id) +
//              dataUpdatedAt(id) + sourceMtime(id))
//   today    : server-local ISO date string (YYYY-MM-DD) for ageDays maths
//
// Returns an array (registry order) of:
//   { id, label, renderer, rowCount, lastEntryDate, ageDays, lastNDelta,
//     staleSource }
// where:
//   - lastEntryDate is the newest per-row date, or null if the card has no
//     dated rows (single-doc / schedule cards, or empty data)
//   - ageDays is days since lastEntryDate; when no row date exists it falls
//     back to the datastore's last data write (staleSource:'updatedAt'),
//     then the file mtime (staleSource:'mtime', meta edits only — data
//     writes no longer touch the manifest file); null when none available
//   - lastNDelta is last - previous row value when the newest two dated rows
//     expose a single obvious numeric field; null otherwise (best-effort, the
//     agent treats it as a hint, not a computed trend)
function buildRecentActivity(registry, today) {
  const cards = typeof registry.list === 'function' ? registry.list() : [];
  return cards.map(c => {
    const meta = c.meta || {};
    const entry = typeof registry.get === 'function' ? registry.get(c.id) : null;
    const data = entry ? entry.data : null;
    const dateField = dateFieldFor(meta);

    const dates = rowDates(data, dateField);
    const rowCount = Array.isArray(data) ? data.length : (data === null ? 0 : 1);
    const lastEntryDate = dates.length ? dates[dates.length - 1] : null;

    let ageDays = null;
    let staleSource = null;
    if (lastEntryDate) {
      ageDays = ageInDays(today, lastEntryDate);
      staleSource = 'rows';
    } else {
      const updatedAt = typeof registry.dataUpdatedAt === 'function'
        ? registry.dataUpdatedAt(c.id)
        : null;
      if (updatedAt) {
        ageDays = ageInDays(today, String(updatedAt).slice(0, 10));
        staleSource = 'updatedAt';
      } else if (typeof registry.sourceMtime === 'function') {
        const mtime = registry.sourceMtime(c.id);
        if (mtime != null) {
          ageDays = ageInDays(today, isoFromMs(mtime));
          staleSource = 'mtime';
        }
      }
    }

    return {
      id: c.id,
      label: meta.label || c.id,
      renderer: meta.view?.component || null,
      rowCount,
      lastEntryDate,
      ageDays,
      lastNDelta: lastNDelta(data, dateField),
      staleSource,
    };
  });
}

function isoFromMs(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

// Best-effort last-vs-previous delta for the newest two dated rows. Only
// fires when the rows share exactly one numeric field besides the date key,
// so it never guesses on multi-metric rows. Returns a Number or null.
function lastNDelta(data, dateField) {
  if (!Array.isArray(data) || data.length < 2) return null;
  const dated = data
    .filter(r => r && typeof r === 'object' && typeof r[dateField] === 'string')
    .sort((a, b) => a[dateField].localeCompare(b[dateField]));
  if (dated.length < 2) return null;
  const last = dated[dated.length - 1];
  const prev = dated[dated.length - 2];
  const numericKeys = Object.keys(last).filter(k => k !== dateField && isFiniteNumber(last[k]));
  if (numericKeys.length !== 1) return null;
  const key = numericKeys[0];
  if (!isFiniteNumber(prev[key])) return null;
  return Number(last[key]) - Number(prev[key]);
}

function isFiniteNumber(v) {
  return v !== null && v !== '' && v !== undefined && Number.isFinite(Number(v));
}

module.exports = { buildRecentActivity, dateFieldFor, rowDates, ageInDays };
