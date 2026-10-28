// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Independent fault expectations run after actual scoped authority setup.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const product = process.env.INDEPENDENT_PRODUCT_ROOT || path.resolve(__dirname, '../..');
const { createSandbox, cleanupSandbox, spawnServer, req, fakeAuthState } =
  require(path.join(product, 'tests/helpers/sandbox'));
const { coldReadNative } = require('../helpers/health-connect-cold-readback.cjs');
const vectors = require(process.env.INDEPENDENT_PRODUCT_ROOT ?
  path.join(__dirname, '../../durable-history-independent-vectors.json') :
  path.join(product, 'tests/fixtures/health-connect/durable-history-independent-vectors.json'));
const preload = path.join(__dirname, '../helpers/health-connect-ingest-fault-preload.cjs');
const ORIGIN = 'https://faults.example.test';
const BASE = '/api/connectors/health-connect';
const TYPE = 'BodyWaterMassRecord';
const LEGACY = { $schema: 'klebb.datafile.v1',
  meta: { id: 'synthetic-fault-legacy', label: 'Synthetic fault legacy' },
  data: [{ date: '2026-10-20', kg: 35.5, note: 'preserve synthetic legacy reading' }] };
const ENV = {
  HEALTH_ORIGIN: ORIGIN, HEALTH_RP_ID: 'faults.example.test',
  AGENT_API_TOKEN: '', KLEBB_ADMIN_TOKEN: '', KLEBB_CLOUD: '', KLEBB_DEMO: '',
  HEALTH_DATA_DIR: '', HEALTH_REPORTS_DIR: '', HEALTH_AUTO_EXPORT_DIR: '',
  HEALTH_SESSIONS_DIR: '', HEALTH_CREDENTIALS_DIR: '', HEALTH_ARCHIVE_DIR: '',
  HEALTH_CONFIG_PATH: '', HEALTH_DB_DIR: '', HEALTH_DB_FILE: '', HEALTH_CHAT_DIR: '',
  HEALTH_USER_FILE: '', HEALTH_NOTIFICATIONS_STATE_FILE: '', HEALTH_INBOX_DIR: '',
  HEALTH_KEYS_DIR: '', HEALTH_VAPID_FILE: '', HEALTH_PUSH_SUBSCRIPTIONS_FILE: '',
  HEALTH_AUTO_EXPORT_TOKEN: '', NODE_OPTIONS: '',
  INDEPENDENT_INGEST_OBSERVATIONS: '', INDEPENDENT_INGEST_FAULT: '',
};
const sha = text => 'sha256:' + crypto.createHash('sha256').update(text, 'utf8').digest('hex');
async function fixture() {
  const owner = fakeAuthState('fault-owner');
  const home = createSandbox({ credentials: owner.credentials, sessions: owner.sessions,
    seed: { 'synthetic-fault-legacy.json': LEGACY } });
  let server;
  try {
    server = await spawnServer(home, ENV);
    const approved = await req(server.baseUrl, `${BASE}/pairing-grants`, {
      method: 'POST', cookie: owner.cookie, headers: { Origin: ORIGIN },
      body: { categories: [TYPE], name: 'Synthetic fault phone' },
    });
    assert.equal(approved.status, 201);
    const paired = await req(server.baseUrl, `${BASE}/v1/pairing/exchange`, {
      method: 'POST', body: { version: 1, kind: 'pairing-exchange',
        tenantId: approved.json.tenantId, instanceId: approved.json.instanceId,
        sourceStoreId: approved.json.sourceStoreId, installationId: 'synthetic-durable-installation',
        categories: [TYPE], grant: approved.json.grant },
    });
    assert.equal(paired.status, 200);
    const binding = {
      tenantId: paired.json.tenantId, instanceId: paired.json.instanceId,
      sourceStoreId: paired.json.sourceStoreId, installationId: paired.json.installationId,
      generation: paired.json.streams[TYPE].generation, restoreEpoch: paired.json.restoreEpoch,
    };
    const headers = { Authorization: `Bearer ${paired.json.credential}`, 'Klebb-Health-Protocol': '1',
      'Klebb-Health-Generation': binding.generation, 'Klebb-Health-Restore-Epoch': binding.restoreEpoch };
    const before = coldReadNative(home);
    const legacyRows = before.legacyRows.filter(row => row.card_id === LEGACY.meta.id);
    assert.equal(legacyRows.length, 1);
    assert.deepEqual(JSON.parse(legacyRows[0].doc), LEGACY.data[0]);
    await server.kill(); server = null;
    return { home, owner, server, binding, headers,
      secrets: [paired.json.credential, approved.json.grant, owner.token],
      legacyBefore: { cards: before.legacyCards, rows: before.legacyRows } };
  } catch (error) {
    if (server) await server.kill();
    cleanupSandbox(home);
    throw error;
  }
}
function first(data, padded = false) {
  const payload = JSON.parse(vectors.vectors.find(vector => vector.id === 'initial-raw-only').payloadJson);
  payload.binding = data.binding;
  for (const change of payload.changes) {
    change.identity.tenantId = data.binding.tenantId;
    change.identity.sourceStoreId = data.binding.sourceStoreId;
  }
  if (padded) payload.changes[0].record.extension.fullFaultPadding = 'F'.repeat(262144);
  const payloadJson = JSON.stringify(payload);
  const payloadDigest = sha(payloadJson);
  const receipt = { version: 1, kind: 'durable-receipt', binding: data.binding, recordType: TYPE,
    sequence: '1', batchId: 'synthetic-batch-1', payloadDigest };
  return { payload, receipt, wire: { version: 1, kind: 'batch', payloadJson, payloadDigest } };
}
async function start(data, operation = null) {
  const env = operation ? { ...ENV,
    NODE_OPTIONS: `--require "${preload.replaceAll('\\', '/')}"`,
    INDEPENDENT_INGEST_OBSERVATIONS: path.join(data.home, 'ingest-observations.jsonl'),
    INDEPENDENT_INGEST_FAULT: operation } : ENV;
  data.server = await spawnServer(data.home, env);
}
function observations(data) {
  return fs.readFileSync(path.join(data.home, 'ingest-observations.jsonl'), 'utf8')
    .trim().split('\n').filter(Boolean).map(JSON.parse);
}
function secretFree(text, data) {
  for (const secret of data.secrets) {
    assert.equal(typeof secret, 'string');
    assert.ok(secret.length > 20, 'actual issued markers are nonempty');
    assert.equal(text.includes(secret), false);
  }
}
function unchangedLegacy(cold, data) {
  assert.deepEqual(cold.legacyCards, data.legacyBefore.cards);
  assert.deepEqual(cold.legacyRows, data.legacyBefore.rows);
  secretFree(cold.logicalNativeDump, data);
}
function empty(cold, data) {
  assert.deepEqual(cold.records, []);
  assert.deepEqual(cold.tombstoneIds, []);
  assert.deepEqual(cold.receipts, []);
  assert.deepEqual(cold.jobs, []);
  assert.ok(cold.frontiers.every(row => row.acknowledgedSequence === '0'));
  unchangedLegacy(cold, data);
}
function complete(cold, vector, data) {
  assert.deepEqual(cold.records, vector.payload.changes.slice(0, 2).map(change => ({
    identity: change.identity, record: change.record,
  })));
  assert.deepEqual(cold.tombstoneIds, ['unknown-deleted-id']);
  assert.deepEqual(cold.receipts, [vector.receipt]);
  assert.deepEqual(cold.jobs, [{ batchId: 'synthetic-batch-1', state: 'queued' }]);
  assert.equal(cold.frontiers.find(row => row.recordType === TYPE)?.acknowledgedSequence, '1');
  unchangedLegacy(cold, data);
}
async function post(data, vector) {
  return req(data.server.baseUrl, `${BASE}/v1/batches`, {
    method: 'POST', headers: data.headers, body: vector.wire,
  });
}
function writerIsFull(events) {
  const writes = events.filter(event => event.kind === 'native-writer');
  assert.ok(writes.length > 0, 'the actual ingest handle was observed at a raw INSERT');
  assert.ok(writes.every(event => event.journalMode === 'wal' && event.synchronous === 2));
  for (const write of writes) {
    assert.equal(write.transactionActive, true);
    const beginIndex = events.findIndex(event => event.kind === 'transaction-begin' &&
      event.handleId === write.handleId && event.transactionId === write.transactionId);
    const completedIndex = events.findIndex(event => event.kind === 'transaction-begin-complete' &&
      event.handleId === write.handleId && event.transactionId === write.transactionId);
    assert.ok(beginIndex >= 0 && completedIndex > beginIndex &&
      completedIndex < events.indexOf(write), 'the same actual handle began before its raw write');
    assert.equal(events[beginIndex].journalMode, 'wal');
    assert.equal(events[beginIndex].synchronous, 2, 'FULL was set before actual BEGIN');
    assert.equal(events[beginIndex].transactionActive, false);
  }
}
async function close(data) {
  if (data.server) await data.server.kill();
  cleanupSandbox(data.home);
}
function postAcrossDeath(data, vector) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${BASE}/v1/batches`, data.server.baseUrl);
    const timer = setTimeout(() => {
      request.destroy();
      reject(new Error('independent death probe timed out'));
    }, 15000);
    const finish = result => { clearTimeout(timer); resolve(result); };
    const request = http.request(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...data.headers },
    }, response => {
      let body = '';
      response.on('data', bytes => { body += bytes.toString('utf8'); });
      response.on('end', () => finish({ status: response.statusCode, body }));
      response.on('aborted', () => finish({ connectionLost: true, errorCode: 'RESPONSE_ABORTED' }));
      response.on('error', error => finish({ connectionLost: true, errorCode: error.code }));
    });
    request.on('error', error => finish({ connectionLost: true, errorCode: error.code }));
    request.end(JSON.stringify(vector.wire));
  });
}
function boundedChildExit(child) {
  const pending = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('isolated server did not exit after commit fault')),
      15000);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  // The HTTP wait can finish later than the exit deadline; prevent an unhandled
  // rejection while retaining the fixed deadline failure when it is awaited.
  void pending.catch(() => {});
  return pending;
}
test('actual native ingest handle uses WAL/FULL before its writes and the saved receipt matches cold state', async () => {
  const data = await fixture();
  try {
    await start(data, 'observe');
    const vector = first(data);
    const response = await post(data, vector);
    assert.equal(response.status, 200);
    assert.deepEqual(response.json, vector.receipt);
    secretFree(response.body, data);
    writerIsFull(observations(data));
    assert.equal(observations(data).some(event => event.kind === 'fault-fired'), false);
    await data.server.kill(); data.server = null;
    complete(coldReadNative(data.home), vector, data);
  } finally { await close(data); }
});
for (const operation of ['sqlite-full', 'outbox-insert-full']) {
  test(`${operation} cannot issue ACK, advance frontier or retain partial source/outbox effects`, async () => {
    const data = await fixture();
    try {
      await start(data, operation);
      const vector = first(data, operation === 'sqlite-full');
      const response = await post(data, vector);
      assert.equal(response.status, 503);
      assert.equal(response.json?.kind, 'error');
      assert.equal(response.json?.code, 'storage-unavailable');
      secretFree(response.body, data);
      const events = observations(data);
      assert.equal(events.filter(event => event.kind === 'fault-fired' &&
        event.operation === operation).length, 1);
      if (operation === 'outbox-insert-full') {
        assert.ok(events.find(event => event.kind === 'fault-fired').rawWrites > 0,
          'the late outbox failure actually follows successful raw writes');
      }
      if (operation === 'sqlite-full') {
        writerIsFull(events);
        assert.deepEqual(events.find(event => event.kind === 'native-write-error'),
          { kind: 'native-write-error', sqliteResult: 13 });
      }
      await data.server.kill(); data.server = null;
      empty(coldReadNative(data.home), data);
      await start(data);
      const retried = await post(data, vector);
      assert.equal(retried.status, 200);
      assert.deepEqual(retried.json, vector.receipt);
      await data.server.kill(); data.server = null;
      complete(coldReadNative(data.home), vector, data);
    } finally { await close(data); }
  });
}
for (const operation of ['before-commit-kill', 'after-commit-kill']) {
  test(`${operation} preserves the independently expected cold atomic state and retry receipt`, async () => {
    const data = await fixture();
    try {
      await start(data, operation);
      const vector = first(data);
      const childExited = boundedChildExit(data.server.proc);
      const response = await postAcrossDeath(data, vector);
      assert.equal(response.connectionLost, true, 'a usable ACK cannot precede the tested commit boundary');
      assert.ok(['ECONNRESET', 'RESPONSE_ABORTED'].includes(response.errorCode));
      const exit = await childExited;
      if (process.platform === 'win32') assert.deepEqual(exit, { code: 1, signal: null });
      else assert.deepEqual(exit, { code: null, signal: 'SIGKILL' });
      data.server = null;
      const events = observations(data);
      writerIsFull(events);
      const phase = operation === 'before-commit-kill' ?
        'immediately-before-native-commit' : 'immediately-after-native-commit';
      assert.equal(events.filter(event => event.kind === 'fault-fired').length, 1);
      assert.equal(events.find(event => event.kind === 'fault-fired').phase, phase);
      const beforeRetry = coldReadNative(data.home);
      if (operation === 'before-commit-kill') empty(beforeRetry, data);
      else complete(beforeRetry, vector, data);
      await start(data);
      const retried = await post(data, vector);
      assert.equal(retried.status, 200);
      assert.deepEqual(retried.json, vector.receipt);
      secretFree(retried.body, data);
      await data.server.kill(); data.server = null;
      const afterRetry = coldReadNative(data.home);
      complete(afterRetry, vector, data);
      if (operation === 'after-commit-kill') assert.deepEqual(afterRetry, beforeRetry);
    } finally { await close(data); }
  });
}
