// SPDX-License-Identifier: AGPL-3.0-only
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createSandbox, cleanupSandbox, spawnProducerServer: spawnServer,
  spawnCandidateServer } = require('../helpers/legacy-health-producer');
// This file uses the helper's watched factory; the fresh V2 cases stay separate.
const { req, fakeAuthState } = require('../helpers/sandbox');

const ORIGIN = 'https://owner-a.klebb.app';
const BASE = '/api/connectors/health-connect';
const GRANTS = `${BASE}/pairing-grants`;
const EXCHANGE = `${BASE}/v1/pairing/exchange`;
const CAPABILITIES = `${BASE}/v1/capabilities`;
const STATUS = `${BASE}/v1/streams/StepsRecord/status`;
const NEW_EPOCH = '22222222-2222-4222-8222-222222222222';
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
const authorityPath = home => path.join(home, 'credentials', 'health-connect.json');
const state = home => JSON.parse(fs.readFileSync(authorityPath(home), 'utf8'));
const hash = text => 'sha256:' + crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const native = credential => ({
  Authorization: `Bearer ${credential}`, 'Klebb-Health-Protocol': '1',
});
function preconditions(paired, generation = '1', epoch = paired.restoreEpoch) {
  return { ...native(paired.credential),
    'Klebb-Health-Generation': generation, 'Klebb-Health-Restore-Epoch': epoch };
}
function failure(response, status, code) {
  assert.equal(response.status, status, response.body);
  assert.equal(response.json?.code, code);
}
function assertStatus(response, paired, generation) {
  assert.equal(response.status, 200, response.body);
  assert.equal(response.json.version, 1);
  assert.equal(response.json.kind, 'stream-status');
  assert.equal(response.json.recordType, 'StepsRecord');
  assert.equal(response.json.generation, generation);
  assert.equal(response.json.acknowledgedSequence, '0');
  assert.deepEqual(response.json.binding, {
    tenantId: paired.tenantId, instanceId: paired.instanceId,
    sourceStoreId: paired.sourceStoreId, installationId: paired.installationId,
    generation, restoreEpoch: paired.restoreEpoch,
  });
  assert.equal(response.body.includes(paired.credential), false);
}
function fixture() {
  const owner = fakeAuthState('owner-a');
  const home = createSandbox({ credentials: owner.credentials, sessions: owner.sessions });
  return { owner, home };
}
async function grant(server, owner) {
  const result = await req(server.baseUrl, GRANTS, {
    method: 'POST', cookie: owner.cookie, headers: { Origin: ORIGIN },
    body: { categories: ['StepsRecord'], name: 'Fence test phone' },
  });
  assert.equal(result.status, 201, result.body);
  return result.json;
}
function frame(approved) {
  return { version: 1, kind: 'pairing-exchange',
    tenantId: approved.tenantId, instanceId: approved.instanceId, grant: approved.grant,
    installationId: 'fence-installation-a', sourceStoreId: approved.sourceStoreId,
    categories: ['StepsRecord'] };
}
async function pair(server, owner) {
  const approved = await grant(server, owner);
  const result = await req(server.baseUrl, EXCHANGE, { method: 'POST', body: frame(approved) });
  assert.equal(result.status, 200, result.body);
  return { paired: result.json, approved };
}
function captureEnv(home) {
  const preload = path.resolve(__dirname, '../helpers/health-connect-startup-capture.js')
    .replaceAll('\\', '/');
  return { ...ENV, NODE_OPTIONS: `--require "${preload}"`,
    KLEBB_TEST_AUTHORITY_LOG_PATH: path.join(home, 'authority-startup-capture.log') };
}

// The original producer owns this complete V1 authority domain. Check it
// independently before changing any fence; a V2 catalogue is a different scope.
function originalAuthority(home, approved, paired = null) {
  const entry = fs.lstatSync(authorityPath(home));
  assert.equal(entry.isFile(), true);
  assert.equal(entry.isSymbolicLink(), false);
  assert.equal(fs.existsSync(path.join(home, 'credentials', 'health-connect-policy.json')), false,
    'authentic retained V1 fixture has no managed policy catalogue');
  const saved = state(home);
  assert.equal(saved.grants.length, 1);
  assert.equal(saved.grants.filter(item => item.verifier === hash(approved.grant)).length, 1,
    'full issued grant digest identifies exactly one saved authority entry');
  assert.equal(saved.connectors.length, paired ? 1 : 0);
  if (paired) assert.equal(saved.connectors.filter(item =>
    item.credentialVerifier === hash(paired.credential)).length, 1,
  'full paired bearer digest identifies exactly one saved connector');
  const timestamp = value => {
    assert.equal(typeof value, 'string');
    assert.equal(new Date(value).toISOString(), value);
    return value;
  };
  assert.deepEqual(saved, {
    version: 1, tenantId: approved.tenantId, instanceId: approved.instanceId,
    restoreEpoch: approved.restoreEpoch,
    grants: [{ verifier: hash(approved.grant), ownerId: 'owner-a',
      instanceId: approved.instanceId, sourceStoreId: approved.sourceStoreId,
      restoreEpoch: approved.restoreEpoch, categories: ['StepsRecord'],
      name: 'Fence test phone', expiresAt: approved.expiresAt,
      consumedAt: paired ? timestamp(saved.grants[0].consumedAt) : null }],
    connectors: paired ? [{ id: paired.connectorId,
      credentialVerifier: hash(paired.credential), ownerId: 'owner-a',
      installationId: paired.installationId, sourceStoreId: approved.sourceStoreId,
      restoreEpoch: approved.restoreEpoch, categories: ['StepsRecord'],
      generations: { StepsRecord: '1' }, name: 'Fence test phone',
      createdAt: timestamp(saved.connectors[0].createdAt), revokedAt: null }] : [],
  });
  if (paired) {
    assert.equal(paired.tenantId, approved.tenantId);
    assert.equal(paired.instanceId, approved.instanceId);
    assert.equal(paired.restoreEpoch, approved.restoreEpoch);
    assert.equal(paired.sourceStoreId, approved.sourceStoreId);
    assert.equal(paired.installationId, 'fence-installation-a');
    assert.deepEqual(paired.categories, ['StepsRecord']);
    assert.equal(paired.streams.StepsRecord.generation, '1');
  }
  return saved;
}

test('cold server generation change fences old and future callers without client-driven upgrade', async () => {
  const data = fixture();
  let server;
  try {
    server = await spawnServer(data.home, ENV);
    const { paired, approved } = await pair(server, data.owner);
    assertStatus(await req(server.baseUrl, STATUS, {
      headers: preconditions(paired),
    }), paired, '1');
    await server.kill(); server = null;
    const changed = originalAuthority(data.home, approved, paired);
    assert.equal(changed.connectors.length, 1);
    const connector = changed.connectors.find(item => item.credentialVerifier === hash(paired.credential));
    assert.ok(connector, 'independently hashed full bearer identifies the one connector');
    assert.deepEqual(connector.generations, { StepsRecord: '1' });
    connector.generations.StepsRecord = '2';
    fs.writeFileSync(authorityPath(data.home), JSON.stringify(changed), { mode: 0o600 });
    server = await spawnCandidateServer(data.home, ENV);
    for (const generation of ['1', '3']) {
      failure(await req(server.baseUrl, STATUS, {
        headers: preconditions(paired, generation),
      }), 409, 'binding-mismatch');
    }
    assertStatus(await req(server.baseUrl, STATUS, {
      headers: preconditions(paired, '2'),
    }), paired, '2');
    await server.kill(); server = null;
    assert.deepEqual(state(data.home), changed, 'preconditions cannot set server generation/frontier');
  } finally {
    if (server) await server.kill();
    cleanupSandbox(data.home);
  }
});

test('cold epoch rotation invalidates pre-restore connector despite a current-epoch echo', async () => {
  const data = fixture();
  let server;
  try {
    server = await spawnServer(data.home, ENV);
    const { paired, approved } = await pair(server, data.owner);
    assertStatus(await req(server.baseUrl, STATUS, {
      headers: preconditions(paired),
    }), paired, '1');
    await server.kill(); server = null;
    const changed = originalAuthority(data.home, approved, paired);
    assert.notEqual(changed.restoreEpoch, NEW_EPOCH);
    changed.restoreEpoch = NEW_EPOCH;
    fs.writeFileSync(authorityPath(data.home), JSON.stringify(changed), { mode: 0o600 });
    server = await spawnCandidateServer(data.home, captureEnv(data.home));
    for (const epoch of [paired.restoreEpoch, NEW_EPOCH]) {
      failure(await req(server.baseUrl, STATUS, {
        headers: preconditions(paired, '1', epoch),
      }), 401, 'revoked');
    }
    failure(await req(server.baseUrl, CAPABILITIES, {
      headers: native(paired.credential),
    }), 401, 'revoked');
    await server.kill(); server = null;
    assert.deepEqual(state(data.home), changed, 'old credential cannot rewrite itself into restored epoch');
    const logs = fs.readFileSync(path.join(data.home, 'authority-startup-capture.log'), 'utf8');
    assert.ok(logs.startsWith('[test authority capture installed]\n'));
    for (const marker of [paired.credential, hash(paired.credential)]) {
      assert.equal(logs.includes(marker), false, 'startup through shutdown must not disclose authority');
    }
  } finally {
    if (server) await server.kill();
    cleanupSandbox(data.home);
  }
});

test('pre-restore unconsumed pairing grant cannot create post-restore authority', async () => {
  const data = fixture();
  let server;
  try {
    server = await spawnServer(data.home, ENV);
    const approved = await grant(server, data.owner);
    await server.kill(); server = null;
    const changed = originalAuthority(data.home, approved);
    assert.equal(changed.grants.length, 1);
    assert.equal(changed.grants[0].verifier, hash(approved.grant));
    assert.equal(changed.grants[0].consumedAt, null);
    assert.deepEqual(changed.connectors, []);
    changed.restoreEpoch = NEW_EPOCH;
    fs.writeFileSync(authorityPath(data.home), JSON.stringify(changed), { mode: 0o600 });
    server = await spawnCandidateServer(data.home, ENV);
    failure(await req(server.baseUrl, EXCHANGE, {
      method: 'POST', body: frame(approved),
    }), 403, 'binding-mismatch');
    await server.kill(); server = null;
    assert.deepEqual(state(data.home), changed, 'refusal consumes no grant and creates no connector');
  } finally {
    if (server) await server.kill();
    cleanupSandbox(data.home);
  }
});
