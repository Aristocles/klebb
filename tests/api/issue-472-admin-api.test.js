// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/api/issue-472-admin-api.test.js
// Regression seed for #472 — the Klebb Cloud control-plane admin API and the
// Cloud bootstrap gate. Covers admin-token auth (disabled when unset, 401
// without/with wrong token), the read-only credential list, mint-invite (URL
// built on the instance's own origin), the absence of any admin delete, and
// that KLEBB_CLOUD closes open first-visitor bootstrap.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const {
  createSandbox,
  cleanupSandbox,
  spawnServer,
  req,
  fakeAuthState,
} = require('../helpers/sandbox');

const ADMIN_TOKEN = 'admin-secret-token-abcdef0123456789';
const bearer = t => ({ Authorization: `Bearer ${t}` });

describe('#472 admin API disabled when KLEBB_ADMIN_TOKEN unset', () => {
  let sandbox, server, auth;
  before(async () => {
    auth = fakeAuthState('user');
    sandbox = createSandbox({ credentials: auth.credentials, sessions: auth.sessions });
    server = await spawnServer(sandbox); // no KLEBB_ADMIN_TOKEN
  });
  after(async () => { if (server) await server.kill(); if (sandbox) cleanupSandbox(sandbox); });

  test('GET /api/admin/credentials is 401 even with a bearer', async () => {
    const r = await req(server.baseUrl, '/api/admin/credentials', { headers: bearer(ADMIN_TOKEN) });
    assert.equal(r.status, 401);
  });
});

describe('#472 admin API (token configured)', () => {
  let sandbox, server, auth;
  before(async () => {
    auth = fakeAuthState('user');
    sandbox = createSandbox({ credentials: auth.credentials, sessions: auth.sessions });
    server = await spawnServer(sandbox, {
      KLEBB_ADMIN_TOKEN: ADMIN_TOKEN,
      HEALTH_ORIGIN: 'https://alice.klebb.app',
      HEALTH_RP_ID: 'alice.klebb.app',
    });
  });
  after(async () => { if (server) await server.kill(); if (sandbox) cleanupSandbox(sandbox); });

  test('rejects a missing token', async () => {
    const r = await req(server.baseUrl, '/api/admin/credentials');
    assert.equal(r.status, 401);
  });

  test('rejects a wrong token', async () => {
    const r = await req(server.baseUrl, '/api/admin/credentials', { headers: bearer('nope') });
    assert.equal(r.status, 401);
  });

  test('lists credentials with the label and no sensitive fields', async () => {
    const r = await req(server.baseUrl, '/api/admin/credentials', { headers: bearer(ADMIN_TOKEN) });
    assert.equal(r.status, 200);
    assert.equal(r.json.credentials.length, 1);
    const c = r.json.credentials[0];
    assert.equal(c.label, 'user');
    assert.ok('registeredAt' in c);
    assert.equal(c.publicKey, undefined);
    assert.equal(c.counter, undefined);
  });

  test('mints an invite with a register URL on the instance origin', async () => {
    const r = await req(server.baseUrl, '/api/admin/invites', {
      method: 'POST', headers: bearer(ADMIN_TOKEN), body: { label: 'newphone' },
    });
    assert.equal(r.status, 201);
    assert.equal(r.json.label, 'newphone');
    assert.match(r.json.code, /^newphone-/);
    assert.ok(
      r.json.registerUrl.startsWith('https://alice.klebb.app/register?code='),
      `register URL must be on the instance origin, got ${r.json.registerUrl}`,
    );
    // The minted code actually works against /auth/register/available.
    const avail = await req(server.baseUrl, `/auth/register/available?code=${encodeURIComponent(r.json.code)}`);
    assert.equal(avail.json.available, true);
    assert.equal(avail.json.reason, 'invite');
  });

  test('exposes no admin delete route', async () => {
    const r = await req(server.baseUrl, '/api/admin/credentials/anything', {
      method: 'DELETE', headers: bearer(ADMIN_TOKEN),
    });
    // The admin handler has no delete; it falls through to 404 (not 200).
    assert.equal(r.status, 404);
  });
});

describe('#472 Cloud bootstrap gate', () => {
  let sandbox, server;
  before(async () => {
    // Empty store + KLEBB_CLOUD: first-visitor bootstrap must be closed.
    sandbox = createSandbox();
    server = await spawnServer(sandbox, {
      KLEBB_CLOUD: '1',
      HEALTH_ORIGIN: 'https://alice.klebb.app',
      HEALTH_RP_ID: 'alice.klebb.app',
    });
  });
  after(async () => { if (server) await server.kill(); if (sandbox) cleanupSandbox(sandbox); });

  test('no-code availability is awaiting-invite, not bootstrap', async () => {
    const r = await req(server.baseUrl, '/auth/register/available');
    assert.equal(r.status, 200);
    assert.equal(r.json.available, false);
    assert.equal(r.json.reason, 'awaiting-invite');
  });

  test('register/options without a code is rejected', async () => {
    const r = await req(server.baseUrl, '/auth/register/options', { method: 'POST', body: {} });
    assert.equal(r.status, 403);
  });
});

describe('#472 self-hosted bootstrap stays open', () => {
  let sandbox, server;
  before(async () => {
    sandbox = createSandbox(); // empty store, no KLEBB_CLOUD
    server = await spawnServer(sandbox);
  });
  after(async () => { if (server) await server.kill(); if (sandbox) cleanupSandbox(sandbox); });

  test('no-code availability is bootstrap', async () => {
    const r = await req(server.baseUrl, '/auth/register/available');
    assert.equal(r.json.available, true);
    assert.equal(r.json.reason, 'bootstrap');
  });
});
