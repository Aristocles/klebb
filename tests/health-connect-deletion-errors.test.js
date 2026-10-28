// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Independent fixed shared-wire vectors; execution is reported separately.
const test = require('node:test');
const assert = require('node:assert/strict');
const { decodeMessage } = require('../lib/health-connect/protocol');
const fixtures = require('./fixtures/health-connect/deletion-error-v1.json');

test('deletion error consumer preserves independently fixed accepted frames', () => {
  for (const vector of fixtures.cases) {
    const bytes = Buffer.from(vector.wire, 'utf8');
    assert.equal(bytes.length, vector.expectedBytes, vector.id);
    const parsed = decodeMessage(bytes);
    assert.deepEqual(JSON.parse(JSON.stringify(parsed)), vector.expectedFrame, vector.id);
    assert.equal(parsed.retryable, false, vector.id);
    assert.ok(Object.isFrozen(parsed), vector.id);
    assert.throws(() => { parsed.code = 'conflict'; }, TypeError);
  }
});

test('deletion error consumer refuses independently fixed malformed frames', () => {
  for (const vector of fixtures.rejectedCases) {
    const bytes = Buffer.from(vector.wire, 'utf8');
    assert.equal(bytes.length, vector.expectedBytes, vector.id);
    assert.throws(() => decodeMessage(bytes), error => {
      assert.equal(error.code, vector.expectedCode, vector.id);
      assert.equal(error.message, vector.expectedCode, vector.id);
      return true;
    });
  }
});
