// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Independently bound browser representations; no product, SQL or server import.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const bank = require('../fixtures/health-connect/owner-deletion-independent-vectors.json');
const sha = bytes => 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex');

function scalarText(value) {
  assert.equal(typeof value, 'string');
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      assert.ok(next >= 0xdc00 && next <= 0xdfff, 'paired Unicode scalar');
    } else assert.ok(code < 0xdc00 || code > 0xdfff, 'no lone low surrogate');
  }
  return value;
}
const ordinal = (left, right) =>
  Buffer.compare(Buffer.from(scalarText(left)), Buffer.from(scalarText(right)));
const compareIdentity = (left, right) =>
  ordinal(left[0], right[0]) || ordinal(left[1], right[1]);
function selection(identities) {
  return identities.map(identity => [scalarText(identity.recordType),
    scalarText(identity.nativeRecordId)]).sort(compareIdentity);
}
function revision(context, identities, vector, states) {
  const canonical = selection(identities);
  const orderedVector = vector.map(row => [...row]).sort((a, b) => ordinal(a[0], b[0]));
  const orderedStates = states.map(row => [...row]).sort(compareIdentity);
  assert.deepEqual(orderedStates.map(row => row.slice(0, 2)), canonical);
  const array = ['health-connect-user-delete', 1, context.tenantId,
    context.sourceStoreId, context.restoreEpoch, context.nativeSchemaVersion,
    canonical, orderedVector, orderedStates];
  const json = JSON.stringify(array);
  return { array, json, bytes: Buffer.byteLength(json), digest: sha(Buffer.from(json)) };
}
const bindingArray = binding => [binding.tenantId, binding.instanceId,
  binding.sourceStoreId, binding.installationId, binding.generation, binding.restoreEpoch];
const declarationArray = declaration => [bindingArray(declaration.binding),
  declaration.recordType, declaration.batchId, declaration.sequence,
  [declaration.identity.tenantId, declaration.identity.sourceStoreId,
    declaration.identity.recordType, declaration.identity.nativeRecordId],
  declaration.objectId, declaration.objectDigest, declaration.partCount, declaration.totalBytes];
function footprintArray(value) {
  if (value === null) return null;
  if (value.kind === 'instant') return ['instant', value.time, value.zoneOffset];
  assert.equal(value.kind, 'interval');
  return ['interval', value.startTime, value.endTime,
    value.startZoneOffset, value.endZoneOffset];
}
function footprintObject(value) {
  if (value === null) return null;
  if (value[0] === 'instant') return { kind: 'instant', time: value[1], zoneOffset: value[2] };
  assert.equal(value[0], 'interval');
  return { kind: 'interval', startTime: value[1], endTime: value[2],
    startZoneOffset: value[3], endZoneOffset: value[4] };
}
function streamBinding(stream) {
  const parts = JSON.parse(stream.stream_key);
  assert.equal(parts.length, 7);
  assert.equal(parts[4], stream.record_type);
  return { tenantId: parts[0], instanceId: parts[1], sourceStoreId: parts[2],
    installationId: parts[3], generation: parts[5], restoreEpoch: parts[6] };
}
function verifiedVector(context, tables) {
  const saved = tables.health_streams.filter(row => {
    const binding = streamBinding(row);
    return binding.tenantId === context.tenantId && binding.sourceStoreId === context.sourceStoreId;
  });
  return saved.map(stream => {
    const receipts = tables.health_batch_receipts.filter(row => row.stream_key === stream.stream_key);
    assert.ok(receipts.some(row => row.sequence === stream.acknowledged_sequence));
    for (const receipt of receipts) {
      assert.match(receipt.payload_digest, /^sha256:[a-f0-9]{64}$/);
      const job = tables.health_projection_outbox.find(row =>
        row.stream_key === receipt.stream_key && row.sequence === receipt.sequence);
      assert.ok(job);
      assert.deepEqual(job, { stream_key: receipt.stream_key, sequence: receipt.sequence,
        batch_id: receipt.batch_id, payload_digest: receipt.payload_digest, state: 'queued' });
      assert.deepEqual(JSON.parse(receipt.receipt_json), {
        version: 1, kind: 'durable-receipt', binding: streamBinding(stream),
        recordType: stream.record_type, sequence: receipt.sequence,
        batchId: receipt.batch_id, payloadDigest: receipt.payload_digest,
      });
    }
    return [stream.stream_key, stream.record_type, stream.acknowledged_sequence];
  });
}
function matches(row, context, type, id) {
  return row.tenant_id === context.tenantId && row.source_store_id === context.sourceStoreId &&
    row.record_type === type && row.native_record_id === id;
}
function statesFromRows(context, identities, tables, footprints) {
  return selection(identities).map(([type, id]) => {
    const current = tables.health_records.find(row => matches(row, context, type, id));
    const tomb = tables.health_tombstones.find(row => matches(row, context, type, id));
    const guard = (tables.health_deletion_guards || []).find(row => matches(row, context, type, id));
    // Common footprints come from independently fixed fixture literals, not a
    // product parser or an inferred period for an unseen ID.
    const known = footprints[`${type}\0${id}`] ?? null;
    const raw = current ? [current.serializer_id, Number(current.serializer_version),
      current.data_family, current.projection, Buffer.byteLength(current.record_json),
      sha(Buffer.from(current.record_json)), footprintArray(known)] : null;
    const guarded = guard ? [Number(guard.source_deleted), Number(guard.user_suppressed),
      guard.source_stream_key, guard.source_sequence,
      guard.footprint_json === null ? null : footprintArray(JSON.parse(guard.footprint_json))] : null;
    const staging = (tables.health_object_staging || []).flatMap(row => {
      const declaration = JSON.parse(row.declaration_json);
      if (declaration.identity.tenantId !== context.tenantId ||
          declaration.identity.sourceStoreId !== context.sourceStoreId ||
          declaration.identity.recordType !== type || declaration.identity.nativeRecordId !== id) return [];
      const parts = (tables.health_object_parts || []).filter(part => part.stream_key === row.stream_key)
        .map(part => {
          assert.equal(part.part_bytes.type, 'blob');
          assert.equal(part.part_bytes.digest, part.part_digest, 'independent actual BLOB hash');
          return [Number(part.part_index), part.part_bytes.bytes, part.part_bytes.digest];
        }).sort((a, b) => a[0] - b[0]);
      return [[row.stream_key, declarationArray(declaration), Number(row.created_at),
        Number(row.expires_at), Number(row.reservation_bytes), parts]];
    }).sort((a, b) => ordinal(a[0], b[0]));
    return [type, id, raw, tomb ? [tomb.stream_key, tomb.sequence] : null, guarded, staging];
  });
}
function effectCounts(states) {
  const result = { newlyUserSuppressed: 0, removedRecords: 0,
    removedStagedObjects: 0, removedParts: 0, removedPartBytes: 0 };
  for (const state of states) {
    if (state[4]?.[1] !== 1) result.newlyUserSuppressed++;
    if (state[2] !== null) result.removedRecords++;
    for (const object of state[5]) {
      result.removedStagedObjects++;
      for (const part of object[5]) {
        result.removedParts++; result.removedPartBytes += part[1];
      }
    }
  }
  return result;
}
function expected(context, identities, tables, footprints) {
  const vector = verifiedVector(context, tables);
  const states = statesFromRows(context, identities, tables, footprints);
  const content = revision(context, identities, vector, states);
  const effects = effectCounts(states);
  const preview = { version: 1, kind: 'deletion-preview', sourceStoreId: context.sourceStoreId,
    revision: content.digest, identities: states.map(state => ({
      recordType: state[0], nativeRecordId: state[1],
      sourceDeleted: state[3] !== null || state[4]?.[0] === 1,
      userSuppressed: state[4]?.[1] === 1, currentRecord: state[2] !== null,
      footprint: footprintObject(state[4]?.[4] ?? state[2]?.[6] ?? null),
    })), effects };
  return { content, preview, apply: projectionQueued => ({
    version: 1, kind: 'deletion-result', sourceStoreId: context.sourceStoreId,
    revision: content.digest, effects, projectionQueued,
  }) };
}
module.exports = { bank, sha, ordinal, selection, revision, declarationArray,
  footprintArray, footprintObject, verifiedVector, statesFromRows, effectCounts, expected };
