// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// public/js/lib/adherence-series.esm.js
// Pure adherence-series extractors for schedule sparklines. Schedule logic
// is injected as callbacks so this file stays decoupled from any engine.

// Enumerate the last `limit` ISO dates (YYYY-MM-DD) ending at and including
// `endDate`, oldest to newest. UTC-anchored so DST can't shift a day.
function dateWindow(endDate, limit) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(endDate);
  if (!m || !(limit > 0)) return [];
  const end = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const out = [];
  for (let i = limit - 1; i >= 0; i--) {
    const d = new Date(end - i * 86_400_000);
    const y = d.getUTCFullYear();
    const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    out.push(`${y}-${mo}-${day}`);
  }
  return out;
}

// Card-level adherence over a window of days, oldest to newest.
//
// For each day D in the window:
//   - due  = items where isDueOn(item, D)
//   - if no items are due, push null (a no-due day is a gap, not a miss)
//   - else push doneCount / due.length, where doneCount counts due items
//     for which isTakenOn(item, D)
//
// Returns (number|null)[] of length `limit` (empty if endDate malformed).
export function adherenceSeries(items, { endDate, limit = 30, isDueOn, isTakenOn } = {}) {
  if (!Array.isArray(items)) return [];
  if (typeof isDueOn !== 'function' || typeof isTakenOn !== 'function') return [];
  return dateWindow(endDate, limit).map(day => {
    const due = items.filter(i => isDueOn(i, day));
    if (due.length === 0) return null;
    const done = due.reduce((n, i) => n + (isTakenOn(i, day) ? 1 : 0), 0);
    return done / due.length;
  });
}

// Cheap availability proxy for the adherence sparkline settings toggle.
// The real strip needs >=2 due-days of signal, which depends on each
// renderer's schedule logic; rather than replicate that statically, this
// answers the weaker "could a strip ever have signal": there are items,
// and either some item carries a schedule/cycle (so due-days exist) or
// at least two distinct check-off dates have been recorded across items.
export function hasAdherenceSignal(items) {
  if (!Array.isArray(items) || items.length === 0) return false;
  if (items.some(i => i && (i.schedule || i.cycles || i.frequency))) return true;
  const dates = new Set();
  for (const i of items) {
    if (Array.isArray(i?.takenDates)) for (const d of i.takenDates) dates.add(d);
    if (Array.isArray(i?.doses)) for (const dose of i.doses) {
      if (dose && dose.takenAt && dose.scheduledDate) dates.add(dose.scheduledDate);
    }
    if (dates.size >= 2) return true;
  }
  return false;
}

// Resolve the items array out of the several data shapes the checklist +
// schedule renderers accept (flat array, { items }, { current }).
export function adherenceItems(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.current)) return data.current;
  return [];
}

// Per-item variant: 1 when taken, 0 when scheduled-but-not-taken, null on
// days the item isn't scheduled (rest/off days are gaps, not misses).
export function itemAdherenceSeries(item, { endDate, limit = 30, isScheduled, isTaken } = {}) {
  if (typeof isScheduled !== 'function' || typeof isTaken !== 'function') return [];
  return dateWindow(endDate, limit).map(day => {
    if (!isScheduled(item, day)) return null;
    return isTaken(item, day) ? 1 : 0;
  });
}
