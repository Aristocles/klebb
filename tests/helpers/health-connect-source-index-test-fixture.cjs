// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const authority = require('./health-connect-object-test-fixture.cjs');
const vectors = require('../fixtures/health-connect/durable-history-independent-vectors.json');
const { coldReadSourceState, coldReadSourceIndex, coldReadSourceNative, publicationOf,
  TABLE_DDL, TABLE_NAMES } = require('./health-connect-source-index-cold-readback.cjs');

const { product, ENV, BASE, TYPE, req, pair, restart, close, noAuthority } = authority;
const ORIGIN = ENV.HEALTH_ORIGIN;
const TARGET = 'source-index-v1';
const BATCHES = `${BASE}/v1/batches`;
const STATUS = `${BASE}/projections/status`;
const REBUILD = `${BASE}/projections/rebuild`;
const sha = text => 'sha256:' + crypto.createHash('sha256').update(text, 'utf8').digest('hex');

function bindVector(id, data) {
  const template = vectors.vectors.find(vector => vector.id === id);
  assert.ok(template, 'original independently fixed ordinary bank vector exists');
  const payload = JSON.parse(template.payloadJson);
  payload.binding = { ...data.binding };
  for (const change of payload.changes) {
    change.identity.tenantId = data.binding.tenantId;
    change.identity.sourceStoreId = data.binding.sourceStoreId;
  }
  const payloadJson = JSON.stringify(payload);
  const payloadDigest = sha(payloadJson);
  return {
    payload, wire: { version: 1, kind: 'batch', payloadJson, payloadDigest },
    receipt: { version: 1, kind: 'durable-receipt', binding: { ...data.binding },
      recordType: TYPE, sequence: payload.sequence, batchId: payload.batchId, payloadDigest },
  };
}
const first = data => bindVector('initial-raw-only', data);
const second = data => bindVector('second-delete-and-correction', data);

async function fixture(extraEnv = {}, expectedPublishedAt) {
  const fixtureStartedAt = Date.now();
  const data = await authority.fixture(extraEnv);
  try {
    data.fixtureStartedAt = fixtureStartedAt;
    if (expectedPublishedAt !== undefined) {
      assert.ok(Number.isSafeInteger(expectedPublishedAt));
      data.expectedPublishedAt = expectedPublishedAt;
    }
    data.initial = coldReadSourceState(data.home);
    assert.deepEqual(data.initial.native.records, []);
    assert.deepEqual(data.initial.native.receipts, []);
    assert.deepEqual(data.initial.native.jobs, []);
    assert.ok(data.initial.native.legacyRows.length > 0, 'real nonempty sentinel exists');
    // No status/rebuild call is hidden in setup: missing routes remain behavioural red.
    return data;
  } catch (error) {
    await close(data);
    throw error;
  }
}
function postBatch(data, vector, headers = data.headers) {
  return req(data.server.baseUrl, BATCHES, {
    method: 'POST', headers, body: vector.wire ?? vector,
  });
}
function ownerStatus(data, options = {}) {
  return req(data.server.baseUrl, STATUS, {
    cookie: data.owner.cookie, ...options,
    headers: { Origin: ORIGIN, ...options.headers },
  });
}
function ownerRebuild(data, body = {}, options = {}) {
  return req(data.server.baseUrl, REBUILD, {
    method: 'POST', cookie: data.owner.cookie, body, ...options,
    headers: { Origin: ORIGIN, ...options.headers },
  });
}
async function waitForStatus(data, predicate, { timeoutMs = 10000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  do {
    last = await ownerStatus(data);
    noAuthority(last.body, data);
    if (last.status === 200 && predicate(last.json)) return last;
    await delay(25);
  } while (Date.now() < deadline);
  assert.fail(`Bounded actual source-index status barrier not observed; last status ${last?.status}`);
}
function assertLegacy(native, data) {
  assert.deepEqual(native.legacyCards, data.initial.native.legacyCards);
  assert.deepEqual(native.legacyRows, data.initial.native.legacyRows);
  noAuthority(native.logicalNativeDump, data);
}
function assertFirstNative(native, data) {
  const vector = first(data);
  assert.deepEqual(native.records, vector.payload.changes.slice(0, 2).map(change => ({
    identity: change.identity, record: change.record,
  })));
  assert.deepEqual(native.tombstoneIds, ['unknown-deleted-id']);
  assert.deepEqual(native.receipts, [vector.receipt]);
  assert.deepEqual(native.frontiers, [{ recordType: TYPE, acknowledgedSequence: '1' }]);
  assert.deepEqual(native.jobs, [{ batchId: 'synthetic-batch-1', state: 'queued' }]);
  assertLegacy(native, data);
}
function assertSecondNative(native, data) {
  const initial = first(data);
  const corrected = second(data);
  assert.deepEqual(native.records, [{
    identity: corrected.payload.changes[1].identity,
    record: corrected.payload.changes[1].record,
  }]);
  assert.deepEqual(native.tombstoneIds, ['raw-a', 'unknown-deleted-id']);
  assert.deepEqual(native.receipts, [initial.receipt, corrected.receipt]);
  assert.deepEqual(native.frontiers, [{ recordType: TYPE, acknowledgedSequence: '2' }]);
  assert.deepEqual(native.jobs, [
    { batchId: 'synthetic-batch-1', state: 'queued' },
    { batchId: 'synthetic-batch-2', state: 'queued' },
  ]);
  assert.equal(native.logicalNativeDump.includes('37.250000000000000001'), false);
  assert.equal(native.logicalNativeDump.includes('38.000000000000000009'), false);
  assertLegacy(native, data);
}
function expectedFrontier(data, sequence) {
  const b = data.binding;
  return { tenant_id: b.tenantId, source_store_id: b.sourceStoreId,
    stream_key: JSON.stringify([b.tenantId, b.instanceId, b.sourceStoreId,
      b.installationId, TYPE, b.generation, b.restoreEpoch]),
    record_type: TYPE, acknowledged_sequence: sequence };
}
function expectedIndex(data, ordinal) {
  const b = data.binding;
  const identities = ordinal === '1' ?
    [['raw-a', 'record'], ['raw-b', 'record'], ['unknown-deleted-id', 'tombstone']] :
    [['raw-a', 'tombstone'], ['raw-b', 'record'], ['unknown-deleted-id', 'tombstone']];
  return identities.map(([id, kind]) => ({
    tenant_id: b.tenantId, source_store_id: b.sourceStoreId,
    record_type: TYPE, native_record_id: id, entry_kind: kind,
  }));
}
function vectorDigest(frontiers) {
  const pairs = frontiers.map(row => {
    assert.equal(typeof row.stream_key, 'string');
    assert.equal(typeof row.acknowledged_sequence, 'string');
    return [row.stream_key, row.acknowledged_sequence];
  }).sort((left, right) => left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0);
  return sha(JSON.stringify(pairs));
}
function assertCurrentIndex(index, data, sequence, { attemptCount = 1 } = {}) {
  assert.equal(index.schemaPresent, true);
  assert.deepEqual(index.indexRows, expectedIndex(data, sequence));
  assert.deepEqual(index.frontierRows, [expectedFrontier(data, sequence)]);
  assert.equal(index.stateRows.length, 1);
  const state = index.stateRows[0];
  assert.equal(state.tenant_id, data.binding.tenantId);
  assert.equal(state.source_store_id, data.binding.sourceStoreId);
  assert.equal(state.target_id, TARGET);
  assert.equal(state.state, 'current');
  assert.equal(state.requested_restore_epoch, data.binding.restoreEpoch);
  assert.equal(state.requested_vector_digest,
    vectorDigest([expectedFrontier(data, sequence)]));
  assert.equal(state.attempt_count, attemptCount);
  assert.equal(state.next_attempt_at, null);
  assert.equal(state.error_code, null);
  assert.equal(state.published_restore_epoch, data.binding.restoreEpoch);
  assert.equal(Number.isSafeInteger(state.published_at), true);
  if (data.expectedPublishedAt === undefined) {
  assert.ok(state.published_at >= data.fixtureStartedAt && state.published_at <= Date.now());
  } else {
    assert.equal(state.published_at, data.expectedPublishedAt);
  }
  noAuthority(JSON.stringify(index), data);
}
const assertFirstIndex = (index, data, options) => assertCurrentIndex(index, data, '1', options);
const assertSecondIndex = (index, data, options) => assertCurrentIndex(index, data, '2', options);

module.exports = { product, ENV, BASE, BATCHES, STATUS, REBUILD, TYPE, TARGET, ORIGIN,
  fixture, pair, restart, close, first, second, bindVector, postBatch,
  ownerStatus, ownerRebuild, waitForStatus, noAuthority, req, sha, expectedFrontier,
  expectedIndex, vectorDigest, assertFirstNative, assertSecondNative, assertFirstIndex, assertSecondIndex,
  coldReadSourceState, coldReadSourceIndex, coldReadSourceNative, publicationOf,
  TABLE_DDL, TABLE_NAMES };
