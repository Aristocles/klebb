// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/format-hours.test.js
// Direct unit tests for the decimal-hours → H:MM helper.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { hoursToHM } = require('../public/js/lib/format-hours.js');

describe('hoursToHM', () => {
  test('integer hours render as H:00', () => {
    assert.equal(hoursToHM(0), '0:00');
    assert.equal(hoursToHM(1), '1:00');
    assert.equal(hoursToHM(8), '8:00');
  });

  test('typical decimals render as H:MM', () => {
    assert.equal(hoursToHM(8.17), '8:10');
    assert.equal(hoursToHM(0.92), '0:55');
    assert.equal(hoursToHM(7.5), '7:30');
    assert.equal(hoursToHM(8.25), '8:15');
  });

  test('carries over when minutes round to 60', () => {
    assert.equal(hoursToHM(0.999), '1:00');
    assert.equal(hoursToHM(7.999), '8:00');
  });

  test('numeric strings work', () => {
    assert.equal(hoursToHM('8.5'), '8:30');
  });

  test('non-numeric returns null', () => {
    assert.equal(hoursToHM(null), null);
    assert.equal(hoursToHM(undefined), null);
    assert.equal(hoursToHM('oops'), null);
    assert.equal(hoursToHM(NaN), null);
    assert.equal(hoursToHM(Infinity), null);
  });

  test('negative clamps at 0:00', () => {
    assert.equal(hoursToHM(-1), '0:00');
    assert.equal(hoursToHM(-0.5), '0:00');
  });
});
