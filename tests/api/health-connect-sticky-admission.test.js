// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Twenty fixed API cases from the independently reviewed v3 contract. Stopped
// SQL/catalogue controls are synthetic inputs, never ACK/restore/phone evidence.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const F = require('../helpers/health-connect-sticky-admission-fixture.cjs');
const { fixture, close, stop, restart, capabilities, control, mutate, copies,
  request, post, ack, unchanged, failure, noAuthority, batch, upsert, deletion, identity,
  binding, headers, streamKey, object, stage, coldRead, rows, identityRows,
  bank, product, ENV, BASE, BATCH, PART, FINAL, TYPE, TYPES, ID } = F;
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
function guardSql(source, { type = TYPE, id = ID, sourceFlag = 0, userFlag = 1,
  key = null, sequence = null, footprint = null } = {}) {
  const target = identity(source, type, id);
  return { sql: 'INSERT INTO health_deletion_guards VALUES (?,?,?,?,?,?,?,?,?)',
    params: [target.tenantId, target.sourceStoreId, type, id, sourceFlag, userFlag, key, sequence, footprint] };
}
async function updateAuthority(data, source, values) {
  await stop(data);
  await control(data, { command: 'authority', sourceStoreId: source.binding.sourceStoreId, ...values });
  await restart(data);
}
async function currentGeneration(data, source, type = TYPE) {
  const old = { ...source.binding };
  await updateAuthority(data, source, { recordType: type, generation: '2',
    installationId: 'synthetic-current-installation-after-control' });
  const current = await capabilities(data, source);
  assert.equal(current.json.streams[type].generation, '2');
  assert.equal(current.json.installationId, 'synthetic-current-installation-after-control');
  assert.equal(current.json.tenantId, old.tenantId);
  assert.equal(current.json.sourceStoreId, old.sourceStoreId);
  assert.equal(current.json.restoreEpoch, old.restoreEpoch);
  source.paired.streams[type].generation = current.json.streams[type].generation;
  source.binding.installationId = current.json.installationId;
  source.binding.generation = '2';
  return old;
}
test('S01 V1 typed known/unseen tombstones stay sticky across controlled saved generation and installation',
  async () => {
    const data = await fixture();
    try {
      const vector = batch(data.alpha, '2', [deletion(data.alpha), deletion(data.alpha, TYPE, 'r0-unseen-id')]);
      await deleteAndCheck(data, data.alpha, vector);
      for (const id of [ID, 'r0-unseen-id']) {
        await unchanged(data, () => post(data, data.alpha, BATCH,
          batch(data.alpha, '3', [upsert(data.alpha, bank.recordInventory[0], id,
            { metadata: { ...JSON.parse(bank.recordInventory[0].recordJson).metadata,
              id, clientRecordVersion: '9223372036854775807' } })]).wire));
      }
      const old = await currentGeneration(data, data.alpha);
      const next = batch(data.alpha, '1', [upsert(data.alpha)]);
      await unchanged(data, () => post(data, data.alpha, BATCH, next.wire,
        { ...headers(data.alpha), 'Klebb-Health-Generation': old.generation }),
      { code: 'binding-mismatch' });
      await unchanged(data, () => post(data, data.alpha, BATCH, next.wire));
      const cold = coldRead(data.home);
      assert.equal(cold.native.tables.health_deletion_guards, undefined);
      assert.deepEqual(copies(data), []);
      assert.equal(rows(cold, 'health_records').length, 2);
      assert.equal(identityRows(cold, 'health_records', identity(data.beta)).length, 1);
      assert.equal(identityRows(cold, 'health_records', identity(data.alpha, TYPES[1])).length, 1);
    } finally { await close(data); }
  });
test('S02 V2 source deletion writes exact instant guard/provenance and preserves source/type siblings', async () => {
  const data = await fixture({ v2: true });
  try {
    const vector = batch(data.alpha, '2', [deletion(data.alpha)]);
    await deleteAndCheck(data, data.alpha, vector, { [ID]: originalPeriod(0) });
    await unchanged(data, () => post(data, data.alpha, BATCH,
      batch(data.alpha, '3', [upsert(data.alpha)]).wire));
  } finally { await close(data); }
});
test('S03 exact source footprints retain nanos offsets extended years and an existing user flag', async () => {
  // Extended-year value is explicitly stopped raw storage, not wire admission.
  for (const index of [0, 1, 2, 3, 4, 5, 6, 8]) {
    const data = await fixture({ v2: true });
    try {
      const period = bank.footprints[index];
      const interval = period.expected?.kind === 'interval';
      const source = index === 1 ? data.beta : data.alpha;
      const type = interval ? TYPES[1] : TYPE;
      const item = bank.recordInventory[interval ? 2 : index === 1 ? 1 : 0];
      const record = JSON.parse(item.recordJson);
      if (period.inputCommonFields) {
        for (const key of ['time', 'zoneOffset', 'startTime', 'endTime', 'startZoneOffset', 'endZoneOffset']) {
          delete record[key];
        }
        Object.assign(record, period.inputCommonFields);
      }
      await mutate(data, [
        { sql: 'UPDATE health_records SET record_json=? WHERE tenant_id=? AND source_store_id=? '
          + 'AND record_type=? AND native_record_id=?',
        params: [JSON.stringify(record), source.binding.tenantId,
          source.binding.sourceStoreId, type, ID] },
        guardSql(source, { type, userFlag: 1 }),
      ]);
      await capabilities(data);
      const first = batch(source, '2', [deletion(source, type)], { type, id: `period-${index}-2` });
      await deleteAndCheck(data, source, first, { [ID]: period.expectedFootprintJson ?? null });
      const repeat = batch(source, '3', [deletion(source, type)], { type, id: `period-${index}-3` });
      await deleteAndCheck(data, source, repeat, { [ID]: period.expectedFootprintJson ?? null });
      const guard = identityRows(coldRead(data.home), 'health_deletion_guards', identity(source, type))[0];
      assert.equal(guard.user_suppressed, '1');
      assert.equal(guard.footprint_json, period.expectedFootprintJson ?? null);
      if (guard.footprint_json !== null) assert.equal(Buffer.byteLength(guard.footprint_json), period.expectedUtf8Bytes);
    } finally { await close(data); }
  }
});
test('S04 unseen footprint is NULL and successful touched historical tombstones alone acquire guards', async () => {
  const data = await fixture({ v2: true });
  try {
    await mutate(data, [{ sql: 'INSERT INTO health_tombstones VALUES (?,?,?,?,?,?)', repeat:
      ['r0-deleted-known', 'r0-untouched-historical'].map(id =>
        [data.alpha.binding.tenantId, data.alpha.binding.sourceStoreId, TYPE, id,
          streamKey(data.alpha), '1']) }]);
    await capabilities(data);
    const vector = batch(data.alpha, '2', [
      deletion(data.alpha, TYPE, 'r0-deleted-known'), deletion(data.alpha, TYPE, 'r0-unseen-id'),
    ]);
    await deleteAndCheck(data, data.alpha, vector);
    const cold = coldRead(data.home);
    assert.equal(rows(cold, 'health_deletion_guards').length, 2);
    assert.equal(identityRows(cold, 'health_deletion_guards',
      identity(data.alpha, TYPE, 'r0-untouched-historical')).length, 0);
    assert.ok(rows(cold, 'health_deletion_guards').every(row => row.footprint_json === null));
  } finally { await close(data); }
});
test('S05 each tombstone/source/user authority suppresses an entire mixed batch without consuming sequence', async () => {
  for (const mode of ['tombstone-only', 'source-only', 'user-only']) {
    const data = await fixture({ v2: true });
    try {
      if (mode === 'tombstone-only') await mutate(data, [{
        sql: 'INSERT INTO health_tombstones VALUES (?,?,?,?,?,?)',
        params: [data.alpha.binding.tenantId, data.alpha.binding.sourceStoreId, TYPE, ID, streamKey(data.alpha), '1'],
      }]);
      else await mutate(data, [guardSql(data.alpha, { sourceFlag: mode === 'source-only' ? 1 : 0,
        userFlag: mode === 'user-only' ? 1 : 0,
        key: mode === 'source-only' ? streamKey(data.alpha) : null,
        sequence: mode === 'source-only' ? '1' : null, footprint: originalPeriod(0) })]);
      await capabilities(data);
      const vector = batch(data.alpha, '2', [upsert(data.alpha),
        upsert(data.alpha, bank.recordInventory[0], 'independent-new-id')]);
      await unchanged(data, () => post(data, data.alpha, BATCH, vector.wire));
      const accepted = batch(data.alpha, '2', [upsert(data.alpha, bank.recordInventory[0], 'independent-new-id')],
        { id: 'independent-after-refusal' });
      const before = coldRead(data.home);
      await ack(data, data.alpha, accepted);
      const after = coldRead(data.home);
      assert.equal(identityRows(after, 'health_records',
        identity(data.alpha, TYPE, 'independent-new-id')).length, 1);
      assert.deepEqual(identityRows(after, 'health_records', identity(data.alpha)),
        identityRows(before, 'health_records', identity(data.alpha)));
      assert.deepEqual(after.native.tables.health_tombstones, before.native.tables.health_tombstones);
      assert.deepEqual(after.native.tables.health_deletion_guards, before.native.tables.health_deletion_guards);
      assert.equal(rows(after, 'health_batch_receipts').length, rows(before, 'health_batch_receipts').length + 1);
      assert.equal(rows(after, 'health_projection_outbox').length, rows(before, 'health_projection_outbox').length + 1);
    } finally { await close(data); }
  }
});
test('S06 missing changed or malformed relevant V2/native/object storage refuses without repair', async () => {
  for (const defect of ['missing-guards', 'changed-guards', 'bad-source-key', 'bad-source-sequence',
    'missing-native', 'partial-object', 'malformed-raw-json']) {
    const data = await fixture({ v2: true });
    try {
      if (defect === 'partial-object') await stage(data, data.alpha, object(data.alpha), [0]);
      let operations;
      if (defect === 'missing-guards') operations = [{ sql: 'DROP TABLE health_deletion_guards' }];
      else if (defect === 'changed-guards') operations = [{ sql: 'ALTER TABLE health_deletion_guards ADD COLUMN unexpected TEXT' }];
      else if (defect === 'missing-native') operations = [{ sql: 'DROP TABLE health_tombstones' }];
      else if (defect === 'partial-object') operations = [{ sql: 'DROP TABLE health_object_parts' }];
      else if (defect === 'malformed-raw-json') operations = [{
        sql: 'UPDATE health_records SET record_json=? WHERE source_store_id=? AND record_type=?',
        params: ['{"time":', data.alpha.binding.sourceStoreId, TYPE],
      }];
      else operations = [guardSql(data.alpha, { sourceFlag: 1, userFlag: 0,
        key: defect === 'bad-source-key' ? '{}' : streamKey(data.alpha),
        sequence: defect === 'bad-source-sequence' ? '01' : '1' })];
      await mutate(data, operations);
      const vector = batch(data.alpha, '2', [deletion(data.alpha)]);
      await unchanged(data, () => post(data, data.alpha, BATCH, vector.wire),
        { status: 503, code: 'storage-unavailable' });
    } finally { await close(data); }
  }
});
test('S07 opposite operations conflict in either order before all effects and typed siblings remain independent', async () => {
  const data = await fixture();
  try {
    for (const operations of [[upsert(data.alpha), deletion(data.alpha)],
      [deletion(data.alpha), upsert(data.alpha)]]) {
      const vector = batch(data.alpha, '2', [...operations,
        upsert(data.alpha, bank.recordInventory[0], 'independent-conflict-id')]);
      await unchanged(data, () => post(data, data.alpha, BATCH, vector.wire), { code: 'conflict' });
    }
    const before = coldRead(data.home);
    await ack(data, data.beta, batch(data.beta, '2', [upsert(data.beta, bank.recordInventory[1])]));
    await ack(data, data.alpha, batch(data.alpha, '2', [upsert(data.alpha, bank.recordInventory[2])],
      { type: TYPES[1], id: 'independent-other-type' }));
    const after = coldRead(data.home);
    assert.deepEqual(after.native.tables.health_records, before.native.tables.health_records);
    assert.deepEqual(after.native.tables.health_tombstones, before.native.tables.health_tombstones);
    assert.equal(rows(after, 'health_batch_receipts').length, rows(before, 'health_batch_receipts').length + 2);
  } finally { await close(data); }
});
test('S08 original ordinary receipt retries precede suppression and changed immutable requests conflict', async () => {
  const data = await fixture({ v2: true });
  try {
    await deleteAndCheck(data, data.alpha, batch(data.alpha, '2', [deletion(data.alpha)]),
      { [ID]: originalPeriod(0) });
    const original = data.original[0];
    await unchanged(data, () => post(data, data.alpha, BATCH, original.wire), { receipt: original.receipt });
    for (const change of ['digest', 'batchId']) {
      const payload = structuredClone(original.payload);
      if (change === 'digest') payload.changes[0].record.mass.value = '44.125';
      else payload.batchId = 'changed-original-batch';
      const payloadJson = JSON.stringify(payload);
      const wire = { version: 1, kind: 'batch', payloadJson, payloadDigest: F.sha(Buffer.from(payloadJson)) };
      await unchanged(data, () => post(data, data.alpha, BATCH, wire), { code: 'conflict' });
    }
  } finally { await close(data); }
});
async function committedObject(data) {
  const item = object(data.alpha);
  await stage(data, data.alpha, item);
  const finalised = await post(data, data.alpha, FINAL, item.finalise);
  assert.equal(finalised.status, 200); assert.deepEqual(finalised.json, item.receipt);
  noAuthority(finalised.body, data);
  const before = coldRead(data.home);
  assert.equal(rows(before, 'health_object_staging').length, 0);
  assert.equal(rows(before, 'health_object_parts').length, 0);
  assert.equal(rows(before, 'health_object_receipts').length, 1);
  assert.equal(identityRows(before, 'health_records', identity(data.alpha)).length, 1);
  await deleteAndCheck(data, data.alpha, batch(data.alpha, '3', [deletion(data.alpha)]),
    { [ID]: JSON.stringify({ kind: 'instant', time: '2026-10-28T03:45:00.123456789Z', zoneOffset: '+11:00' }) });
  return item;
}
test('S09 committed PART retry stays exact after deletion and a new suppressed PART allocates nothing', async () => {
  const data = await fixture({ v2: true });
  try {
    const item = await committedObject(data);
    await unchanged(data, () => post(data, data.alpha, PART, item.partFrames[0]),
      { receipt: item.partReceipts[0] });
    const next = object(data.alpha, { sequence: '4', batchId: 'new-suppressed-part',
      objectId: 'new-suppressed-part' });
    await unchanged(data, () => post(data, data.alpha, PART, next.partFrames[0]));
    const changed = structuredClone(item.partFrames[0]);
    changed.objectId = 'changed-original-object';
    await unchanged(data, () => post(data, data.alpha, PART, changed), { code: 'conflict' });
  } finally { await close(data); }
});
test('S10 committed FINALISE retry stays exact after deletion before new suppressed missing-part admission', async () => {
  const data = await fixture({ v2: true });
  try {
    const item = await committedObject(data);
    await unchanged(data, () => post(data, data.alpha, FINAL, item.finalise), { receipt: item.receipt });
    const next = object(data.alpha, { sequence: '4', batchId: 'new-suppressed-finalise',
      objectId: 'new-suppressed-finalise' });
    await unchanged(data, () => post(data, data.alpha, FINAL, next.finalise));
    // Purged live staging has no complete ordinary receipt. Suppression still
    // precedes missing-parts for this original uncommitted declaration.
    const other = await fixture({ v2: true });
    try {
      const active = object(other.alpha);
      await stage(other, other.alpha, active, [0, 2]);
      await deleteAndCheck(other, other.alpha, batch(other.alpha, '2', [deletion(other.alpha)],
        { id: 'delete-instead-of-object' }), { [ID]: originalPeriod(0) });
      const nextAfterPurge = object(other.alpha, { sequence: '3',
        batchId: 'new-after-staging-purge', objectId: 'new-after-staging-purge' });
      await unchanged(other, () => post(other, other.alpha, FINAL, nextAfterPurge.finalise));
    } finally { await close(other); }
  } finally { await close(data); }
});
test('S11 source delete atomically purges sparse matching old/current streams and preserves other source/type BLOBs', async () => {
  const data = await fixture({ v2: true });
  try {
    const old = object(data.alpha, { objectId: 'old-stream-object', batchId: 'old-stream-object' });
    await stage(data, data.alpha, old, [0, 2]);
    await currentGeneration(data, data.alpha);
    const current = object(data.alpha, { sequence: '1',
      objectId: 'current-stream-object', batchId: 'current-stream-object' });
    await stage(data, data.alpha, current, [0, 2]);
    const otherSource = object(data.beta, { objectId: 'beta-live', batchId: 'beta-live' });
    const otherType = object(data.alpha, { type: TYPES[1], sequence: '1',
      objectId: 'cadence-live', batchId: 'cadence-live' });
    await stage(data, data.beta, otherSource, [0, 2]);
    await stage(data, data.alpha, otherType, [0, 2]);
    const before = coldRead(data.home);
    assert.equal(rows(before, 'health_object_staging').length, 4);
    assert.equal(before.physical.length, 8);
    for (const physical of before.physical) {
      assert.equal(physical.actual.type, 'blob');
      assert.equal(physical.actual.digest, physical.savedDigest.value);
    }
    const vector = batch(data.alpha, '1', [deletion(data.alpha)], { id: 'current-stream-delete' });
    await deleteAndCheck(data, data.alpha, vector, { [ID]: originalPeriod(0) });
    const after = coldRead(data.home);
    assert.equal(rows(after, 'health_object_staging').length, 2);
    assert.equal(after.physical.length, 4);
    const retainedKeys = new Set([streamKey(data.beta), streamKey(data.alpha, TYPES[1])]);
    assert.ok(after.physical.every(part => retainedKeys.has(part.streamKey.value)));
    assert.equal(rows(after, 'health_object_staging').reduce((sum, row) =>
      sum + Number(row.reservation_bytes), 0), otherSource.header.totalBytes + otherType.header.totalBytes);
  } finally { await close(data); }
});
test('S12 every malformed selected declaration or actual physical part refuses before complete effects', async () => {
  for (const defect of ['partial-schema', 'declaration-json', 'wrong-declared-identity', 'key',
    'reservation', 'non-blob', 'empty-blob', 'index', 'actual-digest']) {
    const data = await fixture({ v2: true });
    try {
      const active = object(data.alpha);
      await stage(data, data.alpha, active, [0, 2]);
      const key = streamKey(data.alpha);
      let operations, foreignKeysOff = false;
      if (defect === 'partial-schema') operations = [{ sql: 'DROP TABLE health_object_receipts' }];
      else if (defect === 'declaration-json') operations = [
        { sql: 'UPDATE health_object_staging SET declaration_json=?', params: ['{"binding":'] }];
      else if (defect === 'wrong-declared-identity') {
        const header = structuredClone(active.header);
        header.identity.sourceStoreId = data.beta.binding.sourceStoreId;
        operations = [{ sql: 'UPDATE health_object_staging SET declaration_json=?',
          params: [JSON.stringify(header)] }];
      } else if (defect === 'key') {
        foreignKeysOff = true;
        operations = [{ sql: 'UPDATE health_object_staging SET stream_key=?', params: [key + '-corrupt'] },
          { sql: 'UPDATE health_object_parts SET stream_key=?', params: [key + '-corrupt'] }];
      } else if (defect === 'reservation') operations = [{ sql: 'UPDATE health_object_staging SET reservation_bytes=0' }];
      else if (defect === 'non-blob') operations = [
        { sql: 'UPDATE health_object_parts SET part_bytes=? WHERE part_index=0', params: ['not-a-blob'] }];
      else if (defect === 'empty-blob') operations = [
        { sql: 'UPDATE health_object_parts SET part_bytes=? WHERE part_index=0', params: [{ blobHex: '' }] }];
      else if (defect === 'index') operations = [{ sql: 'UPDATE health_object_parts SET part_index=-1 WHERE part_index=0' }];
      else operations = [{ sql: 'UPDATE health_object_parts SET part_bytes=? WHERE part_index=0',
        params: [{ blobHex: Buffer.alloc(active.pieces[0].length, 81).toString('hex') }] }];
      await mutate(data, operations, { foreignKeysOff });
      const before = coldRead(data.home);
      if (defect === 'actual-digest') {
        const part = before.physical.find(item => item.index.decimal === '0');
        assert.notEqual(part.actual.digest, part.savedDigest.value);
      }
      await unchanged(data, () => post(data, data.alpha, BATCH,
        batch(data.alpha, '2', [deletion(data.alpha)], { id: `corrupt-${defect}` }).wire),
      { status: 503, code: 'storage-unavailable' });
    } finally { await close(data); }
  }
});
test('S13 fixed selected object part and actual-byte inclusive bounds commit while overflows return 413', async () => {
  const controls = [
    { id: 'objects-inclusive', objectCount: 1000, partsPerObject: 1, accepted: true },
    { id: 'objects-overflow', objectCount: 1001, partsPerObject: 1, accepted: false },
    { id: 'parts-inclusive', objectCount: 1000, partsPerObject: 128, accepted: true },
    { id: 'parts-overflow', objectCount: 1000, partsPerObject: 128, extraPart: true, accepted: false },
    { id: 'bytes-inclusive', objectCount: 2, objectPartSizes: [[2048], [2048]], cap: 4096, accepted: true },
    { id: 'bytes-overflow', objectCount: 2, objectPartSizes: [[2048], [2049]], cap: 4096, accepted: false },
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
function observerFiles(data) {
  return { observation: path.join(data.home, 'sticky-observations.jsonl'),
    enabled: path.join(data.home, 'sticky-enabled') };
}
function events(data) {
  const filename = observerFiles(data).observation;
  return fs.existsSync(filename) ? fs.readFileSync(filename, 'utf8').trim().split('\n')
    .filter(Boolean).map(line => JSON.parse(line)) : [];
}
async function arm(data, fault, route) {
  const files = observerFiles(data);
  for (const filename of Object.values(files)) if (fs.existsSync(filename)) fs.unlinkSync(filename);
  const preload = path.join(product, 'tests/helpers/health-connect-sticky-admission-preload.cjs')
    .replaceAll('\\', '/');
  await restart(data, { ...data.extraEnv, NODE_OPTIONS: `--require "${preload}"`,
    STICKY_OBSERVATIONS: files.observation, STICKY_ENABLED: files.enabled,
    STICKY_FAULT: fault, ...(route ? { STICKY_HELD_ROUTE: route } : {}) });
  await capabilities(data);
  fs.writeFileSync(files.enabled, 'armed', { encoding: 'utf8', mode: 0o600 });
}
function ownWriterWitness(data, operation, { nativeResult, priorEffects = false } = {}) {
  const actual = events(data);
  const fired = actual.filter(row => row.kind === 'fault-fired' && row.operation === operation);
  assert.equal(fired.length, 1);
  const event = fired[0];
  const mode = actual.find(row => row.kind === 'own-writer-before-begin' &&
    row.handleId === event.handleId && row.transactionId === event.transactionId);
  assert.ok(mode, 'mode was observed on the actual faulted writer before BEGIN');
  assert.equal(mode.journalMode, 'wal'); assert.equal(mode.synchronous, 2);
  if (nativeResult !== undefined) assert.ok(actual.some(row => row.kind === 'actual-native-error' &&
    row.handleId === event.handleId && row.transactionId === event.transactionId &&
    row.sqliteResult === nativeResult), 'real SQLite returned the fixed native result');
  if (priorEffects) {
    assert.equal(event.transactionActive, operation !== 'after-commit-kill');
    for (const field of ['rawDeleted', 'tombstonesWritten', 'guardsWritten', 'partsDeleted']) {
      assert.ok(event[field] > 0, `${field} must be a real earlier same-transaction change`);
    }
    assert.ok(actual.some(row => row.kind === 'own-writer-begin-complete' &&
      row.handleId === event.handleId && row.transactionId === event.transactionId));
  }
  noAuthority(JSON.stringify(actual), data);
  return event;
}
function held(data, source, route, frame) {
  const wire = Buffer.from(JSON.stringify(frame)), split = Math.floor(wire.length / 2);
  assert.ok(split > 0 && split < wire.length);
  let outgoing;
  const agent = new http.Agent({ keepAlive: false });
  const response = new Promise((resolve, reject) => {
    outgoing = http.request(data.server.baseUrl + route, {
      method: 'POST', agent, headers: { ...headers(source),
        'Content-Type': 'application/json', 'Content-Length': wire.length },
    }, incoming => {
      const chunks = [];
      incoming.on('data', chunk => chunks.push(chunk));
      incoming.on('error', reject);
      incoming.on('end', () => {
        try {
          const body = Buffer.concat(chunks).toString('utf8');
          resolve({ status: incoming.statusCode, body, json: JSON.parse(body) });
        } catch (error) { reject(error); }
        finally { agent.destroy(); }
      });
    });
    outgoing.on('error', reject);
    outgoing.setTimeout(15000, () => outgoing.destroy(new Error('bounded held-body timeout')));
    outgoing.write(wire.subarray(0, split));
  });
  void response.catch(() => {});
  return { response, bytes: wire.length, finish: () => outgoing.end(wire.subarray(split)),
    destroy: () => { outgoing.destroy(); agent.destroy(); } };
}
async function consumed(data, route, total) {
  const deadline = Date.now() + 10000;
  while (!events(data).some(row => row.kind === 'actual-first-body-chunk-consumed') &&
      Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  const event = events(data).find(row => row.kind === 'actual-first-body-chunk-consumed');
  assert.ok(event); assert.equal(event.route, route);
  assert.ok(event.bytes > 0 && event.bytes < total);
}
test('S14 current native body and saved-state fences refuse deletion PART and FINALISE before all effects', async () => {
  let routeClass, currentAction, phase, caughtError, caughtPhase;
  const observe = next => {
    phase = next;
    console.error(JSON.stringify({ kind: 'S14-phase', routeClass, action: currentAction, phase }));
  };
  try {
    for (const route of [BATCH, PART, FINAL]) {
      routeClass = route === BATCH ? 'deletion' : route === PART ? 'part' : 'finalise';
      for (const action of ['revocation', 'freeze']) {
        currentAction = action; caughtError = undefined; caughtPhase = undefined;
        observe('fixture');
        const data = await fixture({ v2: true });
        let pending;
        try {
          observe('object-and-frame');
          const active = object(data.alpha);
          observe('stage-if-required');
          if (route !== BATCH) await stage(data, data.alpha, active, route === PART ? [0] : [0, 1, 2]);
          const frame = route === BATCH ? batch(data.alpha, '2', [deletion(data.alpha)]).wire :
            route === PART ? active.partFrames[1] : active.finalise;
          observe('arm');
          await arm(data, action === 'freeze' ? 'held-freeze' : 'held-observe', route);
          observe('snapshot');
          const before = coldRead(data.home), copyBefore = copies(data);
          observe('held-start');
          pending = held(data, data.alpha, route, frame);
          observe('body-consumed');
          await consumed(data, route, pending.bytes);
          if (action === 'revocation') {
            observe('revocation-request');
            const revoked = await request(data, `${BASE}/${data.alpha.paired.connectorId}`,
              { method: 'DELETE', browser: true });
            assert.equal(revoked.status, 200); assert.deepEqual(revoked.json, { revoked: true });
          }
          observe('held-finish');
          pending.finish();
          observe('held-response');
          const response = await pending.response;
          observe('refusal-and-state-checks');
          failure(response, action === 'freeze' ? 503 : 401,
            action === 'freeze' ? 'IMPORT_FROZEN' : 'revoked', data);
          assert.deepEqual(coldRead(data.home).native, before.native);
          assert.deepEqual(coldRead(data.home).physical, before.physical);
          assert.deepEqual(copies(data), copyBefore);
        } catch (error) { caughtError = error; caughtPhase = phase; throw error; }
        finally { observe('cleanup'); if (pending) pending.destroy(); await close(data); }
      }
      currentAction = 'binding-setup'; caughtError = undefined; caughtPhase = undefined;
      observe('fixture');
      const data = await fixture({ v2: true });
      try {
        observe('object-and-frame');
        const active = object(data.alpha);
        const frame = route === BATCH ? batch(data.alpha, '2', [deletion(data.alpha)]).wire :
          route === PART ? active.partFrames[0] : active.finalise;
        for (const changed of [
          { 'Klebb-Health-Generation': '2' },
          { 'Klebb-Health-Restore-Epoch': '99999999-9999-4999-8999-999999999999' },
        ]) {
          currentAction = Object.hasOwn(changed, 'Klebb-Health-Generation') ?
            'binding-generation' : 'binding-restore-epoch';
          observe('binding-request');
          await unchanged(data, () => post(data, data.alpha, route, frame,
            { ...headers(data.alpha), ...changed }), { code: 'binding-mismatch' });
        }
        const newEpoch = '99999999-9999-4999-8999-999999999999';
        currentAction = 'saved-epoch';
        observe('authority-change');
        await updateAuthority(data, data.alpha, { restoreEpoch: newEpoch });
        observe('saved-epoch-request');
        await unchanged(data, () => post(data, data.alpha, route, frame,
          { ...headers(data.alpha), 'Klebb-Health-Restore-Epoch': newEpoch }),
        { status: 401, code: 'revoked' });
      } catch (error) { caughtError = error; caughtPhase = phase; throw error; }
      finally { observe('cleanup'); await close(data); }
      currentAction = 'recovery'; caughtError = undefined; caughtPhase = undefined;
      observe('fixture');
      const recovery = await fixture({ v2: true });
      try {
        observe('object-and-frame');
        const active = object(recovery.alpha);
        const frame = route === BATCH ? batch(recovery.alpha, '2', [deletion(recovery.alpha)]).wire :
          route === PART ? active.partFrames[0] : active.finalise;
        observe('recovery-stop');
        await stop(recovery);
        observe('recovery-marker-write');
        const directory = path.join(recovery.home, 'import');
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        const marker = JSON.stringify({ state: 'applying', treePath: path.join(directory, 'missing-tree'),
          snapshotPath: path.join(directory, 'missing-snapshot') });
        fs.writeFileSync(path.join(directory, 'job.json'), marker, { mode: 0o600 });
        observe('recovery-restart');
        await restart(recovery);
        observe('recovery-request');
        await unchanged(recovery, () => post(recovery, recovery.alpha, route, frame),
          { status: 503, code: 'IMPORT_RECOVERY_FAILED' });
        observe('recovery-marker-check');
        assert.equal(fs.readFileSync(path.join(directory, 'job.json'), 'utf8'), marker);
      } catch (error) { caughtError = error; caughtPhase = phase; throw error; }
      finally { observe('cleanup'); await close(recovery); }
    }
  } catch (error) {
    try {
      const code = ["EPIPE", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOENT", "EACCES", "ERR_ASSERTION", "ERR_STREAM_DESTROYED", "ERR_STREAM_WRITE_AFTER_END"].includes(error?.code) ? error.code : undefined;
      const syscall = ["write", "read", "connect", "spawn", "open", "close", "stat", "unlink", "rename", "mkdir"].includes(error?.syscall) ? error.syscall : undefined;
      console.error(JSON.stringify({ kind: 'S14-error', routeClass, action: currentAction,
        phase: error === caughtError ? caughtPhase : phase, code, syscall }));
    } finally { throw error; }
  }
});
test('S15 actual own WAL FULL deletion writer returns SQLITE_FULL and complete transaction rollback', async () => {
  const data = await fixture({ v2: true });
  try {
    await stop(data);
    await control(data, { command: 'sql', operations: [], vacuum: true });
    await restart(data); await capabilities(data);
    // Fixed larger valid typed identity set, disclosed before production:
    // 40 unknown IDs of exactly 256 Unicode scalars each force real new rows.
    const unknown = Array.from({ length: 40 }, (_, index) =>
      `full-${String(index).padStart(2, '0')}-` + '\u03a9'.repeat(248));
    for (const id of unknown) assert.equal([...id].length, 256);
    const vector = batch(data.alpha, '2', [deletion(data.alpha),
      ...unknown.map(id => deletion(data.alpha, TYPE, id))], { id: 'native-full-delete' });
    await arm(data, 'sqlite-full');
    await unchanged(data, () => post(data, data.alpha, BATCH, vector.wire),
      { status: 503, code: 'storage-unavailable' });
    ownWriterWitness(data, 'sqlite-full', { nativeResult: 13 });
    assert.equal(events(data).find(row => row.kind === 'full-cap').freePages, 0);
  } finally { await close(data); }
});
test('S16 actual competing WAL writer yields native SQLITE_BUSY with no committed deletion effects', async () => {
  const data = await fixture({ v2: true });
  try {
    const vector = batch(data.alpha, '2', [deletion(data.alpha)], { id: 'native-busy-delete' });
    await arm(data, 'sqlite-busy');
    await unchanged(data, () => post(data, data.alpha, BATCH, vector.wire),
      { status: 503, code: 'storage-unavailable' });
    ownWriterWitness(data, 'sqlite-busy', { nativeResult: 5 });
  } finally { await close(data); }
});
test('S17 late actual native statement refusal rolls back observed raw tomb guard and sparse BLOB deletions', async () => {
  const data = await fixture({ v2: true });
  try {
    await stage(data, data.alpha, object(data.alpha), [0, 2]);
    const vector = batch(data.alpha, '2', [deletion(data.alpha)], { id: 'late-delete-refusal' });
    await arm(data, 'late-outbox-refusal');
    await unchanged(data, () => post(data, data.alpha, BATCH, vector.wire),
      { status: 503, code: 'storage-unavailable' });
    ownWriterWitness(data, 'late-outbox-refusal', { nativeResult: 1811, priorEffects: true });
    assert.ok(events(data).some(row => row.kind === 'own-writer-rollback-complete'));
  } finally { await close(data); }
});
function exitPromise(proc) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('owned faulted child did not close within 10 seconds')), 10000);
    proc.once('close', (code, signal) => {
      clearTimeout(timer); assert.ok(code !== null || signal !== null); resolve({ code, signal });
    });
  });
}
async function acrossDeath(data, source, vector) {
  const proc = data.server.proc, exited = exitPromise(proc);
  void exited.catch(() => {});
  let lost = false;
  try { await post(data, source, BATCH, vector.wire); }
  catch { lost = true; }
  assert.equal(lost, true, 'actual process death interrupted the native HTTP response');
  const result = await exited;
  data.server = null;
  return result;
}
test('S18 actual death before COMMIT retains complete old native state and independently hashed sparse BLOBs', async () => {
  const data = await fixture({ v2: true });
  try {
    await stage(data, data.alpha, object(data.alpha), [0, 2]);
    const vector = batch(data.alpha, '2', [deletion(data.alpha)], { id: 'before-commit-delete' });
    await arm(data, 'before-commit-kill');
    const before = coldRead(data.home), copyBefore = copies(data);
    assert.equal(before.physical.length, 2);
    await acrossDeath(data, data.alpha, vector);
    ownWriterWitness(data, 'before-commit-kill', { priorEffects: true });
    const cold = coldRead(data.home);
    assert.deepEqual(cold.native, before.native);
    assert.deepEqual(cold.physical, before.physical);
    assert.deepEqual(copies(data), copyBefore);
    noAuthority(JSON.stringify(cold), data);
    // Proof above is cold BEFORE restart or any replay.
    await restart(data, {}); await capabilities(data);
    assert.deepEqual(coldRead(data.home).native, before.native);
  } finally { await close(data); }
});
test('S19 actual death after COMMIT exposes complete deletion and zero staged bytes before exact ACK retry', async () => {
  const data = await fixture({ v2: true });
  try {
    await stage(data, data.alpha, object(data.alpha), [0, 2]);
    const vector = batch(data.alpha, '2', [deletion(data.alpha)], { id: 'after-commit-delete' });
    await arm(data, 'after-commit-kill');
    const before = coldRead(data.home), copyBefore = copies(data);
    await acrossDeath(data, data.alpha, vector);
    ownWriterWitness(data, 'after-commit-kill', { priorEffects: true });
    const cold = coldRead(data.home);
    expectedDeletion(data, before, cold, data.alpha, vector, { [ID]: originalPeriod(0) });
    assert.equal(cold.physical.length, 0);
    assert.equal(rows(cold, 'health_object_staging').length, 0);
    assert.deepEqual(copies(data), copyBefore);
    // Already observed complete cold state before startup.
    await restart(data, {}); await capabilities(data);
    await unchanged(data, () => post(data, data.alpha, BATCH, vector.wire), { receipt: vector.receipt });
  } finally { await close(data); }
});
test('S20 default batch PART FINALISE stay V1 and missing required native storage is never repaired', async () => {
  const data = await fixture();
  try {
    const extraHeaders = { ...headers(data.alpha), 'Klebb-Health-Windows-Development': 'true' };
    const vector = batch(data.alpha, '2', [upsert(data.alpha)], { id: 'default-v1-upsert' });
    const accepted = await post(data, data.alpha, BATCH, vector.wire, extraHeaders);
    assert.equal(accepted.status, 200); assert.deepEqual(accepted.json, vector.receipt);
    const item = object(data.alpha, { sequence: '3', objectId: 'default-v1-object',
      batchId: 'default-v1-object', paddingCount: 0 });
    for (let index = 0; index < item.partFrames.length; index++) {
      const part = await post(data, data.alpha, PART, item.partFrames[index], extraHeaders);
      assert.equal(part.status, 200); assert.deepEqual(part.json, item.partReceipts[index]);
    }
    const complete = await post(data, data.alpha, FINAL, item.finalise, extraHeaders);
    assert.equal(complete.status, 200); assert.deepEqual(complete.json, item.receipt);
    const normal = coldRead(data.home);
    assert.deepEqual(rows(normal, 'health_schema_version'), [{ version: '1' }]);
    assert.equal(normal.native.tables.health_deletion_guards, undefined);
    assert.deepEqual(copies(data), []);
    await mutate(data, [{ sql: 'DROP TABLE health_tombstones' }]);
    const newItem = object(data.alpha, { sequence: '4', objectId: 'missing-native-object',
      batchId: 'missing-native-object', paddingCount: 0 });
    const deletionWire = batch(data.alpha, '4', [deletion(data.alpha)], { id: 'missing-native-delete' }).wire;
    for (const [route, frame] of [[BATCH, deletionWire], [PART, newItem.partFrames[0]], [FINAL, newItem.finalise]]) {
      await unchanged(data, () => post(data, data.alpha, route, frame, extraHeaders),
        { status: 503, code: 'storage-unavailable' });
      assert.equal(coldRead(data.home).native.tables.health_tombstones, undefined);
      assert.deepEqual(copies(data), []);
    }
    // Complete disappearance of all native tables after restart still needs
    // initialized portable-catalogue/R0 evidence; this case does not claim it.
  } finally { await close(data); }
});
