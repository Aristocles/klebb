// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { waitFor } = require('../helpers/sandbox');
const {
  product, fixture, restart, close, first, second, postBatch, ownerStatus, ownerRebuild,
  waitForStatus, noAuthority, req, TARGET, TABLE_NAMES, coldReadSourceState,
  publicationOf, assertFirstNative, assertSecondNative, assertFirstIndex,
  expectedIndex, expectedFrontier, vectorDigest,
} = require('../helpers/health-connect-source-index-test-fixture.cjs');
const preload = path.join(__dirname, '../helpers/health-connect-source-index-lifecycle-preload.cjs');
const STARTUP_EPOCH = 'd1000000-0000-4000-8000-000000000070';
const FINAL_FENCE_EPOCH = 'd1000000-0000-4000-8000-000000000071';
const RECOVERY_FAILURE = {
  error: 'an interrupted import could not be recovered at boot; this instance refuses to serve',
  code: 'IMPORT_RECOVERY_FAILED',
  reason: 'an import was interrupted mid-apply and neither the staged tree nor the '
    + 'rollback snapshot survives; refusing to serve or seed over a half-applied instance',
};
function file(data, directory, name) {
  assert.ok(path.resolve(data.home).startsWith(path.resolve(os.tmpdir()) + path.sep));
  assert.ok(path.basename(data.home).startsWith('eh-test-'));
  const result = path.resolve(data.home, directory, name);
  assert.equal(path.dirname(result), path.resolve(data.home, directory));
  return result;
}
async function stop(data) { await data.server.kill(); data.server = null; }
async function finish(data) {
  if (data.server) await stop(data);
  try { noAuthority(data.requestLogs, data); } finally { await close(data); }
}
function environment(data, action = 'observe', newEpoch = '') {
  data.observations = file(data, '', 'source-index-lifecycle-observations.jsonl');
  data.enabled = file(data, '', 'source-index-lifecycle-enabled');
  return { NODE_OPTIONS: `--require "${preload.replaceAll('\\', '/')}"`,
    INDEPENDENT_PRODUCT_ROOT: product,
    INDEPENDENT_INDEX_LIFECYCLE_ACTION: action,
    INDEPENDENT_INDEX_LIFECYCLE_NEW_EPOCH: newEpoch,
    INDEPENDENT_INDEX_LIFECYCLE_OBSERVATIONS: data.observations,
    INDEPENDENT_INDEX_LIFECYCLE_ENABLED: data.enabled };
}
function events(data) {
  if (!fs.existsSync(data.observations)) return [];
  const lines = fs.readFileSync(data.observations, 'utf8').split('\n');
  lines.pop(); // Only an incomplete concurrent last line may be ignored.
  return lines.filter(Boolean).map(JSON.parse);
}
function ownFull(observed, event) {
  const before = observed.find(row => row.kind === 'publisher-before-begin' &&
    row.handleId === event.handleId && row.transactionId === event.transactionId);
  assert.ok(before);
  assert.equal(before.transactionActive, false);
  assert.equal(before.journalMode, 'wal');
  assert.equal(before.synchronous, 2);
}
async function saved(data, vector) {
  const response = await postBatch(data, vector);
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, vector.receipt);
  noAuthority(response.body, data);
}
function current(data, sequence, epoch = data.binding.restoreEpoch) {
  return waitForStatus(data, json => json.target === TARGET && json.sources.length === 1 &&
    json.sources[0].state === 'current' && json.sources[0].currentRestoreEpoch === epoch &&
    json.sources[0].published.restoreEpoch === epoch &&
    json.sources[0].saved.frontiers[0].acknowledgedSequence === sequence);
}
async function initial(data) {
  await saved(data, first(data));
  await current(data, '1');
  const cold = coldReadSourceState(data.home);
  assertFirstNative(cold.native, data);
  assertFirstIndex(cold.index, data);
  return cold;
}
function assertFence(index, data, sequence, epoch) {
  assert.deepEqual(index.indexRows, expectedIndex(data, sequence));
  assert.deepEqual(index.frontierRows, [expectedFrontier(data, sequence)],
    'saved historical stream retains its original binding, including its old epoch');
  assert.equal(index.stateRows.length, 1);
  const state = index.stateRows[0];
  assert.equal(state.tenant_id, data.binding.tenantId);
  assert.equal(state.source_store_id, data.binding.sourceStoreId);
  assert.equal(state.target_id, TARGET);
  assert.equal(state.state, 'current');
  assert.equal(state.requested_restore_epoch, epoch);
  assert.equal(state.requested_vector_digest, vectorDigest([expectedFrontier(data, sequence)]));
  assert.equal(state.published_restore_epoch, epoch);
  assert.equal(state.attempt_count, 1);
  assert.equal(state.next_attempt_at, null);
  assert.equal(state.error_code, null);
  assert.ok(Number.isSafeInteger(state.published_at) &&
    state.published_at >= data.fixtureStartedAt && state.published_at <= Date.now());
  noAuthority(JSON.stringify(index), data);
}
function rotateStoppedCatalogue(data, epoch) {
  assert.equal(data.server, null);
  const target = file(data, 'credentials', 'health-connect.json');
  const state = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.equal(state.restoreEpoch, data.binding.restoreEpoch);
  assert.notEqual(state.restoreEpoch, epoch);
  state.restoreEpoch = epoch;
  // Controlled restore-fence input only, not complete managed restore/R0 proof.
  fs.writeFileSync(target, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
}

test('changed live restore fence rebuilds the same saved old-binding vector and refuses the pre-restore native credential',
  { timeout: 25000 }, async () => {
    const data = await fixture();
    try {
      const before = await initial(data);
      await stop(data);
      rotateStoppedCatalogue(data, STARTUP_EPOCH);
      assert.deepEqual(coldReadSourceState(data.home), before);
      await restart(data, environment(data));
      const status = await current(data, '1', STARTUP_EPOCH);
      assert.deepEqual(status.json.sources[0].saved.frontiers,
        [{ binding: data.binding, recordType: expectedFrontier(data, '1').record_type,
          acknowledgedSequence: '1' }]);
      const rebuilt = coldReadSourceState(data.home);
      assert.deepEqual(rebuilt.native, before.native);
      assertFence(rebuilt.index, data, '1', STARTUP_EPOCH);
      assert.notEqual(rebuilt.index.stateRows[0].published_at, before.index.stateRows[0].published_at);
      const writes = events(data).filter(row => row.kind === 'successful-derived-write' && row.changes > 0);
      assert.ok(writes.length > 0, 'startup executed the actual production publisher');
      for (const write of writes) ownFull(events(data), write);
      const refused = await postBatch(data, first(data));
      assert.equal(refused.status, 401);
      assert.equal(refused.json.code, 'revoked');
      noAuthority(refused.body, data);
      assert.deepEqual(coldReadSourceState(data.home), rebuilt,
        'old credential refusal cannot change saved receipts or new publication');
    } finally { await finish(data); }
  });

test('actual final live fence change rolls back already-written publisher identities vector and current rows before rebuild',
  { timeout: 25000 }, async () => {
    const data = await fixture();
    try {
      const before = await initial(data);
      await restart(data, environment(data, 'rotate', FINAL_FENCE_EPOCH));
      assert.deepEqual(coldReadSourceState(data.home), before);
      fs.writeFileSync(data.enabled, 'enabled\n', { mode: 0o600 });
      await saved(data, second(data));
      await waitFor(() => events(data).some(row => row.kind === 'publisher-rollback-complete'),
        { timeoutMs: 10000, what: 'actual publisher rollback after changed catalogue fence' });
      const observed = events(data);
      const rotations = observed.filter(row => row.kind ===
        'actual-catalogue-fence-rotated-after-publication-writes');
      assert.equal(rotations.length, 1);
      const rotated = rotations[0];
      ownFull(observed, rotated);
      assert.equal(rotated.oldEpoch, data.binding.restoreEpoch);
      assert.equal(rotated.newEpoch, FINAL_FENCE_EPOCH);
      assert.equal(rotated.pendingState, 'current');
      assert.equal(rotated.pendingPublishedEpoch, data.binding.restoreEpoch);
      assert.equal(rotated.transactionActive, true);
      assert.ok(rotated.identitiesWritten > 0 && rotated.frontiersWritten > 0);
      assert.ok(observed.some(row => row.kind === 'successful-derived-write' && row.changes > 0 &&
        row.handleId === rotated.handleId && row.transactionId === rotated.transactionId &&
        observed.indexOf(row) < observed.indexOf(rotated)));
      assert.ok(observed.some(row => row.kind === 'publisher-rollback-complete' &&
        row.handleId === rotated.handleId && row.transactionId === rotated.transactionId));
      assert.equal(observed.some(row => row.kind === 'publisher-commit-complete' &&
        row.handleId === rotated.handleId && row.transactionId === rotated.transactionId), false);
      const rolledBack = coldReadSourceState(data.home);
      assertSecondNative(rolledBack.native, data);
      assert.deepEqual(publicationOf(rolledBack.index), publicationOf(before.index));
      assert.equal(rolledBack.index.stateRows[0].state, 'queued');
      assert.equal(rolledBack.index.stateRows[0].requested_restore_epoch, data.binding.restoreEpoch);
      assert.equal(rolledBack.index.stateRows[0].attempt_count, 1);
      const status = await ownerStatus(data);
      assert.equal(status.status, 200);
      assert.equal(status.json.sources[0].state, 'queued');
      assert.equal(status.json.sources[0].currentRestoreEpoch, FINAL_FENCE_EPOCH);
      assert.equal(status.json.sources[0].published.restoreEpoch, data.binding.restoreEpoch);
      assert.equal(status.json.sources[0].saved.frontiers[0].acknowledgedSequence, '2');
      assert.deepEqual(coldReadSourceState(data.home), rolledBack);
      noAuthority(status.body, data);
      fs.unlinkSync(data.enabled);
      const queued = await ownerRebuild(data);
      assert.equal(queued.status, 202);
      assert.deepEqual(queued.json, { target: TARGET, queuedSources: 1 });
      noAuthority(queued.body, data);
      await current(data, '2', FINAL_FENCE_EPOCH);
      const rebuilt = coldReadSourceState(data.home);
      assert.deepEqual(rebuilt.native, rolledBack.native);
      assertFence(rebuilt.index, data, '2', FINAL_FENCE_EPOCH);
    } finally { await finish(data); }
  });

test('actual refused import recovery startup never schedules initialises or publishes saved source history',
  { timeout: 25000 }, async () => {
    const data = await fixture();
    try {
      const complete = await initial(data);
      await stop(data);
      // Explicit stopped-child derived recovery fixture; source/receipt/legacy
      // history is already genuinely committed and remains untouched.
      const db = new DatabaseSync(file(data, 'db', 'klebb.db'));
      try {
        db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
        for (const table of TABLE_NAMES) db.exec(`DROP TABLE ${table}`);
        db.exec('COMMIT');
      } finally { db.close(); }
      const before = coldReadSourceState(data.home);
      assert.deepEqual(before.native, complete.native);
      assert.equal(before.index.schemaPresent, false);
      const importDirectory = path.join(data.home, 'import');
      fs.mkdirSync(importDirectory, { recursive: true });
      const job = file(data, 'import', 'job.json');
      const marker = JSON.stringify({ state: 'applying',
        treePath: file(data, 'import', 'missing-tree'),
        snapshotPath: file(data, 'import', 'missing-snapshot') });
      fs.writeFileSync(job, marker, { encoding: 'utf8', mode: 0o600 });
      await restart(data, environment(data));
      assert.equal((await req(data.server.baseUrl, '/healthz')).status, 200);
      assert.equal((await req(data.server.baseUrl, '/api/import/status',
        { cookie: data.owner.cookie })).status, 200);
      for (const request of [() => ownerStatus(data), () => ownerRebuild(data)]) {
        const refused = await request();
        assert.equal(refused.status, 503);
        assert.deepEqual(refused.json, RECOVERY_FAILURE);
        noAuthority(refused.body, data);
        assert.deepEqual(coldReadSourceState(data.home), before);
        assert.equal(fs.readFileSync(job, 'utf8'), marker);
      }
      await stop(data);
      assert.deepEqual(coldReadSourceState(data.home), before);
      assert.ok(events(data).some(row => row.kind === 'lifecycle-observer-loaded'));
      assert.equal(events(data).some(row => row.kind.startsWith('publisher-')), false,
        'the loaded actual publisher observer witnessed no scheduled publication handle');
    } finally { await finish(data); }
  });
