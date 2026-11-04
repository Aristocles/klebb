// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {
  createSandbox, cleanupSandbox, spawnServer: spawnActualServer, req, fakeAuthState, waitFor,
} = require('../helpers/sandbox');
const { openZip } = require('../../lib/zip/read');

const ORIGIN = 'https://owner-a.klebb.app';
const BASE = '/api/connectors/health-connect';
const GRANTS = `${BASE}/pairing-grants`;
const EXCHANGE = `${BASE}/v1/pairing/exchange`;
const CAPABILITIES = `${BASE}/v1/capabilities`;
const ADMIN = 'synthetic-authority-admin-token';
const CHAT = 'synthetic-authority-chat-token';
const STEPS = ['StepsRecord'];
const ROWS = [{ date: '2026-01-02', count: 1234 }];
const CURSOR = 'synthetic-native-cursor-excluded-from-portable-authority';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ENV = {
  HEALTH_ORIGIN: ORIGIN,
  HEALTH_RP_ID: 'owner-a.klebb.app',
  AGENT_API_TOKEN: CHAT,
  KLEBB_ADMIN_TOKEN: ADMIN,
  KLEBB_CLOUD: '',
  KLEBB_DEMO: '',
  HEALTH_DATA_DIR: '',
  HEALTH_REPORTS_DIR: '',
  HEALTH_AUTO_EXPORT_DIR: '',
  HEALTH_SESSIONS_DIR: '',
  HEALTH_CREDENTIALS_DIR: '',
  HEALTH_ARCHIVE_DIR: '',
  HEALTH_CONFIG_PATH: '',
  HEALTH_DB_DIR: '',
  HEALTH_DB_FILE: '',
  HEALTH_CHAT_DIR: '',
  HEALTH_USER_FILE: '',
  HEALTH_NOTIFICATIONS_STATE_FILE: '',
  HEALTH_INBOX_DIR: '',
  HEALTH_KEYS_DIR: '',
  HEALTH_VAPID_FILE: '',
  HEALTH_PUSH_SUBSCRIPTIONS_FILE: '',
  HEALTH_AUTO_EXPORT_TOKEN: '',
  NODE_OPTIONS: '',
};
const bearer = value => ({ Authorization: `Bearer ${value}` });
const nativeHeaders = value => ({
  ...bearer(value), 'Klebb-Health-Protocol': '1',
});
const authorityPath = home => path.join(home, 'credentials', 'health-connect.json');
const managedAuthorityPath = home => path.join(home, 'credentials', 'health-connect-policy.json');
function managedNamespace(home, tenantId, owner) {
  const catalogue = JSON.parse(fs.readFileSync(managedAuthorityPath(home), 'utf8'));
  assert.equal(catalogue.version, 2);
  assert.equal(catalogue.recoveryRequired, false);
  const entries = catalogue.namespaces.filter(entry => entry.state.tenantId === tenantId);
  assert.equal(entries.length, 1, 'the independently issued tenant selects exactly one saved namespace');
  const namespace = entries[0];
  const principals = catalogue.principals.filter(principal => principal.ownerId === namespace.ownerId);
  assert.equal(principals.length, 1);
  const principal = principals[0];
  assert.match(principal.ownerId, UUID);
  assert.notEqual(principal.ownerId, 'owner-a');
  assert.notEqual(principal.ownerId, 'owner-b');
  assert.equal(owner.credentials.users['owner-a'].credentials[0].publicKey, 'fake');
  assert.equal(owner.sessions[owner.token].userId, 'owner-a');
  assert.deepEqual(principal.members, [{
    userId: 'owner-a', credentialId: owner.credentialId,
    // Independent digest of the fixture's base64 key "fake" (bytes 7d a9 1e).
    publicKeySha256: 'sha256:0536d3e9b18e52fa27c2951938d4d922e3d0970b534e72cad8126d183159c649',
  }]);
  assert.equal(namespace.state.version, 1);
  assert.equal(namespace.state.tenantId, tenantId);
  return { catalogue, namespace, principal, state: namespace.state };
}
const fixedClock = require('../fixtures/health-connect/fixed-child-clock-inputs-v1.json');
const fixedClockPreload = path.resolve(__dirname, '../helpers/health-connect-fixed-child-clock-preload.cjs');

function fixedAuthState(label, input = fixedClock.base) {
  const issued = fakeAuthState(label);
  issued.sessions[issued.token].created = input.milliseconds;
  issued.sessions[issued.token].lastSeen = input.milliseconds;
  return issued;
}
async function spawnServer(home, extraEnv = {}, input = fixedClock.base) {
  assert.ok(input === fixedClock.base || input === fixedClock.advanced);
  const server = await spawnActualServer(home, { ...extraEnv,
    INDEPENDENT_FIXED_CHILD_CLOCK: String(input.milliseconds),
    NODE_OPTIONS: [`--require=${JSON.stringify(fixedClockPreload)}`, extraEnv.NODE_OPTIONS || ''].filter(Boolean).join(' ') });
  server.fixedClockInput = input; // Independent fixture input; never read from a produced response.
  return server;
}

function fixtureHome(input = fixedClock.base) {
  const owner = fixedAuthState('owner-a', input);
  const other = fixedAuthState('owner-b', input);
  const home = createSandbox({
    credentials: {
      users: { ...owner.credentials.users, ...other.credentials.users },
    },
    sessions: { ...owner.sessions, ...other.sessions },
    seed: {
      'authority-sentinel.json': {
        $schema: 'klebb.datafile.v1',
        meta: { id: 'authority-sentinel', label: 'Authority sentinel' },
        data: ROWS,
      },
    },
  });
  return { home, owner, other };
}

function observeLogs(server) {
  const chunks = [];
  server.proc.stdout.on('data', value => chunks.push(value.toString()));
  server.proc.stderr.on('data', value => chunks.push(value.toString()));
  return () => chunks.join('');
}

function assertNoSecrets(text, secrets) {
  for (const secret of secrets) {
    assert.ok(typeof secret === 'string' && secret.length > 10,
      'an exclusion assertion needs a real nonempty synthetic marker');
    assert.equal(text.includes(secret), false, 'secret marker was disclosed');
  }
}

function assertFailure(response, status, code) {
  assert.equal(response.status, status, response.body);
  if (code) assert.equal(response.json?.code, code);
}

function assertEmptyAuthority(home) {
  const file = authorityPath(home);
  // Instance identity/epoch initialisation is allowed. Refusal must issue
  // zero grants/connectors in both retained authority carriers.
  if (fs.existsSync(file)) {
    const store = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(store.grants, []);
    assert.deepEqual(store.connectors, []);
  }
  const managed = managedAuthorityPath(home);
  if (fs.existsSync(managed)) {
    const catalogue = JSON.parse(fs.readFileSync(managed, 'utf8'));
    assert.equal(catalogue.version, 2);
    assert.equal(catalogue.recoveryRequired, false);
    for (const namespace of catalogue.namespaces) {
      assert.deepEqual(namespace.state.grants, []);
      assert.deepEqual(namespace.state.connectors, []);
    }
  }
}

function exchangeFrame(grant, changes = {}) {
  // #771 already specifies this request frame. #772 extends the grant result
  // with the server-issued sourceStoreId needed to make this approved echo.
  return {
    version: 1,
    kind: 'pairing-exchange',
    tenantId: grant.tenantId,
    instanceId: grant.instanceId,
    grant: grant.grant,
    installationId: 'synthetic-installation-a',
    sourceStoreId: grant.sourceStoreId,
    categories: STEPS,
    ...changes,
  };
}

async function makeGrant(server, owner, changes = {}) {
  const beforeRequest = server.fixedClockInput.milliseconds;
  const response = await req(server.baseUrl, GRANTS, {
    method: 'POST',
    cookie: owner.cookie,
    headers: { Origin: ORIGIN },
    body: { categories: STEPS, name: 'Test phone', ...changes },
  });
  const afterRequest = server.fixedClockInput.milliseconds;
  assert.equal(response.status, 201, response.body);
  const grant = response.json;
  assert.equal(grant.version, 1);
  assert.equal(grant.kind, 'pairing-grant');
  assert.equal(grant.destination, ORIGIN);
  assert.deepEqual(grant.categories, STEPS);
  for (const key of ['tenantId', 'instanceId', 'sourceStoreId']) {
    assert.equal(typeof grant[key], 'string', `${key} is server-issued`);
    assert.ok(grant[key].length > 0, `${key} must not be an empty authority`);
  }
  assert.match(grant.tenantId, UUID);
  assert.match(grant.instanceId, UUID);
  assert.match(grant.grant, /^[A-Za-z0-9_-]{43}$/);
  const expiry = Date.parse(grant.expiresAt);
  assert.ok(expiry >= beforeRequest + 300000 && expiry <= afterRequest + 300000,
    'grant expiry is the independently specified five-minute deadline');
  assert.equal(grant.credential, undefined);
  assert.equal(grant.credentialVerifier, undefined);
  return grant;
}

async function pair(server, owner) {
  const grant = await makeGrant(server, owner);
  const response = await req(server.baseUrl, EXCHANGE, {
    method: 'POST', body: exchangeFrame(grant),
  });
  assert.equal(response.status, 200, response.body);
  const paired = response.json;
  // "paired" and these response fields are reviewed #772 extensions;
  // the #771 validator does not currently define or enforce this result.
  assert.equal(paired.version, 1);
  assert.equal(paired.kind, 'paired');
  assert.equal(paired.destination, ORIGIN);
  assert.equal(paired.tenantId, grant.tenantId);
  assert.equal(paired.instanceId, grant.instanceId);
  assert.equal(paired.sourceStoreId, grant.sourceStoreId);
  assert.equal(paired.installationId, 'synthetic-installation-a');
  assert.deepEqual(paired.categories, STEPS);
  assert.deepEqual(paired.streams, {
    StepsRecord: { generation: '1', acknowledgedSequence: '0' },
  });
  assert.ok(typeof paired.restoreEpoch === 'string' && paired.restoreEpoch.length > 0);
  assert.match(paired.restoreEpoch, UUID);
  assert.ok(typeof paired.connectorId === 'string' && paired.connectorId.length > 0);
  assert.match(paired.credential, /^klebb_hc1_[A-Za-z0-9_-]{43}$/);
  for (const key of ['adminToken', 'agentToken', 'portalToken', 'sessionToken',
    'credentialVerifier', 'verifier', 'grant']) {
    assert.equal(paired[key], undefined, `${key} is not native authority`);
  }
  return { grant, paired };
}

async function listing(server, actor) {
  const response = await req(server.baseUrl, BASE, { cookie: actor.cookie });
  assert.equal(response.status, 200, response.body);
  assert.equal(response.json.destination, ORIGIN);
  assert.ok(Array.isArray(response.json.connectors));
  return response.json;
}

function binaryGet(server, pathname, cookie) {
  return new Promise((resolve, reject) => {
    const request = http.request(new URL(pathname, server.baseUrl), {
      headers: { Cookie: cookie },
    }, response => {
      const chunks = [];
      let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 4 * 1024 * 1024) {
          request.destroy(new Error('synthetic export exceeded bounded fixture size'));
        } else chunks.push(chunk);
      });
      response.on('end', () => resolve({
        status: response.statusCode, body: Buffer.concat(chunks),
      }));
    });
    request.on('error', reject);
    request.setTimeout(10000, () => request.destroy(new Error('export timeout')));
    request.end();
  });
}

function filesUnder(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(file) : [file];
  });
}

describe('#772 session management and native authority over actual routes', () => {
  let fixture, server, logs;
  before(async () => {
    fixture = fixtureHome();
    server = await spawnServer(fixture.home, ENV);
    logs = observeLogs(server);
  });
  after(async () => {
    if (server) await server.kill();
    if (fixture) cleanupSandbox(fixture.home);
  });

  test('independent child clock advance preserves the exact five-minute grant deadline', async () => {
    for (const input of [fixedClock.base, fixedClock.advanced]) {
      const fresh = fixtureHome(input);
      let child;
      try {
        child = await spawnServer(fresh.home, ENV, input);
        const grant = await makeGrant(child, fresh.owner);
        assert.equal(grant.expiresAt, input.grantExpiresAt,
          'independently fixed expiry string follows the supplied child clock');
      } finally {
        if (child) await child.kill();
        cleanupSandbox(fresh.home);
      }
    }
  });

  test('management requires a live session rather than broad bearer auth', async () => {
    for (const headers of [{}, bearer(CHAT), bearer(ADMIN),
      bearer('klebb_hc1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')]) {
      for (const [pathname, method, body] of [
        [BASE, 'GET', null],
        [GRANTS, 'POST', { categories: STEPS, name: 'Test phone' }],
        [`${BASE}/not-owned`, 'DELETE', null],
      ]) {
        assertFailure(await req(server.baseUrl, pathname, {
          method, headers, body,
        }), 401);
      }
    }
    assert.deepEqual((await listing(server, fixture.owner)).connectors, []);
  });

  test('expired session cannot mint a grant', async () => {
    const expired = fixedAuthState('expired-owner');
    expired.sessions[expired.token].created = fixedClock.base.milliseconds - 31 * 86400000;
    const home = createSandbox({
      credentials: expired.credentials, sessions: expired.sessions,
    });
    let child;
    try {
      child = await spawnServer(home, ENV);
      assertFailure(await req(child.baseUrl, GRANTS, {
        method: 'POST', cookie: expired.cookie,
        headers: { Origin: ORIGIN }, body: { categories: STEPS, name: 'Test phone' },
      }), 401);
      await child.kill();
      child = null;
      assertEmptyAuthority(home);
    } finally {
      if (child) await child.kill();
      cleanupSandbox(home);
    }
  });

  test('sibling Origin with a valid cookie cannot grant or revoke', async () => {
    const prior = await listing(server, fixture.owner);
    const sibling = { Origin: 'https://owner-b.klebb.app' };
    assertFailure(await req(server.baseUrl, GRANTS, {
      method: 'POST', cookie: fixture.owner.cookie, headers: sibling,
      body: { categories: STEPS, name: 'Test phone' },
    }), 403);
    const { paired } = await pair(server, fixture.owner);
    assertFailure(await req(server.baseUrl, `${BASE}/${paired.connectorId}`, {
      method: 'DELETE', cookie: fixture.owner.cookie, headers: sibling,
    }), 403);
    assert.equal((await listing(server, fixture.owner)).connectors.length,
      prior.connectors.length + 1);
    assert.equal((await req(server.baseUrl, CAPABILITIES, {
      headers: nativeHeaders(paired.credential),
    })).status, 200);
  });

  test('configured destination resists request Host and forwarding headers', async () => {
    const response = await req(server.baseUrl, GRANTS, {
      method: 'POST', cookie: fixture.owner.cookie,
      headers: {
        Origin: ORIGIN, Host: 'attacker.example.test',
        'X-Forwarded-Host': 'another.example.test', 'X-Forwarded-Proto': 'http',
      },
      body: { categories: STEPS, name: 'Test phone' },
    });
    assert.equal(response.status, 201, response.body);
    assert.equal(response.json.destination, ORIGIN);
  });

  test('browser may not choose an arbitrary native namespace', async () => {
    const response = await req(server.baseUrl, GRANTS, {
      method: 'POST', cookie: fixture.owner.cookie, headers: { Origin: ORIGIN },
      body: {
        categories: STEPS, name: 'Test phone', sourceStoreId: 'client-chosen-store',
      },
    });
    assertFailure(response, 400, 'invalid-message');
    const grant = await makeGrant(server, fixture.owner);
    assert.notEqual(grant.sourceStoreId, 'client-chosen-store');
  });

  test('client userId and ownerId cannot change session-derived ownership', async () => {
    const ownership = fixtureHome();
    const expectedMember = {
      userId: 'owner-a', credentialId: ownership.owner.credentialId,
      // Controlled base64 key "fake" is bytes 7d a9 1e; this literal is not read from policy.
      publicKeySha256: 'sha256:0536d3e9b18e52fa27c2951938d4d922e3d0970b534e72cad8126d183159c649',
    };
    assert.equal(ownership.owner.credentials.users['owner-a'].credentials[0].id,
      expectedMember.credentialId);
    assert.equal(ownership.owner.credentials.users['owner-a'].credentials[0].publicKey, 'fake');
    assert.equal(ownership.owner.sessions[ownership.owner.token].userId, 'owner-a');
    assert.equal(ownership.owner.sessions[ownership.owner.token].credentialId, expectedMember.credentialId);
    assert.notEqual(ownership.other.credentialId, expectedMember.credentialId);
    let child;
    try {
      child = await spawnServer(ownership.home, ENV);
      const { grant, paired } = await pair(child, ownership.owner);
      const beforeList = await listing(child, ownership.owner);
      assert.deepEqual((await listing(child, ownership.other)).connectors, []);
      await child.kill();
      child = null;
      const beforeLegacyBytes = fs.readFileSync(authorityPath(ownership.home));
      assert.deepEqual(JSON.parse(beforeLegacyBytes).grants, []);
      assert.deepEqual(JSON.parse(beforeLegacyBytes).connectors, []);
      const managedFile = path.join(ownership.home, 'credentials', 'health-connect-policy.json');
      const beforeManagedBytes = fs.readFileSync(managedFile);
      const beforeCatalogue = JSON.parse(beforeManagedBytes);
      assert.equal(beforeCatalogue.version, 2);
      assert.equal(beforeCatalogue.recoveryRequired, false);
      assert.equal(beforeCatalogue.principals.length, 1);
      assert.equal(beforeCatalogue.namespaces.length, 1);
      const principal = beforeCatalogue.principals[0];
      assert.match(principal.ownerId, UUID);
      assert.notEqual(principal.ownerId, 'owner-a');
      assert.notEqual(principal.ownerId, 'owner-b');
      assert.deepEqual(principal.members, [expectedMember]);
      assert.equal(paired.restoreEpoch, grant.restoreEpoch);
      assert.equal(grant.expiresAt, fixedClock.base.grantExpiresAt);
      const beforeState = beforeCatalogue.namespaces[0].state;
      assert.deepEqual(beforeCatalogue, {
        version: 2, recoveryRequired: false,
        principals: [{ ownerId: principal.ownerId, members: [expectedMember] }],
        namespaces: [{ ownerId: principal.ownerId, state: {
          version: 1, tenantId: paired.tenantId, instanceId: paired.instanceId,
          restoreEpoch: paired.restoreEpoch,
          grants: [{
            verifier: `sha256:${crypto.createHash('sha256').update(grant.grant, 'utf8').digest('hex')}`,
            ownerId: principal.ownerId, instanceId: grant.instanceId,
            sourceStoreId: grant.sourceStoreId, restoreEpoch: grant.restoreEpoch,
            categories: STEPS, name: 'Test phone', expiresAt: fixedClock.base.grantExpiresAt,
            consumedAt: fixedClock.base.instant,
          }],
          connectors: [{
            id: paired.connectorId,
            credentialVerifier: `sha256:${crypto.createHash('sha256').update(paired.credential, 'utf8').digest('hex')}`,
            ownerId: principal.ownerId, installationId: 'synthetic-installation-a',
            sourceStoreId: paired.sourceStoreId, restoreEpoch: paired.restoreEpoch,
            categories: STEPS, generations: { StepsRecord: '1' }, name: 'Test phone',
            createdAt: fixedClock.base.instant, revokedAt: null,
          }],
        } }],
      });
      assert.equal(beforeState.grants.length, 1);
      assert.equal(beforeState.connectors.length, 1);
      assert.equal(beforeState.grants[0].ownerId, principal.ownerId);
      assert.equal(beforeState.connectors[0].ownerId, principal.ownerId);
      child = await spawnServer(ownership.home, ENV);
      for (const suppliedOwner of [
        { userId: 'owner-b' },
        { ownerId: 'owner-b' },
        { userId: 'owner-b', ownerId: 'owner-b' },
      ]) {
        const refused = await req(child.baseUrl, GRANTS, {
          method: 'POST', cookie: ownership.owner.cookie, headers: { Origin: ORIGIN },
          body: { categories: STEPS, name: 'Test phone', ...suppliedOwner },
        });
        assertFailure(refused, 400, 'invalid-message');
        assert.equal(refused.json.grant, undefined);
        assert.equal(refused.json.credential, undefined);
      }
      const afterList = await listing(child, ownership.owner);
      assert.equal(afterList.connectors.length, beforeList.connectors.length);
      assert.deepEqual(afterList.connectors.map(item => item.id).sort(),
        beforeList.connectors.map(item => item.id).sort());
      assert.deepEqual((await listing(child, ownership.other)).connectors, []);
      assert.ok(afterList.connectors.some(item => item.id === paired.connectorId));
      await child.kill();
      child = null;
      assert.deepEqual(fs.readFileSync(authorityPath(ownership.home)), beforeLegacyBytes,
        'rejected client ownership fields keep the V1 placeholder byte exact');
      const afterManagedBytes = fs.readFileSync(managedFile);
      assert.deepEqual(afterManagedBytes, beforeManagedBytes,
        'rejected client ownership fields keep the complete managed catalogue byte exact');
      const afterState = JSON.parse(afterManagedBytes).namespaces[0].state;
      assert.deepEqual(afterState.grants, beforeState.grants,
        'rejected client ownership fields created or changed no grant');
      assert.deepEqual(afterState.connectors, beforeState.connectors,
        'rejected client ownership fields created or changed no connector authority');
    } finally {
      if (child) await child.kill();
      cleanupSandbox(ownership.home);
    }
  });

  test('successful exchange issues only scoped native authority and current streams', async () => {
    const { paired } = await pair(server, fixture.owner);
    const capabilities = await req(server.baseUrl, CAPABILITIES, {
      headers: nativeHeaders(paired.credential),
    });
    assert.equal(capabilities.status, 200, capabilities.body);
    assert.equal(capabilities.json.version, 1);
    assert.equal(capabilities.json.kind, 'capabilities');
    assert.equal(capabilities.json.tenantId, paired.tenantId);
    assert.equal(capabilities.json.instanceId, paired.instanceId);
    assert.equal(capabilities.json.sourceStoreId, paired.sourceStoreId);
    assert.equal(capabilities.json.installationId, paired.installationId);
    assert.equal(capabilities.json.restoreEpoch, paired.restoreEpoch);
    assert.deepEqual(capabilities.json.categories, STEPS);
    assert.deepEqual(capabilities.json.supportedVersions, [1]);
    assert.deepEqual(capabilities.json.streams, {
      StepsRecord: { generation: '1', acknowledgedSequence: '0' },
    });
    assertNoSecrets(capabilities.body, [paired.credential, ADMIN, CHAT]);
    const own = await listing(server, fixture.owner);
    assert.ok(own.connectors.some(item => item.id === paired.connectorId));
    const other = await listing(server, fixture.other);
    assert.equal(other.connectors.some(item => item.id === paired.connectorId), false);
  });

  test('scope, tenant, instance and namespace refusal do not consume a valid grant', async () => {
    for (const change of [
      { categories: ['WeightRecord'] },
      { tenantId: 'wrong-tenant' },
      { instanceId: 'wrong-instance' },
      { sourceStoreId: 'wrong-store' },
    ]) {
      const grant = await makeGrant(server, fixture.owner);
      assertFailure(await req(server.baseUrl, EXCHANGE, {
        method: 'POST', body: exchangeFrame(grant, change),
      }), 403);
      const valid = await req(server.baseUrl, EXCHANGE, {
        method: 'POST', body: exchangeFrame(grant),
      });
      assert.equal(valid.status, 200, valid.body);
      assert.deepEqual(valid.json.categories, STEPS);
    }
  });

  test('native exchange may narrow approved categories without retaining wider authority', async () => {
    const grantResponse = await req(server.baseUrl, GRANTS, {
      method: 'POST', cookie: fixture.owner.cookie, headers: { Origin: ORIGIN },
      body: { categories: ['StepsRecord', 'WeightRecord'], name: 'Test phone' },
    });
    assert.equal(grantResponse.status, 201, grantResponse.body);
    assert.deepEqual(grantResponse.json.categories, ['StepsRecord', 'WeightRecord']);
    const exchange = await req(server.baseUrl, EXCHANGE, {
      method: 'POST', body: exchangeFrame(grantResponse.json),
    });
    assert.equal(exchange.status, 200, exchange.body);
    assert.deepEqual(exchange.json.categories, STEPS);
    assert.deepEqual(exchange.json.streams, {
      StepsRecord: { generation: '1', acknowledgedSequence: '0' },
    });
    const capabilities = await req(server.baseUrl, CAPABILITIES, {
      headers: nativeHeaders(exchange.json.credential),
    });
    assert.equal(capabilities.status, 200, capabilities.body);
    assert.deepEqual(capabilities.json.categories, STEPS);
    assert.deepEqual(capabilities.json.streams, {
      StepsRecord: { generation: '1', acknowledgedSequence: '0' },
    });
  });

  test('used grant replay refuses instead of issuing another credential', async () => {
    const { grant, paired } = await pair(server, fixture.owner);
    const beforeList = await listing(server, fixture.owner);
    assertFailure(await req(server.baseUrl, EXCHANGE, {
      method: 'POST', body: exchangeFrame(grant),
    }), 409, 'conflict');
    const afterList = await listing(server, fixture.owner);
    assert.equal(afterList.connectors.length, beforeList.connectors.length,
      'replay issued no additional connector');
    assert.deepEqual(afterList.connectors.map(item => item.id).sort(),
      beforeList.connectors.map(item => item.id).sort(),
      'the complete connector identity list is unchanged after replay');
    assert.equal(afterList.connectors.filter(item => item.id === paired.connectorId).length, 1);
  });

  test('two simultaneous exchanges have exactly one accepted winner', async () => {
    const concurrent = fixtureHome();
    let child;
    try {
      child = await spawnServer(concurrent.home, ENV);
      const grant = await makeGrant(child, concurrent.owner);
      const responses = await Promise.all([0, 1].map(() =>
        req(child.baseUrl, EXCHANGE, { method: 'POST', body: exchangeFrame(grant) })));
      assert.deepEqual(responses.map(value => value.status).sort(), [200, 409]);
      const winner = responses.find(value => value.status === 200);
      const loser = responses.find(value => value.status === 409);
      assert.match(winner.json.credential, /^klebb_hc1_[A-Za-z0-9_-]{43}$/);
      assert.equal(loser.json.code, 'conflict');
      assert.equal(loser.json.credential, undefined);
      assert.equal((await listing(child, concurrent.owner)).connectors.length, 1);
      await child.kill();
      child = null;
      const { state } = managedNamespace(concurrent.home, grant.tenantId, concurrent.owner);
      assert.equal(state.version, 1);
      assert.equal(state.grants.length, 1);
      assert.equal(state.connectors.length, 1);
      assert.ok(Number.isFinite(Date.parse(state.grants[0].consumedAt)));
      assert.equal(state.connectors[0].credentialVerifier,
        'sha256:' + crypto.createHash('sha256')
          .update(winner.json.credential, 'utf8').digest('hex'));
      assertNoSecrets(JSON.stringify(state), [grant.grant, winner.json.credential]);
    } finally {
      if (child) await child.kill();
      cleanupSandbox(concurrent.home);
    }
  });

  test('invalid native authority and unsupported negotiation refuse', async () => {
    for (const headers of [{}, bearer(CHAT), bearer(ADMIN),
      nativeHeaders('klebb_hc1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')]) {
      assertFailure(await req(server.baseUrl, CAPABILITIES, { headers }), 401);
    }
    const { paired } = await pair(server, fixture.owner);
    assertFailure(await req(server.baseUrl, CAPABILITIES, {
      headers: {
        ...bearer(paired.credential), 'Klebb-Health-Protocol': '2',
      },
    }), 400, 'unsupported-version');
    const grant = await makeGrant(server, fixture.owner);
    assertFailure(await req(server.baseUrl, EXCHANGE, {
      method: 'POST', body: exchangeFrame(grant, { version: 2 }),
    }), 400, 'unsupported-version');
    assert.equal((await req(server.baseUrl, EXCHANGE, {
      method: 'POST', body: exchangeFrame(grant),
    })).status, 200);
  });

  test('native bearer cannot acquire broader history, account or control-plane authority', async () => {
    const { paired } = await pair(server, fixture.owner);
    for (const [pathname, method, body] of [
      ['/api/manifests', 'GET', null],
      ['/api/manifests/authority-sentinel/data', 'GET', null],
      ['/api/reports', 'GET', null],
      ['/api/chat/history', 'GET', null],
      ['/api/export', 'GET', null],
      ['/api/credentials', 'GET', null],
      ['/api/invites', 'POST', {}],
      [`/api/credentials/${fixture.other.credentialId}`, 'DELETE', null],
      ['/api/admin/credentials', 'GET', null],
      ['/api/admin/info', 'GET', null],
      ['/api/admin/invites', 'POST', { label: 'another-account' }],
    ]) {
      assertFailure(await req(server.baseUrl, pathname, {
        method, body, headers: bearer(paired.credential),
      }), 401);
    }
    const saved = await req(server.baseUrl, '/api/manifests/authority-sentinel/data', {
      cookie: fixture.owner.cookie,
    });
    assert.deepEqual(saved.json.data, ROWS);
  });

  test('owner revoke fences native authority while retaining saved history', async () => {
    const { paired } = await pair(server, fixture.owner);
    assertFailure(await req(server.baseUrl, `${BASE}/${paired.connectorId}`, {
      method: 'DELETE', cookie: fixture.other.cookie, headers: { Origin: ORIGIN },
    }), 403);
    assert.equal((await req(server.baseUrl, CAPABILITIES, {
      headers: nativeHeaders(paired.credential),
    })).status, 200, 'refused sibling-owner revocation changed no native authority');
    const beforeSaved = await req(server.baseUrl, '/api/manifests/authority-sentinel/data', {
      cookie: fixture.owner.cookie,
    });
    const revoke = await req(server.baseUrl, `${BASE}/${paired.connectorId}`, {
      method: 'DELETE', cookie: fixture.owner.cookie, headers: { Origin: ORIGIN },
    });
    assert.equal(revoke.status, 200, revoke.body);
    assert.deepEqual(revoke.json, { revoked: true });
    assertFailure(await req(server.baseUrl, CAPABILITIES, {
      headers: nativeHeaders(paired.credential),
    }), 401);
    const afterSaved = await req(server.baseUrl, '/api/manifests/authority-sentinel/data', {
      cookie: fixture.owner.cookie,
    });
    assert.deepEqual(afterSaved.json, beforeSaved.json);
  });

  test('errors and real captured logs do not echo authority markers', async () => {
    const grant = await makeGrant(server, fixture.owner);
    const malformed = await req(server.baseUrl, EXCHANGE, {
      method: 'POST', body: exchangeFrame(grant, { installationId: { secret: grant.grant } }),
    });
    assertFailure(malformed, 400, 'invalid-message');
    const { paired } = await pair(server, fixture.owner);
    const list = await listing(server, fixture.owner);
    assertNoSecrets(JSON.stringify(list), [grant.grant, paired.credential, ADMIN, CHAT]);
    assertNoSecrets(malformed.body, [grant.grant]);
    const audit = path.join(fixture.home, 'sessions', 'auth-events.log');
    const auditText = fs.existsSync(audit) ? fs.readFileSync(audit, 'utf8') : '';
    assertNoSecrets(logs() + auditText, [grant.grant, paired.credential, ADMIN, CHAT]);
  });
});

describe('#772 persisted authority, export and cold-start fences', () => {
  test('credential verifier is persisted without the live bearer; expanded export excludes it', async () => {
    const fixture = fixtureHome();
    let server, logs, legacyFixture, legacyServer;
    try {
      server = await spawnServer(fixture.home, ENV);
      logs = observeLogs(server);
      const { grant, paired } = await pair(server, fixture.owner);
      const cursorGrant = await makeGrant(server, fixture.owner);
      const rejectedCursor = await req(server.baseUrl, EXCHANGE, {
        method: 'POST', body: exchangeFrame(cursorGrant, { changesCursor: CURSOR }),
      });
      assertFailure(rejectedCursor, 400, 'invalid-message');
      assertNoSecrets(rejectedCursor.body, [CURSOR]);
      const list = await listing(server, fixture.owner);
      const authorityBefore = fs.readFileSync(authorityPath(fixture.home));
      const managedBefore = fs.readFileSync(managedAuthorityPath(fixture.home));
      const exportOwner = managedNamespace(fixture.home, paired.tenantId, fixture.owner).principal.ownerId;
      const { DatabaseSync } = require('node:sqlite');
      const sourceDb = new DatabaseSync(path.join(fixture.home, 'db', 'klebb.db'), { readOnly: true });
      let policyIdentities;
      try {
        sourceDb.exec('BEGIN');
        policyIdentities = sourceDb.prepare('SELECT tenant_id, owner_id, source_store_id, policy_id '
          + 'FROM health_source_policy_sources ORDER BY tenant_id, source_store_id').all();
      } finally {
        try { sourceDb.exec('ROLLBACK'); } finally { sourceDb.close(); }
      }
      assert.deepEqual(policyIdentities.map(row => [row.tenant_id, row.source_store_id]),
        [[grant.tenantId, grant.sourceStoreId], [cursorGrant.tenantId, cursorGrant.sourceStoreId]]
          .sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      for (const row of policyIdentities) {
        assert.equal(row.owner_id, exportOwner); assert.match(row.policy_id, UUID);
      }
      const exportStagingName = `export-staging.${server.fixedClockInput.milliseconds}`;
      const managedDownload = await binaryGet(server, '/api/export', fixture.owner.cookie);
      assert.equal(managedDownload.status, 200);
      assert.equal(fs.readFileSync(authorityPath(fixture.home)).equals(authorityBefore), true,
        'export changed retained native authority');
      assert.equal(fs.readFileSync(managedAuthorityPath(fixture.home)).equals(managedBefore), true,
        'export changed the complete managed catalogue');
      await waitFor(() => {
        const artifacts = fs.readdirSync(fixture.home).filter(name =>
          name.startsWith('export-staging.') || name.endsWith('.zip')
            || name === 'klebb-export.json');
        assert.deepEqual(artifacts.filter(name => name !== exportStagingName &&
          name !== exportStagingName + '.zip'), [],
          'completed export created an unexpected root archive artifact');
        return artifacts.length === 0;
      }, { what: 'completed export response-close cleanup' });
      assert.equal((await req(server.baseUrl, CAPABILITIES, {
        headers: nativeHeaders(paired.credential),
      })).status, 200, 'export revoked native authority');
      const saved = await req(server.baseUrl, '/api/manifests/authority-sentinel/data', {
        cookie: fixture.owner.cookie,
      });
      assert.equal(saved.status, 200);
      assert.deepEqual(saved.json.data, ROWS);
      await server.kill();
      server = null;
      const persisted = fs.readFileSync(managedAuthorityPath(fixture.home), 'utf8');
      const { state, principal } = managedNamespace(fixture.home, paired.tenantId, fixture.owner);
      const verifier = 'sha256:' + crypto.createHash('sha256')
        .update(paired.credential, 'utf8').digest('hex');
      const grantVerifier = 'sha256:' + crypto.createHash('sha256')
        .update(grant.grant, 'utf8').digest('hex');
      assert.equal(state.version, 1);
      assert.equal(state.tenantId, paired.tenantId);
      assert.equal(state.instanceId, paired.instanceId);
      assert.equal(state.restoreEpoch, paired.restoreEpoch);
      assert.equal(state.connectors.length, 1);
      assert.equal(state.connectors[0].ownerId, principal.ownerId);
      assert.equal(state.connectors[0].installationId, 'synthetic-installation-a');
      assert.equal(state.connectors[0].sourceStoreId, grant.sourceStoreId);
      assert.deepEqual(state.connectors[0].categories, STEPS);
      assert.deepEqual(state.connectors[0].generations, { StepsRecord: '1' });
      assert.equal(state.connectors[0].credentialVerifier, verifier);
      assert.equal(state.connectors[0].restoreEpoch, paired.restoreEpoch);
      assert.equal(state.connectors[0].revokedAt, null);
      const consumed = state.grants.find(item => item.verifier === grantVerifier);
      assert.ok(consumed, 'the independently hashed grant verifier is stored');
      assert.equal(consumed.ownerId, principal.ownerId);
      assert.equal(consumed.instanceId, paired.instanceId);
      assert.equal(consumed.sourceStoreId, paired.sourceStoreId);
      assert.equal(consumed.restoreEpoch, paired.restoreEpoch);
      assert.deepEqual(consumed.categories, STEPS);
      assert.equal(consumed.name, 'Test phone');
      assert.ok(Number.isFinite(Date.parse(consumed.consumedAt)));
      assertNoSecrets(persisted, [paired.credential, grant.grant]);
      legacyFixture = fixtureHome();
      assert.notEqual(legacyFixture.home, fixture.home);
      const cursorGrantVerifier = 'sha256:' + crypto.createHash('sha256')
        .update(cursorGrant.grant, 'utf8').digest('hex');
      const markers = [paired.credential, grant.grant, cursorGrant.grant, verifier,
        grantVerifier, cursorGrantVerifier, ADMIN, CHAT, CURSOR];
      const managedArchive = path.join(legacyFixture.home, 'authority-managed-test-export.zip');
      const managedTarget = path.join(legacyFixture.home, 'authority-managed-test-expanded');
      fs.writeFileSync(managedArchive, managedDownload.body);
      const managedZip = await openZip(managedArchive, {
        maxEntries: 100, maxEntryBytes: 1024 * 1024, maxTotalBytes: 4 * 1024 * 1024,
      });
      try {
        const names = managedZip.entries().map(entry => entry.name);
        assert.equal(new Set(names).size, names.length);
        assert.equal(names.some(name => /^(credentials|sessions|keys|db)(?:\/|$)/.test(name)), false);
        for (const file of ['klebb-export.json', 'data/authority-sentinel.json',
          'data/health-connect/ordinary-history.json', 'data/health-connect/ordinary-history-footer.json']) {
          assert.equal(names.filter(name => name === file).length, 1);
        }
        await managedZip.extractTo(managedTarget);
      } finally { await managedZip.close(); }
      const managedExpanded = filesUnder(managedTarget).map(file =>
        path.relative(managedTarget, file) + '\n' + fs.readFileSync(file, 'utf8')).join('\n');
      assertNoSecrets(managedExpanded, markers);
      const managedManifest = JSON.parse(fs.readFileSync(path.join(managedTarget, 'klebb-export.json'), 'utf8'));
      assert.equal(managedManifest.format, 'klebb.export.v1');
      assert.equal(managedManifest.formatVersion, 2);
      const inputFile = 'data/health-connect/ordinary-history.json';
      const footerFile = 'data/health-connect/ordinary-history-footer.json';
      const inputBytes = fs.readFileSync(path.join(managedTarget, inputFile));
      const footerBytes = fs.readFileSync(path.join(managedTarget, footerFile));
      const checksum = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
      assert.deepEqual(managedManifest.inventory.ordinaryHistory, {
        version: 1, controlProfileVersion: 3,
        payload: { file: inputFile, bytes: inputBytes.length, sha256: checksum(inputBytes) },
        footer: { file: footerFile, bytes: footerBytes.length, sha256: checksum(footerBytes) },
      });
      const decoded = require('../../lib/import/native-publication')
        .decodeOrdinaryHistory(inputBytes, footerBytes, { controlProfileVersion: 3 });
      assert.deepEqual(decoded.envelope, { version: 3,
        counts: { namespaces: 2, sources: 2, categories: 2, records: 0, streams: 0,
          receipts: 0, projectionOutbox: 0, tombstones: 0, deletionGuards: 0, suppressions: 0 },
        sha256: 'sha256:' + checksum(inputBytes) });
      assert.deepEqual(decoded.inventory, {
        catalog: { version: 3, ownerRef: exportOwner, namespaces: policyIdentities.map(row => ({
          tenantId: row.tenant_id, ownerRef: exportOwner, sourceCount: 1,
          sources: [{ sourceStoreId: row.source_store_id, provider: 'health-connect-native',
            policyRef: row.policy_id }],
        })) },
        records: [], sourcePolicies: policyIdentities.map(row => ({
          tenantId: row.tenant_id, ownerRef: exportOwner, revision: '1', sourceCount: 1,
          sources: [{ sourceStoreId: row.source_store_id, policyId: row.policy_id, lifecycle: 'active',
            retainCommittedHistory: true, categoryCount: 1,
            categories: [{ recordType: 'StepsRecord', sharing: 'stopped', generation: '1' }] }],
        })),
        streams: [], receipts: [], projectionOutbox: [], tombstones: [], deletionGuards: [], suppressions: [],
      });
      const managedCard = JSON.parse(fs.readFileSync(path.join(managedTarget, 'data',
        'authority-sentinel.json'), 'utf8'));
      assert.deepEqual(managedCard.data, ROWS, 'managed archive retains the original nonempty legacy history');
      const markerFile = path.join(legacyFixture.home, 'credentials',
        'export-exclusion-sentinel.json');
      fs.writeFileSync(markerFile, JSON.stringify({ markers }));
      const markerInput = fs.readFileSync(markerFile, 'utf8');
      for (const marker of markers) {
        assert.ok(typeof marker === 'string' && marker.length > 10);
        assert.equal(markerInput.includes(marker), true, 'excluded source marker was absent');
      }
      legacyServer = await spawnServer(legacyFixture.home, ENV);
      const legacyLogs = [observeLogs(legacyServer)];
      const legacyProcess = legacyServer.proc;
      await legacyServer.kill();
      assert.ok(legacyProcess.exitCode !== null || legacyProcess.signalCode !== null,
        'legacy source snapshot requires a confirmed stopped server');
      legacyServer = null;
      const legacyDb = path.join(legacyFixture.home, 'db', 'klebb.db');
      if (fs.existsSync(legacyDb)) {
        const { DatabaseSync } = require('node:sqlite');
        const db = new DatabaseSync(legacyDb, { readOnly: true });
        try {
          db.exec('BEGIN');
          assert.equal(db.prepare("SELECT count(*) AS count FROM sqlite_schema "
            + "WHERE type IN ('table','view') AND lower(name) GLOB 'health_*'").get().count, 0);
        } finally {
          try { db.exec('ROLLBACK'); } finally { db.close(); }
        }
      }
      if (fs.existsSync(authorityPath(legacyFixture.home))) {
        const unused = JSON.parse(fs.readFileSync(authorityPath(legacyFixture.home), 'utf8'));
        assert.deepEqual(Object.keys(unused).sort(),
          ['version', 'tenantId', 'instanceId', 'restoreEpoch', 'grants', 'connectors'].sort());
        assert.equal(unused.version, 1);
        assert.ok([unused.tenantId, unused.instanceId, unused.restoreEpoch]
          .every(value => typeof value === 'string' && UUID.test(value)));
        assert.deepEqual(unused.grants, []);
        assert.deepEqual(unused.connectors, []);
      }
      legacyServer = await spawnServer(legacyFixture.home, ENV);
      legacyLogs.push(observeLogs(legacyServer));
      const downloaded = await binaryGet(legacyServer, '/api/export', legacyFixture.owner.cookie);
      assert.equal(downloaded.status, 200);
      const archive = path.join(legacyFixture.home, 'authority-test-export.zip');
      fs.writeFileSync(archive, downloaded.body);
      const target = path.join(legacyFixture.home, 'authority-test-expanded');
      const zip = await openZip(archive, {
        maxEntries: 100, maxEntryBytes: 1024 * 1024, maxTotalBytes: 4 * 1024 * 1024,
      });
      try {
        assert.ok(zip.entries().some(entry => entry.name === 'data/authority-sentinel.json'));
        assert.equal(zip.entries().some(entry => entry.name.startsWith('credentials/')), false);
        assert.equal(zip.entries().some(entry => entry.name.startsWith('sessions/')), false);
        await zip.extractTo(target);
      } finally {
        await zip.close();
      }
      const exported = filesUnder(target).map(file =>
        path.relative(target, file) + '\n' + fs.readFileSync(file, 'utf8')).join('\n');
      assertNoSecrets(exported + JSON.stringify(list) + logs(), [
        paired.credential, grant.grant, cursorGrant.grant, verifier, grantVerifier, cursorGrantVerifier,
        ADMIN, CHAT, CURSOR,
      ]);
      assertNoSecrets(managedDownload.body.toString('utf8') + legacyLogs.map(read => read()).join(''), markers);
      const provenance = JSON.parse(fs.readFileSync(path.join(target, 'klebb-export.json'), 'utf8'));
      assert.equal(provenance.format, 'klebb.export.v1');
      assert.equal(provenance.formatVersion, 1);
      // This actual rejected-input marker proves containment at #772's boundary.
      // Native persisted cursor/export lifecycle remains its later owning slice.
      assertNoSecrets(persisted, [CURSOR]);
      const card = JSON.parse(fs.readFileSync(path.join(target, 'data',
        'authority-sentinel.json'), 'utf8'));
      assert.deepEqual(card.data, ROWS, 'nonempty authorised history was actually exported');
    } finally {
      if (server) await server.kill();
      if (legacyServer) await legacyServer.kill();
      cleanupSandbox(fixture.home);
      if (legacyFixture) cleanupSandbox(legacyFixture.home);
    }
  });

  test('a cold-start expired grant refuses without waiting for its real TTL', async () => {
    const fixture = fixtureHome();
    let server;
    try {
      server = await spawnServer(fixture.home, ENV);
      const grant = await makeGrant(server, fixture.owner);
      await server.kill();
      server = null;
      const file = managedAuthorityPath(fixture.home);
      const { catalogue, state: store, principal } =
        managedNamespace(fixture.home, grant.tenantId, fixture.owner);
      const beforeCatalogue = structuredClone(catalogue);
      // Change the one approved grant in its current authoritative namespace.
      assert.ok(Array.isArray(store.grants) && store.grants.length === 1,
        'reviewed authority store must expose the one cold-start grant fixture');
      assert.equal(store.version, 1);
      assert.deepEqual(store.connectors, []);
      assert.equal(store.grants[0].ownerId, principal.ownerId);
      assert.equal(store.grants[0].instanceId, grant.instanceId);
      assert.equal(store.grants[0].sourceStoreId, grant.sourceStoreId);
      assert.equal(store.grants[0].consumedAt, null);
      assert.equal(store.grants[0].verifier, 'sha256:' + crypto.createHash('sha256')
        .update(grant.grant, 'utf8').digest('hex'));
      assert.equal(store.grants[0].expiresAt, fixedClock.base.grantExpiresAt);
      store.grants[0].expiresAt = '2000-01-01T00:00:00.000Z';
      fs.writeFileSync(file, JSON.stringify(catalogue), { mode: 0o600 });
      const written = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.deepEqual(written, catalogue);
      written.namespaces.find(entry => entry.state.tenantId === grant.tenantId)
        .state.grants[0].expiresAt = fixedClock.base.grantExpiresAt;
      assert.deepEqual(written, beforeCatalogue, 'cold expiry changes no unrelated catalogue field');
      server = await spawnServer(fixture.home, ENV);
      assertFailure(await req(server.baseUrl, EXCHANGE, {
        method: 'POST', body: exchangeFrame(grant),
      }), 410, 'expired-grant');
      assert.deepEqual((await listing(server, fixture.owner)).connectors, []);
    } finally {
      if (server) await server.kill();
      cleanupSandbox(fixture.home);
    }
  });

  test('reserved native prefix cannot become broad authority via agent configuration or setup', async () => {
    const fixture = fixtureHome();
    let server;
    try {
      server = await spawnServer(fixture.home, ENV);
      const { paired } = await pair(server, fixture.owner);
      await server.kill();
      server = null;
      // Retain the actual member: this control needs a live native credential.
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(fixture.home, 'credentials',
        'webauthn.json'), 'utf8')).users['owner-a'].credentials,
      fixture.owner.credentials.users['owner-a'].credentials);
      server = await spawnServer(fixture.home, {
        ...ENV, AGENT_API_TOKEN: paired.credential,
      });
      assert.equal((await req(server.baseUrl, CAPABILITIES, {
        headers: nativeHeaders(paired.credential),
      })).status, 200, 'the native credential remains live, so refusal is not vacuous');
      for (const [pathname, method, body] of [
        ['/api/manifests', 'GET', null],
        ['/api/export', 'GET', null],
        [BASE, 'GET', null],
        [GRANTS, 'POST', { categories: STEPS, name: 'Test phone' }],
      ]) {
        assertFailure(await req(server.baseUrl, pathname, {
          method, body, headers: bearer(paired.credential),
        }), 401);
      }
    } finally {
      if (server) await server.kill();
      cleanupSandbox(fixture.home);
    }
  });

  test('pre-setup anonymous/admin/chat/native bearers cannot manage connector grants', async () => {
    const home = createSandbox();
    let server;
    try {
      server = await spawnServer(home, ENV);
      for (const headers of [{}, bearer(ADMIN), bearer(CHAT),
        bearer('klebb_hc1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')]) {
        for (const [pathname, method, body] of [
          [BASE, 'GET', null],
          [GRANTS, 'POST', { categories: STEPS, name: 'Test phone' }],
          [`${BASE}/unknown-connector`, 'DELETE', null],
        ]) {
          assertFailure(await req(server.baseUrl, pathname, {
            method, headers, body,
          }), 401);
        }
      }
    } finally {
      if (server) await server.kill();
      cleanupSandbox(home);
    }
  });

  test('refused boot recovery retains the exact structural API gate', async () => {
    const fixture = fixtureHome();
    let server;
    try {
      fs.mkdirSync(path.join(fixture.home, 'import'), { recursive: true });
      fs.writeFileSync(path.join(fixture.home, 'import', 'job.json'), JSON.stringify({
        state: 'applying',
        treePath: path.join(fixture.home, 'import', 'missing-tree'),
        snapshotPath: path.join(fixture.home, 'import', 'missing-snapshot'),
      }));
      server = await spawnServer(fixture.home, ENV);
      for (const [pathname, method, body] of [
        [BASE, 'GET', null],
        [GRANTS, 'POST', { categories: STEPS, name: 'Test phone' }],
        [`${BASE}/unknown-connector`, 'DELETE', null],
        [CAPABILITIES, 'GET', null],
        [EXCHANGE, 'POST', {
          version: 1, kind: 'pairing-exchange',
          tenantId: 'tenant-a', instanceId: 'instance-a',
          grant: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          installationId: 'synthetic-installation-a', sourceStoreId: 'store-a',
          categories: STEPS,
        }],
      ]) {
        assertFailure(await req(server.baseUrl, pathname, {
          method, body, cookie: fixture.owner.cookie,
          headers: { Origin: ORIGIN },
        }), 503, 'IMPORT_RECOVERY_FAILED');
      }
      assert.equal((await req(server.baseUrl, '/healthz')).status, 200);
      assert.equal((await req(server.baseUrl, '/api/import/status', {
        cookie: fixture.owner.cookie,
      })).status, 200);
      await server.kill();
      server = null;
      assertEmptyAuthority(fixture.home);
    } finally {
      if (server) await server.kill();
      cleanupSandbox(fixture.home);
    }
  });

  test('engaged freeze answers before every management and native authority route', async () => {
    const fixture = fixtureHome();
    let server;
    try {
      const preload = path.resolve(__dirname, '../helpers/health-connect-freeze-preload.js');
      server = await spawnServer(fixture.home, {
        ...ENV, NODE_OPTIONS: `--require "${preload.replace(/\\/g, '/')}"`,
      });
      for (const [pathname, method, body] of [
        [BASE, 'GET', null],
        [GRANTS, 'POST', { categories: STEPS, name: 'Test phone' }],
        [`${BASE}/unknown-connector`, 'DELETE', null],
        [CAPABILITIES, 'GET', null],
        [EXCHANGE, 'POST', {}],
      ]) {
        assertFailure(await req(server.baseUrl, pathname, {
          method, body, cookie: fixture.owner.cookie,
          headers: { Origin: ORIGIN },
        }), 503, 'IMPORT_FROZEN');
      }
      assert.equal((await req(server.baseUrl, '/healthz')).status, 200);
      await server.kill();
      server = null;
      assertEmptyAuthority(fixture.home);
    } finally {
      if (server) await server.kill();
      cleanupSandbox(fixture.home);
    }
  });
});
