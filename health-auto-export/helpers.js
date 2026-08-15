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

// Round a number to `decimals` places, tolerant of null (returns null).
// HAE payloads routinely carry IEEE754 precision tails like 62.00000000000001
// because Apple Health averages under the hood. The catalogue rounds values
// at ingest time so manifest rows stay clean.
function round(v, decimals = 0) {
  if (v === null || v === undefined) return v;
  const f = Math.pow(10, decimals);
  return Math.round(v * f) / f;
}

// HAE wraps most numeric workout fields as `{qty, units}` objects, with
// `units` chosen by the user's iPhone unit preferences (e.g. "kJ" vs "kcal",
// "mi" vs "km", "ft" vs "m"). Read the qty, normalise to the canonical unit
// via the supplied converter, and return null if the field is absent or
// not finite. The legacy v1 shape is sometimes a bare number; tolerate both.
function readQty(field, convert) {
  if (field === null || field === undefined) return null;
  if (typeof field === 'number') {
    return Number.isFinite(field) ? convert(field, null) : null;
  }
  if (typeof field !== 'object') return null;
  const qty = numeric(field.qty);
  if (qty === null) return null;
  return convert(qty, field.units || null);
}

const KJ_PER_KCAL = 4.184;
const KM_PER_MI = 1.609344;
const M_PER_FT = 0.3048;

// Mass is the one metric where a magnitude guess is impossible: 176 lb and
// 176 kg are both plausible human weights in the same numeric band, and stone
// overlaps a real kg value too. So this has to read the declared unit; there is
// no fallback heuristic to lean on.
const KG_PER_LB = 0.45359237;
const KG_PER_ST = 6.35029318;
const toKg = (q, u) => {
  if (u === 'lb' || u === 'lbs') return q * KG_PER_LB;
  if (u === 'st' || u === 'stone') return q * KG_PER_ST;
  return q;
};

const toKcal = (q, u) => (u === 'kJ' ? q / KJ_PER_KCAL : q);
const toKm   = (q, u) => (u === 'mi' ? q * KM_PER_MI : q);
const toM    = (q, u) => (u === 'ft' ? q * M_PER_FT : q);
const passQty = (q) => q;

// Pull the local HH:MM out of an HAE timestamp like
// "2026-05-04 14:23:00 +1000". Regex-only — we want the wall-clock time as
// HAE wrote it, not a reinterpretation through the host's TZ. Returns null
// if the stamp can't be parsed.
function extractHHMM(stamp) {
  if (!stamp || typeof stamp !== 'string') return null;
  const m = stamp.match(/\b(\d{2}:\d{2})(?::\d{2})?\b/);
  return m ? m[1] : null;
}

module.exports = {
  toDate, numeric, round,
  readQty, toKcal, toKm, toM, toKg, passQty,
  extractHHMM,
};
