// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const original = require('./fixtures/managed-v3-codec-vectors.json');
const vectors = require('./fixtures/managed-v3-nonempty-controls.json');
const { encodeOrdinaryHistory, decodeOrdinaryHistory, PublicationError } = require('../lib/import/native-publication');
const OPTIONS = Object.freeze({ controlProfileVersion: 3 });
const sha = value => 'sha256:' + crypto.createHash('sha256').update(value).digest('hex');
const invalid = error => error instanceof PublicationError && error.status === 400 &&
  error.code === 'IMPORT_PUBLICATION_INVALID';
function checkLiteral(value) {
  const input = Buffer.from(value.payloadUTF8), footer = Buffer.from(value.footerUTF8);
  assert.equal(input.length, value.payloadBytes);
  assert.equal(sha(input), value.payloadSHA256);
  assert.equal(footer.length, value.footerBytes);
  assert.equal(sha(footer), value.footerSHA256);
  assert.equal(JSON.parse(value.footerUTF8).sha256, value.payloadSHA256);
}
test('MVCD00: all nine closed families retain nonempty deletion and suppression controls', () => {
  checkLiteral(original.initial);
  for (const vector of [...original.positive, ...original.negative]) checkLiteral(vector.candidate);
  assert.equal(original.positive.length, 3);
  assert.equal(original.negative.length, 11);
  const initial = encodeOrdinaryHistory(JSON.parse(original.initial.payloadUTF8));
  assert.deepEqual(initial.inputBytes, Buffer.from(original.initial.payloadUTF8));
  assert.deepEqual(initial.footerBytes, Buffer.from(original.initial.footerUTF8));
  const value = vectors.positive[0].candidate;
  checkLiteral(value);
  assert.deepEqual(vectors.families, ['catalog', 'records', 'sourcePolicies', 'streams',
    'receipts', 'projectionOutbox', 'tombstones', 'deletionGuards', 'suppressions']);
  const input = Buffer.from(value.payloadUTF8), footer = Buffer.from(value.footerUTF8);
  const inputBefore = Buffer.from(input), footerBefore = Buffer.from(footer);
  const inventory = JSON.parse(value.payloadUTF8), before = JSON.stringify(inventory);
  assert.deepEqual(Object.keys(inventory), vectors.families);
  assert.equal(inventory.catalog.namespaces.length, 2);
  for (const family of vectors.families.slice(1)) assert.ok(inventory[family].length > 0, family);
  assert.equal(inventory.tombstones.length, 2);
  assert.equal(inventory.deletionGuards.length, 3);
  assert.equal(inventory.suppressions.length, 2);
  assert.deepEqual(inventory.deletionGuards.map(row => [row.sourceDeleted, row.userSuppressed]),
    [[1, 0], [1, 1], [0, 1]]);
  assert.equal(inventory.sourcePolicies[1].sources[0].lifecycle, 'retired');
  assert.equal(inventory.sourcePolicies[1].sources[0].categories[0].sharing, 'enabled');
  assert.equal(inventory.sourcePolicies[1].sources[0].categories[1].sharing, 'stopped');
  const decoded = decodeOrdinaryHistory(input, footer, OPTIONS);
  assert.equal(decoded.inputJSON, value.payloadUTF8);
  assert.equal(decoded.envelopeJSON, value.footerUTF8);
  assert.deepEqual(decoded.inventory, inventory);
  assert.deepEqual(decoded.envelope.counts, value.counts);
  const encoded = encodeOrdinaryHistory(inventory, OPTIONS);
  assert.deepEqual(encoded.inputBytes, inputBefore);
  assert.deepEqual(encoded.footerBytes, footerBefore);
  assert.equal(JSON.stringify(inventory), before);
  assert.deepEqual(input, inputBefore);
  assert.deepEqual(footer, footerBefore);
  assert.throws(() => decodeOrdinaryHistory(input, footer), invalid);
  assert.throws(() => encodeOrdinaryHistory(inventory), invalid);
});
for (const vector of vectors.negative) test(vector.id + ': ' + vector.description, () => {
  const value = vector.candidate;
  checkLiteral(value);
  const input = Buffer.from(value.payloadUTF8), footer = Buffer.from(value.footerUTF8);
  const inputBefore = Buffer.from(input), footerBefore = Buffer.from(footer);
  const inventory = JSON.parse(value.payloadUTF8), before = JSON.stringify(inventory);
  assert.throws(() => decodeOrdinaryHistory(input, footer, OPTIONS), invalid);
  assert.throws(() => encodeOrdinaryHistory(inventory, OPTIONS), invalid);
  assert.equal(JSON.stringify(inventory), before);
  assert.deepEqual(input, inputBefore);
  assert.deepEqual(footer, footerBefore);
});
