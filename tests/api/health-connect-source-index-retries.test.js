// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const product = process.env.INDEPENDENT_PRODUCT_ROOT || path.resolve(__dirname, '../..');
const { fixture, restart, close, first, second, postBatch, ownerStatus,
  ownerRebuild, waitForStatus, noAuthority, coldReadSourceState,
  assertFirstNative, assertSecondNative, assertFirstIndex, assertSecondIndex,
  expectedIndex, expectedFrontier, vectorDigest, TYPE, TARGET, BASE, req, sha } =
  require(path.join(product, 'tests/helpers/health-connect-source-index-test-fixture.cjs'));
const { waitFor } = require(path.join(product, 'tests/helpers/sandbox'));
const faultPreload = path.join(__dirname, '../helpers/health-connect-source-index-fault-preload.cjs');

// Transparent child-only observations. No clock, timer, SQLite return value
// or production hook is changed. The existing actual native-fault preload
// supplies the publication-handle/transaction witness.
function timestampObservations(observations) {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const assert = require('node:assert/strict');
  const home = path.resolve(process.env.HEALTH_HOME);
  assert.ok(home.startsWith(path.resolve(os.tmpdir()) + path.sep));
  assert.ok(path.basename(home).startsWith('eh-test-'));
  assert.equal(path.dirname(observations), home);
  const append = fs.appendFileSync.bind(fs);
  fs.appendFileSync = (file, text, options) => {
    if (typeof file === 'string' && path.resolve(file) === observations) {
      const event = JSON.parse(text);
      return append(file, JSON.stringify({ ...event, observedAt: Date.now() }) + '\n', options);
    }
    return append(file, text, options);
  };
  const warn = console.warn.bind(console);
  console.warn = (...args) => {
    if (args.length === 1 && args[0] === '[health-connect] source index unavailable') {
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(path.join(home, 'db/klebb.db'), { readOnly: true });
      let retryRows;
      try {
        db.exec('PRAGMA busy_timeout=5000');
        retryRows = db.prepare('SELECT state,attempt_count,next_attempt_at,error_code '
          + 'FROM health_source_index_state LIMIT 2').all().map(row => ({ ...row }));
        assert.equal(retryRows.length, 1, 'one independently controlled source fixture');
      } finally { db.close(); }
      append(observations, JSON.stringify({ kind: 'source-index-refusal-observed',
        retryState: retryRows[0], observedAt: Date.now() }) + '\n',
      { encoding: 'utf8', mode: 0o600 });
    }
    return warn(...args);
  };
}
function observerEnvironment(data, operation) {
  assert.ok(data.home.startsWith(path.resolve(os.tmpdir()) + path.sep));
  data.observations = path.join(data.home, 'source-index-retry-observations.jsonl');
  data.enabled = path.join(data.home, 'source-index-retry-fault-enabled');
  const timingPreload = path.join(data.home, 'source-index-retry-timestamps.cjs');
  fs.writeFileSync(timingPreload, '// SPDX-License-Identifier: AGPL-3.0-only\n'
    + `(${timestampObservations.toString()})(${JSON.stringify(data.observations)});\n`,
  { encoding: 'utf8', mode: 0o600 });
  return { NODE_OPTIONS: `--require "${faultPreload.replaceAll('\\', '/')}" `
    + `--require "${timingPreload.replaceAll('\\', '/')}"`,
  INDEPENDENT_PRODUCT_ROOT: product, INDEPENDENT_INDEX_FAULT: operation,
  INDEPENDENT_INDEX_OBSERVATIONS: data.observations,
  INDEPENDENT_INDEX_FAULT_ENABLED: data.enabled };
}
function events(data) {
  if (!fs.existsSync(data.observations)) return [];
  const lines = fs.readFileSync(data.observations, 'utf8').split('\n');
  lines.pop(); // Only an incomplete concurrent final line may be ignored.
  return lines.filter(Boolean).map(JSON.parse);
}
function sourceOf(response, data) {
  return response.json.sources.find(source => source.sourceStoreId === data.binding.sourceStoreId);
}
async function save(data, vector, headers = data.headers) {
  const response = await postBatch(data, vector, headers);
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, vector.receipt);
  noAuthority(response.body, data);
}
async function current(data, sequence) {
  return waitForStatus(data, json => json.sources.some(source =>
    source.sourceStoreId === data.binding.sourceStoreId && source.state === 'current' &&
    source.saved.frontiers[0]?.acknowledgedSequence === sequence));
}
async function stop(data) {
  assert.ok(data.server);
  await data.server.kill();
  data.server = null;
}
function controlledDatabase(data, mutate) {
  // Deliberate synthetic persisted corruption, not an observed native fault.
  assert.equal(data.server, null, 'only mutate an isolated stopped child fixture');
  const db = new DatabaseSync(path.join(data.home, 'db/klebb.db'));
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');
    db.exec('BEGIN IMMEDIATE');
    mutate(db);
    db.exec('COMMIT');
  } finally { db.close(); }
}
function unavailable(response, data) {
  assert.equal(response.status, 503);
  assert.deepEqual(response.json,
    { target: TARGET, code: 'storage-unavailable', retryable: true });
  noAuthority(response.body, data);
}

test('corrupt reference admission leaves the prior persisted attempt/publication unchanged and does not retry unadmitted work',
  { timeout: 25000 }, async () => {
    const data = await fixture();
    try {
      const environment = observerEnvironment(data, 'observe');
      await restart(data, environment);
      await save(data, first(data));
      await current(data, '1');
      const valid = coldReadSourceState(data.home);
      assertFirstNative(valid.native, data);
      assertFirstIndex(valid.index, data);
      await stop(data);
      controlledDatabase(data, db => {
        const changed = db.prepare('DELETE FROM health_projection_outbox WHERE stream_key=? AND sequence=?')
          .run(expectedFrontier(data, '1').stream_key, '1');
        assert.equal(changed.changes, 1);
      });
      const corrupted = coldReadSourceState(data.home);
      assert.deepEqual(corrupted.index, valid.index);
      const observedBefore = events(data).length;
      await restart(data, environment);
      // The child's exact fixed warning witnesses an actual blocked admission,
      // including startup output before the generic HTTP-ready helper returns.
      await waitFor(() => events(data).slice(observedBefore)
        .some(event => event.kind === 'source-index-refusal-observed'),
      { timeoutMs: 10000, what: 'actual corrupt-reference admission refusal' });
      assert.deepEqual(coldReadSourceState(data.home), corrupted,
        'a refusal before attempt preparation cannot rewrite state or schedule a failed cycle');
      assert.equal(events(data).slice(observedBefore)
        .some(event => event.kind === 'publisher-before-begin'), false);
      unavailable(await ownerStatus(data), data);
      assert.deepEqual(coldReadSourceState(data.home), corrupted);
      unavailable(await ownerRebuild(data), data);
      assert.deepEqual(coldReadSourceState(data.home), corrupted);
    } finally { await close(data); }
  });

test('three actual late publication failures obey 1s/5s durable retry times, survive restart exhausted, and owner rebuild resets the cycle',
  { timeout: 35000 }, async () => {
    const data = await fixture();
    try {
      const environment = observerEnvironment(data, 'late-frontier-refusal');
      await restart(data, environment);
      await save(data, first(data));
      await current(data, '1');
      fs.writeFileSync(data.enabled, 'enabled\n', { mode: 0o600 });
      const initialEvents = events(data).length;
      await save(data, second(data));
      // Capture every durable intermediate state at the actual failure boundary
      // rather than assuming that a busy parent can poll inside the 1s window.
      await waitFor(() => events(data).slice(initialEvents).some(event =>
        event.kind === 'source-index-refusal-observed' && event.retryState.attempt_count === 3),
      { timeoutMs: 15000, what: 'three actual persisted late-native-failure observations' });
      const observed = events(data).slice(initialEvents);
      const errors = observed.filter(event => event.kind === 'publisher-native-error' &&
        event.sqliteResult === 1811);
      assert.equal(errors.length, 3, 'three failures came from actual native SQLite refusals');
      const failures = observed.filter(event => event.kind === 'source-index-refusal-observed');
      assert.equal(failures.length, 3);
      let previousDue = null;
      for (const count of [1, 2, 3]) {
        const failure = failures[count - 1];
        assert.equal(failure.retryState.state, 'failed');
        assert.equal(failure.retryState.attempt_count, count);
        assert.equal(failure.retryState.error_code, 'storage-unavailable');
        const error = errors[count - 1];
        const begin = observed.find(event => event.kind === 'publisher-before-begin' &&
          event.handleId === error.handleId && event.transactionId === error.transactionId);
        assert.ok(begin);
        assert.equal(begin.journalMode, 'wal');
        assert.equal(begin.synchronous, 2);
        if (previousDue !== null) assert.ok(begin.observedAt >= previousDue,
          'actual publication cannot start before the preceding durable retry deadline');
        if (count < 3) {
          const delay = count === 1 ? 1000 : 5000;
          const due = failure.retryState.next_attempt_at;
          assert.ok(Number.isSafeInteger(due));
          assert.ok(due >= error.observedAt + delay);
          assert.ok(due <= failure.observedAt + delay);
          previousDue = due;
        } else assert.equal(failure.retryState.next_attempt_at, null);
      }
      const status = await ownerStatus(data);
      assert.equal(status.status, 200);
      const source = sourceOf(status, data);
      assert.equal(source.state, 'failed');
      assert.equal(source.errorCode, 'storage-unavailable');
      assert.deepEqual(source.attempts, { count: 3, limit: 3, nextAt: null });
      noAuthority(status.body, data);
      const exhausted = coldReadSourceState(data.home);
      assertSecondNative(exhausted.native, data);
      assert.equal(exhausted.index.stateRows[0].attempt_count, 3);
      assert.equal(exhausted.index.stateRows[0].next_attempt_at, null);
      const faults = events(data).slice(initialEvents).filter(event => event.kind === 'fault-fired');
      assert.equal(faults.length, 3);
      assert.ok(faults.every(event => event.earlierChangedRows > 0));
      await restart(data, environment);
      const restored = await waitForStatus(data, json => json.sources.some(source =>
        source.sourceStoreId === data.binding.sourceStoreId &&
        source.state === 'failed' && source.attempts.count === 3 &&
        source.attempts.nextAt === null));
      assert.equal(sourceOf(restored, data).errorCode, 'storage-unavailable');
      assert.deepEqual(coldReadSourceState(data.home), exhausted,
        'startup cannot reset an exhausted saved attempt budget or publish over the old pointer');
      assert.equal(events(data).slice(initialEvents).filter(event =>
        event.kind === 'fault-fired').length, 3);
      assert.equal(path.dirname(data.enabled), data.home);
      fs.unlinkSync(data.enabled);
      const rebuilt = await ownerRebuild(data);
      assert.equal(rebuilt.status, 202);
      assert.deepEqual(rebuilt.json, { target: TARGET, queuedSources: 1 });
      noAuthority(rebuilt.body, data);
      await current(data, '2');
      const after = coldReadSourceState(data.home);
      assert.deepEqual(after.native, exhausted.native);
      assertSecondIndex(after.index, data, { attemptCount: 1 });
    } finally { await close(data); }
  });

test('actual generation1 sequence2 and generation2 sequence1 uploads publish two complete bound vector components, never a shared counter',
  { timeout: 25000 }, async () => {
    const healthyClock = require('../fixtures/health-connect/fixed-child-clock-inputs-v1.json').base;
    const clockEnv = {
      NODE_OPTIONS: `--require=${JSON.stringify(path.resolve(__dirname,
        '../helpers/health-connect-fixed-child-clock-preload.cjs'))}`,
      INDEPENDENT_FIXED_CHILD_CLOCK: String(healthyClock.milliseconds),
    };
    const data = await fixture(clockEnv, healthyClock.milliseconds);
    try {
      await save(data, first(data));
      await current(data, '1');
      await save(data, second(data));
      await current(data, '2');
      const before = coldReadSourceState(data.home);
      assertSecondNative(before.native, data);
      const publishedAt = before.index.stateRows[0]?.published_at;
      console.log(JSON.stringify({ kind: 'source-index-fixed-clock-precondition',
        expectedPublishedAt: healthyClock.milliseconds, publishedAt,
        fixtureStartedAt: data.fixtureStartedAt }));
      assert.equal(Number.isSafeInteger(publishedAt), true);
      assert.equal(publishedAt, healthyClock.milliseconds,
        'publication uses the independently fixed child time');
      assert.ok(Number.isSafeInteger(data.fixtureStartedAt) &&
        data.fixtureStartedAt > healthyClock.milliseconds,
      'controlled publication requires a later parent fixture start');
      assertSecondIndex(before.index, data);
      await stop(data);
      // Explicit synthetic generation control: the server-issued source and
      // credential remain unchanged. Both streams below are actual routed
      // uploads and actual returned durable receipts, not seeded history ACKs.
      const authorityFile = path.join(data.home, 'credentials/health-connect.json');
      const state = JSON.parse(fs.readFileSync(authorityFile, 'utf8'));
      const connector = state.connectors.find(item => item.id === data.paired.connectorId);
      assert.ok(connector);
      assert.equal(connector.generations[TYPE], '1');
      connector.generations[TYPE] = '2';
      fs.writeFileSync(authorityFile, JSON.stringify(state), { mode: 0o600 });
      await restart(data);
      const binding2 = { ...data.binding, generation: '2' };
      const deletion = structuredClone(first(data).payload.changes[2]);
      const payload = { binding: binding2, recordType: TYPE, sequence: '1',
        batchId: 'synthetic-generation-2-batch-1', changes: [deletion] };
      const payloadJson = JSON.stringify(payload), payloadDigest = sha(payloadJson);
      const receipt = { version: 1, kind: 'durable-receipt', binding: binding2,
        recordType: TYPE, sequence: '1', batchId: payload.batchId, payloadDigest };
      await save(data, { wire: { version: 1, kind: 'batch', payloadJson, payloadDigest }, receipt },
        { ...data.headers, 'Klebb-Health-Generation': '2' });
      const expected = [
        { binding: data.binding, recordType: TYPE, acknowledgedSequence: '2' },
        { binding: binding2, recordType: TYPE, acknowledgedSequence: '1' },
      ];
      const response = await waitForStatus(data, json => json.sources.some(source =>
        source.sourceStoreId === data.binding.sourceStoreId && source.state === 'current' &&
        source.saved.streams === 2));
      const source = sourceOf(response, data);
      assert.deepEqual(source.saved,
        { records: 1, tombstones: 2, streams: 2, complete: true, frontiers: expected });
      assert.deepEqual(source.published.frontiers, expected);
      const after = coldReadSourceState(data.home);
      assert.deepEqual(after.native.records, before.native.records);
      assert.deepEqual(after.native.typedTombstones, before.native.typedTombstones);
      assert.deepEqual(after.native.receipts, [first(data).receipt, second(data).receipt, receipt]);
      assert.deepEqual(after.native.frontiers, expected.map(item => ({
        recordType: TYPE, acknowledgedSequence: item.acknowledgedSequence })));
      assert.deepEqual(after.native.jobs, [
        { batchId: 'synthetic-batch-1', state: 'queued' },
        { batchId: 'synthetic-batch-2', state: 'queued' },
        { batchId: payload.batchId, state: 'queued' },
      ]);
      assert.deepEqual(after.native.legacyCards, before.native.legacyCards);
      assert.deepEqual(after.native.legacyRows, before.native.legacyRows);
      assert.deepEqual(after.index.indexRows, expectedIndex(data, '2'));
      const expectedRows = [expectedFrontier(data, '2'),
        expectedFrontier({ ...data, binding: binding2 }, '1')];
      assert.deepEqual(after.index.frontierRows, expectedRows);
      assert.equal(after.index.stateRows[0].requested_vector_digest, vectorDigest(expectedRows));
      assert.equal(after.index.stateRows[0].state, 'current');
      assert.equal(after.index.stateRows[0].attempt_count, 1);
      noAuthority(JSON.stringify(after.index), data);
      noAuthority(after.native.logicalNativeDump, data);
      noAuthority(response.body, data);
    } finally { await close(data); }
  });
