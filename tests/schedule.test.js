// tests/schedule.test.js
// Unit tests for public/js/lib/schedule.js — the canonical + legacy
// schedule evaluation rules.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isScheduledOnDate, enumerateDates } from '../public/js/lib/schedule.js';

// --- Canonical schema tests ---

test('daily: every date is scheduled', () => {
  const item = { schedule: { type: 'daily' } };
  assert.equal(isScheduledOnDate(item, '2026-04-20'), 'scheduled');
  assert.equal(isScheduledOnDate(item, '2030-12-25'), 'scheduled');
});

test('weekly with on_days: matches named days', () => {
  const item = { schedule: { type: 'weekly', on_days: ['Mon', 'Wed', 'Fri'] } };
  // 2026-04-20 is a Mon
  assert.equal(isScheduledOnDate(item, '2026-04-20'), 'scheduled'); // Mon
  assert.equal(isScheduledOnDate(item, '2026-04-21'), 'rest');      // Tue
  assert.equal(isScheduledOnDate(item, '2026-04-22'), 'scheduled'); // Wed
  assert.equal(isScheduledOnDate(item, '2026-04-24'), 'scheduled'); // Fri
  assert.equal(isScheduledOnDate(item, '2026-04-25'), 'rest');      // Sat
});

test('weekly with legacy dayOfWeek string still works', () => {
  const item = { schedule: { type: 'weekly', dayOfWeek: 'Thu' } };
  assert.equal(isScheduledOnDate(item, '2026-04-23'), 'scheduled'); // Thu
  assert.equal(isScheduledOnDate(item, '2026-04-22'), 'rest');
});

test('every_n_days: interval_days canonical, honours start_date', () => {
  const item = {
    schedule: { type: 'every_n_days', interval_days: 2, start_date: '2026-04-21' },
  };
  assert.equal(isScheduledOnDate(item, '2026-04-21'), 'scheduled');
  assert.equal(isScheduledOnDate(item, '2026-04-22'), 'rest');
  assert.equal(isScheduledOnDate(item, '2026-04-23'), 'scheduled');
  assert.equal(isScheduledOnDate(item, '2026-04-24'), 'rest');
  assert.equal(isScheduledOnDate(item, '2026-04-25'), 'scheduled');
});

test('every_n_days: before start_date → false', () => {
  const item = {
    schedule: { type: 'every_n_days', interval_days: 2, start_date: '2026-04-21' },
  };
  assert.equal(isScheduledOnDate(item, '2026-04-20'), false);
});

test('every_n_days: legacy nDays still honoured', () => {
  const item = {
    schedule: { type: 'every_n_days', nDays: 3, start_date: '2026-04-01' },
  };
  assert.equal(isScheduledOnDate(item, '2026-04-01'), 'scheduled');
  assert.equal(isScheduledOnDate(item, '2026-04-02'), 'rest');
  assert.equal(isScheduledOnDate(item, '2026-04-04'), 'scheduled');
});

test('every_n_days: legacy "every" alias still honoured', () => {
  const item = {
    schedule: { type: 'every_n_days', every: 2, start_date: '2026-04-01' },
  };
  assert.equal(isScheduledOnDate(item, '2026-04-01'), 'scheduled');
  assert.equal(isScheduledOnDate(item, '2026-04-02'), 'rest');
});

test('every_n_days: legacy startDate alias still honoured', () => {
  const item = {
    schedule: { type: 'every_n_days', interval_days: 2, startDate: '2026-04-01' },
  };
  assert.equal(isScheduledOnDate(item, '2026-04-03'), 'scheduled');
  assert.equal(isScheduledOnDate(item, '2026-04-04'), 'rest');
});

test('every_n_days: falls back to cycle startRef if no schedule.start_date', () => {
  const item = {
    schedule: { type: 'every_n_days', interval_days: 2 },
    cycles: [{ type: 'on', start: '2026-04-01' }],
  };
  assert.equal(isScheduledOnDate(item, '2026-04-01'), 'scheduled');
  assert.equal(isScheduledOnDate(item, '2026-04-03'), 'scheduled');
  assert.equal(isScheduledOnDate(item, '2026-04-02'), 'rest');
});

// The most important regression: finasteride used to silently show as
// daily because the lib didn't know about interval_days. Pin that it
// now really is every-other-day.
test('every_n_days: finasteride-like shape correctly skips alternate days', () => {
  const item = {
    schedule: { type: 'every_n_days', interval_days: 2, times_per_day: 1 },
    cycles: [{ type: 'on', start: '2026-04-21' }],
  };
  // 2026-04-21 is day 0 → scheduled
  assert.equal(isScheduledOnDate(item, '2026-04-21'), 'scheduled');
  // 2026-04-22 is day 1 → rest
  assert.equal(isScheduledOnDate(item, '2026-04-22'), 'rest');
  // 2026-04-23 is day 2 → scheduled
  assert.equal(isScheduledOnDate(item, '2026-04-23'), 'scheduled');
});

test('on_off: Mon-Fri on, Sat-Sun off', () => {
  const item = {
    schedule: { type: 'on_off', on_days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], off_days: ['Sat', 'Sun'] },
  };
  assert.equal(isScheduledOnDate(item, '2026-04-20'), 'scheduled'); // Mon
  assert.equal(isScheduledOnDate(item, '2026-04-24'), 'scheduled'); // Fri
  assert.equal(isScheduledOnDate(item, '2026-04-25'), 'rest');      // Sat
  assert.equal(isScheduledOnDate(item, '2026-04-26'), 'rest');      // Sun
});

test('on_off: handles three-letter + full-name day strings equally', () => {
  const item = {
    schedule: { type: 'on_off', on_days: ['Monday', 'Wednesday'], off_days: [] },
  };
  assert.equal(isScheduledOnDate(item, '2026-04-20'), 'scheduled'); // Mon
  assert.equal(isScheduledOnDate(item, '2026-04-22'), 'scheduled'); // Wed
  assert.equal(isScheduledOnDate(item, '2026-04-21'), 'rest');      // Tue
});

test('phased: loading weeks use loading.days', () => {
  const item = {
    schedule: {
      type: 'phased',
      loading: { days: ['Tue', 'Fri'], duration_weeks: 4 },
      maintenance: { days: ['Tue'] },
    },
    cycles: [{ type: 'on', start: '2026-03-25' }],
  };
  // Week 1 of loading
  assert.equal(isScheduledOnDate(item, '2026-03-31'), 'scheduled'); // Tue
  assert.equal(isScheduledOnDate(item, '2026-04-03'), 'scheduled'); // Fri
  assert.equal(isScheduledOnDate(item, '2026-04-01'), 'rest');      // Wed
});

test('phased: after 4 weeks falls back to maintenance', () => {
  const item = {
    schedule: {
      type: 'phased',
      loading: { days: ['Tue', 'Fri'], duration_weeks: 4 },
      maintenance: { days: ['Tue'] },
    },
    cycles: [{ type: 'on', start: '2026-03-25' }],
  };
  // 2026-04-28 is week ~5 (Tue)
  assert.equal(isScheduledOnDate(item, '2026-04-28'), 'scheduled');
  // 2026-05-01 is week 6 (Fri) — NOT in maintenance
  assert.equal(isScheduledOnDate(item, '2026-05-01'), 'rest');
});

// --- Cycles ---

test('outside all cycles → false', () => {
  const item = {
    schedule: { type: 'daily' },
    cycles: [{ type: 'on', start: '2026-03-01', end: '2026-03-31' }],
  };
  assert.equal(isScheduledOnDate(item, '2026-04-01'), false);
  assert.equal(isScheduledOnDate(item, '2026-02-28'), false);
});

test('off cycle → off', () => {
  const item = {
    schedule: { type: 'daily' },
    cycles: [{ type: 'off', start: '2026-03-01', end: '2026-03-31' }],
  };
  assert.equal(isScheduledOnDate(item, '2026-03-15'), 'off');
});

test('no cycles, no start/end → uses schedule only', () => {
  const item = { schedule: { type: 'daily' } };
  assert.equal(isScheduledOnDate(item, '2026-04-20'), 'scheduled');
});

test('no cycles, item.startDate gates history', () => {
  const item = { schedule: { type: 'daily' }, startDate: '2026-04-10' };
  assert.equal(isScheduledOnDate(item, '2026-04-09'), false);
  assert.equal(isScheduledOnDate(item, '2026-04-10'), 'scheduled');
});

// --- Legacy (frequency key) ---

test('legacy schedule.frequency key still works (read-only back-compat)', () => {
  const item = { schedule: { frequency: 'daily' } };
  assert.equal(isScheduledOnDate(item, '2026-04-20'), 'scheduled');
});

test('legacy every_n_days + all legacy aliases together', () => {
  const item = {
    schedule: { frequency: 'every_n_days', nDays: 2, startDate: '2026-04-01' },
  };
  assert.equal(isScheduledOnDate(item, '2026-04-01'), 'scheduled');
  assert.equal(isScheduledOnDate(item, '2026-04-03'), 'scheduled');
  assert.equal(isScheduledOnDate(item, '2026-04-02'), 'rest');
});

// --- enumerateDates ---

test('enumerateDates: inclusive range', () => {
  const out = enumerateDates('2026-04-20', '2026-04-22');
  assert.deepEqual(out, ['2026-04-20', '2026-04-21', '2026-04-22']);
});

test('enumerateDates: single-day range', () => {
  assert.deepEqual(enumerateDates('2026-04-20', '2026-04-20'), ['2026-04-20']);
});

test('enumerateDates: handles month boundary', () => {
  const out = enumerateDates('2026-03-30', '2026-04-02');
  assert.deepEqual(out, ['2026-03-30', '2026-03-31', '2026-04-01', '2026-04-02']);
});
