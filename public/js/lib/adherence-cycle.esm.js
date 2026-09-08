// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// adherence-cycle.esm.js — pure cycle-adherence maths for the
// adherence-report renderer, extracted so the counting rules are
// unit-testable in node.
//
// A day can hold several dose entries (multi check-off, #705, and any
// imported or chat-written data), so `taken` and `offSchedule` count
// unique DATES, never entries: a day contributes once to the adherence
// percentage however many times its item was ticked. `missed` was
// already date-deduped; keeping the other two entry-counted let stacked
// same-day ticks push the bar past 100%.

import { isScheduledOnDate, enumerateDates } from '../../../lib/schedule.mjs';

function localTodayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Aggregate dose-status counts for one cycle.
// Returns { scheduled, taken, missed, offSchedule, upcoming, cycleIsFuture }.
export function cycleStats(item, cycle, { today = localTodayStr() } = {}) {
  const { start_date, end_date, status } = cycle;
  if (!start_date || !end_date) {
    return { scheduled: 0, taken: 0, missed: 0, offSchedule: 0, upcoming: 0, cycleIsFuture: false };
  }

  // Enumerate every date in the cycle window
  let dates = [];
  try { dates = enumerateDates(start_date, end_date); } catch { dates = []; }

  // Dates on which the schedule says a dose IS due. Strict comparison:
  // isScheduledOnDate returns the status STRING, and 'rest' is truthy,
  // so a truthiness filter counted weekly-schedule rest days as
  // scheduled and inflated the denominator.
  const scheduledSet = new Set(dates.filter(d => isScheduledOnDate(item, d) === 'scheduled'));

  // All dose records for this item (item-level, not cycle-scoped)
  const doses = Array.isArray(item.doses) ? item.doses : [];
  // Doses WITHIN this cycle's date range
  const dosesInCycle = doses.filter(x => {
    const d = x.scheduledDate || (x.takenAt ? x.takenAt.slice(0, 10) : null);
    return d && d >= start_date && d <= end_date;
  });

  // Taken = unique dates with a takenAt entry
  const takenDates = new Set(
    dosesInCycle.filter(x => x.takenAt).map(x => x.scheduledDate || x.takenAt.slice(0, 10))
  );
  const taken = takenDates.size;

  // Off-schedule = taken dates that aren't in scheduledSet
  const offSchedule = [...takenDates].filter(d => !scheduledSet.has(d)).length;

  // Missed = scheduled dates before today, no takenAt entry
  const takenScheduledDates = new Set(
    dosesInCycle.filter(x => x.takenAt && x.scheduledDate).map(x => x.scheduledDate)
  );
  const missed = [...scheduledSet].filter(d => d < today && !takenScheduledDates.has(d)).length;

  // Upcoming = scheduled dates in the future, plus today only while it
  // is still untaken. A dose taken today must move into the "past"
  // denominator with it: counting it in the numerator while excluding
  // the day from the denominator let the percentage pass 100 whenever
  // today sat inside the cycle window.
  const upcoming = [...scheduledSet].filter(d => d > today || (d === today && !takenDates.has(d))).length;

  // A cycle can be completely in the future → nothing counts as missed yet
  const cycleIsFuture = status === 'scheduled' && start_date > today;

  return {
    scheduled: scheduledSet.size,
    taken,
    missed: cycleIsFuture ? 0 : missed,
    offSchedule,
    upcoming,
    cycleIsFuture,
  };
}

export function adherencePct(stats) {
  const past = stats.scheduled - stats.upcoming;
  if (past <= 0) return null;
  return Math.round((stats.taken - stats.offSchedule) / past * 100);
}
