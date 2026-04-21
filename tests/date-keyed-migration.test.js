// tests/date-keyed-migration.test.js
// Pure-function tests for the date-keyed-to-array migrator.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { convertDateKeyedToArray } =
  require(path.join(__dirname, '..', 'scripts', 'migrate-date-keyed-to-array.js'));

describe('convertDateKeyedToArray', () => {
  test('empty object returns empty array', () => {
    const r = convertDateKeyedToArray({});
    assert.equal(r.ok, true);
    assert.deepEqual(r.data, []);
  });

  test('single entry', () => {
    const r = convertDateKeyedToArray({ '2026-04-20': { mood: 4, notes: 'ok' } });
    assert.equal(r.ok, true);
    assert.deepEqual(r.data, [{ date: '2026-04-20', mood: 4, notes: 'ok' }]);
  });

  test('multiple entries sorted ascending by date', () => {
    const r = convertDateKeyedToArray({
      '2026-04-20': { mood: 4 },
      '2026-04-18': { mood: 3 },
      '2026-04-19': { mood: 5 },
    });
    assert.equal(r.ok, true);
    assert.equal(r.data.length, 3);
    assert.equal(r.data[0].date, '2026-04-18');
    assert.equal(r.data[1].date, '2026-04-19');
    assert.equal(r.data[2].date, '2026-04-20');
  });

  test('preserves all fields from each entry', () => {
    const r = convertDateKeyedToArray({
      '2026-04-20': {
        mood: 4,
        notes: 'good day',
        time: '2026-04-20T07:00:00Z',
        wakeUps: 0,
        customField: { nested: true },
      },
    });
    assert.equal(r.data[0].mood, 4);
    assert.equal(r.data[0].notes, 'good day');
    assert.equal(r.data[0].time, '2026-04-20T07:00:00Z');
    assert.equal(r.data[0].wakeUps, 0);
    assert.deepEqual(r.data[0].customField, { nested: true });
  });

  test('does not overwrite existing "date" field if one was already present', () => {
    // Edge case: the value already has a `date` key (shouldn't happen in prod,
    // but defensive). The key-date wins because the spread happens first.
    const r = convertDateKeyedToArray({
      '2026-04-20': { date: 'WRONG', mood: 4 },
    });
    assert.equal(r.data[0].date, '2026-04-20', 'outer key should win');
  });

  test('rejects already-array input', () => {
    const r = convertDateKeyedToArray([]);
    assert.equal(r.ok, false);
    assert.ok(r.reason.includes('array'));
  });

  test('rejects null', () => {
    const r = convertDateKeyedToArray(null);
    assert.equal(r.ok, false);
  });

  test('rejects non-object primitive', () => {
    const r = convertDateKeyedToArray('string');
    assert.equal(r.ok, false);
    const r2 = convertDateKeyedToArray(42);
    assert.equal(r2.ok, false);
  });

  test('rejects object with non-date keys (e.g. schedule card shape)', () => {
    const r = convertDateKeyedToArray({ items: [], groups: [] });
    assert.equal(r.ok, false);
    assert.ok(r.reason.includes('non-date'));
  });

  test('rejects mixed date + non-date keys', () => {
    const r = convertDateKeyedToArray({
      '2026-04-20': { mood: 4 },
      items: [],
    });
    assert.equal(r.ok, false);
  });

  test('rejects date keys whose values are primitives', () => {
    const r = convertDateKeyedToArray({
      '2026-04-20': 'just a string',
    });
    assert.equal(r.ok, false);
    assert.ok(r.reason.includes('not an object'));
  });

  test('rejects date keys whose values are arrays', () => {
    const r = convertDateKeyedToArray({
      '2026-04-20': [1, 2, 3],
    });
    assert.equal(r.ok, false);
  });

  test('keys must match YYYY-MM-DD exactly', () => {
    const badKeys = ['2026/04/20', '20260420', '2026-4-20', '26-04-20', '2026-04-20T00:00:00'];
    for (const k of badKeys) {
      const r = convertDateKeyedToArray({ [k]: { mood: 4 } });
      assert.equal(r.ok, false, `should reject key "${k}"`);
    }
  });
});
