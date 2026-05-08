// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// health-auto-export/helpers.js
// Shared primitives used by the catalogue + dispatcher + tests.

// HAE stamps dates like "2026-05-04 14:23:00 +1000". We only need the
// calendar date for row keying; the timezone suffix is advisory.
function toDate(stamp) {
  if (!stamp || typeof stamp !== 'string') return null;
  const m = stamp.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

// Parse a numeric value; returns null on NaN / undefined / non-numeric.
// Catalogue entries use this to decide whether an incoming sample is
// usable, rather than threading Number.isFinite checks through every row().
function numeric(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

module.exports = { toDate, numeric };
