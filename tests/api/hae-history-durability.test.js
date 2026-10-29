// SPDX-License-Identifier: AGPL-3.0-only
// #803: independently fixed source/response contract, actual owned native faults.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const F = require('../helpers/hae-history-durability-fixture.cjs');
const C = F.C;
const weight = [{ date: '2026-01-10', kg: 80 }];
function report(t, id, data, response, before, after) {
  // Safe synthetic facts, not bearer/cookie/header or customer payload output.
  t.diagnostic(JSON.stringify({ case: id, responseStatus: response?.status ?? null,
    coldBeforeDigest: before ? C.digest(Buffer.from(JSON.stringify(before))) : null,
    coldAfterDigest: after ? C.digest(Buffer.from(JSON.stringify(after))) : null,
    witnesses: data.events() }));
}
function assertPushes(cold, count) {
  const rows = C.table(cold, 'hae_pushes');
  assert.equal(rows.length, count);
  assert.deepEqual(rows.map(row => Number(C.integer(row.push_seq))), Array.from({ length: count }, (_, i) => i + 1));
  for (const row of rows) {
    assert.equal(row.source_file, null);
    assert.match(row.received_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  }
  const allocator = C.table(cold, 'sqlite_sequence').find(row => row.name === 'hae_pushes');
  if (count) assert.equal(C.integer(allocator.seq), BigInt(count));
  else assert.equal(allocator, undefined);
}
function assertSuccessful(response, unsubscribed = ['synthetic_history_only_metric']) {
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, { ok: true, ingested: { weight: 1 }, availableUnsubscribed: unsubscribed });
}
function expectedSamples(push = 1, single = false) {
  return F.EXPECTED_SAMPLES.slice(0, single ? 1 : 2).map(row => ({ ...row, last_push: push }));
}
function assertUnrelatedSidecars(after, before) {
  for (const name of ['config.json', 'data/weight.json', 'data/legacy.json']) {
    assert.equal(after.sidecars[name], before.sidecars[name]);
  }
}
async function lost(data, wire) {
  await assert.rejects(data.post(wire), error => ['ECONNRESET', 'EPIPE'].includes(error.code));
  const exit = await data.server.closed;
  assert.ok(exit.code !== 0 || exit.signal, 'real child died, not an ignored received response');
}
function assertNativeFailure(events, role, codes) {
  const native = events.find(e => e.role === role && /^native-.*failure$/.test(e.kind) && codes.includes(e.primaryCode));
  assert.ok(native, `real native ${role} failure witness`);
  assert.equal(native.code, 'ERR_SQLITE_ERROR');
  assert.ok(Number.isInteger(native.nativeCode));
  return native;
}

test('H01 actual HAE native FULL after prior writes refuses success and normal retry preserves both samples', async t => {
  const data = await F.fixture(t, { fault: 'full' });
  data.arm('full');
  const before = data.cold();
  const response = await data.post();
  const after = data.cold();
  report(t, 'H01', data, response, before, after);
  const events = data.events();
  const native = assertNativeFailure(events, 'history', [13]);
  assert.equal(native.earlier.pushWrites, 1);
  assert.equal(native.earlier.sampleWrites, 1);
  assert.ok(events.some(e => e.kind === 'native-page-ceiling' && e.handle === native.handle
    && e.fixedPressureBytes === 1048576 && (e.freePages + 1) * e.pageSize < 1048576));
  F.assertStorageFailure(response); // meaningful existing-route 200 versus expected 503 baseline
  assert.deepEqual(after, before);
  F.assertWriter(events);
  assert.ok(!events.some(e => e.kind === 'history-commit' || e.kind === 'card-prior-delete'));
  await data.removeFault();
  const recovered = await data.post();
  assertSuccessful(recovered);
  F.assertCommitted(data.events());
  const cold = data.cold();
  assertPushes(cold, 1);
  assert.deepEqual(C.samples(cold), expectedSamples());
  assert.deepEqual(await data.card('weight'), weight);
  assert.deepEqual(await data.card('legacy'), F.SEED['legacy.json'].data);
  assert.equal((await F.req(data.server.baseUrl, '/api/manifests/synthetic_history_only_metric/data',
    { cookie: data.auth.cookie })).status, 404);
});

test('H02 actual independently held history lock returns retryable refusal then accepts recovery', async t => {
  const data = await F.fixture(t);
  data.arm('busy');
  const before = data.cold();
  const response = await data.post();
  const after = data.cold();
  report(t, 'H02', data, response, before, after);
  const events = data.events();
  const native = assertNativeFailure(events, 'history', [5, 6]);
  assert.ok(events.some(e => e.kind === 'independent-lock-acquired' && e.handle === native.handle
    && Number.isInteger(e.holderPid) && e.holderPid !== e.pid));
  F.assertStorageFailure(response);
  assert.deepEqual(after, before);
  F.assertWriter(events);
  assert.ok(!events.some(e => e.kind === 'history-commit' || e.kind === 'card-prior-delete'));
  data.release();
  data.arm('observe');
  const retry = await data.post();
  assertSuccessful(retry);
  F.assertCommitted(data.events());
  const cold = data.cold();
  assertPushes(cold, 1);
  assert.deepEqual(C.samples(cold), expectedSamples());
  assert.deepEqual(await data.card('weight'), weight);
});

test('H03 actual pre-COMMIT death rolls back a repeated push before cold read and restart', async t => {
  const data = await F.fixture(t);
  data.arm('observe');
  assertSuccessful(await data.post());
  F.assertCommitted(data.events());
  const before = data.cold();
  assertPushes(before, 1);
  assert.deepEqual(C.samples(before), expectedSamples());
  data.arm('before-commit');
  await lost(data, F.STORAGE_WIRE);
  const after = data.cold(); // actual cold evidence BEFORE restart/retry
  report(t, 'H03', data, null, before, after);
  const events = data.events();
  const death = events.find(e => e.kind === 'death-before-native-commit');
  assert.ok(death && death.nativeTransactionActive);
  assert.equal(death.earlier.pushWrites, 1);
  assert.equal(death.earlier.sampleWrites, 2);
  F.assertWriter(events);
  assert.ok(!events.some(e => e.kind === 'history-commit' || e.kind === 'response-head'));
  assert.deepEqual(after, before);
  await data.stop();
  data.arm('observe');
  await data.start();
  assertSuccessful(await data.post());
  F.assertCommitted(data.events());
  const recovered = data.cold();
  assertPushes(recovered, 2);
  assert.deepEqual(C.table(recovered, 'hae_pushes')[0], C.table(before, 'hae_pushes')[0]);
  assert.deepEqual(C.samples(recovered), expectedSamples(2));
  assert.deepEqual(await data.card('weight'), weight);
});

test('H04 actual post-COMMIT lost response survives and identical network retry is a new push', async t => {
  const data = await F.fixture(t);
  const before = data.cold();
  data.arm('after-commit');
  await lost(data, F.SINGLE_WIRE);
  const committed = data.cold(); // independent committed state BEFORE restart/retry
  report(t, 'H04', data, null, before, committed);
  const events = data.events();
  const commit = events.find(e => e.kind === 'history-commit');
  const death = events.find(e => e.kind === 'death-after-native-commit');
  assert.ok(commit && death && commit.sequence < death.sequence && commit.handle === death.handle);
  assert.equal(commit.nativeTransactionActive, false);
  assert.equal(death.nativeTransactionActive, false);
  assert.equal(commit.earlier.pushWrites, 1);
  assert.equal(commit.earlier.sampleWrites, 1);
  F.assertWriter(events);
  assert.ok(!events.some(e => e.kind === 'response-head'));
  assertPushes(committed, 1);
  assert.deepEqual(C.samples(committed), expectedSamples(1, true));
  assert.deepEqual(C.withoutHae(committed), C.withoutHae(before));
  assert.deepEqual(committed.sidecars, before.sidecars);
  await data.stop();
  data.arm('observe');
  await data.start();
  assertSuccessful(await data.post(F.SINGLE_WIRE), []);
  F.assertCommitted(data.events());
  const retry = data.cold();
  assertPushes(retry, 2);
  assert.deepEqual(C.table(retry, 'hae_pushes')[0], C.table(committed, 'hae_pushes')[0]);
  assert.deepEqual(C.samples(retry), expectedSamples(2, true));
  assert.deepEqual(await data.card('weight'), weight);
});

test('H05 actual card writer refuses after history COMMIT and saved source supports replay', async t => {
  const data = await F.fixture(t, { fault: 'projection' });
  data.arm('observe');
  const before = data.cold();
  const response = await data.post();
  const after = data.cold();
  report(t, 'H05', data, response, before, after);
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, { ok: true, ingested: { weight: 0 },
    availableUnsubscribed: ['synthetic_history_only_metric'] });
  const events = data.events();
  const commit = F.assertCommitted(events);
  const failed = assertNativeFailure(events, 'card', [19]);
  assert.equal(failed.earlier.cardDeletes, 1);
  const prior = events.find(e => e.kind === 'card-prior-delete' && e.handle === failed.handle);
  const rollback = events.find(e => e.kind === 'card-rollback' && e.handle === failed.handle);
  assert.ok(prior && rollback && commit.sequence < prior.sequence && prior.sequence < failed.sequence
    && failed.sequence < rollback.sequence);
  assert.equal(prior.changedRows, 1);
  assert.deepEqual(C.withoutHae(after), C.withoutHae(before));
  assertPushes(after, 1);
  assert.deepEqual(C.samples(after), expectedSamples());
  assertUnrelatedSidecars(after, before);
  const diagnostic = JSON.parse(fs.readFileSync(path.join(data.home, 'data/auto-export/last-push.json')));
  assert.equal(diagnostic.subscribers[0].id, 'weight');
  assert.equal(diagnostic.subscribers[0].rowsWritten, 0);
  assert.ok(diagnostic.warnings.some(w => w.startsWith('[hae] write failed for weight:')));
  assert.deepEqual(await data.card('weight'), F.SEED['weight.json'].data);
  assert.deepEqual(await data.card('legacy'), F.SEED['legacy.json'].data);
  await data.removeFault();
  const saved = data.cold();
  await data.replay();
  const replayed = data.cold();
  assert.deepEqual(C.samples(replayed), C.samples(saved));
  assert.deepEqual(C.table(replayed, 'hae_pushes'), C.table(saved, 'hae_pushes'));
  assertPushes(replayed, 1);
  data.arm('observe');
  await data.start();
  assert.deepEqual(await data.card('weight'), weight);
  assert.deepEqual(await data.card('legacy'), F.SEED['legacy.json'].data);
});

test('P01 original mixed wrappers both persist while live first-wrapper output remains 80 kg', async t => {
  const data = await F.fixture(t);
  data.arm('observe');
  assertSuccessful(await data.post(F.MIXED_WIRE), []);
  F.assertCommitted(data.events());
  const cold = data.cold();
  assertPushes(cold, 1);
  const samples = C.samples(cold);
  assert.equal(samples.length, 2);
  assert.deepEqual(samples[0], expectedSamples(1, true)[0]);
  assert.deepEqual(samples[1], { metric: 'body_mass', metric_meta: '{"units":"kg"}',
    doc: '{"date":"2026-01-10","qty":90}', sample_date: '2026-01-10',
    hashHex: '0ea5ece56f878b392f5316a1372ad2ad', dup_count: 1, push_ord: 1, first_push: 1, last_push: 1 });
  assert.deepEqual(await data.card('weight'), weight);
  assert.deepEqual(await data.card('legacy'), F.SEED['legacy.json'].data);
});

test('P02 disabled unauthorized oversize and both quarantine warning shapes retain existing contracts', async t => {
  const data = await F.fixture(t, { issueToken: false });
  const initial = data.cold();
  const disabled = await data.post();
  assert.equal(disabled.status, 501);
  assert.deepEqual(disabled.json, { error: 'ingest disabled' });
  assert.deepEqual(data.cold(), initial);
  await data.makeToken();
  const authorizedState = data.cold();
  const wrong = await data.post(F.STORAGE_WIRE, 'fixed-invalid-synthetic-token');
  assert.equal(wrong.status, 401);
  assert.deepEqual(wrong.json, { error: 'unauthorised' });
  assert.deepEqual(data.cold(), authorizedState);
  const oversize = await F.postOversize(data);
  assert.equal(oversize.status, 413);
  assert.deepEqual(oversize.json, { error: 'payload too large' });
  assert.deepEqual(C.withoutHae(data.cold()), C.withoutHae(authorizedState));
  assertUnrelatedSidecars(data.cold(), authorizedState);
  assertPushes(data.cold(), 0);
  assert.deepEqual(C.samples(data.cold()), []);
  const parsed = await data.post('not json');
  assert.equal(parsed.status, 200);
  assert.deepEqual(parsed.json, { ok: true, warning: 'parse failed, payload quarantined for inspection' });
  const unparsed = path.join(data.home, 'data/auto-export/unparsed');
  const names = fs.readdirSync(unparsed).filter(name => name.endsWith('.json'));
  assert.equal(names.length, 1);
  assert.equal(fs.readFileSync(path.join(unparsed, names[0]), 'utf8'), 'not json');
  assert.deepEqual(C.withoutHae(data.cold()), C.withoutHae(authorizedState));
  assertUnrelatedSidecars(data.cold(), authorizedState);
  assertPushes(data.cold(), 0);
  assert.deepEqual(C.samples(data.cold()), []);
  const blocked = await F.fixture(t);
  fs.writeFileSync(path.join(blocked.home, 'data/auto-export/unparsed'), 'owned synthetic blocking path',
    { flag: 'wx', mode: 0o600 });
  const blockedBefore = blocked.cold();
  const refusal = await blocked.post('not json');
  assert.equal(refusal.status, 200);
  assert.deepEqual(refusal.json, { ok: true, warning: 'parse failed' });
  assert.deepEqual(C.withoutHae(blocked.cold()), C.withoutHae(blockedBefore));
  assertUnrelatedSidecars(blocked.cold(), blockedBefore);
  assertPushes(blocked.cold(), 0);
  assert.deepEqual(C.samples(blocked.cold()), []);
  assert.ok(!data.events().some(e => e.kind === 'history-begin'));
  assert.ok(!blocked.events().some(e => e.kind === 'history-begin'));
});
