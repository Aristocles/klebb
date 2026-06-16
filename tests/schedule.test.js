// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/schedule.test.js
// Unit tests for lib/schedule.js: the canonical + legacy schedule
// evaluation rules.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isScheduledOnDate, enumerateDates, effectiveCycles } from '../lib/schedule.js';

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

// --- effectiveCycles: synthesised cycles from schedule.start_date + duration ---

test('effectiveCycles: explicit cycles[] wins over schedule-derived', () => {
  const item = {
    schedule: { type: 'daily', start_date: '2026-01-01', cycle_weeks: 4 },
    cycles: [{ type: 'on', start: '2026-05-01', end: '2026-05-10' }],
  };
  assert.deepEqual(effectiveCycles(item), [{ type: 'on', start: '2026-05-01', end: '2026-05-10' }]);
});

test('effectiveCycles: schedule.start_date + cycle_weeks → bounded synthetic cycle', () => {
  const item = {
    schedule: { type: 'weekly', on_days: ['Mon', 'Wed', 'Fri'], start_date: '2026-05-06', cycle_weeks: 6 },
  };
  // 6 weeks = 42 days inclusive of the start date → end = 2026-06-16
  assert.deepEqual(effectiveCycles(item), [{ type: 'on', start: '2026-05-06', end: '2026-06-16' }]);
});

test('effectiveCycles: schedule.start_date + cycle_days → bounded synthetic cycle', () => {
  const item = {
    schedule: { type: 'daily', start_date: '2026-05-01', cycle_days: 20 },
  };
  assert.deepEqual(effectiveCycles(item), [{ type: 'on', start: '2026-05-01', end: '2026-05-20' }]);
});

test('effectiveCycles: start_date only → open-ended synthetic cycle', () => {
  const item = { schedule: { type: 'daily', start_date: '2026-05-06' } };
  assert.deepEqual(effectiveCycles(item), [{ type: 'on', start: '2026-05-06' }]);
});

test('effectiveCycles: no cycles and no start_date → null', () => {
  const item = { schedule: { type: 'daily' } };
  assert.equal(effectiveCycles(item), null);
});

test('effectiveCycles: legacy schedule.startDate also feeds the synthesiser', () => {
  const item = { schedule: { type: 'daily', startDate: '2026-05-06' } };
  assert.deepEqual(effectiveCycles(item), [{ type: 'on', start: '2026-05-06' }]);
});

// #186: agent-authored peptide manifests nest the cycles array under a
// top-level `cycle` object as `cycle.cycles[]`, with per-entry fields
// start_date / end_date / off_start / off_end rather than start/end.
// This is the shape seen on klebbtest; the renderer (via
// effectiveCycles) used to ignore it entirely, leaving the schedule
// card body empty. The resolver now surfaces this shape too, plus the
// single-cycle metadata at the top of the `cycle` object.
test('effectiveCycles: nested cycle.cycles[] shape is surfaced', () => {
  const item = {
    schedule: { type: 'daily_straight', days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] },
    cycle: {
      on_days: 20,
      off_days: 10,
      cycles: [
        {
          cycle_number: 1,
          start_date: '2026-05-09',
          end_date: '2026-05-28',
          off_start: '2026-05-29',
          off_end: '2026-06-07',
        },
      ],
    },
  };
  const cycles = effectiveCycles(item);
  assert.ok(Array.isArray(cycles), 'returns an array');
  assert.equal(cycles.length, 1);
  assert.equal(cycles[0].type, 'on');
  assert.equal(cycles[0].start, '2026-05-09');
  assert.equal(cycles[0].end, '2026-05-28');
});

test('effectiveCycles: nested cycle.cycles[] — multiple entries preserve order', () => {
  const item = {
    schedule: { type: 'daily', days: ['Mon'] },
    cycle: {
      cycles: [
        { start_date: '2026-01-01', end_date: '2026-01-20' },
        { start_date: '2026-02-10', end_date: '2026-03-01' },
      ],
    },
  };
  const cycles = effectiveCycles(item);
  assert.equal(cycles.length, 2);
  assert.equal(cycles[0].start, '2026-01-01');
  assert.equal(cycles[1].start, '2026-02-10');
});

// --- isScheduledOnDate with synthesised cycles ---
//
// Regression for #138: agent-authored peptide cards land with only
// schedule.start_date + cycle_weeks/cycle_days. The renderer must treat
// them the same as cards carrying an explicit cycles[] array.

test('isScheduledOnDate: synth cycle from cycle_weeks gates dates inside window', () => {
  // BPC-157 shape from the #138 reproduction manifest.
  const item = {
    name: 'BPC-157',
    schedule: { type: 'weekly', on_days: ['Mon', 'Wed', 'Fri'], start_date: '2026-05-06', cycle_weeks: 6 },
  };
  // 2026-05-06 is a Wed → scheduled (start of cycle)
  assert.equal(isScheduledOnDate(item, '2026-05-06'), 'scheduled');
  // 2026-05-08 Fri → scheduled
  assert.equal(isScheduledOnDate(item, '2026-05-08'), 'scheduled');
  // 2026-05-07 Thu → rest (within cycle, not a scheduled day)
  assert.equal(isScheduledOnDate(item, '2026-05-07'), 'rest');
  // Before the cycle start → outside all cycles
  assert.equal(isScheduledOnDate(item, '2026-05-05'), false);
  // After the 6-week window (2026-06-17) → outside all cycles
  assert.equal(isScheduledOnDate(item, '2026-06-17'), false);
});

test('isScheduledOnDate: synth cycle from cycle_days honours end boundary', () => {
  // Epitalon shape from the #138 reproduction manifest.
  const item = {
    name: 'Epitalon',
    schedule: { type: 'daily', start_date: '2026-05-01', cycle_days: 20 },
  };
  assert.equal(isScheduledOnDate(item, '2026-05-01'), 'scheduled');
  assert.equal(isScheduledOnDate(item, '2026-05-20'), 'scheduled'); // last day
  assert.equal(isScheduledOnDate(item, '2026-05-21'), false);       // past end
  assert.equal(isScheduledOnDate(item, '2026-04-30'), false);       // before start
});

test('isScheduledOnDate: open-ended synth cycle lets schedule run forever', () => {
  const item = { schedule: { type: 'daily', start_date: '2026-05-06' } };
  assert.equal(isScheduledOnDate(item, '2026-05-06'), 'scheduled');
  assert.equal(isScheduledOnDate(item, '2030-01-01'), 'scheduled');
  assert.equal(isScheduledOnDate(item, '2026-05-05'), false);
});
