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
  createSandbox, cleanupSandbox, spawnServer, req, fakeAuthState,
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

function fixtureHome() {
  const owner = fakeAuthState('owner-a');
  const other = fakeAuthState('owner-b');
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
  if (!fs.existsSync(file)) return;
  const store = JSON.parse(fs.readFileSync(file, 'utf8'));
  // Instance identity/epoch initialisation is allowed. Refusal must issue
  // zero grants/connectors, rather than happen to avoid creating a file.
  assert.deepEqual(store.grants, []);
  assert.deepEqual(store.connectors, []);
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
  const beforeRequest = Date.now();
  const response = await req(server.baseUrl, GRANTS, {
    method: 'POST',
    cookie: owner.cookie,
    headers: { Origin: ORIGIN },
    body: { categories: STEPS, name: 'Test phone', ...changes },
  });
  const afterRequest = Date.now();
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
    const expired = fakeAuthState('expired-owner');
    expired.sessions[expired.token].created = Date.now() - 31 * 86400000;
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
    let child;
    try {
      child = await spawnServer(ownership.home, ENV);
      const { paired } = await pair(child, ownership.owner);
      const beforeList = await listing(child, ownership.owner);
      assert.deepEqual((await listing(child, ownership.other)).connectors, []);
      await child.kill();
      child = null;
      const beforeState = JSON.parse(fs.readFileSync(authorityPath(ownership.home), 'utf8'));
      assert.equal(beforeState.grants.length, 1);
      assert.equal(beforeState.connectors.length, 1);
      assert.equal(beforeState.grants[0].ownerId, 'owner-a');
      assert.equal(beforeState.connectors[0].ownerId, 'owner-a');
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
      const afterState = JSON.parse(fs.readFileSync(authorityPath(ownership.home), 'utf8'));
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
      const state = JSON.parse(fs.readFileSync(authorityPath(concurrent.home), 'utf8'));
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
      const refused = await binaryGet(server, '/api/export', fixture.owner.cookie);
      assert.equal(refused.status, 500);
      assert.deepEqual(JSON.parse(refused.body.toString('utf8')), {
        error: 'export failed: native-history-export-unsupported',
      });
      assert.equal(fs.readFileSync(authorityPath(fixture.home)).equals(authorityBefore), true,
        'refused export changed retained native authority');
      assert.equal(fs.readdirSync(fixture.home).some(name =>
        name.startsWith('export-staging.') || name.endsWith('.zip')
          || name === 'klebb-export.json'), false, 'refused export left success output');
      assert.equal((await req(server.baseUrl, CAPABILITIES, {
        headers: nativeHeaders(paired.credential),
      })).status, 200, 'export refusal revoked native authority');
      const saved = await req(server.baseUrl, '/api/manifests/authority-sentinel/data', {
        cookie: fixture.owner.cookie,
      });
      assert.equal(saved.status, 200);
      assert.deepEqual(saved.json.data, ROWS);
      await server.kill();
      server = null;
      const persisted = fs.readFileSync(authorityPath(fixture.home), 'utf8');
      const state = JSON.parse(persisted);
      const verifier = 'sha256:' + crypto.createHash('sha256')
        .update(paired.credential, 'utf8').digest('hex');
      const grantVerifier = 'sha256:' + crypto.createHash('sha256')
        .update(grant.grant, 'utf8').digest('hex');
      assert.equal(state.version, 1);
      assert.equal(state.tenantId, paired.tenantId);
      assert.equal(state.instanceId, paired.instanceId);
      assert.equal(state.restoreEpoch, paired.restoreEpoch);
      assert.equal(state.connectors.length, 1);
      assert.equal(state.connectors[0].ownerId, 'owner-a');
      assert.equal(state.connectors[0].installationId, 'synthetic-installation-a');
      assert.equal(state.connectors[0].sourceStoreId, grant.sourceStoreId);
      assert.deepEqual(state.connectors[0].categories, STEPS);
      assert.deepEqual(state.connectors[0].generations, { StepsRecord: '1' });
      assert.equal(state.connectors[0].credentialVerifier, verifier);
      assert.equal(state.connectors[0].restoreEpoch, paired.restoreEpoch);
      assert.equal(state.connectors[0].revokedAt, null);
      const consumed = state.grants.find(item => item.verifier === grantVerifier);
      assert.ok(consumed, 'the independently hashed grant verifier is stored');
      assert.equal(consumed.ownerId, 'owner-a');
      assert.equal(consumed.instanceId, paired.instanceId);
      assert.equal(consumed.sourceStoreId, paired.sourceStoreId);
      assert.equal(consumed.restoreEpoch, paired.restoreEpoch);
      assert.deepEqual(consumed.categories, STEPS);
      assert.equal(consumed.name, 'Test phone');
      assert.ok(Number.isFinite(Date.parse(consumed.consumedAt)));
      assertNoSecrets(persisted, [paired.credential, grant.grant]);
      legacyFixture = fixtureHome();
      assert.notEqual(legacyFixture.home, fixture.home);
      const markers = [paired.credential, grant.grant, cursorGrant.grant, verifier,
        grantVerifier, ADMIN, CHAT, CURSOR];
      const markerFile = path.join(legacyFixture.home, 'credentials',
        'export-exclusion-sentinel.json');
      fs.writeFileSync(markerFile, JSON.stringify({ markers }));
      const markerInput = fs.readFileSync(markerFile, 'utf8');
      for (const marker of markers) {
        assert.ok(typeof marker === 'string' && marker.length > 10);
        assert.equal(markerInput.includes(marker), true, 'excluded source marker was absent');
      }
      legacyServer = await spawnServer(legacyFixture.home, ENV);
      const legacyLogs = observeLogs(legacyServer);
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
        paired.credential, grant.grant, cursorGrant.grant, verifier, grantVerifier,
        ADMIN, CHAT, CURSOR,
      ]);
      assertNoSecrets(refused.body.toString('utf8') + legacyLogs(), markers);
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
      const file = authorityPath(fixture.home);
      const store = JSON.parse(fs.readFileSync(file, 'utf8'));
      // This cold fixture follows the reviewed pending #772 persisted schema.
      assert.ok(Array.isArray(store.grants) && store.grants.length === 1,
        'reviewed authority store must expose the one cold-start grant fixture');
      assert.equal(store.version, 1);
      assert.deepEqual(store.connectors, []);
      assert.equal(store.grants[0].ownerId, 'owner-a');
      assert.equal(store.grants[0].instanceId, grant.instanceId);
      assert.equal(store.grants[0].sourceStoreId, grant.sourceStoreId);
      assert.equal(store.grants[0].consumedAt, null);
      assert.equal(store.grants[0].verifier, 'sha256:' + crypto.createHash('sha256')
        .update(grant.grant, 'utf8').digest('hex'));
      store.grants[0].expiresAt = '2000-01-01T00:00:00.000Z';
      fs.writeFileSync(file, JSON.stringify(store), { mode: 0o600 });
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
      fs.writeFileSync(path.join(fixture.home, 'credentials', 'webauthn.json'),
        JSON.stringify({ users: {} }));
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
