// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/api/issue-471-add-device.test.js
// Regression seed for #471 — an authenticated session can add a passkey to
// its own account regardless of requireInviteForRegistration (that flag gates
// UNAUTHENTICATED registration only). The Settings > Security "Add a passkey"
// button relies on this. Verifies the /available and /register/options gates;
// the actual attestation ceremony needs a real authenticator so is not driven
// here (the verify step is exercised via the invite flow tests).

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const {
  createSandbox,
  cleanupSandbox,
  spawnServer,
  req,
  fakeAuthState,
} = require('../helpers/sandbox');

describe('#471 authenticated add-device gate (invite required = default)', () => {
  let sandbox, server, auth;

  before(async () => {
    auth = fakeAuthState('user');
    // requireInviteForRegistration defaults to true (no config override): the
    // gate must still let an authenticated session through for add-device.
    sandbox = createSandbox({ credentials: auth.credentials, sessions: auth.sessions });
    server = await spawnServer(sandbox);
  });
  after(async () => {
    if (server) await server.kill();
    if (sandbox) cleanupSandbox(sandbox);
  });

  test('GET /auth/register/available returns add-device for a live session', async () => {
    const r = await req(server.baseUrl, '/auth/register/available', { cookie: auth.cookie });
    assert.equal(r.status, 200);
    assert.equal(r.json.available, true);
    assert.equal(r.json.reason, 'add-device');
  });

  test('GET /auth/register/available is closed without a session', async () => {
    const r = await req(server.baseUrl, '/auth/register/available');
    assert.equal(r.status, 200);
    assert.equal(r.json.available, false);
    assert.equal(r.json.reason, 'closed');
  });

  test('POST /auth/register/options issues options for a live session (no invite)', async () => {
    const r = await req(server.baseUrl, '/auth/register/options', {
      method: 'POST', cookie: auth.cookie, body: {},
    });
    assert.equal(r.status, 200);
    // simplewebauthn options carry a challenge + rp; presence is enough here.
    assert.ok(r.json.challenge, 'should return registration options with a challenge');
    assert.ok(r.json.user, 'should bind options to a user');
  });

  test('POST /auth/register/options is rejected without a session', async () => {
    const r = await req(server.baseUrl, '/auth/register/options', { method: 'POST', body: {} });
    assert.equal(r.status, 403);
  });
});
