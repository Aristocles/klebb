// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/api/issue-485-auth-hardening.test.js
// Regression seed for #485 — auth-surface hardening: constant-time bearer
// comparisons, invite entropy, admin invite input validation, and the
// /api/build gate.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const {
  createSandbox,
  cleanupSandbox,
  spawnServer,
  req,
  fakeAuthState,
} = require('../helpers/sandbox');

const ADMIN_TOKEN = 'admin-secret-token-485';
const bearer = t => ({ Authorization: `Bearer ${t}` });

describe('#485 constant-time bearer comparison', () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'auth', 'webauthn.js'), 'utf8');
  const adminSrc = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'auth', 'admin-api.js'), 'utf8');

  test('token checks route through timingSafeEqual, not ===', () => {
    assert.match(src, /timingSafeEqual/);
    assert.match(src, /bearerMatches/);
    assert.doesNotMatch(src, /=== agentToken/);
    assert.match(adminSrc, /bearerMatches/);
    assert.doesNotMatch(adminSrc, /=== token\)/);
  });

  test('bearerMatches handles unequal lengths without throwing', () => {
    // timingSafeEqual throws on unequal buffer lengths; the hash-first
    // pattern must absorb that.
    const { bearerMatches } = require('../../auth/webauthn.js');
    assert.equal(bearerMatches('short', 'a-much-longer-expected-token-value'), false);
    assert.equal(bearerMatches('same-token', 'same-token'), true);
    assert.equal(bearerMatches('', 'x'), false);
    assert.equal(bearerMatches(null, 'x'), false);
  });
});

describe('#485 invite entropy', () => {
  test('codes carry 8 random bytes (16 hex chars) after the label', () => {
    const sandbox = createSandbox();
    try {
      for (const key of Object.keys(require.cache)) {
        if (key.includes(path.join('auth', '')) || key.includes(path.join('config', ''))) {
          delete require.cache[key];
        }
      }
      process.env.HEALTH_HOME = sandbox;
      process.env.HEALTH_HOME_WARNED = '1';
      const invites = require('../../auth/invites.js');
      const inv = invites.createInvite({ label: 'alice' });
      const suffix = inv.code.slice('alice-'.length);
      assert.match(suffix, /^[0-9a-f]{16}$/, `expected 16 hex chars, got '${suffix}'`);
    } finally {
      cleanupSandbox(sandbox);
    }
  });
});

describe('#485 admin invite input validation', () => {
  let sandbox, server;
  before(async () => {
    const auth = fakeAuthState('user');
    sandbox = createSandbox({ credentials: auth.credentials, sessions: auth.sessions });
    server = await spawnServer(sandbox, { KLEBB_ADMIN_TOKEN: ADMIN_TOKEN });
  });
  after(async () => { if (server) await server.kill(); if (sandbox) cleanupSandbox(sandbox); });

  test('hostile label is shaped at the boundary, not stored raw', async () => {
    const r = await req(server.baseUrl, '/api/admin/invites', {
      method: 'POST', headers: bearer(ADMIN_TOKEN),
      body: { label: '../Weird $(rm) Label!' },
    });
    assert.equal(r.status, 201);
    assert.match(r.json.label, /^[a-z0-9-]{1,32}$/, `label '${r.json.label}' not shaped`);
  });

  test('empty-after-sanitising label falls back to user', async () => {
    const r = await req(server.baseUrl, '/api/admin/invites', {
      method: 'POST', headers: bearer(ADMIN_TOKEN),
      body: { label: '!!!' },
    });
    assert.equal(r.status, 201);
    assert.equal(r.json.label, 'user');
  });

  test('expiresInDays is clamped to 1..30', async () => {
    for (const [sent, min, max] of [[-5, 1, 1], [0, 1, 1], [9999, 30, 30], [2.9, 2, 2]]) {
      const r = await req(server.baseUrl, '/api/admin/invites', {
        method: 'POST', headers: bearer(ADMIN_TOKEN),
        body: { label: 'user', expiresInDays: sent },
      });
      assert.equal(r.status, 201);
      const days = (new Date(r.json.expiresAt) - Date.now()) / 86400000;
      assert.ok(days >= min - 0.1 && days <= max + 0.1,
        `expiresInDays=${sent} produced ${days.toFixed(2)} days, expected ~${min}`);
    }
  });
});

describe('#485 /api/build requires auth', () => {
  let sandbox, server, auth;
  before(async () => {
    auth = fakeAuthState('user');
    sandbox = createSandbox({ credentials: auth.credentials, sessions: auth.sessions });
    server = await spawnServer(sandbox, { AGENT_API_TOKEN: 'agent-token-485' });
  });
  after(async () => { if (server) await server.kill(); if (sandbox) cleanupSandbox(sandbox); });

  test('anonymous request is 401', async () => {
    const r = await req(server.baseUrl, '/api/build');
    assert.equal(r.status, 401);
  });

  test('a session sees the build info', async () => {
    const r = await req(server.baseUrl, '/api/build', {
      headers: { Cookie: auth.cookie },
    });
    assert.equal(r.status, 200);
    assert.ok('commit' in r.json);
  });

  test('the agent bearer sees the build info', async () => {
    const r = await req(server.baseUrl, '/api/build', { headers: bearer('agent-token-485') });
    assert.equal(r.status, 200);
  });
});
