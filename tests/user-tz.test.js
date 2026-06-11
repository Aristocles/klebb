// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/user-tz.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  createSandbox, cleanupSandbox,
  spawnServer, req,
  fakeAuthState, sessionCookie,
} = require('./helpers/sandbox');

test.describe('POST /api/user/tz', () => {
  let sandbox, srv, cookie;

  test.before(async () => {
    const auth = fakeAuthState();
    sandbox = createSandbox({ credentials: auth.credentials, sessions: auth.sessions });
    cookie = sessionCookie(auth.token);
    srv = await spawnServer(sandbox, { KLEBB_DEMO: '1' });
  });

  test.after(async () => {
    if (srv) await srv.kill();
    if (sandbox) cleanupSandbox(sandbox);
  });

  test('valid IANA tz: persists to user.json and returns changed=true', async () => {
    const r = await req(srv.baseUrl, '/api/user/tz', {
      method: 'POST',
      cookie,
      body: { tz: 'Australia/Melbourne' },
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.tz, 'Australia/Melbourne');
    assert.equal(r.json.changed, true);

    const fileContents = JSON.parse(fs.readFileSync(path.join(sandbox, 'user.json'), 'utf8'));
    assert.equal(fileContents.tz, 'Australia/Melbourne');
  });

  test('repeated POST with same tz: changed=false, no rewrite', async () => {
    const r = await req(srv.baseUrl, '/api/user/tz', {
      method: 'POST',
      cookie,
      body: { tz: 'Australia/Melbourne' },
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.changed, false);
  });

  test('different tz: persists and returns changed=true', async () => {
    const r = await req(srv.baseUrl, '/api/user/tz', {
      method: 'POST',
      cookie,
      body: { tz: 'America/New_York' },
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.changed, true);
    const fileContents = JSON.parse(fs.readFileSync(path.join(sandbox, 'user.json'), 'utf8'));
    assert.equal(fileContents.tz, 'America/New_York');
  });

  test('rejects malformed tz with 400', async () => {
    const r = await req(srv.baseUrl, '/api/user/tz', {
      method: 'POST',
      cookie,
      body: { tz: 'Mars/Olympus' },
    });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, 'invalid tz');
  });

  test('rejects missing tz with 400', async () => {
    const r = await req(srv.baseUrl, '/api/user/tz', {
      method: 'POST',
      cookie,
      body: {},
    });
    assert.equal(r.status, 400);
  });

  test('unauthenticated request returns 302/401 (auth gate, not endpoint reachable)', async () => {
    const r = await req(srv.baseUrl, '/api/user/tz', {
      method: 'POST',
      body: { tz: 'Australia/Melbourne' },
    });
    // The gate returns 302 to /login.html in normal mode and 401 in
    // demo for /api/* paths. Either way, 200 would be a regression.
    assert.notEqual(r.status, 200);
  });
});
