// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Exact large staging-part controls for the explicit optional extended entry point.
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../tests/helpers/health-connect-sticky-admission-fixture.cjs');
const { fixture, close, stop, restart, capabilities, control, post, ack, unchanged,
  noAuthority, batch, deletion, identity, streamKey, object, stage, coldRead, rows,
  bank, BATCH, ID } = F;

const canonicalSet = items => items.map(item => JSON.stringify(item)).sort();
const sameSet = (actual, expected, message) => assert.deepEqual(canonicalSet(actual), canonicalSet(expected), message);
const typedKey = item => JSON.stringify([item.tenant_id, item.source_store_id, item.record_type, item.native_record_id]);
const identityKey = item => JSON.stringify([item.tenantId, item.sourceStoreId, item.recordType, item.nativeRecordId]);
const originalPeriod = index => bank.footprints[index].expectedFootprintJson;
function expectedDeletion(data, before, after, source, vector, footprints = {}) {
  const identities = vector.payload.changes.map(change => change.identity);
  assert.ok(vector.payload.changes.every(change => change.operation === 'delete'));
  const targets = new Set(identities.map(identityKey));
  const key = streamKey(source, vector.payload.recordType);
  const type = vector.payload.recordType, sequence = vector.payload.sequence;
  const originalRows = table => rows(before, table);
  const expectRows = (table, expected) => sameSet(rows(after, table), expected, table);
  expectRows('health_records', originalRows('health_records').filter(row => !targets.has(typedKey(row))));
  expectRows('health_tombstones', [
    ...originalRows('health_tombstones').filter(row => !targets.has(typedKey(row))),
    ...identities.map(item => ({ tenant_id: item.tenantId, source_store_id: item.sourceStoreId,
      record_type: item.recordType, native_record_id: item.nativeRecordId, stream_key: key, sequence })),
  ]);
  const mutable = new Set(['health_records', 'health_tombstones', 'health_batch_receipts',
    'health_streams', 'health_projection_outbox', 'health_object_staging', 'health_object_parts']);
  if (before.native.tables.health_deletion_guards) {
    mutable.add('health_deletion_guards');
    expectRows('health_deletion_guards', [
      ...originalRows('health_deletion_guards').filter(row => !targets.has(typedKey(row))),
      ...identities.map(item => {
        const prior = originalRows('health_deletion_guards').find(row => typedKey(row) === identityKey(item));
        return { tenant_id: item.tenantId, source_store_id: item.sourceStoreId,
          record_type: item.recordType, native_record_id: item.nativeRecordId,
          source_deleted: '1', user_suppressed: prior?.user_suppressed || '0',
          source_stream_key: key, source_sequence: sequence,
          footprint_json: footprints[item.nativeRecordId] ?? prior?.footprint_json ?? null };
      }),
    ]);
  }
  expectRows('health_batch_receipts', [...originalRows('health_batch_receipts'), {
    stream_key: key, sequence, batch_id: vector.payload.batchId,
    payload_digest: vector.receipt.payloadDigest, receipt_json: JSON.stringify(vector.receipt),
  }]);
  expectRows('health_streams', [...originalRows('health_streams').filter(row => row.stream_key !== key),
    { stream_key: key, record_type: type, acknowledged_sequence: sequence }]);
  expectRows('health_projection_outbox', [...originalRows('health_projection_outbox'),
    { stream_key: key, sequence, batch_id: vector.payload.batchId,
      payload_digest: vector.receipt.payloadDigest, state: 'queued' }]);
  const selected = new Set(originalRows('health_object_staging').filter(row =>
    targets.has(identityKey(JSON.parse(row.declaration_json).identity))).map(row => row.stream_key));
  if (before.native.tables.health_object_staging) {
    expectRows('health_object_staging', originalRows('health_object_staging').filter(row => !selected.has(row.stream_key)));
    expectRows('health_object_parts', originalRows('health_object_parts').filter(row => !selected.has(row.stream_key)));
  }
  for (const [table, original] of Object.entries(before.native.tables)) {
    if (!mutable.has(table)) assert.deepEqual(after.native.tables[table], original, table);
  }
  assert.deepEqual(after.native.schema, before.native.schema);
  assert.deepEqual(after.native.integrity, before.native.integrity);
  assert.equal(after.native.userVersion, before.native.userVersion);
  assert.equal(after.native.applicationId, before.native.applicationId);
  noAuthority(JSON.stringify(after), data);
}
async function deleteAndCheck(data, source, vector, footprints = {}) {
  const before = coldRead(data.home);
  await ack(data, source, vector);
  const after = coldRead(data.home);
  expectedDeletion(data, before, after, source, vector, footprints);
  return { before, after };
}
test('S13 extended fixed selected part-capacity inclusive bound commits while overflow returns 413', async () => {
  const controls = [
    { id: 'parts-inclusive', objectCount: 1000, partsPerObject: 128, accepted: true },
    { id: 'parts-overflow', objectCount: 1000, partsPerObject: 128, extraPart: true, accepted: false },
  ];
  for (const input of controls) {
    const data = await fixture({ v2: true,
      extraEnv: input.cap ? { HEALTH_CONNECT_STAGING_MAX_BYTES: String(input.cap) } : {} });
    try {
      // Obtain real object schema by one actual valid routed part; bulk rows
      // replace only staging while stopped. They are not actual native ACKs.
      const template = object(data.alpha, { paddingCount: 0 });
      await stage(data, data.alpha, template, [0]);
      await stop(data);
      await control(data, { command: 'bulk-stage', header: template.header, ...input });
      await restart(data); await capabilities(data);
      const before = coldRead(data.home);
      assert.equal(rows(before, 'health_object_staging').length, input.objectCount);
      if (input.id.startsWith('parts-')) assert.equal(before.physical.length, input.extraPart ? 128001 : 128000);
      if (input.cap) assert.equal(before.physical.reduce((sum, part) => sum + part.actual.bytes, 0),
        input.accepted ? 4096 : 4097);
      const vector = batch(data.alpha, '2', [deletion(data.alpha)], { id: input.id });
      if (input.accepted) {
        await deleteAndCheck(data, data.alpha, vector, { [ID]: originalPeriod(0) });
        assert.equal(coldRead(data.home).physical.length, 0);
      } else await unchanged(data, () => post(data, data.alpha, BATCH, vector.wire),
        { status: 413, code: 'limit-exceeded' });
    } finally { await close(data); }
  }
});
