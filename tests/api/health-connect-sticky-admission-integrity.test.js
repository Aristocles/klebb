// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Two fixed changed-boundary controls; not real generation/restore endpoints.
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../helpers/health-connect-sticky-admission-fixture.cjs');

test('I01 valid saved generation zero deletion keeps positive source sequence and sticky identity',
  async () => {
    const data = await F.fixture({ v2: true });
    try {
      const originalBinding = { ...data.alpha.binding };
      const before = F.coldRead(data.home);
      await F.stop(data);
      await F.control(data, { command: 'authority',
        sourceStoreId: originalBinding.sourceStoreId, recordType: F.TYPE, generation: '0' });
      await F.restart(data);
      const current = await F.capabilities(data);
      assert.equal(current.json.streams[F.TYPE].generation, '0');
      assert.equal(current.json.streams[F.TYPE].acknowledgedSequence, '0');
      for (const name of ['tenantId', 'instanceId', 'sourceStoreId', 'installationId', 'restoreEpoch']) {
        assert.equal(current.json[name], originalBinding[name], name);
      }
      // Only the disclosed saved generation changes. Actual returned capability
      // and current native headers validate this controlled source boundary.
      data.alpha.paired.streams[F.TYPE].generation = '0';
      data.alpha.binding.generation = '0';
      const vector = F.batch(data.alpha, '1', [F.deletion(data.alpha)],
        { id: 'generation-zero-source-delete' });
      assert.equal(vector.payload.binding.generation, '0');
      assert.equal(vector.payload.sequence, '1');
      await F.ack(data, data.alpha, vector);
      const committed = F.coldRead(data.home);
      const target = F.identity(data.alpha);
      assert.deepEqual(F.identityRows(committed, 'health_records', target), []);
      for (const [source, type] of [[data.beta, F.TYPE], [data.alpha, F.TYPES[1]]]) {
        assert.deepEqual(F.identityRows(committed, 'health_records', F.identity(source, type)),
          F.identityRows(before, 'health_records', F.identity(source, type)));
      }
      assert.deepEqual(F.identityRows(committed, 'health_tombstones', target), [{
        tenant_id: target.tenantId, source_store_id: target.sourceStoreId,
        record_type: F.TYPE, native_record_id: F.ID,
        stream_key: F.streamKey(data.alpha), sequence: '1',
      }]);
      assert.deepEqual(F.identityRows(committed, 'health_deletion_guards', target), [{
        tenant_id: target.tenantId, source_store_id: target.sourceStoreId,
        record_type: F.TYPE, native_record_id: F.ID,
        source_deleted: '1', user_suppressed: '0',
        source_stream_key: F.streamKey(data.alpha), source_sequence: '1',
        footprint_json: '{"kind":"instant","time":"2026-01-02T03:04:05.123456789Z","zoneOffset":"+11:00"}',
      }]);
      assert.equal(JSON.parse(F.streamKey(data.alpha))[5], '0');
      assert.equal(F.rows(committed, 'health_batch_receipts').length, 4);
      assert.equal(F.rows(committed, 'health_projection_outbox').length, 4);
      const next = F.batch(data.alpha, '2', [F.upsert(data.alpha)],
        { id: 'generation-zero-suppressed-upsert' });
      await F.unchanged(data, () => F.post(data, data.alpha, F.BATCH, next.wire),
        { status: 409, code: 'deletion-suppressed' });
    } finally { await F.close(data); }
  });

test('I02 two distinct valid stored time members refuse ambiguous footprint without any deletion effects',
  async () => {
    const data = await F.fixture({ v2: true });
    try {
      const original = F.bank.recordInventory[0].recordJson;
      const firstTime = '2026-01-02T03:04:05.123456789Z';
      const secondTime = '2026-01-03T03:04:05.123456789Z';
      assert.notEqual(firstTime, secondTime);
      const prefix = `{"time":"${firstTime}"`;
      assert.ok(original.startsWith(prefix));
      const ambiguous = `{"time":"${firstTime}","time":"${secondTime}"` + original.slice(prefix.length);
      assert.equal((ambiguous.match(/"time":/g) || []).length, 2);
      // Preserve every other original field and byte. This is deliberately
      // corrupted stopped raw storage, not an accepted wire or SDK record.
      await F.mutate(data, [{
        sql: 'UPDATE health_records SET record_json=? WHERE tenant_id=? AND source_store_id=? '
          + 'AND record_type=? AND native_record_id=?',
        params: [ambiguous, data.alpha.binding.tenantId, data.alpha.binding.sourceStoreId, F.TYPE, F.ID],
      }]);
      await F.capabilities(data);
      const cold = F.coldRead(data.home);
      assert.equal(F.identityRows(cold, 'health_records', F.identity(data.alpha))[0].record_json, ambiguous);
      assert.deepEqual(F.rows(cold, 'health_deletion_guards'), []);
      const vector = F.batch(data.alpha, '2', [F.deletion(data.alpha)],
        { id: 'refuse-ambiguous-stored-period' });
      await F.unchanged(data, () => F.post(data, data.alpha, F.BATCH, vector.wire),
        { status: 503, code: 'storage-unavailable' });
    } finally { await F.close(data); }
  });
