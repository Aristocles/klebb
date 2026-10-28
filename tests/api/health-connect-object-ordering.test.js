// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Metadata member order is independent of the original immutable payload bytes.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const product = process.env.INDEPENDENT_PRODUCT_ROOT || path.resolve(__dirname, '../..');
const { fixture, close, post, stage, finalise, committedNative, purgedWithReceipt,
  coldReadNative, coldReadObjects, makeObject, sha, noAuthority, PART, FINAL } =
  require(path.join(product, 'tests/helpers/health-connect-object-test-fixture.cjs'));

function reordered(frame) {
  const changed = structuredClone(frame);
  const b = frame.binding;
  changed.binding = { restoreEpoch: b.restoreEpoch, generation: b.generation,
    installationId: b.installationId, sourceStoreId: b.sourceStoreId,
    instanceId: b.instanceId, tenantId: b.tenantId };
  const i = frame.identity;
  changed.identity = { nativeRecordId: i.nativeRecordId, recordType: i.recordType,
    sourceStoreId: i.sourceStoreId, tenantId: i.tenantId };
  if (frame.parts) {
    changed.parts = frame.parts.map(part =>
      ({ digest: part.digest, bytes: part.bytes, index: part.index }));
    assert.notEqual(JSON.stringify(changed.parts), JSON.stringify(frame.parts));
    assert.deepEqual(changed.parts, frame.parts, 'manifest array order and values are unchanged');
  }
  assert.notEqual(JSON.stringify(changed.binding), JSON.stringify(frame.binding));
  assert.notEqual(JSON.stringify(changed.identity), JSON.stringify(frame.identity));
  assert.deepEqual(changed, frame, 'only JSON object member order changes');
  if (frame.partBase64) assert.equal(changed.partBase64, frame.partBase64);
  return changed;
}
function originalDigest(object) {
  assert.equal(object.header.objectDigest, sha(object.bytes));
  assert.equal(object.receipt.payloadDigest, sha(Buffer.from(object.payloadJson, 'utf8')));
}
async function acceptedPart(data, object, index) {
  const response = await post(data, PART, reordered(object.partFrames[index]));
  assert.equal(response.status, 200, 'equivalent declaration values cannot conflict on JSON member order');
  assert.deepEqual(response.json, object.partReceipts[index]);
  noAuthority(response.body, data);
}
async function acceptedFinalise(data, object) {
  const response = await post(data, FINAL, reordered(object.finalise));
  assert.equal(response.status, 200, 'equivalent finalise metadata preserves the original batch receipt');
  assert.deepEqual(response.json, object.receipt);
  noAuthority(response.body, data);
}

test('same-values reordered declaration permits a duplicate part and the next part without TTL or digest changes',
  async () => {
    const data = await fixture();
    try {
      const object = makeObject(data.binding);
      originalDigest(object);
      await stage(data, object, [0]);
      const first = coldReadObjects(data.home);
      const native = coldReadNative(data.home);
      assert.equal(first.objects.length, 1);
      assert.equal(first.physicalPartCount, 1);
      assert.equal(first.aggregateReservedBytes, 1049872);
      await acceptedPart(data, object, 0);
      assert.deepEqual(coldReadObjects(data.home), first);
      assert.deepEqual(coldReadNative(data.home), native);
      await acceptedPart(data, object, 1);
      const second = coldReadObjects(data.home);
      assert.equal(second.objects.length, 1);
      assert.equal(second.physicalPartCount, 2);
      assert.equal(second.aggregateReservedBytes, first.aggregateReservedBytes);
      assert.equal(second.objects[0].createdAt, first.objects[0].createdAt);
      assert.equal(second.objects[0].expiresAt, first.objects[0].expiresAt);
      assert.deepEqual(second.objects[0].declaration, object.header);
      assert.deepEqual(second.objects[0].parts, object.manifest.slice(0, 2));
      assert.ok(second.partDigestEvidence.every(part => part.matches));
      const nextNative = coldReadNative(data.home);
      const { logicalNativeDump: beforeDump, ...beforeHistory } = native;
      const { logicalNativeDump: afterDump, ...afterHistory } = nextNative;
      assert.deepEqual(afterHistory, beforeHistory);
      const beforeTables = JSON.parse(beforeDump);
      const afterTables = JSON.parse(afterDump);
      delete beforeTables.health_object_parts;
      delete afterTables.health_object_parts;
      assert.deepEqual(afterTables, beforeTables,
        'only the independently observed added physical part changes the diagnostic tables');
      noAuthority(afterDump, data);
      originalDigest(object);
    } finally { await close(data); }
  });

test('same-values reordered declaration and manifest commit exact original payload bytes',
  async () => {
    const data = await fixture();
    try {
      const object = makeObject(data.binding);
      originalDigest(object);
      await stage(data, object);
      assert.equal(coldReadObjects(data.home).physicalPartCount, 3);
      await acceptedFinalise(data, object);
      committedNative(data, object);
      purgedWithReceipt(data, object);
      originalDigest(object);
    } finally { await close(data); }
  });

test('same-values reordered committed finalise and part retry return original results without any new effects',
  async () => {
    const data = await fixture();
    try {
      const object = makeObject(data.binding);
      await stage(data, object);
      await finalise(data, object);
      const native = committedNative(data, object);
      const compact = purgedWithReceipt(data, object);
      await acceptedFinalise(data, object);
      assert.deepEqual(coldReadNative(data.home), native);
      assert.deepEqual(coldReadObjects(data.home), compact);
      await acceptedPart(data, object, 1);
      assert.deepEqual(coldReadNative(data.home), native);
      assert.deepEqual(coldReadObjects(data.home), compact);
      originalDigest(object);
    } finally { await close(data); }
  });
