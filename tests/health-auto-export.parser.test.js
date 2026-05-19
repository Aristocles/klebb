// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/health-auto-export.parser.test.js
// Pure unit tests for the catalogue entries + helpers. No HTTP, no filesystem.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { toDate, numeric } = require('../health-auto-export/helpers.js');
const catalogue = require('../health-auto-export/catalogue.js');
const { aggregate, mergeByDate } = require('../health-auto-export/ingest.js');

describe('helpers: toDate', () => {
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

describe('helpers: numeric', () => {
  test('parses numbers and numeric strings', () => {
    assert.equal(numeric(42), 42);
    assert.equal(numeric('42.5'), 42.5);
    assert.equal(numeric(0), 0);
  });
  test('returns null for NaN / empty / undefined', () => {
    assert.equal(numeric(undefined), null);
    assert.equal(numeric(null), null);
    assert.equal(numeric(''), null);
    assert.equal(numeric('not a number'), null);
    assert.equal(numeric(NaN), null);
  });
});

describe('catalogue: sleep_analysis', () => {
  const cat = catalogue.sleep_analysis;

  test('prefers totalSleep for hours, preserves other fields passed alongside', () => {
    // asleep=7.3 is kept as a stage-breakdown field; hours comes from totalSleep.
    assert.deepEqual(cat.row({ date: '2026-05-04', totalSleep: 7.8, asleep: 7.3 }),
      { date: '2026-05-04', hours: 7.8, asleep: 7.3 });
  });

  test('falls back to asleep, then inBed, then qty when totalSleep absent', () => {
    assert.deepEqual(cat.row({ date: '2026-05-04', asleep: 7.3, inBed: 8.1 }),
      { date: '2026-05-04', hours: 7.3, asleep: 7.3, inBed: 8.1 });
    assert.deepEqual(cat.row({ date: '2026-05-04', inBed: 8.1 }),
      { date: '2026-05-04', hours: 8.1, inBed: 8.1 });
    assert.deepEqual(cat.row({ date: '2026-05-04', qty: 6.5 }),
      { date: '2026-05-04', hours: 6.5 });
  });

  test('attaches source when present', () => {
    assert.deepEqual(cat.row({ date: '2026-05-04', totalSleep: 7, source: 'Apple Watch' }),
      { date: '2026-05-04', hours: 7, source: 'Apple Watch' });
  });

  test('drops entries with no date or no numeric hours', () => {
    assert.equal(cat.row({ totalSleep: 7 }), null);
    assert.equal(cat.row({ date: '2026-05-04', totalSleep: 'zzz' }), null);
  });

  test('preserves full stage breakdown when HAE provides it', () => {
    assert.deepEqual(cat.row({
      date: '2026-05-04 00:00:00 +1000',
      totalSleep: 7.8, asleep: 7.6, inBed: 8.4,
      deep: 1.2, rem: 1.8, core: 4.6, awake: 0.2,
      source: 'Apple Watch',
    }), {
      date: '2026-05-04',
      hours: 7.8, asleep: 7.6, inBed: 8.4,
      deep: 1.2, rem: 1.8, core: 4.6, awake: 0.2,
      source: 'Apple Watch',
    });
  });

  test('stage fields with non-numeric values are omitted, not zeroed', () => {
    const row = cat.row({
      date: '2026-05-04', totalSleep: 7, deep: 'unknown', rem: null,
    });
    assert.equal(row.hours, 7);
    assert.equal(row.deep, undefined);
    assert.equal(row.rem, undefined);
    assert.ok(!('deep' in row));
    assert.ok(!('rem' in row));
  });

  test('partial stage breakdown: only present fields are copied', () => {
    assert.deepEqual(cat.row({
      date: '2026-05-04', totalSleep: 7, deep: 1.1, rem: 1.5,
    }), { date: '2026-05-04', hours: 7, deep: 1.1, rem: 1.5 });
  });
});

describe('catalogue: step_count', () => {
  const cat = catalogue.step_count;
  test('maps qty -> count', () => {
    assert.deepEqual(cat.row({ date: '2026-05-04 08:00:00 +1000', qty: 1200 }),
      { date: '2026-05-04', count: 1200 });
  });
  test('drops malformed entries', () => {
    assert.equal(cat.row({ qty: 100 }), null);
    assert.equal(cat.row({ date: '2026-05-04', qty: 'lots' }), null);
  });
});

describe('catalogue: apple_exercise_time', () => {
  const cat = catalogue.apple_exercise_time;
  test('maps qty -> minutes', () => {
    assert.deepEqual(cat.row({ date: '2026-05-04', qty: 1 }),
      { date: '2026-05-04', minutes: 1 });
  });
});

describe('catalogue: workouts pseudo-metric', () => {
  const cat = catalogue.workouts;
  test('declares from: workouts', () => {
    assert.equal(cat.from, 'workouts');
  });
  test('derives trained: true from a workout record', () => {
    // The minimum-shape row carries date/trained/type plus startTime
    // (always derivable from `start`). Other enriched fields are
    // covered in detail in tests/health-auto-export.workouts.test.js.
    assert.deepEqual(cat.row({ name: 'Running', start: '2026-05-04 11:00:00 +1000' }),
      { date: '2026-05-04', trained: true, type: 'Running', startTime: '11:00' });
  });
  test('drops records with no date', () => {
    assert.equal(cat.row({ name: 'Running' }), null);
  });
});

describe('catalogue: HRV + resting HR', () => {
  test('heart_rate_variability maps qty -> ms', () => {
    assert.deepEqual(catalogue.heart_rate_variability.row(
      { date: '2026-05-04', qty: 55 }),
      { date: '2026-05-04', ms: 55 });
  });
  test('resting_heart_rate maps qty -> bpm', () => {
    assert.deepEqual(catalogue.resting_heart_rate.row(
      { date: '2026-05-04', qty: 58 }),
      { date: '2026-05-04', bpm: 58 });
  });
});

describe('catalogue: SpO2 + body fat normalise fraction to percent', () => {
  test('blood_oxygen: 0.97 -> 97', () => {
    assert.deepEqual(catalogue.blood_oxygen_saturation.row(
      { date: '2026-05-04', qty: 0.97 }),
      { date: '2026-05-04', pct: 97 });
  });
  test('blood_oxygen: 97 -> 97 (already percent)', () => {
    assert.deepEqual(catalogue.blood_oxygen_saturation.row(
      { date: '2026-05-04', qty: 97 }),
      { date: '2026-05-04', pct: 97 });
  });
  test('body_fat_percentage: 0.18 -> 18', () => {
    assert.deepEqual(catalogue.body_fat_percentage.row(
      { date: '2026-05-04', qty: 0.18 }),
      { date: '2026-05-04', pct: 18 });
  });
});

describe('catalogue: body_mass + mindful_minutes + blood_pressure', () => {
  test('body_mass maps qty -> kg', () => {
    assert.deepEqual(catalogue.body_mass.row(
      { date: '2026-05-04', qty: 78.5 }),
      { date: '2026-05-04', kg: 78.5 });
  });
  test('mindful_minutes maps qty -> minutes', () => {
    assert.deepEqual(catalogue.mindful_minutes.row(
      { date: '2026-05-04', qty: 10 }),
      { date: '2026-05-04', minutes: 10 });
  });
  test('blood_pressure_systolic / _diastolic are separate entries', () => {
    assert.deepEqual(catalogue.blood_pressure_systolic.row(
      { date: '2026-05-04', qty: 118 }),
      { date: '2026-05-04', systolic: 118 });
    assert.deepEqual(catalogue.blood_pressure_diastolic.row(
      { date: '2026-05-04', qty: 76 }),
      { date: '2026-05-04', diastolic: 76 });
  });
});

describe('aggregate', () => {
  test('last-per-date: last row wins', () => {
    const out = aggregate([
      { date: '2026-05-04', hours: 6 },
      { date: '2026-05-04', hours: 7 },
    ], 'last-per-date');
    assert.equal(out.length, 1);
    assert.equal(out[0].hours, 7);
  });

  test('sum-per-date: sums numeric fields, rounds to int', () => {
    const out = aggregate([
      { date: '2026-05-04', count: 1200.5 },
      { date: '2026-05-04', count: 3200 },
      { date: '2026-05-04', count: 500.3 },
      { date: '2026-05-05', count: 2000 },
    ], 'sum-per-date');
    const byDate = Object.fromEntries(out.map(r => [r.date, r.count]));
    assert.equal(byDate['2026-05-04'], 4901);   // 1200.5 + 3200 + 500.3 = 4900.8 -> 4901
    assert.equal(byDate['2026-05-05'], 2000);
  });

  test('mean-per-date: averages numeric fields, one decimal', () => {
    const out = aggregate([
      { date: '2026-05-04', bpm: 58 },
      { date: '2026-05-04', bpm: 62 },
    ], 'mean-per-date');
    assert.equal(out[0].bpm, 60);
  });

  test('max-per-date', () => {
    const out = aggregate([
      { date: '2026-05-04', v: 3 },
      { date: '2026-05-04', v: 7 },
      { date: '2026-05-04', v: 5 },
    ], 'max-per-date');
    assert.equal(out[0].v, 7);
  });

  test('boolean-any-per-date: any truthy boolean wins', () => {
    const out = aggregate([
      { date: '2026-05-04', trained: true, type: 'Running' },
      { date: '2026-05-04', trained: true, type: 'Walking' },
    ], 'boolean-any-per-date');
    assert.equal(out.length, 1);
    assert.equal(out[0].trained, true);
    assert.equal(out[0].type, 'Running');   // head wins for scalar fields
  });

  test('empty input returns empty array', () => {
    assert.deepEqual(aggregate([], 'sum-per-date'), []);
    assert.deepEqual(aggregate(null, 'sum-per-date'), []);
  });

  test('sorted by date ascending', () => {
    const out = aggregate([
      { date: '2026-05-05', count: 1 },
      { date: '2026-05-03', count: 2 },
      { date: '2026-05-04', count: 3 },
    ], 'sum-per-date');
    assert.deepEqual(out.map(r => r.date), ['2026-05-03', '2026-05-04', '2026-05-05']);
  });
});

describe('mergeByDate', () => {
  test('appends new dates', () => {
    const merged = mergeByDate(
      [{ date: '2026-05-01', hours: 7 }],
      [{ date: '2026-05-02', hours: 8 }],
    );
    assert.equal(merged.length, 2);
  });

  test('overwrites row for same date', () => {
    const merged = mergeByDate(
      [{ date: '2026-05-01', hours: 7 }],
      [{ date: '2026-05-01', hours: 9 }],
    );
    assert.equal(merged.length, 1);
    assert.equal(merged[0].hours, 9);
  });

  test('drops new rows with no date', () => {
    const merged = mergeByDate(
      [{ date: '2026-05-01', hours: 7 }],
      [{ hours: 99 }, { date: '2026-05-02', hours: 8 }],
    );
    assert.equal(merged.length, 2);
    assert.ok(merged.every(r => r.date));
  });

  test('handles null existing', () => {
    const merged = mergeByDate(null, [{ date: '2026-05-01', hours: 7 }]);
    assert.equal(merged.length, 1);
  });
});
