// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/api/issue-482-invite-mint.test.js
// Regression seed for #482 — Settings > Security adds devices via a QR/link
// invite. POST /api/invites mints a single-use register invite bound to the
// CALLER's own account (label = session userId), so registering on another
// device via the link lands the passkey under the same label. Also pins the
// /api/instance cloud flag the pane uses for the portal hint.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const {
  createSandbox,
  cleanupSandbox,
  spawnServer,
  req,
  fakeAuthState,
} = require('../helpers/sandbox');

describe('#482 POST /api/invites (session-authed add-device mint)', () => {
  let sandbox, server, auth;

  before(async () => {
    auth = fakeAuthState('wren');
    sandbox = createSandbox({ credentials: auth.credentials, sessions: auth.sessions });
    server = await spawnServer(sandbox);
  });
  after(async () => {
    if (server) await server.kill();
    if (sandbox) cleanupSandbox(sandbox);
  });

  test('401 without a session', async () => {
    const r = await req(server.baseUrl, '/api/invites', { method: 'POST' });
    assert.equal(r.status, 401);
  });

  test('mints an invite bound to the session user, with a registerUrl', async () => {
    const r = await req(server.baseUrl, '/api/invites', { method: 'POST', cookie: auth.cookie });
    assert.equal(r.status, 201);
    assert.ok(r.json.code, 'invite code returned');
    assert.equal(r.json.label, 'wren', 'label bound to the session userId, not client input');
    assert.ok(r.json.expiresAt, 'expiry returned');
    assert.ok(
      r.json.registerUrl.includes(`/register?code=${encodeURIComponent(r.json.code)}`),
      'registerUrl carries the code'
    );
  });

  test('the minted code opens registration under the same label', async () => {
    const mint = await req(server.baseUrl, '/api/invites', { method: 'POST', cookie: auth.cookie });
    // As the second device would see it: no session, only the code.
    const r = await req(server.baseUrl, `/auth/register/available?code=${encodeURIComponent(mint.json.code)}`);
    assert.equal(r.status, 200);
    assert.equal(r.json.available, true);
    assert.equal(r.json.reason, 'invite');
    assert.equal(r.json.label, 'wren', 'registration would land under the inviter\'s account');
  });

  test('label cannot be overridden by the request body', async () => {
    const r = await req(server.baseUrl, '/api/invites', {
      method: 'POST', cookie: auth.cookie, body: { label: 'attacker' },
    });
    assert.equal(r.status, 201);
    assert.equal(r.json.label, 'wren');
  });
});

describe('#482 demo mode: invite minting is closed', () => {
  let sandbox, server, auth;

  before(async () => {
    auth = fakeAuthState('demo');
    sandbox = createSandbox({ credentials: auth.credentials, sessions: auth.sessions });
    server = await spawnServer(sandbox, { KLEBB_DEMO: '1' });
  });
  after(async () => {
    if (server) await server.kill();
    if (sandbox) cleanupSandbox(sandbox);
  });

  test('403 in demo mode (register page is hidden there anyway)', async () => {
    const r = await req(server.baseUrl, '/api/invites', { method: 'POST', cookie: auth.cookie });
    assert.equal(r.status, 403);
  });
});

describe('#482 /api/instance exposes cloud posture for the portal hint', () => {
  test('cloud=false by default', async () => {
    const sandbox = createSandbox();
    const server = await spawnServer(sandbox);
    try {
      const r = await req(server.baseUrl, '/api/instance');
      assert.equal(r.json.cloud, false);
    } finally {
      await server.kill();
      cleanupSandbox(sandbox);
    }
  });

  test('cloud=true with KLEBB_CLOUD=1', async () => {
    const auth = fakeAuthState('wren');
    const sandbox = createSandbox({ credentials: auth.credentials, sessions: auth.sessions });
    const server = await spawnServer(sandbox, { KLEBB_CLOUD: '1' });
    try {
      const r = await req(server.baseUrl, '/api/instance', { cookie: auth.cookie });
      assert.equal(r.json.cloud, true);
    } finally {
      await server.kill();
      cleanupSandbox(sandbox);
    }
  });
});
