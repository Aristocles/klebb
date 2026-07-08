// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/node-floor.test.js
// The boot-time Node version guard: fail fast, with a clear message, below the
// node:sqlite floor (22.13); pass at or above it.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { assertNodeFloor, meetsFloor } = require('../lib/node-floor');

describe('node floor guard', () => {
  test('rejects Node below the floor', () => {
    for (const v of ['v20.0.0', 'v22.0.0', 'v22.12.9', '18.19.1']) {
      assert.equal(meetsFloor(v), false, `${v} should be below floor`);
    }
  });

  test('accepts Node at or above the floor', () => {
    for (const v of ['v22.13.0', 'v22.13.1', 'v22.23.1', 'v23.4.0', 'v24.15.0']) {
      assert.equal(meetsFloor(v), true, `${v} should meet floor`);
    }
  });

  test('assertNodeFloor throws a clear, actionable message below the floor', () => {
    assert.throws(
      () => assertNodeFloor('v20.11.0'),
      (e) => /Node >= 22\.13/.test(e.message) && /node:sqlite/.test(e.message) && /v20\.11\.0/.test(e.message),
    );
  });

  test('assertNodeFloor is a no-op at or above the floor', () => {
    assert.doesNotThrow(() => assertNodeFloor('v22.13.0'));
    assert.doesNotThrow(() => assertNodeFloor('v24.15.0'));
  });

  test('unparseable version never blocks boot', () => {
    assert.equal(meetsFloor('weird'), true);
    assert.doesNotThrow(() => assertNodeFloor('weird'));
  });
});
