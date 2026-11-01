// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const product = process.env.INDEPENDENT_PRODUCT_ROOT || path.resolve(__dirname, '../..');
const { fixture, restart, close, first, second, postBatch, ownerRebuild,
  waitForStatus, noAuthority, coldReadSourceState, publicationOf,
  assertFirstNative, assertSecondNative, assertFirstIndex, assertSecondIndex,
  expectedFrontier, vectorDigest, TYPE, TARGET, BATCHES } =
  require(path.join(product, 'tests/helpers/health-connect-source-index-test-fixture.cjs'));
const preload = path.join(__dirname, '../helpers/health-connect-source-index-fault-preload.cjs');
const sha = text => 'sha256:' + crypto.createHash('sha256').update(text, 'utf8').digest('hex');

function faultEnv(data, operation) {
  data.observations = path.join(data.home, 'source-index-observations.jsonl');
  data.enabled = path.join(data.home, 'source-index-fault-enabled');
  return { NODE_OPTIONS: `--require "${preload.replaceAll('\\', '/')}"`,
    INDEPENDENT_PRODUCT_ROOT: product, INDEPENDENT_INDEX_FAULT: operation,
    INDEPENDENT_INDEX_OBSERVATIONS: data.observations,
    INDEPENDENT_INDEX_FAULT_ENABLED: data.enabled };
}
function events(data) {
  const text = fs.readFileSync(data.observations, 'utf8');
  const lines = text.split('\n');
  // Ignore only an incomplete concurrent final write, never a malformed
  // completed event. Cold post-exit reads retain every complete event.
  lines.pop();
  return lines.filter(Boolean).map(JSON.parse);
}
function ownFull(observed, fault) {
  const before = observed.find(event => event.kind === 'publisher-before-begin' &&
    event.handleId === fault.handleId && event.transactionId === fault.transactionId);
  assert.ok(before, 'the real publication handle is observed before its BEGIN');
  assert.equal(before.transactionActive, false);
  assert.equal(before.journalMode, 'wal');
  assert.equal(before.synchronous, 2);
}
const sourceOf = (json, data) => json.sources.find(source => source.sourceStoreId === data.binding.sourceStoreId);
async function current(data, sequence) {
  const response = await waitForStatus(data, json => {
    const source = sourceOf(json, data);
    return source?.state === 'current' && source.saved.complete &&
      source.saved.frontiers[0]?.acknowledgedSequence === sequence &&
      source.published?.frontiers[0]?.acknowledgedSequence === sequence;
  });
  assert.equal(response.json.target, TARGET);
  return response;
}
async function saved(data, vector) {
  const response = await postBatch(data, vector);
  assert.equal(response.status, 200, 'publication failure must not invalidate raw save ACK');
  assert.deepEqual(response.json, vector.receipt);
  noAuthority(response.body, data);
}
function enable(data) { fs.writeFileSync(data.enabled, 'enabled\n', { mode: 0o600 }); }
function disable(data) {
  assert.equal(path.dirname(data.enabled), data.home);
  fs.unlinkSync(data.enabled);
}
function largeSecond(data) {
  const payload = structuredClone(second(data).payload);
  const corrected = payload.changes.find(change => change.operation === 'upsert');
  assert.ok(corrected);
  const additions = Array.from({ length: 128 }, (_, ordinal) => {
    const change = structuredClone(corrected);
    const id = `index-full-${String(ordinal).padStart(3, '0')}-`.padEnd(256, 'I');
    assert.equal([...id].length, 256);
    change.identity.nativeRecordId = id;
    change.record.metadata.id = id;
    return change;
  });
  payload.changes.push(...additions);
  const payloadJson = JSON.stringify(payload), payloadDigest = sha(payloadJson);
  assert.ok(Buffer.byteLength(payloadJson, 'utf8') < 1048576);
  assert.equal(payload.changes.length, 130);
  return { payload, wire: { version: 1, kind: 'batch', payloadJson, payloadDigest },
    receipt: { version: 1, kind: 'durable-receipt', binding: data.binding,
      recordType: TYPE, sequence: '2', batchId: payload.batchId, payloadDigest } };
}
function assertLargeNative(native, data, vector) {
  const expected = vector.payload.changes.filter(change => change.operation === 'upsert')
    .map(change => ({ identity: change.identity, record: change.record }))
    .sort((left, right) => left.identity.nativeRecordId < right.identity.nativeRecordId ? -1 : 1);
  assert.equal(expected.length, 129);
  assert.deepEqual(native.records, expected);
  assert.deepEqual(native.tombstoneIds, ['raw-a', 'unknown-deleted-id']);
  assert.deepEqual(native.receipts, [first(data).receipt, vector.receipt]);
  assert.deepEqual(native.frontiers, [{ recordType: TYPE, acknowledgedSequence: '2' }]);
  assert.deepEqual(native.jobs, [{ batchId: 'synthetic-batch-1', state: 'queued' },
    { batchId: 'synthetic-batch-2', state: 'queued' }]);
  assert.deepEqual(native.legacyCards, data.initial.native.legacyCards);
  assert.deepEqual(native.legacyRows, data.initial.native.legacyRows);
  noAuthority(native.logicalNativeDump, data);
}
function assertLargeIndex(index, data, vector) {
  const ids = vector.payload.changes.filter(change => change.operation === 'upsert')
    .map(change => [change.identity.nativeRecordId, 'record'])
    .concat([['raw-a', 'tombstone'], ['unknown-deleted-id', 'tombstone']])
    .sort((left, right) => left[0] < right[0] ? -1 : 1);
  assert.deepEqual(index.indexRows, ids.map(([id, kind]) => ({
    tenant_id: data.binding.tenantId, source_store_id: data.binding.sourceStoreId,
    record_type: TYPE, native_record_id: id, entry_kind: kind,
  })));
  assert.deepEqual(index.frontierRows, [expectedFrontier(data, '2')]);
  assert.equal(index.stateRows.length, 1);
  const state = index.stateRows[0];
  assert.equal(state.tenant_id, data.binding.tenantId);
  assert.equal(state.source_store_id, data.binding.sourceStoreId);
  assert.equal(state.target_id, TARGET);
  assert.equal(state.state, 'current');
  assert.equal(state.attempt_count, 1);
  assert.equal(state.requested_restore_epoch, data.binding.restoreEpoch);
  assert.equal(state.requested_vector_digest, vectorDigest([expectedFrontier(data, '2')]));
  assert.equal(state.published_restore_epoch, data.binding.restoreEpoch);
  assert.equal(state.next_attempt_at, null);
  assert.equal(state.error_code, null);
  assert.ok(Number.isSafeInteger(state.published_at) &&
    state.published_at >= data.fixtureStartedAt && state.published_at <= Date.now());
  noAuthority(JSON.stringify(index), data);
}
async function initialPublished(data, operation, clockEnv) {
  const observationEnv = faultEnv(data, operation);
  if (clockEnv !== undefined) {
    observationEnv.NODE_OPTIONS = `${clockEnv.NODE_OPTIONS} ${observationEnv.NODE_OPTIONS}`;
    observationEnv.INDEPENDENT_FIXED_CHILD_CLOCK = clockEnv.INDEPENDENT_FIXED_CHILD_CLOCK;
    if (clockEnv.OWNER_INITIAL_PUBLICATION_CLOCK_DIRECTORY !== undefined) {
      observationEnv.OWNER_INITIAL_PUBLICATION_CLOCK_DIRECTORY =
        clockEnv.OWNER_INITIAL_PUBLICATION_CLOCK_DIRECTORY;
    }
  }
  await restart(data, observationEnv);
  await saved(data, first(data));
  await current(data, '1');
  const cold = coldReadSourceState(data.home);
  assertFirstNative(cold.native, data);
  if (clockEnv !== undefined) {
    const expectedPublishedAt = Number(clockEnv.INDEPENDENT_FIXED_CHILD_CLOCK);
    const publishedAt = cold.index.stateRows[0]?.published_at;
    console.log(JSON.stringify({ kind: 'source-index-fixed-clock-precondition',
      expectedPublishedAt, publishedAt, fixtureStartedAt: data.fixtureStartedAt }));
    assert.equal(publishedAt, expectedPublishedAt, 'publication uses the independently fixed child time');
    if (data.expectedPublishedAt === undefined) {
      assert.ok(Number.isSafeInteger(data.fixtureStartedAt) && data.fixtureStartedAt > expectedPublishedAt,
        'unmarked controlled publication requires a later parent fixture start');
    }
  }
  assertFirstIndex(cold.index, data);
  return cold;
}
test('actual source-index publication own handle is WAL/FULL before BEGIN and publishes the fixed first index', async () => {
  const healthyClock = require('../fixtures/health-connect/fixed-child-clock-inputs-v1.json').base;
  const clockPreload = path.resolve(__dirname, '../helpers/health-connect-fixed-child-clock-preload.cjs');
  const clockEnv = {
    NODE_OPTIONS: `--require=${JSON.stringify(clockPreload)}`,
    INDEPENDENT_FIXED_CHILD_CLOCK: String(healthyClock.milliseconds),
  };
  const data = await fixture(clockEnv, healthyClock.milliseconds);
  try {
    await initialPublished(data, 'observe', clockEnv);
    const observed = events(data);
    const writes = observed.filter(event => event.kind === 'successful-derived-write' && event.changes > 0);
    assert.ok(writes.length > 0);
    for (const write of writes) {
      ownFull(observed, write);
      assert.equal(write.transactionActive, true);
    }
    assert.equal(observed.some(event => event.kind === 'fault-fired'), false);
  } finally { await close(data); }
});
for (const operation of ['sqlite-full', 'sqlite-busy', 'late-frontier-refusal']) {
  test(`actual publisher ${operation} preserves raw ACK and complete prior publication then rebuilds`, async () => {
    const healthyClock = operation === 'sqlite-busy' || operation === 'late-frontier-refusal' ?
      require('../fixtures/health-connect/fixed-child-clock-inputs-v1.json') : undefined;
    let clockDirectory;
    let clockEnv;
    if (healthyClock !== undefined) {
      clockDirectory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'eh-selection-observer-'));
      fs.writeFileSync(path.join(clockDirectory, 'clock'), healthyClock.base.instant, { mode: 0o600 });
      const fixedPreload = path.resolve(__dirname, '../helpers/health-connect-fixed-child-clock-preload.cjs');
      const removablePreload = path.resolve(__dirname, '../helpers/health-connect-removable-owner-clock-preload.cjs');
      clockEnv = {
        NODE_OPTIONS: `--require=${JSON.stringify(fixedPreload)} --require=${JSON.stringify(removablePreload)}`,
        INDEPENDENT_FIXED_CHILD_CLOCK: String(healthyClock.base.milliseconds),
        OWNER_INITIAL_PUBLICATION_CLOCK_DIRECTORY: clockDirectory,
      };
    }
    const data = clockEnv === undefined ? await fixture() : await fixture(clockEnv, healthyClock.base.milliseconds);
    try {
      const prior = await initialPublished(data, operation, clockEnv);
      enable(data);
      const vector = operation === 'sqlite-full' ? largeSecond(data) : second(data);
      await saved(data, vector);
      const response = await waitForStatus(data, json => sourceOf(json, data)?.state === 'failed');
      const failed = sourceOf(response.json, data);
      assert.equal(failed.errorCode, 'storage-unavailable');
      assert.equal(failed.saved.frontiers[0].acknowledgedSequence, '2');
      assert.equal(failed.published.frontiers[0].acknowledgedSequence, '1');
      const observed = events(data);
      const faults = observed.filter(event => event.kind === 'fault-fired' && event.operation === operation);
      assert.ok(faults.length > 0, 'the selected actual publication fault fired');
      for (const fault of faults) ownFull(observed, fault);
      const errors = observed.filter(event => event.kind === 'publisher-native-error');
      assert.ok(errors.some(event => event.sqliteResult ===
        (operation === 'sqlite-full' ? 13 : operation === 'sqlite-busy' ? 5 : 1811)),
      'actual SQLite, not an invented fs/JS error, returns the fixed result code');
      if (operation === 'sqlite-full') assert.ok(faults.every(event => event.freePages === 0));
      if (operation === 'late-frontier-refusal') {
        assert.ok(faults.every(event => event.earlierChangedRows > 0));
        for (const fault of faults) assert.ok(observed.some(event =>
          event.kind === 'successful-derived-write' && event.changes > 0 &&
          event.handleId === fault.handleId && event.transactionId === fault.transactionId &&
          observed.indexOf(event) < observed.indexOf(fault)));
      }
      const beforeRetry = coldReadSourceState(data.home);
      if (operation === 'sqlite-full') assertLargeNative(beforeRetry.native, data, vector);
      else assertSecondNative(beforeRetry.native, data);
      assert.deepEqual(publicationOf(beforeRetry.index), publicationOf(prior.index));
      assert.equal(beforeRetry.index.stateRows[0].state, 'failed');
      assert.equal(JSON.stringify(beforeRetry.index).includes('39.000000000000000009'), false);
      noAuthority(JSON.stringify(beforeRetry.index), data);
      if (clockEnv !== undefined) {
        assert.equal(beforeRetry.index.stateRows[0].attempt_count, 1);
        assert.equal(beforeRetry.index.stateRows[0].next_attempt_at, healthyClock.base.milliseconds + 1000);
      }
      disable(data);
      if (clockEnv !== undefined) {
        fs.writeFileSync(path.join(clockDirectory, 'clock.next'), healthyClock.advanced.instant,
        { mode: 0o600, flag: 'wx' });
      fs.renameSync(path.join(clockDirectory, 'clock.next'), path.join(clockDirectory, 'clock'));
        data.expectedPublishedAt = healthyClock.advanced.milliseconds;
      }
      const queued = await ownerRebuild(data);
      assert.equal(queued.status, 202);
      await current(data, '2');
      const afterRetry = coldReadSourceState(data.home);
      assert.deepEqual(afterRetry.native, beforeRetry.native,
        'every native/receipt/frontier/outbox/object/schema/legacy byte field stays unchanged');
      if (operation === 'sqlite-full') assertLargeIndex(afterRetry.index, data, vector);
      else assertSecondIndex(afterRetry.index, data);
    } finally {
      await close(data);
      if (clockDirectory !== undefined) {
        const temporaryRoot = fs.realpathSync(os.tmpdir());
        assert.equal(path.dirname(clockDirectory), temporaryRoot);
        assert.ok(path.basename(clockDirectory).startsWith('eh-selection-observer-'));
        assert.equal(fs.lstatSync(clockDirectory).isSymbolicLink(), false);
        assert.equal(fs.realpathSync(clockDirectory), clockDirectory);
        fs.rmSync(clockDirectory, { recursive: true, force: true });
      }
    }
  });
}
function boundedExit(child) {
  const pending = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('actual publication child exit not observed')), 15000);
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
  void pending.catch(() => {});
  return pending;
}
function postAcrossDeath(data, vector) {
  return new Promise((resolve, reject) => {
    let request;
    const timer = setTimeout(() => {
      request.destroy(); reject(new Error('bounded native upload result not observed'));
    }, 15000);
    const finish = result => { clearTimeout(timer); resolve(result); };
    request = http.request(`${data.server.baseUrl}${BATCHES}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...data.headers },
    }, response => {
      let body = '';
      response.on('data', bytes => { body += bytes.toString('utf8'); });
      response.on('end', () => {
        try { finish({ status: response.statusCode, body, json: JSON.parse(body) }); }
        catch (error) { clearTimeout(timer); reject(error); }
      });
      response.on('aborted', () => finish({ lost: true, code: 'RESPONSE_ABORTED' }));
      response.on('error', error => finish({ lost: true, code: error.code }));
    });
    request.on('error', error => finish({ lost: true, code: error.code }));
    request.end(JSON.stringify(vector.wire));
  });
}
for (const operation of ['before-commit-kill', 'after-commit-kill']) {
  test(`${operation} proves cold index/vector/state atomicity separately from already committed raw ACK`, async () => {
    const data = await fixture();
    try {
      const prior = await initialPublished(data, operation);
      enable(data);
      const vector = second(data);
      const exited = boundedExit(data.server.proc);
      const outcome = await postAcrossDeath(data, vector);
      const exit = await exited;
      if (process.platform === 'win32') assert.deepEqual(exit, { code: 1, signal: null });
      else assert.deepEqual(exit, { code: null, signal: 'SIGKILL' });
      data.server = null;
      if (outcome.lost) assert.ok(['ECONNRESET', 'RESPONSE_ABORTED'].includes(outcome.code));
      else { assert.equal(outcome.status, 200); assert.deepEqual(outcome.json, vector.receipt); noAuthority(outcome.body, data); }
      const observed = events(data), fired = observed.filter(event => event.kind === 'fault-fired');
      assert.equal(fired.length, 1);
      const expectedPhase = operation === 'before-commit-kill' ?
        'immediately-before-publication-native-commit' : 'immediately-after-publication-native-commit';
      assert.equal(fired[0].phase, expectedPhase);
      ownFull(observed, fired[0]);
      const coldBeforeRestart = coldReadSourceState(data.home);
      assertSecondNative(coldBeforeRestart.native, data);
      if (operation === 'before-commit-kill') {
        assert.deepEqual(publicationOf(coldBeforeRestart.index), publicationOf(prior.index));
        assert.equal(coldBeforeRestart.index.stateRows[0].state, 'queued');
        assert.equal(coldBeforeRestart.index.stateRows[0].attempt_count, 1);
      } else assertSecondIndex(coldBeforeRestart.index, data);
      disable(data);
      await restart(data, {});
      await current(data, '2');
      const restored = coldReadSourceState(data.home);
      assert.deepEqual(restored.native, coldBeforeRestart.native);
      assertSecondIndex(restored.index, data,
        { attemptCount: operation === 'before-commit-kill' ? 2 : 1 });
      if (operation === 'after-commit-kill') assert.deepEqual(restored, coldBeforeRestart,
        'already current identical publication skips startup and does not reset counters/timestamps');
    } finally { await close(data); }
  });
}
