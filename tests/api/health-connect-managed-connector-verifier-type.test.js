// SPDX-License-Identifier: AGPL-3.0-only
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { createSandbox, cleanupSandbox, spawnServer, req, fakeAuthState } =
  require('../helpers/sandbox');

const BASE = '/api/connectors/health-connect';
const TYPE = 'StepsRecord';
const ORIGIN = 'https://synthetic-custody.example.test';
const ENV = {
  HEALTH_ORIGIN: ORIGIN, HEALTH_RP_ID: 'synthetic-custody.example.test',
  AGENT_API_TOKEN: '', KLEBB_ADMIN_TOKEN: '', KLEBB_CLOUD: '', KLEBB_DEMO: '',
  HEALTH_DATA_DIR: '', HEALTH_REPORTS_DIR: '', HEALTH_AUTO_EXPORT_DIR: '',
  HEALTH_SESSIONS_DIR: '', HEALTH_CREDENTIALS_DIR: '', HEALTH_ARCHIVE_DIR: '',
  HEALTH_CONFIG_PATH: '', HEALTH_DB_DIR: '', HEALTH_DB_FILE: '', HEALTH_CHAT_DIR: '',
  HEALTH_USER_FILE: '', HEALTH_NOTIFICATIONS_STATE_FILE: '', HEALTH_INBOX_DIR: '',
  HEALTH_KEYS_DIR: '', HEALTH_VAPID_FILE: '', HEALTH_PUSH_SUBSCRIPTIONS_FILE: '',
  HEALTH_AUTO_EXPORT_TOKEN: '', NODE_OPTIONS: '',
};
const digest = value => 'sha256:' + crypto.createHash('sha256').update(value).digest('hex');
const policyPath = home => path.join(home, 'credentials', 'health-connect-policy.json');
const legacyPath = home => path.join(home, 'credentials', 'health-connect.json');

function historySnapshot(home) {
  const db = new DatabaseSync(path.join(home, 'db', 'klebb.db'), { readOnly: true });
  try {
    db.exec('BEGIN');
    const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema " +
      "WHERE lower(name) GLOB 'health_*' OR lower(tbl_name) GLOB 'health_*' " +
      'ORDER BY type,name').all().map(row => ({ ...row }));
    const tables = {};
    for (const row of schema.filter(item => item.type === 'table')) {
      assert.match(row.name, /^health_[a-z0-9_]+$/);
      tables[row.name] = db.prepare(`SELECT * FROM "${row.name}" ORDER BY rowid`).all()
        .map(item => ({ ...item }));
    }
    return { schema, tables };
  } finally {
    db.close();
  }
}

test('managed connector verifier arrays refuse without changing catalogue or history', async () => {
  const owner = fakeAuthState('synthetic-managed-connector-member');
  const home = createSandbox({ credentials: owner.credentials, sessions: owner.sessions });
  let server;
  try {
    server = await spawnServer(home, ENV);
    const approved = await req(server.baseUrl, `${BASE}/pairing-grants`, {
      method: 'POST', cookie: owner.cookie, headers: { Origin: ORIGIN },
      body: { categories: [TYPE], name: 'Synthetic connector type check' },
    });
    assert.equal(approved.status, 201, 'healthy real grant before any corruption');
    assert.equal(approved.json.kind, 'pairing-grant');
    assert.equal(typeof approved.json.grant, 'string');
    const paired = await req(server.baseUrl, `${BASE}/v1/pairing/exchange`, {
      method: 'POST', body: {
        version: 1, kind: 'pairing-exchange', tenantId: approved.json.tenantId,
        instanceId: approved.json.instanceId, sourceStoreId: approved.json.sourceStoreId,
        grant: approved.json.grant, installationId: 'synthetic-managed-type-installation',
        categories: [TYPE],
      },
    });
    assert.equal(paired.status, 200, 'healthy real exchange before any corruption');
    assert.equal(paired.json.kind, 'paired');
    assert.equal(typeof paired.json.credential, 'string');
    assert.match(paired.json.credential, /^klebb_hc1_[A-Za-z0-9_-]{43}$/);
    const listed = await req(server.baseUrl, BASE, { cookie: owner.cookie });
    assert.equal(listed.status, 200, 'healthy real list before any corruption');
    assert.equal(listed.json.kind, 'connector-list');
    assert.deepEqual(listed.json.connectors.map(item => item.id), [paired.json.connectorId]);
    await server.kill(); server = null;

    const catalogue = JSON.parse(fs.readFileSync(policyPath(home), 'utf8'));
    assert.equal(catalogue.version, 2);
    assert.equal(catalogue.recoveryRequired, false);
    const userId = Object.keys(owner.credentials.users)[0];
    const registered = owner.credentials.users[userId].credentials
      .find(item => item.id === owner.credentialId);
    const member = { userId, credentialId: owner.credentialId,
      publicKeySha256: digest(Buffer.from(registered.publicKey, 'base64')) };
    const principals = catalogue.principals.filter(item =>
      item.members.some(saved => saved.userId === member.userId &&
        saved.credentialId === member.credentialId && saved.publicKeySha256 === member.publicKeySha256));
    assert.equal(principals.length, 1, 'actual registered member owns the managed principal');
    const namespaces = catalogue.namespaces.filter(entry =>
      entry.ownerId === principals[0].ownerId &&
      entry.state.tenantId === paired.json.tenantId &&
      entry.state.instanceId === paired.json.instanceId &&
      entry.state.restoreEpoch === paired.json.restoreEpoch);
    assert.equal(namespaces.length, 1, 'select the actual namespace returned by exchange');
    const connectors = namespaces[0].state.connectors.filter(item =>
      item.id === paired.json.connectorId && item.sourceStoreId === paired.json.sourceStoreId);
    assert.equal(connectors.length, 1, 'select the actual connector returned by exchange');
    const connector = connectors[0];
    assert.equal(connector.ownerId, principals[0].ownerId);
    assert.equal(typeof connector.credentialVerifier, 'string');
    assert.equal(connector.credentialVerifier, digest(paired.json.credential));
    const historyBefore = historySnapshot(home);
    assert.ok(historyBefore.tables.health_source_policy_sources.some(row =>
      row.source_store_id === connector.sourceStoreId), 'healthy real SQL enrolment exists');
    const legacyBefore = fs.readFileSync(legacyPath(home));

    // A JSON array remains malformed even when its string coercion is a valid digest.
    connector.credentialVerifier = [connector.credentialVerifier];
    fs.writeFileSync(policyPath(home), JSON.stringify(catalogue));
    const malformedBefore = fs.readFileSync(policyPath(home));
    assert.deepEqual(historySnapshot(home), historyBefore, 'only the selected descriptor was corrupted');
    server = await spawnServer(home, ENV);
    const refused = await req(server.baseUrl, BASE, { cookie: owner.cookie });
    assert.deepEqual(fs.readFileSync(policyPath(home)), malformedBefore,
      'refusal preserves the entire corrupted descriptor rather than repairing it');
    assert.deepEqual(fs.readFileSync(legacyPath(home)), legacyBefore, 'retained V1 bytes stay exact');
    assert.deepEqual(historySnapshot(home), historyBefore, 'history and SQL policy stay exact');
    assert.equal(refused.status, 503, 'malformed persisted connector verifier must fail closed');
    assert.deepEqual(refused.json, {
      version: 1, kind: 'error', code: 'storage-unavailable', retryable: true,
    });
    assert.equal(refused.body.includes(paired.json.credential), false, 'no credential in response');
    assert.equal(refused.body.includes(approved.json.grant), false, 'no grant in response');
  } finally {
    if (server) await server.kill();
    cleanupSandbox(home);
  }
});
