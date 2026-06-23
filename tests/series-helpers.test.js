// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/series-helpers.test.js
// Coverage for the pure series extractors that feed sparklines:
// numericSeries (display-template.js) and adherenceSeries +
// itemAdherenceSeries (adherence-series.esm.js). The ESM module is pulled
// in via dynamic import so the CJS test runner can exercise it directly.

const { test, describe, before } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { pathToFileURL } = require('url');
const { numericSeries } = require('../public/js/lib/display-template.js');

let adherenceSeries;
let itemAdherenceSeries;

before(async () => {
  const p = path.join(__dirname, '..', 'public', 'js', 'lib', 'adherence-series.esm.js');
  const mod = await import(pathToFileURL(p).href);
  adherenceSeries = mod.adherenceSeries;
  itemAdherenceSeries = mod.itemAdherenceSeries;
});

describe('numericSeries', () => {
  test('returns values in ascending date order regardless of input order', () => {
    const rows = [
      { date: '2026-01-03', kg: 82 },
      { date: '2026-01-01', kg: 80 },
      { date: '2026-01-02', kg: 81 },
    ];
    assert.deepStrictEqual(numericSeries(rows, 'kg'), [80, 81, 82]);
  });

  test('clips rows after endDate (inclusive of endDate itself)', () => {
    const rows = [
      { date: '2026-01-01', kg: 80 },
      { date: '2026-01-02', kg: 81 },
      { date: '2026-01-03', kg: 82 },
    ];
    assert.deepStrictEqual(numericSeries(rows, 'kg', { endDate: '2026-01-02' }), [80, 81]);
  });

  test('keeps only the most recent `limit` values (tail slice)', () => {
    const rows = [
      { date: '2026-01-01', kg: 1 },
      { date: '2026-01-02', kg: 2 },
      { date: '2026-01-03', kg: 3 },
      { date: '2026-01-04', kg: 4 },
    ];
    assert.deepStrictEqual(numericSeries(rows, 'kg', { limit: 2 }), [3, 4]);
  });

  test('drops rows missing a date', () => {
    const rows = [
      { date: '2026-01-01', kg: 80 },
      { kg: 99 },
      { date: '2026-01-02', kg: 81 },
    ];
    assert.deepStrictEqual(numericSeries(rows, 'kg'), [80, 81]);
  });

  test('drops rows whose value is not Number-able', () => {
    const rows = [
      { date: '2026-01-01', kg: 80 },
      { date: '2026-01-02', kg: 'heavy' },
      { date: '2026-01-03', kg: null },
      { date: '2026-01-04', kg: 82 },
    ];
    assert.deepStrictEqual(numericSeries(rows, 'kg'), [80, 82]);
  });

  test('resolves dotted-path fields via getValue', () => {
    const rows = [
      { date: '2026-01-01', bp: { systolic: 120 } },
      { date: '2026-01-02', bp: { systolic: 118 } },
    ];
    assert.deepStrictEqual(numericSeries(rows, 'bp.systolic'), [120, 118]);
  });

  test('returns [] when no rows qualify', () => {
    assert.deepStrictEqual(numericSeries([{ kg: 80 }], 'kg'), []);
    assert.deepStrictEqual(numericSeries([], 'kg'), []);
    assert.deepStrictEqual(numericSeries(null, 'kg'), []);
  });

  test('numeric strings count and coerce to numbers', () => {
    const rows = [
      { date: '2026-01-01', kg: '80' },
      { date: '2026-01-02', kg: '81.5' },
    ];
    assert.deepStrictEqual(numericSeries(rows, 'kg'), [80, 81.5]);
  });
});

describe('adherenceSeries', () => {
  // Items carry a set of due dates and a set of taken dates for the test
  // callbacks to read; the helper itself stays schedule-agnostic.
  const isDueOn = (item, day) => item.due.includes(day);
  const isTakenOn = (item, day) => item.taken.includes(day);

  test('emits the per-day done/due ratio, oldest to newest', () => {
    const items = [
      { due: ['2026-01-01', '2026-01-02', '2026-01-03'], taken: ['2026-01-01', '2026-01-03'] },
      { due: ['2026-01-01', '2026-01-02', '2026-01-03'], taken: ['2026-01-02', '2026-01-03'] },
    ];
    const series = adherenceSeries(items, {
      endDate: '2026-01-03', limit: 3, isDueOn, isTakenOn,
    });
    // 01: item-a taken only -> 1/2; 02: item-b taken only -> 1/2; 03: both -> 2/2
    assert.deepStrictEqual(series, [0.5, 0.5, 1]);
  });

  test('pushes null for a day with no due items (gap, not a miss)', () => {
    const items = [
      { due: ['2026-01-01', '2026-01-03'], taken: ['2026-01-01'] },
    ];
    const series = adherenceSeries(items, {
      endDate: '2026-01-03', limit: 3, isDueOn, isTakenOn,
    });
    // 01 due+taken -> 1; 02 not due -> null; 03 due+not-taken -> 0
    assert.deepStrictEqual(series, [1, null, 0]);
  });

  test('a rest/off day is null, never counted as a zero miss', () => {
    const items = [{ due: ['2026-01-02'], taken: [] }];
    const series = adherenceSeries(items, {
      endDate: '2026-01-02', limit: 2, isDueOn, isTakenOn,
    });
    // 01 nothing due -> null; 02 due but not taken -> 0
    assert.deepStrictEqual(series, [null, 0]);
  });

  test('window length matches limit and ends at endDate', () => {
    const items = [{ due: ['2026-03-10'], taken: ['2026-03-10'] }];
    const series = adherenceSeries(items, {
      endDate: '2026-03-10', limit: 5, isDueOn, isTakenOn,
    });
    assert.strictEqual(series.length, 5);
    assert.deepStrictEqual(series, [null, null, null, null, 1]);
  });

  test('window is UTC-safe across a month boundary', () => {
    const items = [
      { due: ['2026-01-31', '2026-02-01'], taken: ['2026-02-01'] },
    ];
    const series = adherenceSeries(items, {
      endDate: '2026-02-01', limit: 2, isDueOn, isTakenOn,
    });
    assert.deepStrictEqual(series, [0, 1]);
  });

  test('returns [] when callbacks or items are invalid', () => {
    assert.deepStrictEqual(adherenceSeries(null, { endDate: '2026-01-01', isDueOn, isTakenOn }), []);
    assert.deepStrictEqual(adherenceSeries([], { endDate: '2026-01-01' }), []);
    assert.deepStrictEqual(adherenceSeries([], { endDate: 'not-a-date', limit: 3, isDueOn, isTakenOn }), []);
  });
});

describe('itemAdherenceSeries', () => {
  const isScheduled = (item, day) => item.due.includes(day);
  const isTaken = (item, day) => item.taken.includes(day);

  test('emits 1 taken / 0 missed over scheduled days, null otherwise', () => {
    const item = { due: ['2026-01-01', '2026-01-03'], taken: ['2026-01-01'] };
    const series = itemAdherenceSeries(item, {
      endDate: '2026-01-03', limit: 3, isScheduled, isTaken,
    });
    assert.deepStrictEqual(series, [1, null, 0]);
  });

  test('returns [] when callbacks are missing', () => {
    assert.deepStrictEqual(itemAdherenceSeries({}, { endDate: '2026-01-01' }), []);
  });
});
