// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  fixture, close, restart, first, second, postBatch, ownerStatus, ownerRebuild,
  waitForStatus, TARGET, TYPE, noAuthority, coldReadSourceState,
  assertFirstNative, assertSecondNative, assertFirstIndex, assertSecondIndex,
} = require('../helpers/health-connect-source-index-test-fixture.cjs');

async function save(data, vector) {
  const response = await postBatch(data, vector);
  assert.equal(response.status, 200, 'real native history commits before target checks');
  assert.deepEqual(response.json, vector.receipt);
  noAuthority(response.body, data);
}
const current = data => waitForStatus(data, result =>
  result.target === TARGET && result.sources.length === 1 &&
  result.sources[0].state === 'current');
function statusShape(response, data, sequence, records, tombstones) {
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(response.json).sort(), ['sources', 'target']);
  assert.equal(response.json.target, TARGET);
  assert.equal(response.json.sources.length, 1);
  const source = response.json.sources[0];
  assert.deepEqual(Object.keys(source).sort(), ['attempts', 'currentRestoreEpoch', 'errorCode',
    'published', 'saved', 'sourceStoreId', 'state']);
  assert.equal(source.sourceStoreId, data.binding.sourceStoreId);
  assert.equal(source.state, 'current');
  assert.equal(source.currentRestoreEpoch, data.binding.restoreEpoch);
  assert.deepEqual(source.saved, {
    records, tombstones, streams: 1, complete: true,
    frontiers: [{ binding: data.binding, recordType: TYPE,
      acknowledgedSequence: sequence }],
  });
  assert.equal(source.published.records, records);
  assert.deepEqual(Object.keys(source.published).sort(), ['frontiers', 'publishedAt',
    'records', 'restoreEpoch', 'tombstones']);
  assert.equal(source.published.tombstones, tombstones);
  assert.deepEqual(source.published.frontiers, source.saved.frontiers);
  assert.equal(source.published.restoreEpoch, data.binding.restoreEpoch);
  assert.equal(new Date(source.published.publishedAt).toISOString(),
    source.published.publishedAt);
  assert.equal(source.published.publishedAt, new Date(coldReadSourceState(data.home)
    .index.stateRows[0].published_at).toISOString(), 'status uses the durable publication timestamp');
  assert.deepEqual(source.attempts, { count: 1, limit: 3, nextAt: null });
  assert.equal(source.errorCode, null);
  for (const value of ['37.250000000000000001', '38.000000000000000009',
    '39.000000000000000009']) {
    assert.equal(response.body.includes(value), false, 'status never copies source quantities');
  }
  noAuthority(response.body, data);
}

test('committed raw-only history automatically publishes its exact typed source index and separate status',
  { timeout: 20000 }, async () => {
    const data = await fixture();
    try {
      await save(data, first(data));
      assertFirstNative(coldReadSourceState(data.home).native, data);
      const initial = await ownerStatus(data);
      assert.equal(initial.status, 200, 'existing browser session can read the named target');
      const response = await current(data);
      statusShape(response, data, '1', 2, 1);
      const cold = coldReadSourceState(data.home);
      assertFirstNative(cold.native, data);
      assertFirstIndex(cold.index, data);
      assert.equal(JSON.stringify(cold.index).includes('37.250000000000000001'), false);
    } finally { await close(data); }
  });

test('real owner rebuild and restart retain immutable raw receipts while reconstructing the complete target',
  { timeout: 25000 }, async () => {
    const data = await fixture();
    try {
      await save(data, first(data));
      assertFirstNative(coldReadSourceState(data.home).native, data);
      const accepted = await ownerRebuild(data);
      assert.equal(accepted.status, 202, 'real browser rebuild route queues a distinct operation');
      assert.deepEqual(accepted.json, { target: TARGET, queuedSources: 1 });
      noAuthority(accepted.body, data);
      statusShape(await current(data), data, '1', 2, 1);
      const before = coldReadSourceState(data.home);
      assertFirstNative(before.native, data);
      assertFirstIndex(before.index, data);
      await restart(data);
      statusShape(await current(data), data, '1', 2, 1);
      assert.deepEqual(coldReadSourceState(data.home), before,
        'already-current startup cannot republish, change counters or duplicate raw effects');
    } finally { await close(data); }
  });

test('correction and deletion rebuild current identities; an older received batch cannot resurrect its source snapshot',
  { timeout: 25000 }, async () => {
    const data = await fixture();
    try {
      await save(data, first(data));
      assertFirstNative(coldReadSourceState(data.home).native, data);
      const initial = await ownerStatus(data);
      assert.equal(initial.status, 200, 'current-source status is an actual registered browser route');
      await current(data);
      await save(data, second(data));
      statusShape(await current(data), data, '2', 1, 2);
      const corrected = coldReadSourceState(data.home);
      assertSecondNative(corrected.native, data);
      assertSecondIndex(corrected.index, data);
      await save(data, first(data));
      statusShape(await current(data), data, '2', 1, 2);
      assert.deepEqual(coldReadSourceState(data.home), corrected,
        'original receipt retry cannot republish an older index or revive raw-a');
    } finally { await close(data); }
  });
