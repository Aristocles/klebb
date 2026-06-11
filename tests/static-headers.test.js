// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/static-headers.test.js
//
// PWA shell #384: the static handler must send specific headers for
// the service worker, the web app manifest, and the HTML shell, and
// must 404 the SW in demo mode so the public demo doesn't capture
// dead push subscriptions.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createSandbox, cleanupSandbox,
  spawnServer, req,
} = require('./helpers/sandbox');

// Authenticated server: uses a seeded session so the static handler is
// reachable for /, /index.html, SPA fallbacks, and /icons/*. /sw.js and
// /manifest.json are on the public-path allowlist regardless.
test.describe('static headers (#384 PWA shell)', () => {
  let sandbox, srv, cookie;

  test.before(async () => {
    const { fakeAuthState, sessionCookie } = require('./helpers/sandbox');
    const auth = fakeAuthState();
    sandbox = createSandbox({
      credentials: auth.credentials,
      sessions: auth.sessions,
    });
    cookie = sessionCookie(auth.token);
    srv = await spawnServer(sandbox);
  });

  test.after(async () => {
    if (srv) await srv.kill();
    if (sandbox) cleanupSandbox(sandbox);
  });

  test('GET /sw.js sends Cache-Control: no-cache and JS Content-Type', async () => {
    const r = await req(srv.baseUrl, '/sw.js');
    assert.equal(r.status, 200);
    assert.equal(r.headers['cache-control'], 'no-cache');
    assert.match(r.headers['content-type'], /^application\/javascript/);
  });

  test('GET /manifest.json sends Cache-Control: no-cache and application/manifest+json', async () => {
    const r = await req(srv.baseUrl, '/manifest.json');
    assert.equal(r.status, 200);
    assert.equal(r.headers['cache-control'], 'no-cache');
    assert.match(r.headers['content-type'], /application\/manifest\+json/);
    const body = JSON.parse(r.body);
    assert.equal(body.id, '/');
    assert.equal(body.scope, '/');
  });

  test('GET / sends a Content-Security-Policy header that includes push providers', async () => {
    const r = await req(srv.baseUrl, '/', { cookie });
    assert.equal(r.status, 200);
    const csp = r.headers['content-security-policy'];
    assert.ok(csp, 'CSP header should be present on /');
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /worker-src 'self'/);
    assert.match(csp, /https:\/\/web\.push\.apple\.com/);
    assert.match(csp, /https:\/\/\*\.push\.services\.mozilla\.com/);
    assert.match(csp, /https:\/\/\*\.googleapis\.com/);
    assert.match(csp, /https:\/\/esm\.sh/);
    assert.match(csp, /object-src 'none'/);
  });

  test('GET /index.html (direct path) carries the same CSP', async () => {
    const r = await req(srv.baseUrl, '/index.html', { cookie });
    assert.equal(r.status, 200);
    assert.ok(r.headers['content-security-policy']);
  });

  test('GET /unknown-spa-route falls back to index and carries the CSP', async () => {
    const r = await req(srv.baseUrl, '/calendar', { cookie });
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /^text\/html/);
    assert.ok(r.headers['content-security-policy'], 'SPA fallback should still send CSP');
  });

  test('Other static assets still cache normally (no Cache-Control: no-cache)', async () => {
    const r = await req(srv.baseUrl, '/icons/icon-192.png');
    assert.equal(r.status, 200);
    assert.equal(r.headers['cache-control'], undefined);
  });
});

test.describe('demo-mode SW gate (#384)', () => {
  let sandbox, srv;

  test.before(async () => {
    sandbox = createSandbox();
    srv = await spawnServer(sandbox, { KLEBB_DEMO: '1' });
  });

  test.after(async () => {
    if (srv) await srv.kill();
    if (sandbox) cleanupSandbox(sandbox);
  });

  test('GET /sw.js returns 404 in KLEBB_DEMO=1', async () => {
    const r = await req(srv.baseUrl, '/sw.js');
    assert.equal(r.status, 404);
  });

  test('GET /manifest.json still serves in demo mode', async () => {
    const r = await req(srv.baseUrl, '/manifest.json');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /application\/manifest\+json/);
  });
});
