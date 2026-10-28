// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Invented fixtures and independent crypto only. Never imports product code.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const bank = require('../fixtures/health-connect/durable-history-independent-vectors.json');
const TYPE = 'BodyWaterMassRecord';
const sha = bytes => 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex');
const original = JSON.parse(bank.vectors.find(item => item.id === 'initial-raw-only').payloadJson);
function makeObject(binding = bank.binding, options = {}) {
  const change = structuredClone(original.changes[0]);
  const nativeRecordId = options.nativeRecordId || 'large-raw-only';
  change.identity = { tenantId: binding.tenantId, sourceStoreId: binding.sourceStoreId,
    recordType: TYPE, nativeRecordId };
  change.record.metadata.id = nativeRecordId;
  change.record.mass.value = '37.25';
  change.record.extension.padding = 'P'.repeat(options.paddingCount ?? 1048704);
  const payload = { binding: structuredClone(binding), recordType: TYPE,
    sequence: options.sequence || '1', batchId: options.batchId || 'synthetic-large-1',
    changes: [change] };
  if (options.mutatePayload) options.mutatePayload(payload);
  let payloadJson = JSON.stringify(payload);
  if (options.mutateText) payloadJson = options.mutateText(payloadJson);
  let bytes = Buffer.from(payloadJson, 'utf8');
  if (options.mutateBytes) bytes = options.mutateBytes(Buffer.from(bytes));
  const header = { binding: structuredClone(binding), recordType: TYPE,
    batchId: payload.batchId, sequence: payload.sequence, identity: structuredClone(change.identity),
    objectId: options.objectId || 'synthetic-complete-object-1',
    objectDigest: sha(bytes), partCount: 0, totalBytes: bytes.length };
  const cuts = options.cuts || [];
  const pieces = [];
  if (cuts.length) {
    let start = 0;
    for (const end of [...cuts, bytes.length]) {
      assert.ok(end > start && end <= bytes.length);
      pieces.push(bytes.subarray(start, end));
      start = end;
    }
  } else {
    for (let start = 0; start < bytes.length; start += 524288) {
      pieces.push(bytes.subarray(start, Math.min(start + 524288, bytes.length)));
    }
  }
  header.partCount = pieces.length;
  const manifest = pieces.map((part, index) => ({ index, bytes: part.length, digest: sha(part) }));
  const partFrames = pieces.map((part, index) => ({
    version: 1, kind: 'object-part', ...header,
    partIndex: index, partBase64: part.toString('base64'), partDigest: manifest[index].digest,
  }));
  const partReceipts = manifest.map(part => ({ version: 1, kind: 'object-part-receipt',
    ...header, partIndex: part.index, partDigest: part.digest, partBytes: part.bytes }));
  return { payload, payloadJson, bytes, pieces, header, manifest, partFrames, partReceipts,
    finalise: { version: 1, kind: 'object-finalise', ...header, parts: manifest },
    receipt: { version: 1, kind: 'durable-receipt', binding: structuredClone(binding),
      recordType: TYPE, sequence: payload.sequence, batchId: payload.batchId,
      payloadDigest: header.objectDigest } };
}
function verifyOriginalBank() {
  const object = makeObject();
  assert.equal(object.bytes.length, 1049872);
  assert.equal(object.header.objectDigest, bank.largeRecord.payloadDigest);
  assert.deepEqual(object.manifest, bank.largeRecord.manifest);
  assert.deepEqual(object.receipt, bank.largeRecord.expectedReceipt);
  assert.deepEqual(object.pieces.map(piece => piece.length), [524288, 524288, 1296]);
  assert.ok(object.bytes.length > 1048576, 'this exercises distinct reconstructed-payload validation');
  for (const part of object.partFrames) {
    assert.ok(Buffer.byteLength(JSON.stringify(part), 'utf8') < 1048576);
  }
  const joined = Buffer.concat(object.pieces);
  assert.ok(joined.equals(object.bytes));
  assert.equal(sha(joined), bank.largeRecord.payloadDigest);
  return object;
}
if (require.main === module) {
  const object = verifyOriginalBank();
  console.log(JSON.stringify({ productImported: false, frozenBankUnchanged: true,
    originalPayloadBytes: object.bytes.length, partBytes: object.manifest.map(part => part.bytes),
    originalDigest: object.header.objectDigest,
    everyPartFrameBelowOrdinaryLimit: true }));
}
module.exports = { makeObject, verifyOriginalBank, sha, TYPE };
