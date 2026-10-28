// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const product = process.env.INDEPENDENT_PRODUCT_ROOT || path.resolve(__dirname, '../..');
const { createSandbox, cleanupSandbox, spawnServer, req, fakeAuthState } =
  require(path.join(product, 'tests/helpers/sandbox'));
const { coldReadNative } =
  require(path.join(product, 'tests/helpers/health-connect-cold-readback.cjs'));
const { coldReadObjects } =
  require(path.join(product, 'tests/helpers/health-connect-object-cold-readback.cjs'));
const { makeObject, sha, TYPE } = require(process.env.INDEPENDENT_PRODUCT_ROOT ?
  path.join(__dirname, '../../independent-object-fixtures.cjs') :
  path.join(product, 'tests/helpers/health-connect-independent-object-fixtures.cjs'));
const BASE = '/api/connectors/health-connect';
const PART = `${BASE}/v1/object-parts`;
const FINAL = `${BASE}/v1/object-finalise`;
const ORIGIN = 'https://object-fault.example.test';
const LEGACY = { $schema: 'klebb.datafile.v1',
  meta: { id: 'synthetic-object-fault-legacy', label: 'Synthetic object fault legacy' },
  data: [{ date: '2026-10-20', kg: 35.5, note: 'preserve fixed native fault sentinel' }] };
const ENV = {
  HEALTH_ORIGIN: ORIGIN, HEALTH_RP_ID: 'object-fault.example.test',
  AGENT_API_TOKEN: '', KLEBB_ADMIN_TOKEN: '', KLEBB_CLOUD: '', KLEBB_DEMO: '',
  HEALTH_DATA_DIR: '', HEALTH_REPORTS_DIR: '', HEALTH_AUTO_EXPORT_DIR: '',
  HEALTH_SESSIONS_DIR: '', HEALTH_CREDENTIALS_DIR: '', HEALTH_ARCHIVE_DIR: '',
  HEALTH_CONFIG_PATH: '', HEALTH_DB_DIR: '', HEALTH_DB_FILE: '', HEALTH_CHAT_DIR: '',
  HEALTH_USER_FILE: '', HEALTH_NOTIFICATIONS_STATE_FILE: '', HEALTH_INBOX_DIR: '',
  HEALTH_KEYS_DIR: '', HEALTH_VAPID_FILE: '', HEALTH_PUSH_SUBSCRIPTIONS_FILE: '',
  HEALTH_AUTO_EXPORT_TOKEN: '', HEALTH_CONNECT_STAGING_MAX_BYTES: '', NODE_OPTIONS: '',
};
function watch(data) {
  for (const stream of [data.server.proc.stdout, data.server.proc.stderr]) {
    stream.on('data', bytes => { data.requestLogs += bytes.toString('utf8'); });
  }
}
function noAuthority(text, data) {
  for (const marker of data.markers) {
    assert.equal(typeof marker, 'string');
    assert.ok(marker.length > 20);
    assert.equal(text.includes(marker), false);
  }
}
async function pair(data, installationId = 'synthetic-durable-installation') {
  const grant = await req(data.server.baseUrl, `${BASE}/pairing-grants`, {
    method: 'POST', cookie: data.owner.cookie, headers: { Origin: ORIGIN },
    body: { name: 'Synthetic object fault phone', categories: [TYPE] },
  });
  assert.equal(grant.status, 201);
  const response = await req(data.server.baseUrl, `${BASE}/v1/pairing/exchange`, {
    method: 'POST', body: { version: 1, kind: 'pairing-exchange',
      tenantId: grant.json.tenantId, instanceId: grant.json.instanceId,
      sourceStoreId: grant.json.sourceStoreId, installationId,
      categories: [TYPE], grant: grant.json.grant },
  });
  assert.equal(response.status, 200);
  const paired = response.json;
  data.markers.push(grant.json.grant, paired.credential);
  const binding = { tenantId: paired.tenantId, instanceId: paired.instanceId,
    sourceStoreId: paired.sourceStoreId, installationId: paired.installationId,
    generation: paired.streams[TYPE].generation, restoreEpoch: paired.restoreEpoch };
  return { paired, binding, headers: { Authorization: `Bearer ${paired.credential}`,
    'Klebb-Health-Protocol': '1', 'Klebb-Health-Generation': binding.generation,
    'Klebb-Health-Restore-Epoch': binding.restoreEpoch } };
}
async function fixture(extraEnv = {}) {
  const owner = fakeAuthState('object-fault-owner');
  const home = createSandbox({ credentials: owner.credentials, sessions: owner.sessions,
    seed: { 'synthetic-object-fault-legacy.json': LEGACY } });
  const data = { home, owner, server: null, requestLogs: '', markers: [owner.token],
    extraEnv: { ...extraEnv } };
  try {
    data.server = await spawnServer(home, { ...ENV, ...data.extraEnv });
    watch(data);
    Object.assign(data, await pair(data));
    data.before = coldReadNative(home);
    const rows = data.before.legacyRows.filter(row => row.card_id === LEGACY.meta.id);
    assert.ok(data.before.legacyCards.some(row => row.card_id === LEGACY.meta.id));
    assert.equal(rows.length, 1);
    assert.deepEqual(JSON.parse(rows[0].doc), LEGACY.data[0]);
    return data;
  } catch (error) {
    if (data.server) await data.server.kill();
    cleanupSandbox(home);
    throw error;
  }
}
async function restart(data, extraEnv = data.extraEnv) {
  if (data.server) await data.server.kill();
  data.extraEnv = { ...extraEnv };
  data.server = await spawnServer(data.home, { ...ENV, ...data.extraEnv });
  watch(data);
}
async function close(data) {
  if (data.server) await data.server.kill();
  try { noAuthority(data.requestLogs, data); } finally { cleanupSandbox(data.home); }
}
const post = (data, route, body, headers = data.headers) =>
  req(data.server.baseUrl, route, { method: 'POST', headers, body });
function failure(response, status, code, data) {
  assert.equal(response.status, status);
  assert.equal(response.json.kind, 'error');
  assert.equal(response.json.code, code);
  assert.equal(response.json.retryable, status === 503);
  noAuthority(response.body, data);
}
async function stage(data, object, indices = object.manifest.map(part => part.index), headers = data.headers) {
  for (const index of indices) {
    const response = await post(data, PART, object.partFrames[index], headers);
    assert.equal(response.status, 200);
    assert.deepEqual(response.json, object.partReceipts[index]);
    noAuthority(response.body, data);
  }
}
async function finalise(data, object, headers = data.headers) {
  const response = await post(data, FINAL, object.finalise, headers);
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, object.receipt);
  noAuthority(response.body, data);
}
function committedNative(data, object) {
  const snapshot = coldReadNative(data.home);
  assert.deepEqual(snapshot.records, [{ identity: object.header.identity,
    record: object.payload.changes[0].record }]);
  assert.deepEqual(snapshot.tombstoneIds, []);
  assert.deepEqual(snapshot.receipts, [object.receipt]);
  assert.deepEqual(snapshot.frontiers, [{ recordType: TYPE, acknowledgedSequence: '1' }]);
  assert.deepEqual(snapshot.jobs, [{ batchId: object.header.batchId, state: 'queued' }]);
  assert.deepEqual(snapshot.legacyCards, data.before.legacyCards);
  assert.deepEqual(snapshot.legacyRows, data.before.legacyRows);
  noAuthority(snapshot.logicalNativeDump, data);
  return snapshot;
}
function purgedWithReceipt(data, object) {
  const snapshot = coldReadObjects(data.home);
  assert.deepEqual(snapshot.objects, []);
  assert.equal(snapshot.aggregateReservedBytes, 0);
  assert.equal(snapshot.physicalPartCount, 0);
  assert.equal(snapshot.physicalPayloadBytes, 0);
  assert.deepEqual(snapshot.committedDeclarations, [{ declaration: object.header, parts: object.manifest }]);
  assert.equal(snapshot.compactText.includes('P'.repeat(256)), false);
  noAuthority(snapshot.compactText, data);
  return snapshot;
}
module.exports = { fixture, pair, restart, close, post, failure, stage, finalise,
  noAuthority, committedNative, purgedWithReceipt, coldReadNative, coldReadObjects,
  makeObject, sha, BASE, PART, FINAL, TYPE, ENV, req, product };
