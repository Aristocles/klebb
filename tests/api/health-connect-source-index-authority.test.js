// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Fixed synthetic authority/reference oracles; production helpers are not used.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { fakeAuthState } = require('../helpers/sandbox');
const {
  fixture, close, restart, first, second, postBatch, ownerStatus, ownerRebuild,
  waitForStatus, req, BASE, STATUS, REBUILD, ORIGIN, TYPE, TARGET, sha,
  noAuthority, coldReadSourceState, assertFirstNative, assertSecondNative,
  assertFirstIndex, assertSecondIndex, expectedFrontier,
} = require('../helpers/health-connect-source-index-test-fixture.cjs');

const ADMIN = 'synthetic-source-index-authority-admin';
const CHAT = 'synthetic-source-index-authority-chat';
const OTHER_OWNER = 'synthetic-source-index-other-owner';
const WRONG_DIGEST = 'sha256:' + '0'.repeat(64);
const UNQUALIFIED_DIGEST = 'unqualified-synthetic-reference-digest';
const WRONG_BATCH = 'synthetic-mismatched-reference-batch';
const QUANTITIES = ['37.250000000000000001', '38.000000000000000009',
  '39.000000000000000009'];

function noAuthorityOrVerifier(text, data) {
  noAuthority(text, data);
  for (const marker of data.markers) {
    assert.equal(text.includes(sha(marker)), false, 'issued-authority verifier is not disclosed');
  }
}
function diagnostics(text, data) {
  noAuthorityOrVerifier(text, data);
  for (const quantity of QUANTITIES) {
    assert.equal(text.includes(quantity), false, 'diagnostics do not copy source quantities');
  }
}
function cold(data) {
  const result = coldReadSourceState(data.home);
  noAuthorityOrVerifier(result.native.logicalNativeDump, data);
  diagnostics(JSON.stringify(result.index), data);
  return result;
}
async function finish(data) {
  if (data.server) { await data.server.kill(); data.server = null; }
  try {
    // Request-phase output only; the shared launcher does not return earlier startup output.
    diagnostics(data.requestLogs, data);
  } finally { await close(data); }
}
async function saved(data, vector) {
  const response = await postBatch(data, vector);
  noAuthorityOrVerifier(response.body, data);
  assert.equal(response.status, 200, 'real scoped native batch committed');
  assert.deepEqual(response.json, vector.receipt);
}
async function current(data, sequence) {
  const result = await waitForStatus(data, json => {
    const source = json.sources?.[0];
    return json.target === TARGET && json.sources?.length === 1 &&
      source?.sourceStoreId === data.binding.sourceStoreId && source.state === 'current' &&
      source.saved.complete && source.saved.frontiers.length === 1 &&
      source.saved.frontiers[0].acknowledgedSequence === sequence &&
      source.published?.frontiers[0]?.acknowledgedSequence === sequence;
  });
  diagnostics(result.body, data);
  return result;
}
async function published(data, sequence = '1') {
  await saved(data, first(data));
  await current(data, '1');
  assertFirstNative(cold(data).native, data);
  assertFirstIndex(cold(data).index, data);
  if (sequence === '2') {
    await saved(data, second(data));
    await current(data, '2');
    const result = cold(data);
    assertSecondNative(result.native, data);
    assertSecondIndex(result.index, data);
    return result;
  }
  return cold(data);
}
async function refusal(data, request, status, before, code) {
  const response = await request();
  diagnostics(response.body, data);
  assert.equal(response.status, status);
  if (code) assert.equal(response.json?.code, code);
  assert.deepEqual(cold(data), before, 'each refused request has zero durable effects');
  return response;
}
function writer(data, operation) {
  const file = path.resolve(data.home, 'db', 'klebb.db');
  assert.equal(path.dirname(file), path.resolve(data.home, 'db'));
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA busy_timeout=5000');
    db.exec('BEGIN IMMEDIATE');
    operation(db);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  } finally { db.close(); }
}
async function stopped(data, operation) {
  await data.server.kill();
  data.server = null;
  await operation();
}
function sandboxFile(data, directory, name) {
  const file = path.resolve(data.home, directory, name);
  assert.equal(path.dirname(file), path.resolve(data.home, directory));
  return file;
}

test('source-index browser controls reject native and broad authority, wrong origin and caller-selected scope without effects',
  { timeout: 25000 }, async () => {
    const data = await fixture({ AGENT_API_TOKEN: CHAT, KLEBB_ADMIN_TOKEN: ADMIN });
    data.markers.push(CHAT, ADMIN);
    try {
      const before = await published(data);
      for (const headers of [{}, data.headers,
        { Authorization: `Bearer ${CHAT}` }, { Authorization: `Bearer ${ADMIN}` }]) {
        for (const [route, method, body] of [[STATUS, 'GET', null], [REBUILD, 'POST', {}]]) {
          await refusal(data, () => req(data.server.baseUrl, route, {
            method, body, headers: { Origin: ORIGIN, ...headers },
          }), 401, before);
        }
      }
      const sibling = { headers: { Origin: 'https://sibling.example.test' } };
      await refusal(data, () => ownerStatus(data, sibling), 403, before);
      await refusal(data, () => ownerRebuild(data, {}, sibling), 403, before);
      for (const body of [
        { ownerId: OTHER_OWNER },
        { userId: OTHER_OWNER },
        { sourceStoreId: data.binding.sourceStoreId },
        { tenantId: data.binding.tenantId },
        { sources: [data.binding.sourceStoreId] },
      ]) {
        await refusal(data, () => ownerRebuild(data, body), 400, before, 'invalid-message');
      }
      // Even configuring a live reserved native bearer as a broad key cannot widen it.
      await restart(data, { ...data.extraEnv, AGENT_API_TOKEN: data.paired.credential,
        KLEBB_ADMIN_TOKEN: data.paired.credential });
      assert.deepEqual(cold(data), before);
      await refusal(data, () => req(data.server.baseUrl, STATUS,
        { headers: { ...data.headers, Origin: ORIGIN } }), 401, before);
      await refusal(data, () => req(data.server.baseUrl, REBUILD,
        { method: 'POST', headers: { ...data.headers, Origin: ORIGIN }, body: {} }), 401, before);
    } finally { await finish(data); }
  });

test('a different real browser session sees no other owner source and queues no rebuild',
  { timeout: 25000 }, async () => {
    const data = await fixture();
    try {
      const before = await published(data);
      const other = fakeAuthState(OTHER_OWNER);
      data.markers.push(other.token);
      await stopped(data, () => {
        const credentialsFile = sandboxFile(data, 'credentials', 'webauthn.json');
        const sessionsFile = sandboxFile(data, 'sessions', 'webauthn.json');
        const credentials = JSON.parse(fs.readFileSync(credentialsFile, 'utf8'));
        const sessions = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'));
        credentials.users = { ...credentials.users, ...other.credentials.users };
        fs.writeFileSync(credentialsFile, JSON.stringify(credentials));
        fs.writeFileSync(sessionsFile, JSON.stringify({ ...sessions, ...other.sessions }));
      });
      await restart(data);
      assert.deepEqual(cold(data), before);
      const status = await ownerStatus(data, { cookie: other.cookie });
      diagnostics(status.body, data);
      assert.equal(status.status, 200);
      assert.deepEqual(status.json, { target: TARGET, sources: [] });
      assert.equal(status.body.includes(data.binding.sourceStoreId), false);
      assert.deepEqual(cold(data), before);
      const rebuild = await ownerRebuild(data, {}, { cookie: other.cookie });
      diagnostics(rebuild.body, data);
      assert.equal(rebuild.status, 202);
      assert.deepEqual(rebuild.json, { target: TARGET, queuedSources: 0 });
      assert.deepEqual(cold(data), before);
      const retained = await current(data, '1');
      assert.equal(retained.json.sources[0].sourceStoreId, data.binding.sourceStoreId);
      assert.deepEqual(cold(data), before);
    } finally { await finish(data); }
  });

function immutableExceptReferences(native, changedReceipt = false) {
  const { jobs, logicalNativeDump, nativeTables, ...unchanged } = native;
  if (changedReceipt) delete unchanged.receipts;
  return { ...unchanged, nativeTables: Object.fromEntries(Object.entries(nativeTables)
    .filter(([name]) => name !== 'health_projection_outbox' &&
      (!changedReceipt || name !== 'health_batch_receipts'))) };
}
function referenceRow(data, vector) {
  return { stream_key: expectedFrontier(data, vector.receipt.sequence).stream_key,
    sequence: vector.receipt.sequence, batch_id: vector.receipt.batchId,
    payload_digest: vector.receipt.payloadDigest, state: 'queued' };
}
for (const defect of ['missing-latest-reference', 'changed-latest-digest',
  'changed-latest-batch', 'missing-earlier-reference', 'changed-earlier-unqualified-digest']) {
  test(`O09 ${defect} refuses status/rebuild despite an existing complete publication`,
    { timeout: 25000 }, async () => {
      const data = await fixture();
      try {
        const changedReceipt = defect === 'changed-earlier-unqualified-digest';
        const two = defect === 'missing-earlier-reference' || changedReceipt;
        const healthy = await published(data, two ? '2' : '1');
        const key = expectedFrontier(data, '1').stream_key;
        assert.notEqual(first(data).receipt.payloadDigest, WRONG_DIGEST);
        writer(data, db => {
          let result;
          if (defect.startsWith('missing-')) {
            result = db.prepare('DELETE FROM health_projection_outbox '
              + 'WHERE stream_key=? AND sequence=?').run(key, '1');
          } else if (defect === 'changed-latest-digest') {
            result = db.prepare('UPDATE health_projection_outbox SET payload_digest=? '
              + 'WHERE stream_key=? AND sequence=?').run(WRONG_DIGEST, key, '1');
          } else if (changedReceipt) {
            const receipt = { ...first(data).receipt, payloadDigest: UNQUALIFIED_DIGEST };
            result = db.prepare('UPDATE health_projection_outbox SET payload_digest=? '
              + 'WHERE stream_key=? AND sequence=?').run(UNQUALIFIED_DIGEST, key, '1');
            assert.equal(db.prepare('UPDATE health_batch_receipts SET payload_digest=?, '
              + 'receipt_json=? WHERE stream_key=? AND sequence=?')
              .run(UNQUALIFIED_DIGEST, JSON.stringify(receipt), key, '1').changes, 1);
          } else {
            result = db.prepare('UPDATE health_projection_outbox SET batch_id=? '
              + 'WHERE stream_key=? AND sequence=?').run(WRONG_BATCH, key, '1');
          }
          assert.equal(result.changes, 1, 'the independently selected immutable reference changed');
        });
        const corrupted = cold(data);
        assert.deepEqual(immutableExceptReferences(corrupted.native, changedReceipt),
          immutableExceptReferences(healthy.native, changedReceipt));
        assert.deepEqual(corrupted.index, healthy.index);
        const expected = changedReceipt ?
          [referenceRow(data, first(data)), referenceRow(data, second(data))] :
          two ? [referenceRow(data, second(data))] :
          defect === 'missing-latest-reference' ? [] : [referenceRow(data, first(data))];
        if (defect === 'changed-latest-digest') expected[0].payload_digest = WRONG_DIGEST;
        if (defect === 'changed-latest-batch') expected[0].batch_id = WRONG_BATCH;
        if (changedReceipt) {
          expected[0].payload_digest = UNQUALIFIED_DIGEST;
          const original = first(data).receipt;
          const changed = { ...original, payloadDigest: UNQUALIFIED_DIGEST };
          assert.deepEqual(corrupted.native.receipts, [changed, second(data).receipt]);
          const expectedReceipts = healthy.native.nativeTables.health_batch_receipts
            .map(row => row.sequence === '1' ? { ...row,
              payload_digest: UNQUALIFIED_DIGEST, receipt_json: JSON.stringify(changed) } : row);
          assert.deepEqual(corrupted.native.nativeTables.health_batch_receipts, expectedReceipts);
          assert.equal(corrupted.native.nativeTables.health_batch_receipts[0].payload_digest,
            corrupted.native.nativeTables.health_projection_outbox[0].payload_digest);
          assert.equal(corrupted.native.receipts[0].payloadDigest, UNQUALIFIED_DIGEST);
          assert.match(corrupted.native.receipts[1].payloadDigest, /^sha256:[0-9a-f]{64}$/);
        }
        assert.deepEqual(corrupted.native.nativeTables.health_projection_outbox, expected);
        await refusal(data, () => ownerStatus(data), 503, corrupted, 'storage-unavailable');
        await refusal(data, () => ownerRebuild(data), 503, corrupted, 'storage-unavailable');
      } finally { await finish(data); }
    });
}

test('O10 revoked phone loses upload authority while its real owner rebuilds exhausted retained derived state',
  { timeout: 25000 }, async () => {
    const data = await fixture();
    try {
      const complete = await published(data);
      const revoke = await req(data.server.baseUrl, `${BASE}/${data.paired.connectorId}`, {
        method: 'DELETE', cookie: data.owner.cookie, headers: { Origin: ORIGIN },
      });
      diagnostics(revoke.body, data);
      assert.equal(revoke.status, 200);
      assert.deepEqual(revoke.json, { revoked: true });
      assert.deepEqual(cold(data), complete);
      await refusal(data, () => postBatch(data, first(data)), 401, complete, 'revoked');
      await current(data, '1');
      assert.deepEqual(cold(data), complete);

      // This is an explicit isolated derived-recovery fixture, not a claimed native fault.
      // Exhausted persisted work prevents an outstanding automatic retry from passing rebuild.
      await stopped(data, () => writer(data, db => {
        assert.equal(db.prepare('DELETE FROM health_source_index '
          + 'WHERE tenant_id=? AND source_store_id=? AND record_type=? AND native_record_id=?')
          .run(data.binding.tenantId, data.binding.sourceStoreId, TYPE, 'raw-a').changes, 1);
        assert.equal(db.prepare("UPDATE health_source_index_state SET state='failed', "
          + "attempt_count=3, next_attempt_at=NULL, error_code='storage-unavailable' "
          + 'WHERE tenant_id=? AND source_store_id=?')
          .run(data.binding.tenantId, data.binding.sourceStoreId).changes, 1);
      }));
      const seeded = cold(data);
      assert.deepEqual(seeded.native, complete.native);
      assert.equal(seeded.index.indexRows.length, 2);
      assert.equal(seeded.index.indexRows.some(row => row.native_record_id === 'raw-a'), false);
      assert.equal(seeded.index.stateRows[0].state, 'failed');
      assert.equal(seeded.index.stateRows[0].attempt_count, 3);
      assert.equal(seeded.index.stateRows[0].next_attempt_at, null);
      await restart(data);
      assert.deepEqual(cold(data), seeded, 'startup cannot reset an exhausted retry budget');
      const failed = await ownerStatus(data);
      diagnostics(failed.body, data);
      assert.equal(failed.status, 200);
      assert.equal(failed.json.sources.length, 1);
      assert.equal(failed.json.sources[0].sourceStoreId, data.binding.sourceStoreId);
      assert.equal(failed.json.sources[0].state, 'failed');
      assert.deepEqual(failed.json.sources[0].attempts, { count: 3, limit: 3, nextAt: null });
      assert.deepEqual(cold(data), seeded);
      const accepted = await ownerRebuild(data);
      diagnostics(accepted.body, data);
      assert.equal(accepted.status, 202);
      assert.deepEqual(accepted.json, { target: TARGET, queuedSources: 1 });
      await current(data, '1');
      const rebuilt = cold(data);
      assert.deepEqual(rebuilt.native, complete.native);
      assertFirstIndex(rebuilt.index, data);
      await refusal(data, () => postBatch(data, first(data)), 401, rebuilt, 'revoked');
    } finally { await finish(data); }
  });

test('O11 unknown saved catalogue ownership fails closed without changing history or prior publication',
  { timeout: 25000 }, async () => {
    const data = await fixture();
    try {
      const before = await published(data);
      await stopped(data, () => {
        const file = sandboxFile(data, 'credentials', 'health-connect.json');
        const authority = JSON.parse(fs.readFileSync(file, 'utf8'));
        const owned = authority.connectors.filter(connector =>
          connector.sourceStoreId === data.binding.sourceStoreId);
        assert.equal(owned.length, 1, 'the real owner catalogue binding existed before the fixture');
        assert.equal(owned[0].ownerId, data.owner.sessions[data.owner.token].userId);
        authority.connectors = authority.connectors.filter(connector =>
          connector.sourceStoreId !== data.binding.sourceStoreId);
        authority.grants = authority.grants.filter(grant =>
          grant.sourceStoreId !== data.binding.sourceStoreId);
        fs.writeFileSync(file, JSON.stringify(authority));
      });
      assert.deepEqual(cold(data), before);
      await restart(data);
      assert.deepEqual(cold(data), before, 'unknown startup ownership cannot repair or erase history');
      await refusal(data, () => ownerStatus(data), 503, before, 'storage-unavailable');
      await refusal(data, () => ownerRebuild(data), 503, before, 'storage-unavailable');
    } finally { await finish(data); }
  });
