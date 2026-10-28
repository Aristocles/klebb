// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Independent synthetic expectations, actual scoped HTTP authority and cold
// SQLite readback. The missing-route baseline is recorded in the issue.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createSandbox, cleanupSandbox, spawnServer, req, fakeAuthState } = require('../helpers/sandbox');
const { coldReadNative } = require('../helpers/health-connect-cold-readback.cjs');
const vectors = require('../fixtures/health-connect/durable-history-independent-vectors.json');
const ORIGIN = 'https://durable.example.test';
const BASE = '/api/connectors/health-connect';
const BATCHES = `${BASE}/v1/batches`;
const TYPE = 'BodyWaterMassRecord';
const LEGACY_CARD = {
  $schema: 'klebb.datafile.v1',
  meta: { id: 'synthetic-legacy-baseline', label: 'Synthetic legacy baseline' },
  data: [{ date: '2026-10-20', kg: 35.5, note: 'preserve synthetic legacy reading' }],
};
const ENV = {
  HEALTH_ORIGIN: ORIGIN, HEALTH_RP_ID: 'durable.example.test',
  AGENT_API_TOKEN: '', KLEBB_ADMIN_TOKEN: '', KLEBB_CLOUD: '', KLEBB_DEMO: '',
  HEALTH_DATA_DIR: '', HEALTH_REPORTS_DIR: '', HEALTH_AUTO_EXPORT_DIR: '',
  HEALTH_SESSIONS_DIR: '', HEALTH_CREDENTIALS_DIR: '', HEALTH_ARCHIVE_DIR: '',
  HEALTH_CONFIG_PATH: '', HEALTH_DB_DIR: '', HEALTH_DB_FILE: '', HEALTH_CHAT_DIR: '',
  HEALTH_USER_FILE: '', HEALTH_NOTIFICATIONS_STATE_FILE: '', HEALTH_INBOX_DIR: '',
  HEALTH_KEYS_DIR: '', HEALTH_VAPID_FILE: '', HEALTH_PUSH_SUBSCRIPTIONS_FILE: '',
  HEALTH_AUTO_EXPORT_TOKEN: '', NODE_OPTIONS: '',
};
const sha = text => 'sha256:' + crypto.createHash('sha256').update(text, 'utf8').digest('hex');
function bindVector(id, binding) {
  const template = vectors.vectors.find(item => item.id === id);
  assert.ok(template, 'independently authored fixture exists');
  const payload = JSON.parse(template.payloadJson);
  payload.binding = binding;
  for (const change of payload.changes) {
    change.identity.tenantId = binding.tenantId;
    change.identity.sourceStoreId = binding.sourceStoreId;
  }
  const payloadJson = JSON.stringify(payload);
  const payloadDigest = sha(payloadJson);
  return {
    wire: { version: 1, kind: 'batch', payloadJson, payloadDigest },
    receipt: { version: 1, kind: 'durable-receipt', binding, recordType: TYPE,
      sequence: payload.sequence, batchId: payload.batchId, payloadDigest },
    payload,
  };
}
async function fixture() {
  const owner = fakeAuthState('durable-owner');
  const home = createSandbox({ credentials: owner.credentials, sessions: owner.sessions,
    seed: { 'synthetic-legacy-baseline.json': LEGACY_CARD } });
  let server;
  try {
    server = await spawnServer(home, ENV);
    const data = { home, owner, server, requestPhaseLogs: '' };
    watchLogs(data, server);
    const grant = await req(server.baseUrl, `${BASE}/pairing-grants`, {
      method: 'POST', cookie: owner.cookie, headers: { Origin: ORIGIN },
      body: { name: 'Synthetic durable phone', categories: [TYPE] },
    });
    assert.equal(grant.status, 201);
    const paired = await req(server.baseUrl, `${BASE}/v1/pairing/exchange`, {
      method: 'POST', body: { version: 1, kind: 'pairing-exchange',
        tenantId: grant.json.tenantId, instanceId: grant.json.instanceId,
        sourceStoreId: grant.json.sourceStoreId, installationId: 'synthetic-durable-installation',
        categories: [TYPE], grant: grant.json.grant },
    });
    assert.equal(paired.status, 200);
    const fields = paired.json;
    const binding = {
      tenantId: fields.tenantId, instanceId: fields.instanceId,
      sourceStoreId: fields.sourceStoreId, installationId: fields.installationId,
      generation: fields.streams[TYPE].generation, restoreEpoch: fields.restoreEpoch,
    };
    const headers = {
      Authorization: `Bearer ${fields.credential}`, 'Klebb-Health-Protocol': '1',
      'Klebb-Health-Generation': binding.generation, 'Klebb-Health-Restore-Epoch': binding.restoreEpoch,
    };
    const coldBefore = coldReadNative(home);
    assert.equal(coldBefore.legacyCards.some(row => row.card_id === LEGACY_CARD.meta.id), true,
      'the independently prepared nonempty legacy sentinel was actually loaded');
    const sentinelRows = coldBefore.legacyRows.filter(row => row.card_id === LEGACY_CARD.meta.id);
    assert.equal(sentinelRows.length, 1);
    assert.deepEqual(JSON.parse(sentinelRows[0].doc), LEGACY_CARD.data[0]);
    return Object.assign(data, { binding, headers, credential: fields.credential,
      authorityMarkers: [fields.credential, grant.json.grant, owner.token],
      legacyBefore: { cards: coldBefore.legacyCards, rows: coldBefore.legacyRows } });
  } catch (error) {
    if (server) await server.kill();
    cleanupSandbox(home);
    throw error;
  }
}
async function close(data) {
  if (data.server) await data.server.kill();
  try { noAuthority(data.requestPhaseLogs, data); } finally { cleanupSandbox(data.home); }
}
function watchLogs(data, server) {
  // Actual request logs only: spawnServer's earlier startup output is not returned.
  server.proc.stdout.on('data', bytes => { data.requestPhaseLogs += bytes.toString('utf8'); });
  server.proc.stderr.on('data', bytes => { data.requestPhaseLogs += bytes.toString('utf8'); });
}
async function restart(data) {
  data.server = await spawnServer(data.home, ENV);
  watchLogs(data, data.server);
}
function noAuthority(text, data) {
  for (const marker of data.authorityMarkers) {
    assert.equal(typeof marker, 'string');
    assert.ok(marker.length > 20, 'the actual-issued authority marker is nonempty');
    assert.equal(text.includes(marker), false, 'issued authority is not echoed or saved in native history');
  }
}
function assertLegacy(snapshot, data) {
  assert.deepEqual(snapshot.legacyCards, data.legacyBefore.cards);
  assert.deepEqual(snapshot.legacyRows, data.legacyBefore.rows);
  noAuthority(snapshot.logicalNativeDump, data);
}
async function post(data, vector, body = vector.wire) {
  return req(data.server.baseUrl, BATCHES, { method: 'POST', headers: data.headers, body });
}
async function receipt(data, vector) {
  const response = await post(data, vector);
  assert.equal(response.status, 200, 'complete native batch is durably acknowledged');
  assert.deepEqual(response.json, vector.receipt);
  noAuthority(response.body, data);
  return response.json;
}
function failure(response, status, code, data) {
  assert.equal(response.status, status);
  assert.equal(response.json?.code, code);
  assert.equal(response.json?.kind, 'error');
  assert.equal(response.json?.kind === 'durable-receipt', false);
  noAuthority(response.body, data);
}
async function frontier(data, expected) {
  const result = await req(data.server.baseUrl, `${BASE}/v1/streams/${TYPE}/status`, { headers: data.headers });
  assert.equal(result.status, 200);
  assert.deepEqual(result.json.binding, data.binding);
  assert.equal(result.json.acknowledgedSequence, expected);
}
function assertFirst(snapshot, vector, data) {
  assert.deepEqual(snapshot.records, vector.payload.changes.slice(0, 2).map(change => ({
    identity: change.identity, record: change.record,
  })));
  assert.deepEqual(snapshot.tombstoneIds, ['unknown-deleted-id']);
  assert.deepEqual(snapshot.receipts, [vector.receipt]);
  assert.deepEqual(snapshot.jobs, [{ batchId: 'synthetic-batch-1', state: 'queued' }]);
  assert.equal(snapshot.frontiers.find(row => row.recordType === TYPE)?.acknowledgedSequence, '1');
  assertLegacy(snapshot, data);
}
test('ACK survives cold readback with raw-only unknown fields, both producers, deletes, receipt and outbox', async () => {
  const data = await fixture();
  try {
    const first = bindVector('initial-raw-only', data.binding);
    await receipt(data, first);
    await frontier(data, '1');
    await data.server.kill(); data.server = null;
    assertFirst(coldReadNative(data.home), first, data);
    await restart(data);
    await frontier(data, '1');
  } finally { await close(data); }
});
test('discarded response body and different outer formatting return the exact original receipt without effects', async () => {
  const data = await fixture();
  try {
    const first = bindVector('initial-raw-only', data.binding);
    await post(data, first); // deliberately discard the response body
    // A failed first save followed by a successful retry must not pass this case.
    assertFirst(coldReadNative(data.home), first, data);
    const original = await receipt(data, first);
    const before = coldReadNative(data.home);
    const pretty = JSON.stringify(first.wire, null, 2);
    const formattedRetry = await post(data, first, pretty);
    assert.equal(formattedRetry.status, 200);
    assert.deepEqual(formattedRetry.json, original);
    noAuthority(formattedRetry.body, data);
    await data.server.kill(); data.server = null;
    assertFirst(coldReadNative(data.home), first, data);
    assert.deepEqual(coldReadNative(data.home), before);
    await restart(data);
    assert.deepEqual(await receipt(data, first), original);
  } finally { await close(data); }
});
test('changed digest, reused sequence/batch identity and gap cannot modify committed native state', async () => {
  const data = await fixture();
  try {
    const first = bindVector('initial-raw-only', data.binding);
    await receipt(data, first);
    const before = coldReadNative(data.home);
    failure(await post(data, bindVector('changed-digest-same-sequence', data.binding)), 409, 'conflict', data);
    failure(await post(data, bindVector('used-sequence-different-batch-id', data.binding)), 409, 'conflict', data);
    failure(await post(data, bindVector('used-batch-id-next-sequence', data.binding)), 409, 'conflict', data);
    failure(await post(data, bindVector('gap-after-first', data.binding)), 409, 'sequence-gap', data);
    await frontier(data, '1');
    await data.server.kill(); data.server = null;
    assert.deepEqual(coldReadNative(data.home), before);
  } finally { await close(data); }
});
test('initial sequence gap issues no receipt or history and cannot advance frontier zero', async () => {
  const data = await fixture();
  try {
    failure(await post(data, bindVector('gap-before-first', data.binding)), 409, 'sequence-gap', data);
    await frontier(data, '0');
    await data.server.kill(); data.server = null;
    const cold = coldReadNative(data.home);
    assert.deepEqual(cold.records, []);
    assert.deepEqual(cold.tombstoneIds, []);
    assert.deepEqual(cold.receipts, []);
    assert.deepEqual(cold.jobs, []);
    assert.ok(cold.frontiers.every(row => row.acknowledgedSequence === '0'));
    assertLegacy(cold, data);
  } finally { await close(data); }
});
test('unsupported serializer visibly rejects the entire batch before any save or ACK', async () => {
  const data = await fixture();
  try {
    failure(await post(data, bindVector('unsupported-serializer', data.binding)), 400, 'invalid-message', data);
    await frontier(data, '0');
    await data.server.kill(); data.server = null;
    const cold = coldReadNative(data.home);
    assert.deepEqual(cold.records, []);
    assert.deepEqual(cold.tombstoneIds, []);
    assert.deepEqual(cold.receipts, []);
    assert.deepEqual(cold.jobs, []);
    assert.ok(cold.frontiers.every(row => row.acknowledgedSequence === '0'));
    assertLegacy(cold, data);
  } finally { await close(data); }
});
test('second complete batch atomically purges a deleted raw payload and preserves the corrected other producer', async () => {
  const data = await fixture();
  try {
    const first = bindVector('initial-raw-only', data.binding);
    const second = bindVector('second-delete-and-correction', data.binding);
    await receipt(data, first);
    await receipt(data, second);
    await frontier(data, '2');
    await data.server.kill(); data.server = null;
    const cold = coldReadNative(data.home);
    assert.deepEqual(cold.records, [{
      identity: second.payload.changes[1].identity, record: second.payload.changes[1].record,
    }]);
    assert.deepEqual(cold.tombstoneIds, ['raw-a', 'unknown-deleted-id']);
    assert.deepEqual(cold.receipts, [first.receipt, second.receipt]);
    assert.deepEqual(cold.jobs.map(job => job.batchId), ['synthetic-batch-1', 'synthetic-batch-2']);
    assert.equal(cold.logicalNativeDump.includes('37.250000000000000001'), false,
      'receipt/outbox archives cannot retain the purged reading');
    assert.equal(cold.logicalNativeDump.includes('38.000000000000000009'), false,
      'an unbounded superseded-payload archive was not created');
    assertLegacy(cold, data);
  } finally { await close(data); }
});
test('a real SQLite writer lock refuses ACK and leaves the grant-backed stream retryable', async () => {
  const data = await fixture();
  let locker;
  try {
    const first = bindVector('initial-raw-only', data.binding);
    locker = new DatabaseSync(path.join(data.home, 'db', 'klebb.db'));
    locker.exec('BEGIN IMMEDIATE');
    failure(await post(data, first), 503, 'storage-unavailable', data);
    locker.exec('ROLLBACK'); locker.close(); locker = null;
    await frontier(data, '0');
    await data.server.kill(); data.server = null;
    const cold = coldReadNative(data.home);
    assert.deepEqual(cold.records, []);
    assert.deepEqual(cold.tombstoneIds, []);
    assert.deepEqual(cold.receipts, []);
    assert.deepEqual(cold.jobs, []);
    assert.ok(cold.frontiers.every(row => row.acknowledgedSequence === '0'));
    assertLegacy(cold, data);
    await restart(data);
    await receipt(data, first);
    assertFirst(coldReadNative(data.home), first, data);
  } finally {
    if (locker) { try { locker.exec('ROLLBACK'); } finally { locker.close(); } }
    await close(data);
  }
});
test('upload authority rejects another namespace, stale headers, category widening and revoked credentials without effects',
  async () => {
    const data = await fixture();
    try {
      const first = bindVector('initial-raw-only', data.binding);
      const before = coldReadNative(data.home);
      const browserOnly = await req(data.server.baseUrl, BATCHES, {
        method: 'POST', cookie: data.owner.cookie, headers: { Origin: ORIGIN }, body: first.wire,
      });
      failure(browserOnly, 401, 'unauthorised', data);
      const alienBinding = { ...data.binding, sourceStoreId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
      failure(await post(data, bindVector('initial-raw-only', alienBinding)), 400, 'binding-mismatch', data);
      const staleHeaders = { ...data.headers, 'Klebb-Health-Generation': '2' };
      failure(await req(data.server.baseUrl, BATCHES, {
        method: 'POST', headers: staleHeaders, body: first.wire,
      }), 409, 'binding-mismatch', data);
      const missingEpoch = { ...data.headers };
      delete missingEpoch['Klebb-Health-Restore-Epoch'];
      failure(await req(data.server.baseUrl, BATCHES, {
        method: 'POST', headers: missingEpoch, body: first.wire,
      }), 400, 'invalid-message', data);
      const widenedPayload = { ...first.payload, recordType: 'StepsRecord',
        changes: first.payload.changes.map(change => ({ ...change,
          identity: { ...change.identity, recordType: 'StepsRecord' } })) };
      const payloadJson = JSON.stringify(widenedPayload);
      failure(await post(data, first, { ...first.wire, payloadJson, payloadDigest: sha(payloadJson) }),
        403, 'scope-mismatch', data);
      assert.deepEqual(coldReadNative(data.home), before);
      const list = await req(data.server.baseUrl, BASE, { cookie: data.owner.cookie });
      assert.equal(list.status, 200);
      const revoked = await req(data.server.baseUrl, `${BASE}/${list.json.connectors[0].id}`, {
        method: 'DELETE', cookie: data.owner.cookie, headers: { Origin: ORIGIN },
      });
      assert.equal(revoked.status, 200);
      failure(await post(data, first), 401, 'revoked', data);
      assert.deepEqual(coldReadNative(data.home), before);
    } finally { await close(data); }
  });
test('sequence arithmetic persists consecutive canonical Int64 strings beyond Number precision and at the signed maximum',
  async () => {
    const data = await fixture();
    let writer;
    try {
      await receipt(data, bindVector('initial-raw-only', data.binding));
      // Seed the previously acknowledged frontier explicitly to isolate arithmetic;
      // this does not claim trillions of real uploads or a portable restore.
      writer = new DatabaseSync(path.join(data.home, 'db', 'klebb.db'));
      for (const [prior, next, batchId] of [
        ['9007199254740992', '9007199254740993', 'synthetic-wide-sequence'],
        ['9223372036854775806', '9223372036854775807', 'synthetic-maximum-sequence'],
      ]) {
        // A saved frontier must also have its own matching immutable receipt.
        // Seed both components of this deliberately large synthetic history.
        const priorBatchId = `synthetic-predecessor-${prior}`;
        const priorVector = bindVector('initial-raw-only', data.binding);
        priorVector.payload.sequence = prior;
        priorVector.payload.batchId = priorBatchId;
        const priorDigest = sha(JSON.stringify(priorVector.payload));
        const priorReceipt = { ...priorVector.receipt, sequence: prior, batchId: priorBatchId,
          payloadDigest: priorDigest };
        const key = writer.prepare('SELECT stream_key FROM health_streams').get().stream_key;
        writer.exec('BEGIN IMMEDIATE');
        writer.prepare('INSERT INTO health_batch_receipts '
          + '(stream_key, sequence, batch_id, payload_digest, receipt_json) VALUES (?, ?, ?, ?, ?)')
          .run(key, prior, priorBatchId, priorDigest, JSON.stringify(priorReceipt));
        writer.prepare('UPDATE health_streams SET acknowledged_sequence = ?').run(prior);
        writer.exec('COMMIT');
        const vector = bindVector('initial-raw-only', data.binding);
        vector.payload.sequence = next;
        vector.payload.batchId = batchId;
        vector.wire.payloadJson = JSON.stringify(vector.payload);
        vector.wire.payloadDigest = sha(vector.wire.payloadJson);
        vector.receipt = { ...vector.receipt, sequence: next, batchId,
          payloadDigest: vector.wire.payloadDigest };
        await receipt(data, vector);
        await frontier(data, next);
        assert.deepEqual(await receipt(data, vector), vector.receipt);
      }
      writer.close(); writer = null;
      await data.server.kill(); data.server = null;
      const cold = coldReadNative(data.home);
      assert.equal(cold.frontiers[0].acknowledgedSequence, '9223372036854775807');
      assert.deepEqual(cold.receipts.map(item => item.sequence),
        ['1', '9007199254740992', '9007199254740993', '9223372036854775806', '9223372036854775807']);
      assertLegacy(cold, data);
    } finally { if (writer) writer.close(); await close(data); }
  });
test('partial native schema and malformed or unreceipted saved frontier fail closed without resetting records or issuing an ACK',
  async () => {
    for (const defect of ['missing-table', 'malformed-frontier', 'unreceipted-frontier']) {
      const data = await fixture();
      let writer;
      try {
        const first = bindVector('initial-raw-only', data.binding);
        await receipt(data, first);
        // Corrupt stopped storage, independently of post-ACK index work.
        await data.server.kill(); data.server = null;
        writer = new DatabaseSync(path.join(data.home, 'db', 'klebb.db'));
        const rawBefore = writer.prepare('SELECT * FROM health_records ORDER BY native_record_id').all();
        if (defect === 'missing-table') writer.exec('DROP TABLE health_tombstones');
        else writer.prepare('UPDATE health_streams SET acknowledged_sequence = ?')
          .run(defect === 'malformed-frontier' ? '01' : '2');
        await restart(data);
        failure(await post(data, first), 503, 'storage-unavailable', data);
        failure(await req(data.server.baseUrl, `${BASE}/v1/streams/${TYPE}/status`, { headers: data.headers }),
          503, 'storage-unavailable', data);
        assert.deepEqual(writer.prepare('SELECT * FROM health_records ORDER BY native_record_id').all(), rawBefore);
        if (defect === 'missing-table') assert.equal(writer.prepare(
          "SELECT count(*) AS n FROM sqlite_schema WHERE name='health_tombstones'").get().n, 0);
        else assert.equal(writer.prepare('SELECT acknowledged_sequence FROM health_streams').get()
          .acknowledged_sequence, defect === 'malformed-frontier' ? '01' : '2');
      } finally { if (writer) writer.close(); await close(data); }
    }
  });
