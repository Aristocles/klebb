// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/health-auto-export.parser.test.js
// Pure parser unit tests. No HTTP, no filesystem.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { parseHAEPayload, mergeByDate, toDate } = require('../health-auto-export/ingest.js');

describe('toDate', () => {
  test('extracts YYYY-MM-DD from HAE-style stamp', () => {
    assert.equal(toDate('2026-05-04 14:23:00 +1000'), '2026-05-04');
  });
  test('handles a date-only string', () => {
    assert.equal(toDate('2026-05-04'), '2026-05-04');
  });
  test('returns null for empty / undefined / malformed', () => {
    assert.equal(toDate(null), null);
    assert.equal(toDate(''), null);
    assert.equal(toDate('not a date'), null);
    assert.equal(toDate(42), null);
  });
});

describe('parseHAEPayload', () => {
  test('empty payload returns empty row sets', () => {
    const r = parseHAEPayload({});
    assert.deepEqual(r.sleepRows, []);
    assert.deepEqual(r.stepsRows, []);
    assert.deepEqual(r.activeMinutesRows, []);
    assert.deepEqual(r.workoutsRows, []);
  });

  test('sleep_analysis -> sleep-hours rows', () => {
    const r = parseHAEPayload({
      data: {
        metrics: [
          { name: 'sleep_analysis', data: [
            { date: '2026-05-04 00:00:00 +1000', totalSleep: 7.6, asleep: 7.3,
              inBed: 8.1, source: 'Apple Watch' },
          ]},
        ],
      },
    });
    assert.equal(r.sleepRows.length, 1);
    assert.equal(r.sleepRows[0].date, '2026-05-04');
    assert.equal(r.sleepRows[0].hours, 7.6);
    assert.equal(r.sleepRows[0].source, 'Apple Watch');
  });

  test('sleep: falls back to asleep then inBed when totalSleep missing', () => {
    const r = parseHAEPayload({ data: { metrics: [
      { name: 'sleep_analysis', data: [
        { date: '2026-05-04 00:00:00 +1000', asleep: 7.2, inBed: 8.0 },
        { date: '2026-05-05 00:00:00 +1000', inBed: 9.0 },
      ]},
    ]}});
    const byDate = Object.fromEntries(r.sleepRows.map(r => [r.date, r.hours]));
    assert.equal(byDate['2026-05-04'], 7.2);
    assert.equal(byDate['2026-05-05'], 9.0);
  });

  test('step_count: sums per-date samples', () => {
    const r = parseHAEPayload({ data: { metrics: [
      { name: 'step_count', data: [
        { date: '2026-05-04 08:00:00 +1000', qty: 1200.5 },
        { date: '2026-05-04 12:30:00 +1000', qty: 3200 },
        { date: '2026-05-04 18:15:00 +1000', qty: 500.3 },
        { date: '2026-05-05 09:00:00 +1000', qty: 2000 },
      ]},
    ]}});
    const byDate = Object.fromEntries(r.stepsRows.map(r => [r.date, r.count]));
    assert.equal(byDate['2026-05-04'], 4901);  // 1200.5 + 3200 + 500.3 = 4900.8 -> round 4901
    assert.equal(byDate['2026-05-05'], 2000);
  });

  test('apple_exercise_time: sums qty per date', () => {
    const r = parseHAEPayload({ data: { metrics: [
      { name: 'apple_exercise_time', data: [
        { date: '2026-05-04 09:29:00 +1000', qty: 1 },
        { date: '2026-05-04 09:35:00 +1000', qty: 1 },
        { date: '2026-05-04 16:01:00 +1000', qty: 1 },
      ]},
    ]}});
    assert.equal(r.activeMinutesRows.length, 1);
    assert.equal(r.activeMinutesRows[0].date, '2026-05-04');
    assert.equal(r.activeMinutesRows[0].minutes, 3);
  });

  test('workouts[]: one row per date with trained:true', () => {
    const r = parseHAEPayload({ data: { workouts: [
      { name: 'Functional Strength Training', start: '2026-05-04 11:06:02 +1000', duration: 1463 },
      { name: 'Walking', start: '2026-05-04 16:00:00 +1000', duration: 600 },
      { name: 'Running', start: '2026-05-05 07:00:00 +1000', duration: 1800 },
    ]}});
    assert.equal(r.workoutsRows.length, 2);
    const byDate = Object.fromEntries(r.workoutsRows.map(r => [r.date, r]));
    assert.equal(byDate['2026-05-04'].trained, true);
    assert.equal(byDate['2026-05-04'].type, 'Functional Strength Training');
    assert.equal(byDate['2026-05-05'].trained, true);
    assert.equal(byDate['2026-05-05'].type, 'Running');
  });

  test('ignores unrelated metric names', () => {
    const r = parseHAEPayload({ data: { metrics: [
      { name: 'blood_oxygen', data: [{ date: '2026-05-04', qty: 98 }] },
      { name: 'heart_rate', data: [{ date: '2026-05-04', qty: 62 }] },
    ]}});
    assert.deepEqual(r.sleepRows, []);
    assert.deepEqual(r.stepsRows, []);
    assert.deepEqual(r.activeMinutesRows, []);
    assert.deepEqual(r.workoutsRows, []);
  });

  test('malformed samples (missing date or qty) are skipped, not thrown', () => {
    const r = parseHAEPayload({ data: { metrics: [
      { name: 'step_count', data: [
        { date: '2026-05-04', qty: 100 },
        { qty: 200 },              // missing date
        { date: '2026-05-05', qty: 'not-a-number' },
        { date: '2026-05-05', qty: 300 },
      ]},
    ]}});
    const byDate = Object.fromEntries(r.stepsRows.map(r => [r.date, r.count]));
    assert.equal(byDate['2026-05-04'], 100);
    assert.equal(byDate['2026-05-05'], 300);
  });

  test('accepts raw payload without outer data wrapper', () => {
    // Some HAE versions send {metrics:[...]} at the top level
    const r = parseHAEPayload({
      metrics: [{ name: 'step_count', data: [{ date: '2026-05-04', qty: 1500 }] }],
    });
    assert.equal(r.stepsRows.length, 1);
    assert.equal(r.stepsRows[0].count, 1500);
  });
});

describe('mergeByDate', () => {
  test('appends new dates', () => {
    const merged = mergeByDate(
      [{ date: '2026-05-01', hours: 7 }],
      [{ date: '2026-05-02', hours: 8 }],
    );
    assert.equal(merged.length, 2);
    assert.equal(merged[0].date, '2026-05-01');
    assert.equal(merged[1].date, '2026-05-02');
  });

  test('overwrites row for same date', () => {
    const merged = mergeByDate(
      [{ date: '2026-05-01', hours: 7 }],
      [{ date: '2026-05-01', hours: 9 }],
    );
    assert.equal(merged.length, 1);
    assert.equal(merged[0].hours, 9);
  });

  test('sorted by date ascending', () => {
    const merged = mergeByDate(
      [{ date: '2026-05-03', hours: 7 }],
      [{ date: '2026-05-01', hours: 8 }, { date: '2026-05-02', hours: 7.5 }],
    );
    assert.deepEqual(merged.map(r => r.date), ['2026-05-01', '2026-05-02', '2026-05-03']);
  });

  test('handles missing existing data', () => {
    const merged = mergeByDate(null, [{ date: '2026-05-01', hours: 7 }]);
    assert.equal(merged.length, 1);
  });

  test('drops new rows with no date', () => {
    const merged = mergeByDate(
      [{ date: '2026-05-01', hours: 7 }],
      [{ hours: 99 }, { date: '2026-05-02', hours: 8 }],
    );
    assert.equal(merged.length, 2);
    assert.ok(merged.every(r => r.date));
  });
});
