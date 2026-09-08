// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/adherence-cycle.test.js
// Unit tests for the adherence-report cycle maths (#705). The load-bearing
// rule: taken and offSchedule count unique DATES, never entries, so a day
// with several stacked check-offs (maxReadingsPerDay > 1, imports, chat
// writes) contributes once to the percentage and the bar can never pass
// 100%.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { cycleStats, adherencePct } from '../public/js/lib/adherence-cycle.esm.js';

const CYCLE = { start_date: '2026-01-01', end_date: '2026-01-10', status: 'active' };
const PAST = { today: '2026-01-11' };

function dailyItem(doses) {
  return { name: 'TP', schedule: { type: 'daily', start_date: '2026-01-01' }, doses };
}

function taken(date, n = 1) {
  return Array.from({ length: n }, (_, i) => ({
    scheduledDate: date,
    takenAt: `${date}T0${8 + i}:00:00Z`,
  }));
}

describe('cycleStats date dedupe', () => {
  test('single entries per day count one each (baseline)', () => {
    const s = cycleStats(dailyItem([...taken('2026-01-02'), ...taken('2026-01-04'), ...taken('2026-01-07')]), CYCLE, PAST);
    assert.equal(s.scheduled, 10);
    assert.equal(s.taken, 3);
    assert.equal(s.missed, 7);
    assert.equal(adherencePct(s), 30);
  });

  test('stacked same-day entries count the day once', () => {
    const s = cycleStats(dailyItem([...taken('2026-01-02', 3), ...taken('2026-01-04'), ...taken('2026-01-07')]), CYCLE, PAST);
    assert.equal(s.taken, 3, 'three DATES taken, not five entries');
    assert.equal(s.missed, 7);
    assert.equal(adherencePct(s), 30);
  });

  test('the percentage can never exceed 100 however hard a day is stacked', () => {
    const doses = [];
    for (let d = 1; d <= 10; d++) doses.push(...taken(`2026-01-${String(d).padStart(2, '0')}`));
    doses.push(...taken('2026-01-05', 4));
    const s = cycleStats(dailyItem(doses), CYCLE, PAST);
    assert.equal(s.taken, 10);
    assert.equal(adherencePct(s), 100);
  });

  test('off-schedule dates dedupe too', () => {
    // Weekly Mondays only; 2026-01-05 is the only scheduled date in window.
    const item = {
      name: 'TP',
      schedule: { type: 'weekly', on_days: ['Mon'], start_date: '2026-01-01' },
      doses: [...taken('2026-01-05'), ...taken('2026-01-06', 2)],
    };
    const s = cycleStats(item, { start_date: '2026-01-05', end_date: '2026-01-06', status: 'active' }, PAST);
    assert.equal(s.scheduled, 1);
    assert.equal(s.taken, 2, 'two distinct dates taken');
    assert.equal(s.offSchedule, 1, 'the stacked Tuesday counts once');
    assert.equal(adherencePct(s), 100);
  });

  test('entries with takenAt null never count as taken', () => {
    const s = cycleStats(dailyItem([
      { scheduledDate: '2026-01-02', takenAt: null },
      ...taken('2026-01-02'),
      { scheduledDate: '2026-01-03', takenAt: null },
    ]), CYCLE, PAST);
    assert.equal(s.taken, 1);
    assert.equal(s.missed, 9, 'the null-only date is missed');
  });

  test('future cycles report no misses', () => {
    const s = cycleStats(dailyItem([]), { start_date: '2026-02-01', end_date: '2026-02-05', status: 'scheduled' }, { today: '2026-01-11' });
    assert.equal(s.missed, 0);
    assert.equal(s.cycleIsFuture, true);
    assert.equal(adherencePct(s), null, 'nothing in the past yet');
  });

  test('today inside the window: a dose taken today cannot push the percentage past 100', () => {
    // Perfect adherence through today, rest of the cycle still ahead.
    const doses = [];
    for (let d = 1; d <= 5; d++) doses.push(...taken(`2026-01-0${d}`));
    const s = cycleStats(dailyItem(doses), CYCLE, { today: '2026-01-05' });
    assert.equal(s.upcoming, 5, 'taken-today moves out of upcoming; days 6-10 remain');
    assert.equal(adherencePct(s), 100, 'not 125: today sits in the denominator once taken');

    // Today still untaken stays upcoming, not missed.
    const s2 = cycleStats(dailyItem(doses.slice(0, 4 * 1)), CYCLE, { today: '2026-01-05' });
    assert.equal(s2.upcoming, 6);
    assert.equal(s2.missed, 0);
    assert.equal(adherencePct(s2), 100);
  });

  test('entries without scheduledDate fall back to the takenAt date', () => {
    const s = cycleStats(dailyItem([
      { takenAt: '2026-01-03T08:00:00Z' },
      { takenAt: '2026-01-03T14:00:00Z' },
    ]), CYCLE, PAST);
    assert.equal(s.taken, 1, 'both entries resolve to one date');
    assert.equal(s.offSchedule, 0, 'the date is a scheduled one');
  });

  test('off-cycle segments are not scheduled dates (truthy status strings stay excluded)', () => {
    const item = {
      name: 'TP',
      schedule: { type: 'daily', start_date: '2026-01-01' },
      cycles: [
        { start_date: '2026-01-01', end_date: '2026-01-04' },
        { type: 'off', start_date: '2026-01-05', end_date: '2026-01-08' },
      ],
      doses: [],
    };
    const s = cycleStats(item, { start_date: '2026-01-01', end_date: '2026-01-08', status: 'active' }, PAST);
    assert.equal(s.scheduled, 4, "the 'off' half of the window is not scheduled");
    assert.equal(s.missed, 4);
  });
});
