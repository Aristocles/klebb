// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/schedule-time-of-day-validation.test.js
//
// time_of_day on data.items[].schedule: lenient at load (drop bad
// field), strict at create / PATCH (throw).

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateManifestShape } = require('../manifests/registry');

function shape(items) {
  return {
    $schema: 'klebb.datafile.v1',
    meta: { id: 'peptide-cycle', label: 'Injections' },
    data: { items },
  };
}

test.describe('schedule.time_of_day validation', () => {
  test('lenient: keeps a valid string token', () => {
    const m = shape([{ name: 'BPC-157', schedule: { type: 'daily', time_of_day: 'morning' } }]);
    validateManifestShape(m);
    assert.equal(m.data.items[0].schedule.time_of_day, 'morning');
  });

  test('lenient: keeps a valid array of distinct tokens', () => {
    const m = shape([{ name: 'X', schedule: { type: 'daily', time_of_day: ['morning', 'evening'] } }]);
    validateManifestShape(m);
    assert.deepEqual(m.data.items[0].schedule.time_of_day, ['morning', 'evening']);
  });

  test('lenient: drops unknown string token silently', () => {
    const m = shape([{ name: 'X', schedule: { type: 'daily', time_of_day: 'dawn' } }]);
    validateManifestShape(m);
    assert.equal('time_of_day' in m.data.items[0].schedule, false);
  });

  test('lenient: drops array with duplicates silently', () => {
    const m = shape([{ name: 'X', schedule: { type: 'daily', time_of_day: ['morning', 'morning'] } }]);
    validateManifestShape(m);
    assert.equal('time_of_day' in m.data.items[0].schedule, false);
  });

  test('lenient: drops empty array silently', () => {
    const m = shape([{ name: 'X', schedule: { type: 'daily', time_of_day: [] } }]);
    validateManifestShape(m);
    assert.equal('time_of_day' in m.data.items[0].schedule, false);
  });

  test('lenient: drops non-string non-array silently', () => {
    const m = shape([{ name: 'X', schedule: { type: 'daily', time_of_day: 42 } }]);
    validateManifestShape(m);
    assert.equal('time_of_day' in m.data.items[0].schedule, false);
  });

  test('strict: throws on unknown token', () => {
    const m = shape([{ name: 'X', schedule: { type: 'daily', time_of_day: 'dawn' } }]);
    assert.throws(
      () => validateManifestShape(m, { strictId: true }),
      /invalid schedule.time_of_day/,
    );
  });

  test('strict: throws on array with bad entry', () => {
    const m = shape([{ name: 'X', schedule: { type: 'daily', time_of_day: ['morning', 'lunchtime'] } }]);
    assert.throws(
      () => validateManifestShape(m, { strictId: true }),
      /invalid schedule.time_of_day/,
    );
  });

  test('absent field: untouched', () => {
    const m = shape([{ name: 'X', schedule: { type: 'daily' } }]);
    validateManifestShape(m);
    assert.equal('time_of_day' in m.data.items[0].schedule, false);
  });

  test('non-array data.items: ignored', () => {
    const m = {
      $schema: 'klebb.datafile.v1',
      meta: { id: 'card', label: 'X' },
      data: { items: 'not-array' },
    };
    validateManifestShape(m);
  });
});
