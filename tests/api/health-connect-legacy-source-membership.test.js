// SPDX-License-Identifier: AGPL-3.0-only
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createSandbox, cleanupSandbox, spawnProducerServer,
  spawnCandidateServer: spawnServer } = require('../helpers/legacy-health-producer');
const { req, fakeAuthState, waitFor } = require('../helpers/sandbox');
const { migrateNativeV2 } = require('../../lib/health-connect/guard-migration');
const vectors = require('../fixtures/health-connect/durable-history-independent-vectors.json');

const ORIGIN = 'https://legacy-membership.example.test';
const BASE = '/api/connectors/health-connect';
const TYPE = 'BodyWaterMassRecord';
const OWNER = 'legacy-member';
const UNKNOWN = 'IMPORT_SOURCE_POLICY_UNKNOWN';
const ENV = {
  HEALTH_ORIGIN: ORIGIN, HEALTH_RP_ID: 'legacy-membership.example.test',
  AGENT_API_TOKEN: '', KLEBB_ADMIN_TOKEN: '', KLEBB_CLOUD: '', KLEBB_DEMO: '',
  HEALTH_DATA_DIR: '', HEALTH_REPORTS_DIR: '', HEALTH_AUTO_EXPORT_DIR: '',
  HEALTH_SESSIONS_DIR: '', HEALTH_CREDENTIALS_DIR: '', HEALTH_ARCHIVE_DIR: '',
  HEALTH_CONFIG_PATH: '', HEALTH_DB_DIR: '', HEALTH_DB_FILE: '', HEALTH_CHAT_DIR: '',
  HEALTH_USER_FILE: '', HEALTH_NOTIFICATIONS_STATE_FILE: '', HEALTH_INBOX_DIR: '',
  HEALTH_KEYS_DIR: '', HEALTH_VAPID_FILE: '', HEALTH_PUSH_SUBSCRIPTIONS_FILE: '',
  HEALTH_AUTO_EXPORT_TOKEN: '', NODE_OPTIONS: '',
};
const legacyFile = home => path.join(home, 'credentials', 'health-connect.json');
const policyFile = home => path.join(home, 'credentials', 'health-connect-policy.json');
const dbFile = home => path.join(home, 'db', 'klebb.db');
const credentialFile = home => path.join(home, 'credentials', 'webauthn.json');
const sentinelFile = home => path.join(home, 'data', 'legacy-membership-sentinel.json');
const headers = paired => ({
  Authorization: `Bearer ${paired.credential}`, 'Klebb-Health-Protocol': '1',
  'Klebb-Health-Generation': '1', 'Klebb-Health-Restore-Epoch': paired.restoreEpoch,
});
const digest = text => 'sha256:' + crypto.createHash('sha256').update(text, 'utf8').digest('hex');

function actor(label, key) {
  const result = fakeAuthState(label);
  result.credentials.users[label].credentials[0].publicKey =
    Buffer.from(key, 'utf8').toString('base64');
  return result;
}

function history(home) {
  const db = new DatabaseSync(dbFile(home), { readOnly: true });
  try {
    db.exec('BEGIN');
    const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema "
      + "WHERE name LIKE 'health_%' ORDER BY type,name").all().map(row => ({ ...row }));
    const tables = schema.filter(row => row.type === 'table').map(row => row.name);
    const rows = Object.fromEntries(tables.map(name => [name,
      db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all().map(row => ({ ...row }))]));
    db.exec('COMMIT');
    return { schema, rows };
  } finally { db.close(); }
}

function migrateFixture(home) {
  const db = new DatabaseSync(dbFile(home));
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; '
      + 'PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
    migrateNativeV2(db, dbFile(home), { windowsDevelopment: process.platform === 'win32' });
    db.exec('COMMIT');
    assert.equal(db.prepare('SELECT version FROM health_schema_version').get().version, 2);
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  } finally { db.close(); }
}

async function browserRequest(data, pathname, options = {}, selected = data.current) {
  return req(data.server.baseUrl, pathname, {
    cookie: selected.cookie, ...options,
    headers: { Origin: ORIGIN, ...options.headers },
  });
}

async function nativeControl(data) {
  const capabilities = await req(data.server.baseUrl, `${BASE}/v1/capabilities`, {
    headers: headers(data.paired),
  });
  assert.equal(capabilities.status, 200, capabilities.body);
  assert.equal(capabilities.json.kind, 'capabilities');
  assert.equal(capabilities.json.sourceStoreId, data.paired.sourceStoreId);
  assert.equal(capabilities.json.restoreEpoch, data.paired.restoreEpoch);
  assert.deepEqual(capabilities.json.streams, {
    [TYPE]: { generation: '1', acknowledgedSequence: '1' },
  });
  const status = await req(data.server.baseUrl, `${BASE}/v1/streams/${TYPE}/status`, {
    headers: headers(data.paired),
  });
  assert.equal(status.status, 200, status.body);
  assert.equal(status.json.acknowledgedSequence, '1');
}

async function fixture({ replacement = true, v2 = false } = {}) {
  const owner = actor(OWNER, 'original retained-owner fixture public key');
  const other = actor('unrelated-member', 'unrelated fixture public key');
  const home = createSandbox({
    credentials: { users: { ...owner.credentials.users, ...other.credentials.users } },
    sessions: { ...owner.sessions, ...other.sessions },
    seed: { 'legacy-membership-sentinel.json': {
      $schema: 'klebb.datafile.v1', meta: { id: 'legacy-membership-sentinel' },
      data: [{ date: '2026-01-02', count: 17 }],
    } },
  });
  const data = { home, owner, other, current: owner, server: null, paired: null };
  try {
    data.server = await spawnProducerServer(home, ENV);
    const empty = await browserRequest(data, BASE);
    assert.equal(empty.status, 200, empty.body);
    assert.deepEqual(empty.json.connectors, [], 'genuinely empty legacy default remains readable');
    const approved = await browserRequest(data, `${BASE}/pairing-grants`, {
      method: 'POST', body: { categories: [TYPE], name: 'Fresh legacy fixture' },
    });
    assert.equal(approved.status, 201, approved.body);
    assert.equal(approved.json.kind, 'pairing-grant');
    const exchanged = await req(data.server.baseUrl, `${BASE}/v1/pairing/exchange`, {
      method: 'POST', body: {
        version: 1, kind: 'pairing-exchange', tenantId: approved.json.tenantId,
        instanceId: approved.json.instanceId, sourceStoreId: approved.json.sourceStoreId,
        grant: approved.json.grant, installationId: 'legacy-membership-installation',
        categories: [TYPE],
      },
    });
    assert.equal(exchanged.status, 200, exchanged.body);
    assert.equal(exchanged.json.kind, 'paired');
    data.paired = exchanged.json;
    const payload = JSON.parse(vectors.vectors.find(item => item.id === 'initial-raw-only').payloadJson);
    payload.binding = {
      tenantId: data.paired.tenantId, instanceId: data.paired.instanceId,
      sourceStoreId: data.paired.sourceStoreId, installationId: data.paired.installationId,
      generation: '1', restoreEpoch: data.paired.restoreEpoch,
    };
    for (const change of payload.changes) {
      change.identity.tenantId = payload.binding.tenantId;
      change.identity.sourceStoreId = payload.binding.sourceStoreId;
    }
    const payloadJson = JSON.stringify(payload);
    const committed = await req(data.server.baseUrl, `${BASE}/v1/batches`, {
      method: 'POST', headers: headers(data.paired),
      body: { version: 1, kind: 'batch', payloadJson, payloadDigest: digest(payloadJson) },
    });
    assert.equal(committed.status, 200, committed.body);
    assert.equal(committed.json.kind, 'durable-receipt');
    assert.equal(committed.json.sequence, '1');
    await nativeControl(data);
    await waitFor(() => {
      const db = new DatabaseSync(dbFile(home), { readOnly: true });
      try {
        if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='health_source_index_state'").get()) return false;
        return db.prepare('SELECT state FROM health_source_index_state WHERE source_store_id=?')
          .get(data.paired.sourceStoreId)?.state === 'current';
      } finally { db.close(); }
    }, { what: 'existing source index settles before the retained-history oracle' });
    await data.server.kill(); data.server = null;
    if (v2) migrateFixture(home);
    const before = history(home);
    assert.equal(before.rows.health_records.length, 2);
    assert.equal(before.rows.health_tombstones.length, 1);
    assert.equal(before.rows.health_batch_receipts.length, 1);
    data.legacyBytes = fs.readFileSync(legacyFile(home));
    assert.equal(JSON.parse(data.legacyBytes).version, 1);
    assert.equal(fs.existsSync(policyFile(home)), false);
    data.sentinelBytes = fs.readFileSync(sentinelFile(home));
    if (replacement) {
      data.current = actor(OWNER, 'replacement retained-owner fixture public key');
      assert.notEqual(data.current.credentialId, owner.credentialId);
      assert.notEqual(data.current.credentials.users[OWNER].credentials[0].publicKey,
        owner.credentials.users[OWNER].credentials[0].publicKey);
      fs.writeFileSync(credentialFile(home), JSON.stringify({
        users: { ...data.current.credentials.users, ...other.credentials.users },
      }));
      fs.writeFileSync(path.join(home, 'sessions', 'webauthn.json'),
        JSON.stringify({ ...data.current.sessions, ...other.sessions }));
    }
    data.credentialsBytes = fs.readFileSync(credentialFile(home));
    data.server = await spawnServer(home, ENV);
    const authenticated = await browserRequest(data, '/auth/status');
    assert.equal(authenticated.status, 200, authenticated.body);
    assert.equal(authenticated.json.authenticated, true);
    const unrelated = await browserRequest(data, BASE, {}, other);
    assert.equal(unrelated.status, 200, unrelated.body);
    assert.deepEqual(unrelated.json.connectors, []);
    await nativeControl(data);
    data.historyBefore = history(home);
    assert.deepEqual(data.historyBefore, before, 'healthy cold setup preserves all retained health tables');
    return data;
  } catch (error) {
    try {
      if (data.server) await data.server.kill();
      cleanupSandbox(home);
    } catch (closureError) {
      throw new AggregateError([error, closureError], 'Fixture failed; owned home retained');
    }
    throw error;
  }
}

async function close(data) {
  if (data.server) await data.server.kill();
  cleanupSandbox(data.home);
}

function unchanged(data) {
  assert.deepEqual(fs.readFileSync(legacyFile(data.home)), data.legacyBytes);
  assert.deepEqual(fs.readFileSync(credentialFile(data.home)), data.credentialsBytes);
  assert.deepEqual(fs.readFileSync(sentinelFile(data.home)), data.sentinelBytes);
  assert.equal(fs.existsSync(policyFile(data.home)), false);
  assert.deepEqual(history(data.home), data.historyBefore);
}

function unknown(response, projection = false) {
  assert.equal(response.status, 409, response.body);
  assert.deepEqual(response.json, projection
    ? { target: 'source-index-v1', code: UNKNOWN, retryable: false }
    : { version: 1, kind: 'error', code: UNKNOWN, retryable: false });
}

test('LEGACYMEMBER01 fresh legacy pairing and native bearer controls preserve the existing defaults', async () => {
  const data = await fixture();
  try { await nativeControl(data); unchanged(data); }
  finally { await close(data); }
});

test('LEGACYMEMBER02 a cold current member alone does not prove original V1 owner continuity', async () => {
  const data = await fixture({ replacement: false });
  try {
    unknown(await browserRequest(data, BASE));
    unchanged(data); await nativeControl(data); unchanged(data);
  } finally { await close(data); }
});

test('LEGACYMEMBER03 a current replacement with a reused label cannot list retained V1 ownership', async () => {
  const data = await fixture();
  try {
    unknown(await browserRequest(data, BASE));
    unchanged(data); await nativeControl(data); unchanged(data);
  } finally { await close(data); }
});

test('LEGACYMEMBER04 a replacement cannot revoke retained V1 and an unrelated owner still refuses', async () => {
  const data = await fixture();
  try {
    const pathname = `${BASE}/${data.paired.connectorId}`;
    const other = await browserRequest(data, pathname, { method: 'DELETE' }, data.other);
    assert.equal(other.status, 403, other.body);
    assert.equal(other.json.code, 'scope-mismatch');
    unchanged(data);
    unknown(await browserRequest(data, pathname, { method: 'DELETE' }));
    unchanged(data); await nativeControl(data); unchanged(data);
  } finally { await close(data); }
});

test('LEGACYMEMBER05 unmanaged pairing cannot adopt retained ownership through a replacement label', async () => {
  const data = await fixture();
  try {
    unknown(await browserRequest(data, `${BASE}/pairing-grants`, {
      method: 'POST', body: { categories: [TYPE], name: 'Retained ownership must not be adopted' },
    }));
    unchanged(data); await nativeControl(data); unchanged(data);
  } finally { await close(data); }
});

for (const [name, pathname, method, projection, makeBody, v2] of [
  ['LEGACYMEMBER06 retained projection status requires original credential continuity',
    `${BASE}/projections/status`, 'GET', true, () => null, false],
  ['LEGACYMEMBER07 retained projection rebuild requires original credential continuity',
    `${BASE}/projections/rebuild`, 'POST', true, () => ({}), false],
  ['LEGACYMEMBER08 typed deletion preview cannot adopt a retained owner label',
    `${BASE}/deletions/preview`, 'POST', false, data => ({
      sourceStoreId: data.paired.sourceStoreId,
      identities: [{ recordType: TYPE, nativeRecordId: 'raw-a' }],
    }), false],
  ['LEGACYMEMBER09 typed apply refuses unknown owner authority before a stale revision',
    `${BASE}/deletions/apply`, 'POST', false, data => ({
      sourceStoreId: data.paired.sourceStoreId,
      identities: [{ recordType: TYPE, nativeRecordId: 'raw-a' }],
      revision: 'sha256:' + '0'.repeat(64),
    }), true],
  ['LEGACYMEMBER10 selection preview cannot adopt a retained owner label',
    `${BASE}/deletions/selection-preview`, 'POST', false, data => ({
      sourceStoreIds: [data.paired.sourceStoreId], recordTypes: [TYPE],
      period: null, cutoff: null,
    }), false],
]) {
  test(name, async () => {
    const data = await fixture({ v2 });
    try {
      unknown(await browserRequest(data, pathname, { method, body: makeBody(data) }), projection);
      unchanged(data); await nativeControl(data); unchanged(data);
    } finally { await close(data); }
  });
}
