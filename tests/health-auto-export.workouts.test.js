// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/health-auto-export.workouts.test.js
//
// Coverage for #235: enriched HAE workouts row recipe + the
// workouts-merge-per-date aggregator that combines several same-date
// sessions into one daily summary.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const catalogue = require('../health-auto-export/catalogue');
const { aggregate } = require('../health-auto-export/ingest');

// --- row recipe ----------------------------------------------------------

describe('catalogue.workouts.row()', () => {
  test('emits date + trained + type + start time on the simplest payload', () => {
    const row = catalogue.workouts.row({
      name: 'Functional Strength Training',
      start: '2026-05-04 09:30:00 +1000',
      duration: 1800,
    });
    assert.equal(row.date, '2026-05-04');
    assert.equal(row.trained, true);
    assert.equal(row.type, 'Functional Strength Training');
    assert.equal(row.durationMin, 30);
    assert.equal(row.startTime, '09:30');
  });

  test('emits all enriched fields on a fully-populated v2 payload', () => {
    const row = catalogue.workouts.row({
      name: 'Outdoor Walk',
      start: '2026-05-14 14:05:42 +1000',
      duration: 2804.4456186294556,
      distance: { qty: 1.59169161061874, units: 'km' },
      activeEnergyBurned: { qty: 518.89914937614969, units: 'kJ' },
      avgHeartRate: { qty: 97.480536266644847, units: 'bpm' },
      maxHeartRate: { qty: 118, units: 'bpm' },
      elevationUp: { qty: 45.46, units: 'm' },
    });
    assert.equal(row.durationMin, 47);
    assert.equal(row.distanceKm, 1.59);
    assert.equal(row.calories, 124);          // 518.9 kJ / 4.184 ≈ 124 kcal
    assert.equal(row.avgHr, 97);
    assert.equal(row.maxHr, 118);
    assert.equal(row.elevationM, 45);
    assert.equal(row.startTime, '14:05');
  });

  test('drops absent optional fields rather than emitting null', () => {
    const row = catalogue.workouts.row({
      name: 'Functional Strength Training',
      start: '2026-05-04 09:30:00 +1000',
      duration: 1800,
      distance: null,
      activeEnergyBurned: { qty: 120, units: 'kcal' },
      // No HR fields, no elevation.
    });
    assert.equal(row.calories, 120);
    assert.ok(!('distanceKm' in row),  'distanceKm should be absent');
    assert.ok(!('avgHr' in row),       'avgHr should be absent');
    assert.ok(!('maxHr' in row),       'maxHr should be absent');
    assert.ok(!('elevationM' in row),  'elevationM should be absent');
  });

  test('falls back to nested heartRate.{avg,max} when flat fields missing', () => {
    const row = catalogue.workouts.row({
      name: 'Cycling',
      start: '2026-05-04 06:00:00 +1000',
      duration: 1800,
      heartRate: {
        avg: { qty: 142, units: 'bpm' },
        max: { qty: 168, units: 'bpm' },
        min: { qty: 95,  units: 'bpm' },
      },
    });
    assert.equal(row.avgHr, 142);
    assert.equal(row.maxHr, 168);
  });

  test('normalises mi → km on distance', () => {
    const row = catalogue.workouts.row({
      name: 'Outdoor Run',
      start: '2026-05-04 06:00:00 +1000',
      duration: 1800,
      distance: { qty: 3.1, units: 'mi' },
    });
    // 3.1 mi * 1.609344 = 4.989 → rounded to 4.99
    assert.equal(row.distanceKm, 4.99);
  });

  test('normalises kJ → kcal on activeEnergyBurned', () => {
    const row = catalogue.workouts.row({
      name: 'Lift',
      start: '2026-05-04 09:00:00 +1000',
      duration: 1800,
      activeEnergyBurned: { qty: 1104.576, units: 'kJ' },
    });
    // 1104.576 / 4.184 ≈ 264 kcal
    assert.equal(row.calories, 264);
  });

  test('normalises ft → m on elevationUp', () => {
    const row = catalogue.workouts.row({
      name: 'Hike',
      start: '2026-05-04 08:00:00 +1000',
      duration: 3600,
      elevationUp: { qty: 100, units: 'ft' },
    });
    // 100 ft * 0.3048 = 30.48 → 30 m
    assert.equal(row.elevationM, 30);
  });

  test('falls back to v1 elevation.ascent when v2 elevationUp absent', () => {
    const row = catalogue.workouts.row({
      name: 'Hike',
      start: '2026-05-04 08:00:00 +1000',
      duration: 3600,
      elevation: { ascent: 50, descent: 30, units: 'm' },
    });
    assert.equal(row.elevationM, 50);
  });

  test('drops a non-finite duration silently', () => {
    const row = catalogue.workouts.row({
      name: 'Yoga',
      start: '2026-05-04 18:00:00 +1000',
      duration: 'not-a-number',
    });
    assert.ok(!('durationMin' in row));
    assert.equal(row.trained, true);
  });

  test('drops malformed entries with no date', () => {
    assert.equal(catalogue.workouts.row({ name: 'Mystery' }), null);
  });

  test('declares the workouts-merge-per-date aggregator', () => {
    assert.equal(catalogue.workouts.aggregate, 'workouts-merge-per-date');
  });
});

// --- same-date merge ----------------------------------------------------

describe('aggregate(workouts-merge-per-date)', () => {
  test('passes a single-row day through with all fields preserved', () => {
    const out = aggregate([{
      date: '2026-05-04', trained: true, type: 'Outdoor Walk',
      durationMin: 30, distanceKm: 2.5, calories: 200,
      avgHr: 110, maxHr: 130, elevationM: 25, startTime: '09:30',
    }], 'workouts-merge-per-date');
    assert.equal(out.length, 1);
    assert.deepEqual(out[0], {
      date: '2026-05-04', sessionCount: 1, trained: true, type: 'Outdoor Walk',
      durationMin: 30, distanceKm: 2.5, calories: 200,
      avgHr: 110, maxHr: 130, elevationM: 25, startTime: '09:30',
    });
  });

  test('sums additive fields across two same-date entries', () => {
    const out = aggregate([
      { date: '2026-05-04', trained: true, type: 'Functional Strength Training',
        durationMin: 45, calories: 320, startTime: '07:00' },
      { date: '2026-05-04', trained: true, type: 'Outdoor Walk',
        durationMin: 30, distanceKm: 2.1, calories: 110,
        avgHr: 110, maxHr: 130, startTime: '18:30' },
    ], 'workouts-merge-per-date');
    assert.equal(out.length, 1);
    const r = out[0];
    assert.equal(r.durationMin, 75);
    assert.equal(r.distanceKm, 2.1);             // only the walk had distance
    assert.equal(r.calories, 430);
    assert.equal(r.startTime, '07:00');
    assert.equal(r.type, 'Functional Strength Training, Outdoor Walk');
  });

  test('three-on-same-day rolls up to one row, type list deduped', () => {
    const out = aggregate([
      { date: '2026-05-14', trained: true, type: 'Outdoor Walk',
        durationMin: 47, distanceKm: 1.59, calories: 124,
        avgHr: 97, maxHr: 118, elevationM: 45, startTime: '14:05' },
      { date: '2026-05-14', trained: true, type: 'Outdoor Walk',
        durationMin: 17, distanceKm: 0.95, calories: 73,
        avgHr: 113, maxHr: 136, startTime: '12:48' },
      { date: '2026-05-14', trained: true, type: 'Outdoor Walk',
        durationMin: 29, distanceKm: 1.86, calories: 119,
        avgHr: 96, maxHr: 120, elevationM: 40, startTime: '09:40' },
    ], 'workouts-merge-per-date');
    assert.equal(out.length, 1);
    const r = out[0];
    assert.equal(r.type, 'Outdoor Walk');         // dedup → single string
    assert.equal(r.durationMin, 93);              // 47 + 17 + 29
    assert.equal(r.distanceKm, 4.40);             // 1.59 + 0.95 + 1.86 = 4.40
    assert.equal(r.calories, 316);                // 124 + 73 + 119
    assert.equal(r.elevationM, 85);               // 45 + 40 (middle entry had none)
    assert.equal(r.maxHr, 136);                   // max across the three
    assert.equal(r.startTime, '09:40');           // earliest local start
    // Weighted-average HR: (97*47 + 113*17 + 96*29) / 93 ≈ 100
    assert.equal(r.avgHr, 100);
  });

  test('partial HR data: only entries with HR contribute', () => {
    const out = aggregate([
      { date: '2026-05-04', trained: true, type: 'Lift',
        durationMin: 45, startTime: '07:00' },
      { date: '2026-05-04', trained: true, type: 'Walk',
        durationMin: 30, avgHr: 100, maxHr: 120, startTime: '18:00' },
    ], 'workouts-merge-per-date');
    assert.equal(out[0].avgHr, 100);
    assert.equal(out[0].maxHr, 120);
  });

  test('flat-mean HR fallback when no entry carries duration', () => {
    const out = aggregate([
      { date: '2026-05-04', trained: true, type: 'A', avgHr: 100 },
      { date: '2026-05-04', trained: true, type: 'B', avgHr: 140 },
    ], 'workouts-merge-per-date');
    assert.equal(out[0].avgHr, 120);
  });

  test('preserves a minimal {date, trained, type} legacy row unchanged', () => {
    // Backwards compat: rows from before #235 stored only these three keys
    // and must continue to validate + render.
    const out = aggregate([
      { date: '2026-04-01', trained: true, type: 'Functional Strength Training' },
    ], 'workouts-merge-per-date');
    assert.equal(out.length, 1);
    assert.equal(out[0].trained, true);
    assert.equal(out[0].type, 'Functional Strength Training');
    assert.ok(!('durationMin' in out[0]));
    assert.ok(!('avgHr' in out[0]));
  });

  test('groups by date: two days end up as two rows', () => {
    const out = aggregate([
      { date: '2026-05-04', trained: true, type: 'Walk', durationMin: 30, startTime: '08:00' },
      { date: '2026-05-05', trained: true, type: 'Walk', durationMin: 25, startTime: '08:00' },
    ], 'workouts-merge-per-date');
    assert.equal(out.length, 2);
    assert.deepEqual(out.map(r => r.date), ['2026-05-04', '2026-05-05']);
  });

  test('mixed-type same-day: chronological dedup list, no duplicate strings', () => {
    const out = aggregate([
      { date: '2026-05-04', trained: true, type: 'Outdoor Walk',
        durationMin: 30, startTime: '07:30' },
      { date: '2026-05-04', trained: true, type: 'Functional Strength Training',
        durationMin: 45, startTime: '11:00' },
      { date: '2026-05-04', trained: true, type: 'Outdoor Walk',
        durationMin: 20, startTime: '18:00' },
    ], 'workouts-merge-per-date');
    assert.equal(out.length, 1);
    assert.equal(out[0].type, 'Outdoor Walk, Functional Strength Training');
  });

  test('emits sessionCount = 1 for a single-session day', () => {
    const out = aggregate([
      { date: '2026-05-04', trained: true, type: 'Outdoor Walk', durationMin: 30 },
    ], 'workouts-merge-per-date');
    assert.equal(out[0].sessionCount, 1);
  });

  test('emits sessionCount equal to the number of merged sessions', () => {
    const out = aggregate([
      { date: '2026-05-04', trained: true, type: 'Outdoor Walk', startTime: '07:30' },
      { date: '2026-05-04', trained: true, type: 'Functional Strength Training', startTime: '11:00' },
      { date: '2026-05-04', trained: true, type: 'Cycling', startTime: '18:00' },
    ], 'workouts-merge-per-date');
    assert.equal(out.length, 1);
    assert.equal(out[0].sessionCount, 3);
  });

  test('sessionCount is per-date: separate days get their own count', () => {
    const out = aggregate([
      { date: '2026-05-04', trained: true, type: 'Walk', startTime: '08:00' },
      { date: '2026-05-04', trained: true, type: 'Lift', startTime: '18:00' },
      { date: '2026-05-05', trained: true, type: 'Walk', startTime: '08:00' },
    ], 'workouts-merge-per-date');
    assert.equal(out.length, 2);
    const byDate = Object.fromEntries(out.map(r => [r.date, r.sessionCount]));
    assert.equal(byDate['2026-05-04'], 2);
    assert.equal(byDate['2026-05-05'], 1);
  });
});
