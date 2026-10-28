// SPDX-License-Identifier: AGPL-3.0-only
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { decodeMessage, payloadDigest } = require('../lib/health-connect/protocol');
const fixtures = require('./fixtures/health-connect/durable-receipt-v1.json');
const bank = require('./fixtures/health-connect/durable-history-independent-vectors.json');
const hash = text => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
const received = vector => vector.wireHex ? Buffer.from(vector.wireHex, 'hex') :
  Buffer.from(vector.wire, 'utf8');
const context = vector => vector.context || {
  binding: fixtures.binding, categories: fixtures.categories
};

test('receipt expectations retain every frozen wire-bank identity and original digest', () => {
  assert.equal(fixtures.sourceBankCases.length, 8);
  assert.deepEqual(fixtures.sourceBankCases, bank.vectors.map(vector => vector.id));
  for (const source of bank.vectors) {
    const expected = fixtures.cases.find(vector => vector.id === source.id);
    assert.ok(expected, source.id);
    assert.deepEqual(expected.expectedReceipt, source.expectedReceipt, source.id);
    assert.equal(expected.payloadJson, source.payloadJson, source.id);
    assert.equal(expected.expectedReceipt.payloadDigest, hash(source.payloadJson), source.id);
  }
});

for (const vector of fixtures.cases) {
  test(`durable receipt preserves independently fixed fields and bytes: ${vector.id}`, () => {
    const bytes = received(vector);
    assert.equal(bytes.length, vector.expectedBytes);
    assert.equal(hash(vector.payloadJson), vector.expectedReceipt.payloadDigest);
    assert.equal(payloadDigest(vector.payloadJson), vector.expectedReceipt.payloadDigest);
    const parsed = decodeMessage(bytes, context(vector));
    assert.deepEqual(JSON.parse(JSON.stringify(parsed)), vector.expectedReceipt);
    assert.equal(typeof parsed.sequence, 'string');
    assert.equal(typeof parsed.binding.generation, 'string');
    assert.equal(parsed.sequence, vector.expectedReceipt.sequence);
    assert.equal(parsed.binding.generation, vector.expectedReceipt.binding.generation);
    assert.ok(Object.isFrozen(parsed));
    assert.ok(Object.isFrozen(parsed.binding));
    assert.throws(() => { parsed.sequence = '2'; }, TypeError);
    assert.throws(() => { parsed.binding.restoreEpoch = 'other'; }, TypeError);
  });
}

test('receipt digests preserve exact original payload spacing rather than JSON equivalence', () => {
  const initial = fixtures.cases.find(vector => vector.id === 'initial-raw-only');
  const spaced = fixtures.cases.find(vector => vector.id === 'original-payload-trailing-space');
  assert.deepEqual(JSON.parse(initial.payloadJson), JSON.parse(spaced.payloadJson));
  assert.notEqual(initial.payloadJson, spaced.payloadJson);
  assert.notEqual(initial.expectedReceipt.payloadDigest, spaced.expectedReceipt.payloadDigest);
  assert.equal(decodeMessage(received(spaced), context(spaced)).payloadDigest,
    spaced.expectedReceipt.payloadDigest);
});

for (const vector of fixtures.rejectedCases) {
  test(`durable receipt refuses independently specified wire: ${vector.id}`, () => {
    const bytes = received(vector);
    assert.equal(bytes.length, vector.expectedBytes);
    assert.throws(() => decodeMessage(bytes, context(vector)), error => {
      assert.equal(error.code, vector.expectedCode);
      assert.equal(error.message, vector.expectedCode);
      return true;
    });
  });
}
