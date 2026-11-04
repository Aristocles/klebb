// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { createSandbox, cleanupSandbox, spawnServer, req, fakeAuthState } = require('../helpers/sandbox');
const vectors = require('../fixtures/health-connect/durable-history-independent-vectors.json');
const BASE = '/api/connectors/health-connect';
const TYPE = 'BodyWaterMassRecord';
const ORIGIN = 'https://synthetic-custody.example.test';
const ENV = { HEALTH_ORIGIN: ORIGIN, HEALTH_RP_ID: 'synthetic-custody.example.test',
  AGENT_API_TOKEN: '', KLEBB_ADMIN_TOKEN: '', KLEBB_CLOUD: '', KLEBB_DEMO: '',
  HEALTH_DATA_DIR: '', HEALTH_REPORTS_DIR: '', HEALTH_AUTO_EXPORT_DIR: '',
  HEALTH_SESSIONS_DIR: '', HEALTH_CREDENTIALS_DIR: '', HEALTH_ARCHIVE_DIR: '',
  HEALTH_CONFIG_PATH: '', HEALTH_DB_DIR: '', HEALTH_DB_FILE: '', HEALTH_CHAT_DIR: '',
  HEALTH_USER_FILE: '', HEALTH_NOTIFICATIONS_STATE_FILE: '', HEALTH_INBOX_DIR: '',
  HEALTH_KEYS_DIR: '', HEALTH_VAPID_FILE: '', HEALTH_PUSH_SUBSCRIPTIONS_FILE: '',
  HEALTH_AUTO_EXPORT_TOKEN: '', NODE_OPTIONS: '' };
const file = (home, name) => path.join(home, 'credentials', name);
const browser = (f, route, options = {}) => req(f.server.baseUrl, route, {
  cookie: f.owner.cookie, ...options, headers: { Origin: ORIGIN, ...options.headers },
});
const error = (response, status, code) => {
  assert.equal(response.status, status, response.body);
  assert.deepEqual(response.json, { version: 1, kind: 'error', code, retryable: false });
};
async function setup(label = 'synthetic-current-member') {
  const owner = fakeAuthState(label);
  const home = createSandbox({ credentials: owner.credentials, sessions: owner.sessions });
  const f = { owner, home, server: null };
  try { f.server = await spawnServer(home, ENV); return f; }
  catch (failure) { cleanupSandbox(home); throw failure; }
}
async function close(f) { if (f.server) await f.server.kill(); cleanupSandbox(f.home); }
async function authenticated(f) {
  const result = await browser(f, '/auth/status');
  assert.equal(result.status, 200); assert.equal(result.json.authenticated, true);
}
async function grant(f) {
  const result = await browser(f, `${BASE}/pairing-grants`, { method: 'POST',
    body: { categories: [TYPE], name: 'Synthetic stopped source' } });
  assert.equal(result.status, 201, result.body);
  assert.deepEqual(Object.keys(result.json).sort(), ['categories', 'destination', 'expiresAt',
    'grant', 'instanceId', 'kind', 'limits', 'restoreEpoch', 'sourceStoreId', 'tenantId', 'version']);
  assert.equal(result.json.version, 1); assert.equal(result.json.kind, 'pairing-grant');
  assert.equal(result.json.destination, ORIGIN); assert.deepEqual(result.json.categories, [TYPE]);
  return result.json;
}
async function firstPair(f) {
  const issued = await grant(f);
  const response = await req(f.server.baseUrl, `${BASE}/v1/pairing/exchange`, {
    method: 'POST', body: { version: 1, kind: 'pairing-exchange', tenantId: issued.tenantId,
      instanceId: issued.instanceId, sourceStoreId: issued.sourceStoreId, grant: issued.grant,
      installationId: 'synthetic-stopped-installation', categories: [TYPE] } });
  assert.equal(response.status, 200, response.body);
  const paired = response.json;
  assert.equal(paired.version, 1); assert.equal(paired.kind, 'paired');
  for (const key of ['tenantId', 'instanceId', 'sourceStoreId', 'restoreEpoch']) {
    assert.equal(paired[key], issued[key]);
  }
  assert.deepEqual(paired.streams, { [TYPE]: { generation: '1', acknowledgedSequence: '0' } });
  return { issued, paired };
}
function sqlSnapshot(home) {
  const db = new DatabaseSync(path.join(home, 'db', 'klebb.db'), { readOnly: true });
  try {
    db.exec('BEGIN');
    const rows = table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map(x => ({ ...x }));
    return { state: rows('health_source_policy_state'), sources: rows('health_source_policy_sources'),
      categories: rows('health_source_policy_categories'), native: Object.fromEntries([
        'health_records', 'health_tombstones', 'health_streams', 'health_batch_receipts',
        'health_projection_outbox'].map(table => [table, rows(table)])) };
  } finally { db.close(); }
}
function stopped(snapshot, ids, owner) {
  assert.deepEqual(snapshot.sources.map(x => x.source_store_id).sort(), [...ids].sort());
  const principals = new Set(snapshot.sources.map(x => x.owner_id));
  assert.equal(principals.size, 1); assert.notEqual([...principals][0], Object.keys(owner.credentials.users)[0]);
  for (const row of snapshot.sources) {
    assert.equal(row.lifecycle, 'active'); assert.equal(row.knowledge, 'COMPLETE');
    assert.equal(row.retain_committed_history, 1); assert.equal(row.category_count, 1);
    assert.equal(row.reconciled_epoch, null);
    assert.deepEqual(snapshot.categories.filter(x => x.source_store_id === row.source_store_id)
      .map(x => ({ record_type: x.record_type, sharing: x.sharing, generation: x.generation })),
      [{ record_type: TYPE, sharing: 'stopped', generation: '1' }]);
  }
  for (const rows of Object.values(snapshot.native)) assert.deepEqual(rows, []);
}
function nativeHeaders(paired) {
  return { Authorization: `Bearer ${paired.credential}`, 'Klebb-Health-Protocol': '1',
    'Klebb-Health-Generation': '1', 'Klebb-Health-Restore-Epoch': paired.restoreEpoch };
}
function validStoppedBatch(paired) {
  const original = vectors.vectors.find(x => x.id === 'initial-raw-only');
  const payload = JSON.parse(original.payloadJson);
  payload.binding = { tenantId: paired.tenantId, instanceId: paired.instanceId,
    sourceStoreId: paired.sourceStoreId, installationId: paired.installationId,
    generation: '1', restoreEpoch: paired.restoreEpoch };
  for (const change of payload.changes) {
    change.identity.tenantId = paired.tenantId; change.identity.sourceStoreId = paired.sourceStoreId;
  }
  const payloadJson = JSON.stringify(payload);
  return { version: 1, kind: 'batch', payloadJson,
    payloadDigest: 'sha256:' + crypto.createHash('sha256').update(payloadJson).digest('hex') };
}

test('STOPPED_CUSTODY01 first/exchange and second grants preserve managed stopped custody and refuse ingestion', async () => {
  const f = await setup();
  try {
    await authenticated(f);
    const { issued, paired } = await firstPair(f); // No batch, native ACK, policy installation or enabling in setup.
    const second = await grant(f); // Meaningful current baseline RED is 409 versus this independent 201.
    assert.notEqual(second.sourceStoreId, issued.sourceStoreId);
    const list = await browser(f, BASE);
    assert.equal(list.status, 200); assert.equal(list.json.version, 1);
    assert.equal(list.json.kind, 'connector-list'); assert.equal(list.json.destination, ORIGIN);
    assert.deepEqual(list.json.connectors.map(x => x.id), [paired.connectorId]);
    const before = sqlSnapshot(f.home);
    stopped(before, [issued.sourceStoreId, second.sourceStoreId], f.owner);
    const catalogue = JSON.parse(fs.readFileSync(file(f.home, 'health-connect-policy.json')));
    assert.equal(catalogue.version, 2);
    const principal = catalogue.principals.find(x => x.ownerId === before.sources[0].owner_id);
    assert.ok(principal.members.some(x => x.credentialId === f.owner.credentialId));
    const status = await browser(f, `${BASE}/projections/status`);
    assert.equal(status.status, 200);
    assert.deepEqual(status.json, { target: 'source-index-v1', sources: [] });
    const refused = await req(f.server.baseUrl, `${BASE}/v1/batches`, { method: 'POST',
      headers: nativeHeaders(paired), body: validStoppedBatch(paired) });
    error(refused, 409, 'IMPORT_SOURCE_POLICY_UNKNOWN');
    assert.deepEqual(sqlSnapshot(f.home), before, 'refusal creates no records, controls, frontier, receipt or job');
    const revoke = await browser(f, `${BASE}/${paired.connectorId}`, { method: 'DELETE' });
    assert.equal(revoke.status, 200); assert.deepEqual(revoke.json, { revoked: true });
    const denied = await req(f.server.baseUrl, `${BASE}/v1/capabilities`, { headers: nativeHeaders(paired) });
    error(denied, 401, 'revoked');
    assert.deepEqual(sqlSnapshot(f.home).native, before.native);
  } finally { await close(f); }
});

test('STOPPED_CUSTODY02 literal retained V1 metadata remains UNKNOWN and cannot enrol', async () => {
  const f = await setup('synthetic-retained-member');
  try {
    await f.server.kill(); f.server = null;
    const state = { version: 1, tenantId: '11111111-1111-4111-8111-111111111111',
      instanceId: '22222222-2222-4222-8222-222222222222', restoreEpoch: '33333333-3333-4333-8333-333333333333',
      grants: [], connectors: [{ id: '55555555-5555-4555-8555-555555555555',
        credentialVerifier: 'sha256:' + '0'.repeat(64), ownerId: 'synthetic-retained-member',
        installationId: 'synthetic-retained-installation', sourceStoreId: '44444444-4444-4444-8444-444444444444',
        restoreEpoch: '33333333-3333-4333-8333-333333333333', categories: [TYPE], generations: { [TYPE]: '1' },
        name: 'Unproven retained source', createdAt: '2026-01-02T00:00:00.000Z', revokedAt: null }] };
    const bytes = Buffer.from(JSON.stringify(state));
    fs.writeFileSync(file(f.home, 'health-connect.json'), bytes);
    f.server = await spawnServer(f.home, ENV); await authenticated(f);
    error(await browser(f, BASE), 409, 'IMPORT_SOURCE_POLICY_UNKNOWN');
    error(await browser(f, `${BASE}/pairing-grants`, { method: 'POST',
      body: { categories: [TYPE], name: 'No retained adoption' } }), 409, 'IMPORT_SOURCE_POLICY_UNKNOWN');
    error(await browser(f, `${BASE}/${state.connectors[0].id}`, { method: 'DELETE' }), 409, 'IMPORT_SOURCE_POLICY_UNKNOWN');
    assert.deepEqual(fs.readFileSync(file(f.home, 'health-connect.json')), bytes);
  } finally { await close(f); }
});

test('STOPPED_CUSTODY03 a replacement current credential cannot revoke the prior managed source', async () => {
  const f = await setup();
  try {
    const { paired } = await firstPair(f);
    const before = sqlSnapshot(f.home), catalogue = fs.readFileSync(file(f.home, 'health-connect-policy.json'));
    await f.server.kill(); f.server = null;
    const replacement = fakeAuthState(Object.keys(f.owner.credentials.users)[0]);
    replacement.credentials.users[Object.keys(replacement.credentials.users)[0]].credentials[0].publicKey =
      Buffer.from('independently replaced registered key').toString('base64');
    assert.notEqual(replacement.credentialId, f.owner.credentialId);
    fs.writeFileSync(file(f.home, 'webauthn.json'), JSON.stringify(replacement.credentials));
    fs.writeFileSync(path.join(f.home, 'sessions', 'webauthn.json'), JSON.stringify(replacement.sessions));
    f.owner = replacement; f.server = await spawnServer(f.home, ENV); await authenticated(f);
    error(await browser(f, `${BASE}/${paired.connectorId}`, { method: 'DELETE' }), 403, 'scope-mismatch');
    assert.deepEqual(sqlSnapshot(f.home), before);
    assert.deepEqual(fs.readFileSync(file(f.home, 'health-connect-policy.json')), catalogue);
  } finally { await close(f); }
});

test('STOPPED_CUSTODY04 copied catalogue without its owning SQL cannot establish managed custody', async () => {
  const f = await setup(); let copied;
  try {
    await firstPair(f);
    const catalogue = fs.readFileSync(file(f.home, 'health-connect-policy.json'));
    copied = { owner: f.owner, home: createSandbox({ credentials: f.owner.credentials, sessions: f.owner.sessions }), server: null };
    fs.writeFileSync(file(copied.home, 'health-connect-policy.json'), catalogue); // Metadata only: never SQL/capability/credential birth.
    copied.server = await spawnServer(copied.home, ENV); await authenticated(copied);
    error(await browser(copied, BASE), 409, 'IMPORT_SOURCE_POLICY_UNKNOWN');
    assert.deepEqual(fs.readFileSync(file(copied.home, 'health-connect-policy.json')), catalogue);
  } finally { if (copied) await close(copied); await close(f); }
});
