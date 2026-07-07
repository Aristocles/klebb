// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/api/issue-484-login-recovery.test.js
// Regression seed for #484 — the login page's lost-passkey recovery
// affordance and the invite label contract. Covers: /auth/status exposing
// the hosting mode so the page can word its recovery hint, the login/setup
// copy wiring, and that a recovery invite minted with the SAME label appends
// a credential to the existing user rather than splitting a ghost entry.

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

const PUBLIC = path.resolve(__dirname, '..', '..', 'public');
const read = f => fs.readFileSync(path.join(PUBLIC, f), 'utf8');

describe('#484 /auth/status exposes the hosting mode', () => {
  let sandbox, server;
  before(async () => {
    sandbox = createSandbox();
    server = await spawnServer(sandbox);
  });
  after(async () => { if (server) await server.kill(); if (sandbox) cleanupSandbox(sandbox); });

  test('self-host default reports cloud:false', async () => {
    const r = await req(server.baseUrl, '/auth/status');
    assert.equal(r.status, 200);
    assert.equal(r.json.cloud, false);
  });
});

describe('#484 /auth/status on a hosted instance', () => {
  let sandbox, server;
  before(async () => {
    sandbox = createSandbox();
    server = await spawnServer(sandbox, { KLEBB_CLOUD: '1' });
  });
  after(async () => { if (server) await server.kill(); if (sandbox) cleanupSandbox(sandbox); });

  test('reports cloud:true', async () => {
    const r = await req(server.baseUrl, '/auth/status');
    assert.equal(r.status, 200);
    assert.equal(r.json.cloud, true);
  });
});

describe('#484 login page recovery affordance (wiring)', () => {
  const login = read('login.html');

  test('a recovery element exists and fills on ceremony failure', () => {
    assert.match(login, /id="recovery"/);
    assert.match(login, /showRecovery\(\)/);
    assert.match(login, /Lost access to your passkeys\?/);
  });

  test('copy branches on the hosting mode from /auth/status', () => {
    assert.match(login, /isCloud/);
    assert.match(login, /hosting account/, 'hosted copy points at the provider account');
    assert.match(login, /scripts\/invite\.js/, 'self-host copy points at the invite script');
  });
});

describe('#484 expired-invite copy covers both deployment shapes', () => {
  const setup = read('setup.html');

  test('no longer assumes a separate admin person', () => {
    assert.doesNotMatch(setup, /Ask the admin for a new one/);
    assert.match(setup, /single-use/);
    assert.match(setup, /hosting account/);
    assert.match(setup, /scripts\/invite\.js/);
  });
});

describe('#484 invite label contract: same label appends, no ghost split', () => {
  let sandbox, server, auth;
  const ADMIN_TOKEN = 'admin-secret-token-484';

  before(async () => {
    // An instance already set up for label 'user' with one credential.
    auth = fakeAuthState('user');
    sandbox = createSandbox({ credentials: auth.credentials, sessions: auth.sessions });
    server = await spawnServer(sandbox, {
      KLEBB_CLOUD: '1',
      KLEBB_ADMIN_TOKEN: ADMIN_TOKEN,
    });
  });
  after(async () => { if (server) await server.kill(); if (sandbox) cleanupSandbox(sandbox); });

  test('a recovery invite for the existing label targets the existing user entry', async () => {
    // Mint the invite exactly as the control plane's recovery flow does
    // (default label 'user' matches the original registration).
    const mint = await req(server.baseUrl, '/api/admin/invites', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      body: { label: 'user' },
    });
    assert.equal(mint.status, 201);
    assert.equal(mint.json.label, 'user');

    // The register options ceremony binds to that label: excludeCredentials
    // carries the EXISTING credential, proving the registration would append
    // to the same user entry (a ghost split would exclude nothing).
    const opts = await req(server.baseUrl, '/auth/register/options', {
      method: 'POST',
      body: { code: mint.json.code },
    });
    assert.equal(opts.status, 200);
    assert.equal(opts.json.user.name, 'user', 'ceremony bound to the existing label');
    assert.equal(opts.json.excludeCredentials.length, 1,
      'existing credential excluded: registration appends to the same entry');
  });

  test('a mismatched label WOULD split: the contract the portal must honour', async () => {
    // Document the sharp edge #484 flags: a different label creates a new
    // user entry. The recovery path must therefore mint with the original
    // label ('user' is both sides' default; the portal never overrides it).
    const mint = await req(server.baseUrl, '/api/admin/invites', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      body: { label: 'other' },
    });
    const opts = await req(server.baseUrl, '/auth/register/options', {
      method: 'POST',
      body: { code: mint.json.code },
    });
    assert.equal(opts.status, 200);
    assert.equal(opts.json.user.name, 'other');
    assert.equal(opts.json.excludeCredentials.length, 0,
      'different label sees no existing credentials: it would create a separate entry');
  });
});
