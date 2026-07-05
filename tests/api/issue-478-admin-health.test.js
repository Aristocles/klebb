// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/api/issue-478-admin-health.test.js
// Regression seed for #478 — GET /api/admin/health, the provisioner's
// readiness poll. Covers the admin-token gate (disabled when unset, 401
// missing/wrong), the snapshot shape/values under known env, and that no
// sensitive material leaks.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const {
  createSandbox,
  cleanupSandbox,
  spawnServer,
  req,
  fakeAuthState,
} = require('../helpers/sandbox');

const ADMIN_TOKEN = 'admin-health-token-0123456789abcdef';
const bearer = t => ({ Authorization: `Bearer ${t}` });

describe('#478 /api/admin/health disabled when KLEBB_ADMIN_TOKEN unset', () => {
  let sandbox, server;
  before(async () => {
    sandbox = createSandbox();
    server = await spawnServer(sandbox); // no admin token
  });
  after(async () => { if (server) await server.kill(); if (sandbox) cleanupSandbox(sandbox); });

  test('401 even with a bearer supplied', async () => {
    const r = await req(server.baseUrl, '/api/admin/health', { headers: bearer(ADMIN_TOKEN) });
    assert.equal(r.status, 401);
  });
});

describe('#478 /api/admin/health (cloud instance, empty store)', () => {
  let sandbox, server;
  before(async () => {
    sandbox = createSandbox(); // no credentials seeded
    server = await spawnServer(sandbox, {
      KLEBB_ADMIN_TOKEN: ADMIN_TOKEN,
      KLEBB_CLOUD: '1',
      HEALTH_ORIGIN: 'https://alice.klebb.app',
      HEALTH_RP_ID: 'alice.klebb.app',
    });
  });
  after(async () => { if (server) await server.kill(); if (sandbox) cleanupSandbox(sandbox); });

  test('401 without a token, 401 with a wrong token', async () => {
    assert.equal((await req(server.baseUrl, '/api/admin/health')).status, 401);
    assert.equal((await req(server.baseUrl, '/api/admin/health', { headers: bearer('nope') })).status, 401);
  });

  test('snapshot reflects awaiting-setup cloud posture and the bound subdomain', async () => {
    const r = await req(server.baseUrl, '/api/admin/health', { headers: bearer(ADMIN_TOKEN) });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, {
      ok: true,
      setup: false,
      cloud: true,
      rpId: 'alice.klebb.app',
      origin: 'https://alice.klebb.app',
      credentialCount: 0,
    });
  });
});

describe('#478 /api/admin/health (claimed self-host-style instance)', () => {
  let sandbox, server, auth;
  before(async () => {
    auth = fakeAuthState('user');
    sandbox = createSandbox({ credentials: auth.credentials, sessions: auth.sessions });
    // Admin token set, but KLEBB_CLOUD not: health must report cloud:false.
    server = await spawnServer(sandbox, { KLEBB_ADMIN_TOKEN: ADMIN_TOKEN });
  });
  after(async () => { if (server) await server.kill(); if (sandbox) cleanupSandbox(sandbox); });

  test('reports setup:true, cloud:false, and counts the credential', async () => {
    const r = await req(server.baseUrl, '/api/admin/health', { headers: bearer(ADMIN_TOKEN) });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.setup, true);
    assert.equal(r.json.cloud, false);
    assert.equal(r.json.credentialCount, 1);
  });

  test('never leaks keys, counters, tokens, or session material', async () => {
    const r = await req(server.baseUrl, '/api/admin/health', { headers: bearer(ADMIN_TOKEN) });
    const body = r.body;
    assert.ok(!body.includes('publicKey'), 'no publicKey field');
    assert.ok(!body.includes('counter'), 'no counter field');
    assert.ok(!body.includes(ADMIN_TOKEN), 'admin token never echoed');
    assert.deepEqual(
      Object.keys(r.json).sort(),
      ['cloud', 'credentialCount', 'ok', 'origin', 'rpId', 'setup'],
      'exact response shape pinned (Seam B contract)',
    );
  });

  test('counts credentials across multiple labels', async () => {
    // Second label with two more credentials, written directly to the store.
    const fs = require('fs');
    const path = require('path');
    const file = path.join(sandbox, 'credentials', 'webauthn.json');
    const store = JSON.parse(fs.readFileSync(file, 'utf8'));
    store.users.other = {
      credentials: [1, 2].map(n => ({
        id: 'x-' + n + '-' + crypto.randomBytes(4).toString('hex'),
        publicKey: 'pk', counter: 0, deviceType: 'test',
        registeredAt: new Date().toISOString(),
      })),
    };
    fs.writeFileSync(file, JSON.stringify(store, null, 2));

    const r = await req(server.baseUrl, '/api/admin/health', { headers: bearer(ADMIN_TOKEN) });
    assert.equal(r.json.credentialCount, 3);
  });
});
