// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const F = require('../helpers/health-connect-sticky-admission-fixture.cjs');
const BODY = 'BodyWaterMassRecord', CYCLE = 'CyclingPedalingCadenceRecord', STEPS = 'StepsRecord';
const digest = text => 'sha256:' + crypto.createHash('sha256').update(text).digest('hex');
const currentBinding = (source, generation) => ({
  tenantId: source.binding.tenantId, instanceId: source.binding.instanceId,
  sourceStoreId: source.binding.sourceStoreId, installationId: source.binding.installationId,
  generation, restoreEpoch: source.binding.restoreEpoch,
});
const category = (snapshot, source, type) => F.rows(snapshot, 'health_source_policy_categories')
  .find(row => row.tenant_id === source.binding.tenantId &&
    row.source_store_id === source.binding.sourceStoreId && row.record_type === type);
function immutableHistory(snapshot) {
  return Object.fromEntries(['health_records', 'health_tombstones', 'health_streams',
    'health_batch_receipts'].map(table => [table, F.rows(snapshot, table)]));
}
function originalRows(data, snapshot = F.coldRead(data.home)) {
  assert.equal(F.rows(snapshot, 'health_records').length, 3);
  assert.equal(F.rows(snapshot, 'health_batch_receipts').length, 3);
  const roles = [[data.alpha, BODY], [data.beta, BODY], [data.alpha, CYCLE]];
  for (let index = 0; index < roles.length; index++) {
    const [source, type] = roles[index], item = F.bank.recordInventory[index];
    assert.equal(item.identity[2], type); assert.equal(item.identity[3], 'r0-shared-id');
    const target = { tenantId: source.binding.tenantId, sourceStoreId: source.binding.sourceStoreId,
      recordType: type, nativeRecordId: 'r0-shared-id' };
    const saved = F.identityRows(snapshot, 'health_records', target);
    assert.equal(saved.length, 1); assert.equal(saved[0].record_json, item.recordJson);
    assert.equal(digest(saved[0].record_json), item.expectedRecordDigest);
    const bound = currentBinding(source, '2');
    const batchId = `sticky-original-${index}`;
    const payloadJson = JSON.stringify({ binding: bound, recordType: type, sequence: '1', batchId,
      changes: [{ operation: 'upsert', identity: target, dataFamily: 'ordinary', projection: 'raw-only',
        serializerId: 'health-connect-record', serializerVersion: 1, record: JSON.parse(item.recordJson) }] });
    const expected = { version: 1, kind: 'durable-receipt', binding: bound, recordType: type,
      sequence: '1', batchId, payloadDigest: digest(payloadJson) };
    const receipts = F.rows(snapshot, 'health_batch_receipts').filter(row => row.batch_id === batchId);
    assert.equal(receipts.length, 1); assert.deepEqual(JSON.parse(receipts[0].receipt_json), expected);
    assert.equal(receipts[0].payload_digest, expected.payloadDigest);
    assert.equal(receipts[0].stream_key, JSON.stringify([bound.tenantId, bound.instanceId,
      bound.sourceStoreId, bound.installationId, type, '2', bound.restoreEpoch]));
    assert.deepEqual(data.original[index].receipt, expected);
  }
  return snapshot;
}

test('FIXREADY01 explicit V2 activation obtains three genuine gen2 seed ACKs with unchanged raw identities', async () => {
  // This fixture version runs authenticated API setup; no invented report is native SDK evidence.
  const data = await F.fixture({ readinessVersion: 2 });
  try {
    assert.notEqual(data.alpha.binding.tenantId, data.beta.binding.tenantId);
    const snapshot = originalRows(data);
    assert.equal(data.readiness.length, 3);
    const scopes = [[data.alpha, BODY, '2', '3'], [data.beta, BODY, '2', '3'],
      [data.alpha, CYCLE, '4', '5']];
    for (let index = 0; index < scopes.length; index++) {
      const [source, type, challengeRevision, completeRevision] = scopes[index];
      const observed = data.readiness[index];
      assert.equal(observed.recordType, type);
      assert.equal(observed.initial.sharing, 'stopped'); assert.equal(observed.initial.verification, 'unverified');
      assert.deepEqual(observed.initial.binding, currentBinding(source, '1'));
      assert.deepEqual(observed.challenge.binding, currentBinding(source, '2'));
      assert.equal(observed.challenge.policyRevision, challengeRevision);
      assert.equal(observed.challenge.acknowledgedSequence, '0');
      assert.equal(observed.result.policyRevision, completeRevision);
      assert.equal(observed.result.sharing, 'enabled');
      assert.equal(observed.result.verification, 'authenticated-companion-report');
      const stored = category(snapshot, source, type);
      assert.equal(stored.sharing, 'enabled'); assert.equal(stored.generation, '2');
      assert.equal(stored.readiness_generation, '2');
    }
    for (const [source, type] of [[data.alpha, STEPS], [data.beta, CYCLE], [data.beta, STEPS]]) {
      const stopped = category(snapshot, source, type);
      assert.equal(stopped.sharing, 'stopped'); assert.equal(stopped.generation, '1');
      assert.equal(stopped.readiness_mac, null);
    }
    assert.deepEqual(F.rows(snapshot, 'health_tombstones'), []);
    assert.equal(snapshot.native.tables.health_deletion_guards, undefined);
    F.noAuthority(JSON.stringify(snapshot), data);
  } finally { await F.close(data); }
});

test('FIXREADY02 Steps stays stopped until its own genuine readiness and leaves the three seed scopes exact', async () => {
  const data = await F.fixture({ readinessVersion: 2 });
  try {
    const before = originalRows(data);
    const selected = [[data.alpha, BODY], [data.beta, BODY], [data.alpha, CYCLE]];
    const stepsItem = { identity: ['fixture', 'fixture', STEPS, 'explicit-step-readiness'],
      recordJson: '{"startTime":"2026-01-02T03:00:00Z","endTime":"2026-01-02T03:10:00Z",'
        + '"count":"1234","metadata":{"id":"explicit-step-readiness"}}' };
    const stopped = F.batch(data.alpha, '1', [F.upsert(data.alpha, stepsItem, 'explicit-step-readiness')],
      { type: STEPS, id: 'explicit-step-before-readiness' });
    assert.equal(stopped.payload.binding.generation, '1');
    await F.unchanged(data, () => F.post(data, data.alpha, F.BATCH, stopped.wire),
      { code: 'IMPORT_SOURCE_POLICY_UNKNOWN' });
    const activated = await F.activateReadiness(data, data.alpha, STEPS);
    assert.deepEqual(activated.binding, currentBinding(data.alpha, '2'));
    assert.equal(activated.policyRevision, '7');
    const trace = data.readiness[3];
    assert.equal(trace.challenge.policyRevision, '6'); assert.equal(trace.challenge.acknowledgedSequence, '0');
    const after = F.coldRead(data.home);
    assert.deepEqual(immutableHistory(after), immutableHistory(before));
    for (const [source, type] of selected) {
      assert.deepEqual(category(after, source, type), category(before, source, type));
    }
    assert.deepEqual(category(after, data.beta, STEPS), category(before, data.beta, STEPS));
    // This is a newly constructed frame using actual refreshed generation2, not an edited old frame.
    const fresh = F.batch(data.alpha, '1', [F.upsert(data.alpha, stepsItem, 'explicit-step-readiness')],
      { type: STEPS, id: 'explicit-step-after-readiness' });
    assert.equal(fresh.payload.binding.generation, '2');
    assert.equal(stopped.payload.binding.generation, '1');
    const saved = await F.ack(data, data.alpha, fresh);
    assert.equal(saved.json.sequence, '1'); assert.equal(saved.json.binding.generation, '2');
    const final = F.coldRead(data.home);
    assert.equal(F.rows(final, 'health_records').length, 4);
    assert.equal(F.rows(final, 'health_batch_receipts').length, 4);
    for (const item of F.rows(before, 'health_batch_receipts')) {
      assert.ok(F.rows(final, 'health_batch_receipts').some(row =>
        JSON.stringify(row) === JSON.stringify(item)), 'Every original seed receipt remains exact');
    }
  } finally { await F.close(data); }
});

test('FIXREADY03 cold gen2 status and explicit gen3 begin retain all old ACKs before a fresh new stream upload', async () => {
  const data = await F.fixture({ readinessVersion: 2 });
  try {
    const before = originalRows(data);
    const originalReceipts = structuredClone(data.original.map(item => item.receipt));
    await F.restart(data);
    const current = await F.readinessStatus(data, data.alpha, BODY);
    assert.deepEqual(current.json.binding, currentBinding(data.alpha, '2'));
    assert.equal(current.json.sharing, 'enabled');
    assert.equal(current.json.verification, 'authenticated-companion-report');
    const capabilities = await F.capabilities(data, data.alpha);
    assert.deepEqual(capabilities.json.streams[BODY], { generation: '2', acknowledgedSequence: '1' });
    assert.deepEqual(immutableHistory(F.coldRead(data.home)), immutableHistory(before));
    const activated = await F.activateReadiness(data, data.alpha, BODY);
    assert.deepEqual(activated.binding, currentBinding(data.alpha, '3'));
    assert.equal(activated.policyRevision, '7');
    const trace = data.readiness[3];
    assert.equal(trace.challenge.policyRevision, '6'); assert.equal(trace.challenge.acknowledgedSequence, '0');
    const pending = F.coldRead(data.home);
    assert.deepEqual(immutableHistory(pending), immutableHistory(before));
    assert.deepEqual(category(pending, data.alpha, CYCLE), category(before, data.alpha, CYCLE));
    assert.deepEqual(category(pending, data.beta, BODY), category(before, data.beta, BODY));
    assert.deepEqual(data.original.map(item => item.receipt), originalReceipts);
    const fresh = F.batch(data.alpha, '1',
      [F.upsert(data.alpha, F.bank.recordInventory[0], 'explicit-gen3-body-water')],
      { type: BODY, id: 'explicit-gen3-after-readiness' });
    assert.equal(fresh.payload.binding.generation, '3');
    assert.equal(fresh.payload.sequence, '1');
    const saved = await F.ack(data, data.alpha, fresh);
    assert.equal(saved.json.binding.generation, '3'); assert.equal(saved.json.sequence, '1');
    const final = F.coldRead(data.home);
    assert.equal(F.rows(final, 'health_records').length, 4);
    assert.equal(F.rows(final, 'health_batch_receipts').length, 4);
    for (const item of F.rows(before, 'health_batch_receipts')) {
      assert.ok(F.rows(final, 'health_batch_receipts').some(row =>
        JSON.stringify(row) === JSON.stringify(item)), 'Old gen2 ACKs retain their own stream keys and JSON');
    }
    assert.deepEqual(data.original.map(item => item.receipt), originalReceipts);
    for (const [index, source] of [[0, data.alpha], [1, data.beta], [2, data.alpha]]) {
      const item = F.bank.recordInventory[index];
      const stored = F.identityRows(final, 'health_records',
        { tenantId: source.binding.tenantId, sourceStoreId: source.binding.sourceStoreId,
          recordType: item.identity[2], nativeRecordId: 'r0-shared-id' });
      assert.equal(stored.length, 1); assert.equal(stored[0].record_json, item.recordJson);
    }
  } finally { await F.close(data); }
});
