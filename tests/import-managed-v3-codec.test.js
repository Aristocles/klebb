// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const vectors = require('./fixtures/managed-v3-codec-vectors.json');
const { encodeOrdinaryHistory, decodeOrdinaryHistory, PublicationError } = require('../lib/import/native-publication');
const OPTIONS = Object.freeze({ controlProfileVersion: 3 });
const sha = value => 'sha256:' + crypto.createHash('sha256').update(value).digest('hex');
const invalid = error => error instanceof PublicationError && error.status === 400 &&
  error.code === 'IMPORT_PUBLICATION_INVALID';

function checkLiteral(value) {
  const input = Buffer.from(value.payloadUTF8, 'utf8');
  const footer = Buffer.from(value.footerUTF8, 'utf8');
  assert.equal(input.length, value.payloadBytes);
  assert.equal(sha(input), value.payloadSHA256);
  assert.equal(footer.length, value.footerBytes);
  assert.equal(sha(footer), value.footerSHA256);
  assert.equal(JSON.parse(value.footerUTF8).sha256, value.payloadSHA256);
}

test('MVC00: existing initial codec preserves the fixed 4419/182 streams', () => {
  assert.equal(typeof encodeOrdinaryHistory, 'function');
  assert.equal(typeof decodeOrdinaryHistory, 'function');
  checkLiteral(vectors.initial);
  for (const vector of [...vectors.positive, ...vectors.negative]) checkLiteral(vector.candidate);
  assert.equal(vectors.positive.length, 3);
  assert.equal(vectors.negative.length, 11);
  const value = JSON.parse(vectors.initial.payloadUTF8);
  const before = JSON.stringify(value);
  const encoded = encodeOrdinaryHistory(value);
  assert.deepEqual(encoded.inputBytes, Buffer.from(vectors.initial.payloadUTF8));
  assert.deepEqual(encoded.footerBytes, Buffer.from(vectors.initial.footerUTF8));
  const decoded = decodeOrdinaryHistory(encoded.inputBytes, encoded.footerBytes);
  assert.equal(decoded.inputJSON, vectors.initial.payloadUTF8);
  assert.equal(decoded.envelopeJSON, vectors.initial.footerUTF8);
  assert.deepEqual(decoded.inventory, value);
  assert.equal(JSON.stringify(value), before);
});

for (const vector of vectors.positive) test(vector.id + ': ' + vector.description, () => {
  const value = vector.candidate;
  checkLiteral(value);
  assert.equal(value.outerManifestFormatVersion, 3);
  assert.equal(value.proposedDescriptorVersion, 3);
  const input = Buffer.from(value.payloadUTF8, 'utf8');
  const footer = Buffer.from(value.footerUTF8, 'utf8');
  const originalInput = Buffer.from(input), originalFooter = Buffer.from(footer);
  let decoded;
  assert.doesNotThrow(() => {
    decoded = decodeOrdinaryHistory(input, footer, OPTIONS);
  }, vector.id + ': fixed managed profile3 bytes must decode');
  assert.ok(decoded && typeof decoded === 'object');
  assert.equal(decoded.inputJSON, value.payloadUTF8);
  assert.equal(decoded.envelopeJSON, value.footerUTF8);
  assert.deepEqual(decoded.inventory, JSON.parse(value.payloadUTF8));
  assert.deepEqual(decoded.envelope.counts, value.counts);
  assert.equal(decoded.inventory.catalog.version, 3);
  assert.equal(decoded.inventory.catalog.namespaces.length, 2);
  const inventory = JSON.parse(value.payloadUTF8), before = JSON.stringify(inventory);
  let encoded;
  assert.doesNotThrow(() => {
    encoded = encodeOrdinaryHistory(inventory, OPTIONS);
  }, vector.id + ': fixed managed profile3 bytes must encode');
  assert.ok(encoded && typeof encoded === 'object');
  assert.deepEqual(encoded.inputBytes, originalInput);
  assert.deepEqual(encoded.footerBytes, originalFooter);
  assert.equal(JSON.stringify(inventory), before);
  assert.deepEqual(input, originalInput);
  assert.deepEqual(footer, originalFooter);
  // Explicit codec support does not select a default archive or publication profile.
  assert.throws(() => decodeOrdinaryHistory(originalInput, originalFooter), invalid);
  assert.throws(() => encodeOrdinaryHistory(JSON.parse(value.payloadUTF8)), invalid);
});

for (const vector of vectors.negative) test(vector.id + ': ' + vector.description, () => {
  const value = vector.candidate;
  checkLiteral(value);
  const input = Buffer.from(value.payloadUTF8), footer = Buffer.from(value.footerUTF8);
  const originalInput = Buffer.from(input), originalFooter = Buffer.from(footer);
  assert.throws(() => decodeOrdinaryHistory(input, footer, OPTIONS), invalid);
  const inventory = JSON.parse(value.payloadUTF8), before = JSON.stringify(inventory);
  assert.throws(() => encodeOrdinaryHistory(inventory, OPTIONS), invalid);
  assert.equal(JSON.stringify(inventory), before);
  assert.deepEqual(input, originalInput);
  assert.deepEqual(footer, originalFooter);
});

test('MVC15: unknown explicit profile options refuse without selecting the initial codec', () => {
  checkLiteral(vectors.initial);
  const input = Buffer.from(vectors.initial.payloadUTF8), footer = Buffer.from(vectors.initial.footerUTF8);
  const originalInput = Buffer.from(input), originalFooter = Buffer.from(footer);
  const inventory = JSON.parse(vectors.initial.payloadUTF8), before = JSON.stringify(inventory);
  for (const options of [undefined, {}, { controlProfileVersion: 1 }]) {
    const encoded = encodeOrdinaryHistory(inventory, options);
    assert.deepEqual(encoded.inputBytes, originalInput);
    assert.deepEqual(encoded.footerBytes, originalFooter);
    const decoded = decodeOrdinaryHistory(input, footer, options);
    assert.equal(decoded.inputJSON, vectors.initial.payloadUTF8);
    assert.equal(decoded.envelopeJSON, vectors.initial.footerUTF8);
  }
  for (const version of [0, 4, '3', null, false, undefined]) {
    const options = Object.freeze({ controlProfileVersion: version });
    assert.throws(() => encodeOrdinaryHistory(inventory, options), invalid);
    assert.throws(() => decodeOrdinaryHistory(input, footer, options), invalid);
    assert.equal(JSON.stringify(inventory), before);
    assert.deepEqual(input, originalInput);
    assert.deepEqual(footer, originalFooter);
  }
});
