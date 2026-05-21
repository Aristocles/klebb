// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/api/hae-token-api.test.js
// Regression seed for #278 — HAE token managed via Settings UI rather
// than HEALTH_AUTO_EXPORT_TOKEN. Covers the four new endpoints + the
// passkey-auth gate, and confirms a freshly-rotated token immediately
// authenticates the ingest webhook.

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

const TOKEN_PATH = '/api/health-auto-export/token';
const REGEN_PATH = '/api/health-auto-export/token/regenerate';
const INGEST_PATH = '/api/health-auto-export';

describe('#278 HAE token API', () => {
  let sandbox, server, auth;

  before(async () => {
    auth = fakeAuthState('e2e-user');
    sandbox = createSandbox({
      credentials: auth.credentials,
      sessions: auth.sessions,
    });
    // Note: no HEALTH_AUTO_EXPORT_TOKEN passed. The store starts empty.
    server = await spawnServer(sandbox, { HEALTH_AUTO_EXPORT_TOKEN: '' });
  });
  after(async () => {
    if (server) await server.kill();
    if (sandbox) cleanupSandbox(sandbox);
  });

  test('GET token (auth required) returns null when none set', async () => {
    const r = await req(server.baseUrl, TOKEN_PATH, { cookie: auth.cookie });
    assert.equal(r.status, 200);
    assert.equal(r.json.token, null);
  });

  test('GET token without session returns 401', async () => {
    const r = await req(server.baseUrl, TOKEN_PATH);
    assert.equal(r.status, 401);
  });

  test('POST token (auth) generates a 64-char hex token', async () => {
    const r = await req(server.baseUrl, TOKEN_PATH, {
      method: 'POST', cookie: auth.cookie,
    });
    assert.equal(r.status, 200);
    assert.match(r.json.token, /^[a-f0-9]{64}$/);
    assert.ok(r.json.lastRegeneratedAt);
  });

  test('POST token without session returns 401', async () => {
    const r = await req(server.baseUrl, TOKEN_PATH, { method: 'POST' });
    assert.equal(r.status, 401);
  });

  test('POST token a second time returns 409 (already set)', async () => {
    const r = await req(server.baseUrl, TOKEN_PATH, {
      method: 'POST', cookie: auth.cookie,
    });
    assert.equal(r.status, 409);
  });

  test('GET token after generate returns the stored value', async () => {
    const r = await req(server.baseUrl, TOKEN_PATH, { cookie: auth.cookie });
    assert.equal(r.status, 200);
    assert.match(r.json.token, /^[a-f0-9]{64}$/);
  });

  test('persisted under cfg.hae.token in $HEALTH_HOME/config.json', () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(sandbox, 'config.json'), 'utf8'));
    assert.match(cfg.hae.token, /^[a-f0-9]{64}$/);
  });

  test('regenerate (auth) rotates: old token 401s, new token 200s', async () => {
    const before = await req(server.baseUrl, TOKEN_PATH, { cookie: auth.cookie });
    const oldToken = before.json.token;

    const rotated = await req(server.baseUrl, REGEN_PATH, {
      method: 'POST', cookie: auth.cookie,
    });
    assert.equal(rotated.status, 200);
    const newToken = rotated.json.token;
    assert.notEqual(newToken, oldToken);
    assert.match(newToken, /^[a-f0-9]{64}$/);

    // Old token no longer authenticates the ingest webhook.
    const oldIngest = await req(server.baseUrl, INGEST_PATH, {
      method: 'POST',
      body: { data: { metrics: [] } },
      headers: { Authorization: `Bearer ${oldToken}` },
    });
    assert.equal(oldIngest.status, 401);

    // New token does.
    const newIngest = await req(server.baseUrl, INGEST_PATH, {
      method: 'POST',
      body: { data: { metrics: [] } },
      headers: { Authorization: `Bearer ${newToken}` },
    });
    assert.equal(newIngest.status, 200);
  });

  test('regenerate without session returns 401', async () => {
    const r = await req(server.baseUrl, REGEN_PATH, { method: 'POST' });
    assert.equal(r.status, 401);
  });

  test('DELETE token (auth) clears it; ingest then 501s', async () => {
    const r = await req(server.baseUrl, TOKEN_PATH, {
      method: 'DELETE', cookie: auth.cookie,
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);

    const after = await req(server.baseUrl, TOKEN_PATH, { cookie: auth.cookie });
    assert.equal(after.json.token, null);

    const ingest = await req(server.baseUrl, INGEST_PATH, {
      method: 'POST', body: { data: { metrics: [] } },
    });
    assert.equal(ingest.status, 501);
  });

  test('DELETE without session returns 401', async () => {
    const r = await req(server.baseUrl, TOKEN_PATH, { method: 'DELETE' });
    assert.equal(r.status, 401);
  });
});

describe('#278 HAE env var migration on boot', () => {
  let sandbox, server, auth;
  const ENV_TOKEN = 'legacy-env-supplied-token-1234567890abcdef';

  before(async () => {
    auth = fakeAuthState('e2e-user');
    sandbox = createSandbox({
      credentials: auth.credentials,
      sessions: auth.sessions,
    });
    // Spawn with the legacy env var set and config.json empty: the boot
    // path should migrate the value into config.json.
    server = await spawnServer(sandbox, { HEALTH_AUTO_EXPORT_TOKEN: ENV_TOKEN });
  });
  after(async () => {
    if (server) await server.kill();
    if (sandbox) cleanupSandbox(sandbox);
  });

  test('config.json now contains cfg.hae.token from the env var', () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(sandbox, 'config.json'), 'utf8'));
    assert.equal(cfg.hae.token, ENV_TOKEN);
    assert.ok(cfg.hae.migratedFromEnvAt);
  });

  test('GET /api/health-auto-export/token returns the migrated value', async () => {
    const r = await req(server.baseUrl, TOKEN_PATH, { cookie: auth.cookie });
    assert.equal(r.json.token, ENV_TOKEN);
  });

  test('ingest still authenticates with the migrated token', async () => {
    const r = await req(server.baseUrl, INGEST_PATH, {
      method: 'POST',
      body: { data: { metrics: [] } },
      headers: { Authorization: `Bearer ${ENV_TOKEN}` },
    });
    assert.equal(r.status, 200);
  });
});
