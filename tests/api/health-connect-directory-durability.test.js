// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const product = path.resolve(__dirname, '../..');
const { createSandbox, cleanupSandbox, spawnServer, req, fakeAuthState } =
  require(path.join(product, 'tests/helpers/sandbox'));
const ORIGIN = 'https://owner-a.klebb.app';
const BASE = '/api/connectors/health-connect';
const ENV = {
  HEALTH_ORIGIN: ORIGIN, HEALTH_RP_ID: 'owner-a.klebb.app',
  AGENT_API_TOKEN: '', KLEBB_ADMIN_TOKEN: '', KLEBB_CLOUD: '', KLEBB_DEMO: '',
  HEALTH_DATA_DIR: '', HEALTH_REPORTS_DIR: '', HEALTH_AUTO_EXPORT_DIR: '',
  HEALTH_SESSIONS_DIR: '', HEALTH_CREDENTIALS_DIR: '', HEALTH_ARCHIVE_DIR: '',
  HEALTH_CONFIG_PATH: '', HEALTH_DB_DIR: '', HEALTH_DB_FILE: '', HEALTH_CHAT_DIR: '',
  HEALTH_USER_FILE: '', HEALTH_NOTIFICATIONS_STATE_FILE: '', HEALTH_INBOX_DIR: '',
  HEALTH_KEYS_DIR: '', HEALTH_VAPID_FILE: '', HEALTH_PUSH_SUBSCRIPTIONS_FILE: '',
  HEALTH_AUTO_EXPORT_TOKEN: '', NODE_OPTIONS: '',
};
const stateFile = home => path.join(home, 'credentials', 'health-connect.json');
const state = home => JSON.parse(fs.readFileSync(stateFile(home), 'utf8'));
const digest = value => 'sha256:' + crypto.createHash('sha256').update(value, 'utf8').digest('hex');
test('POSIX directory flush failure discloses no credential while preserving committed single use', {
  skip: process.platform === 'win32' ? 'Windows Node cannot open the required directory descriptor' : false,
}, async () => {
  const owner = fakeAuthState('owner-a');
  const home = createSandbox({ credentials: owner.credentials, sessions: owner.sessions });
  let server;
  try {
    server = await spawnServer(home, ENV);
    const issued = await req(server.baseUrl, `${BASE}/pairing-grants`, {
      method: 'POST', cookie: owner.cookie, headers: { Origin: ORIGIN },
      body: { categories: ['StepsRecord'], name: 'Directory flush synthetic phone' },
    });
    assert.equal(issued.status, 201);
    const approved = issued.json;
    await server.kill(); server = null;
    const before = state(home);
    assert.equal(before.grants.length, 1);
    assert.equal(before.grants[0].verifier, digest(approved.grant));
    assert.equal(before.grants[0].consumedAt, null);
    assert.deepEqual(before.connectors, []);
    const exchange = {
      version: 1, kind: 'pairing-exchange', tenantId: approved.tenantId,
      instanceId: approved.instanceId, grant: approved.grant,
      sourceStoreId: approved.sourceStoreId, installationId: 'directory-flush-installation',
      categories: ['StepsRecord'],
    };
    const marker = path.join(home, 'directory-fault-fired.txt');
    server = await spawnServer(home, {
      ...ENV,
      NODE_OPTIONS: `--require "${path.join(__dirname,
        '../helpers/health-connect-authority-fault-preload.cjs').replaceAll('\\', '/')}"`,
      INDEPENDENT_AUTHORITY_FILE: stateFile(home),
      INDEPENDENT_FAULT_MARKER: marker,
      INDEPENDENT_FAULT: 'directory-fsync-eio',
    });
    const refused = await req(server.baseUrl, `${BASE}/v1/pairing/exchange`, {
      method: 'POST', body: exchange,
    });
    assert.equal(fs.readFileSync(marker, 'utf8'), 'directory-fsync-eio', 'real directory fsync was attempted');
    assert.equal(refused.status, 503);
    assert.equal(refused.json.code, 'storage-unavailable');
    assert.equal(refused.json.credential, undefined);
    assert.equal(refused.json.grant, undefined);
    assert.equal(refused.body.includes(approved.grant), false);
    await server.kill(); server = null;
    const committed = state(home);
    assert.equal(committed.grants.length, 1);
    assert.equal(typeof committed.grants[0].consumedAt, 'string');
    assert.deepEqual({ ...committed.grants[0], consumedAt: null }, before.grants[0]);
    assert.equal(committed.connectors.length, 1);
    const connector = committed.connectors[0];
    assert.equal(connector.ownerId, 'owner-a');
    assert.equal(connector.sourceStoreId, approved.sourceStoreId);
    assert.equal(connector.restoreEpoch, approved.restoreEpoch);
    assert.equal(connector.installationId, 'directory-flush-installation');
    assert.deepEqual(connector.categories, ['StepsRecord']);
    assert.deepEqual(connector.generations, { StepsRecord: '1' });
    assert.equal(connector.revokedAt, null);
    assert.equal(fs.readdirSync(path.dirname(stateFile(home)))
      .filter(name => name.startsWith('health-connect.json.') && name.endsWith('.tmp')).length, 0);
    server = await spawnServer(home, ENV);
    const replay = await req(server.baseUrl, `${BASE}/v1/pairing/exchange`, {
      method: 'POST', body: exchange,
    });
    assert.equal(replay.status, 409);
    assert.equal(replay.json.code, 'conflict');
    assert.equal(replay.json.credential, undefined);
    assert.deepEqual(state(home), committed, 'the indeterminate first response cannot mint a second authority');
    const listed = await req(server.baseUrl, BASE, { cookie: owner.cookie });
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.json.connectors.map(item => item.id), [connector.id]);
    const revoked = await req(server.baseUrl, `${BASE}/${connector.id}`, {
      method: 'DELETE', cookie: owner.cookie, headers: { Origin: ORIGIN },
    });
    assert.equal(revoked.status, 200);
    assert.deepEqual(revoked.json, { revoked: true });
    assert.ok(state(home).connectors[0].revokedAt, 'owner can retire undisclosed orphan authority');
  } finally {
    if (server) await server.kill();
    cleanupSandbox(home);
  }
});
