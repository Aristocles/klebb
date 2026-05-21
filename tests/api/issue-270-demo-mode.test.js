// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/api/issue-270-demo-mode.test.js
//
// Coverage for #270 KLEBB_DEMO env flag. Each test boots a fresh sandbox
// in demo mode and asserts the gate behaves as documented in the issue.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { createSandbox, cleanupSandbox, spawnServer, req, sessionCookie } = require('../helpers/sandbox');

const SAMPLE_MANIFEST = {
  $schema: 'klebb.datafile.v1',
  meta: { id: 'demo-card', label: 'Demo card', view: { component: 'generic-card' } },
  data: [{ date: '2026-05-20', value: 1 }],
};

function withDemoServer(seed = {}) {
  return async function setup() {
    const box = createSandbox({ seed: { 'demo-card.json': SAMPLE_MANIFEST, ...seed } });
    const srv = await spawnServer(box, { KLEBB_DEMO: '1' });
    return { box, srv, cleanup: async () => { await srv.kill(); cleanupSandbox(box); } };
  };
}

describe('KLEBB_DEMO server-side', () => {
  test('GET /api/instance reports demo:true', async () => {
    const { srv, cleanup } = await withDemoServer()();
    try {
      const r = await req(srv.baseUrl, '/api/instance', { cookie: 'placeholder' });
      // /api/instance is gated by auth; we need a session. Easier: hit it
      // through demo-login first.
      const login = await req(srv.baseUrl, '/auth/demo-login', { method: 'POST' });
      assert.equal(login.status, 200);
      const cookie = login.headers['set-cookie'][0].split(';')[0];
      const inst = await req(srv.baseUrl, '/api/instance', { cookie });
      assert.equal(inst.status, 200);
      assert.equal(inst.json.demo, true);
    } finally { await cleanup(); }
  });

  test('POST /auth/demo-login mints a session for the demo user', async () => {
    const { srv, cleanup } = await withDemoServer()();
    try {
      const r = await req(srv.baseUrl, '/auth/demo-login', { method: 'POST' });
      assert.equal(r.status, 200);
      assert.equal(r.json.label, 'demo');
      assert.ok(r.headers['set-cookie'], 'demo-login should set a cookie');
      assert.match(r.headers['set-cookie'][0], /^klebb_session=[a-f0-9]+/);
    } finally { await cleanup(); }
  });

  test('passkey + invite + setup routes return 410 in demo mode', async () => {
    const { srv, cleanup } = await withDemoServer()();
    try {
      for (const path of [
        '/auth/register/options',
        '/auth/register/verify',
        '/auth/login/options',
        '/auth/login/verify',
        '/auth/register/available',
      ]) {
        const r = await req(srv.baseUrl, path, { method: 'POST', body: {} });
        assert.equal(r.status, 410, `${path} should be 410 Gone`);
      }
    } finally { await cleanup(); }
  });

  test('/setup.html and /register redirect to /login.html in demo mode', async () => {
    const { srv, cleanup } = await withDemoServer()();
    try {
      for (const path of ['/setup.html', '/register']) {
        const r = await req(srv.baseUrl, path);
        assert.equal(r.status, 302, `${path} should redirect`);
        assert.equal(r.headers['location'], '/login.html');
      }
    } finally { await cleanup(); }
  });

  test('unauthenticated requests still get bounced to /login.html', async () => {
    const { srv, cleanup } = await withDemoServer()();
    try {
      const r = await req(srv.baseUrl, '/');
      assert.equal(r.status, 302);
      assert.equal(r.headers['location'], '/login.html');
    } finally { await cleanup(); }
  });

  test('POST /api/chat returns the canned demo reply, no outbound HTTP', async () => {
    const { srv, cleanup } = await withDemoServer()();
    try {
      const login = await req(srv.baseUrl, '/auth/demo-login', { method: 'POST' });
      const cookie = login.headers['set-cookie'][0].split(';')[0];
      const r = await req(srv.baseUrl, '/api/chat', {
        method: 'POST',
        cookie,
        body: { messages: [{ role: 'user', content: 'hello' }] },
      });
      assert.equal(r.status, 200);
      assert.match(r.json.reply, /public demo/i);
      assert.match(r.json.reply, /klebb\.app/i);
      assert.equal(typeof r.json.speak, 'undefined', 'text-mode reply should not include speak');
    } finally { await cleanup(); }
  });

  test('POST /api/chat in voiceMode returns both reply and speak fields', async () => {
    const { srv, cleanup } = await withDemoServer()();
    try {
      const login = await req(srv.baseUrl, '/auth/demo-login', { method: 'POST' });
      const cookie = login.headers['set-cookie'][0].split(';')[0];
      const r = await req(srv.baseUrl, '/api/chat', {
        method: 'POST',
        cookie,
        body: { messages: [{ role: 'user', content: 'hi' }], voiceMode: true },
      });
      assert.equal(r.status, 200);
      assert.equal(typeof r.json.reply, 'string');
      assert.equal(typeof r.json.speak, 'string');
      assert.equal(r.json.reply, r.json.speak);
    } finally { await cleanup(); }
  });

  test('GET /api/chat/status reports configured:true with demo:true marker', async () => {
    const { srv, cleanup } = await withDemoServer()();
    try {
      const login = await req(srv.baseUrl, '/auth/demo-login', { method: 'POST' });
      const cookie = login.headers['set-cookie'][0].split(';')[0];
      const r = await req(srv.baseUrl, '/api/chat/status', { cookie });
      assert.equal(r.status, 200);
      assert.equal(r.json.configured, true);
      assert.equal(r.json.demo, true);
    } finally { await cleanup(); }
  });

  test('voice endpoints return 503 in demo mode', async () => {
    const { srv, cleanup } = await withDemoServer()();
    try {
      const login = await req(srv.baseUrl, '/auth/demo-login', { method: 'POST' });
      const cookie = login.headers['set-cookie'][0].split(';')[0];
      for (const path of ['/api/voice/config', '/api/voice/tts', '/api/voice/asr']) {
        const method = path === '/api/voice/config' ? 'GET' : 'POST';
        const r = await req(srv.baseUrl, path, { method, cookie, body: method === 'POST' ? { text: 'x' } : null });
        assert.equal(r.status, 503, `${path} should be 503`);
        assert.equal(r.json.demo, true);
      }
    } finally { await cleanup(); }
  });

  test('PATCH /api/manifests/:id with meta.enabled is rejected with 403', async () => {
    const { srv, cleanup } = await withDemoServer()();
    try {
      const login = await req(srv.baseUrl, '/auth/demo-login', { method: 'POST' });
      const cookie = login.headers['set-cookie'][0].split(';')[0];
      const r = await req(srv.baseUrl, '/api/manifests/demo-card', {
        method: 'PATCH',
        cookie,
        body: { meta: { enabled: false } },
      });
      assert.equal(r.status, 403);
      assert.match(r.json.error, /demo mode/i);
    } finally { await cleanup(); }
  });

  test('PATCH with non-enabled meta fields is allowed in demo mode', async () => {
    const { srv, cleanup } = await withDemoServer()();
    try {
      const login = await req(srv.baseUrl, '/auth/demo-login', { method: 'POST' });
      const cookie = login.headers['set-cookie'][0].split(';')[0];
      const r = await req(srv.baseUrl, '/api/manifests/demo-card', {
        method: 'PATCH',
        cookie,
        body: { meta: { label: 'Renamed in demo' } },
      });
      assert.equal(r.status, 200);
      assert.equal(r.json.ok, true);
    } finally { await cleanup(); }
  });

  test('POST /api/settings/cards/:id/disable is rejected with 403 in demo mode', async () => {
    const { srv, cleanup } = await withDemoServer()();
    try {
      const login = await req(srv.baseUrl, '/auth/demo-login', { method: 'POST' });
      const cookie = login.headers['set-cookie'][0].split(';')[0];
      const r = await req(srv.baseUrl, '/api/settings/cards/demo-card/disable', {
        method: 'POST',
        cookie,
      });
      assert.equal(r.status, 403);
      assert.match(r.json.error, /demo mode/i);
    } finally { await cleanup(); }
  });

  test('POST /api/settings/cards/:id/enable is rejected with 403 in demo mode', async () => {
    const { srv, cleanup } = await withDemoServer()();
    try {
      const login = await req(srv.baseUrl, '/auth/demo-login', { method: 'POST' });
      const cookie = login.headers['set-cookie'][0].split(';')[0];
      const r = await req(srv.baseUrl, '/api/settings/cards/demo-card/enable', {
        method: 'POST',
        cookie,
      });
      assert.equal(r.status, 403);
      assert.match(r.json.error, /demo mode/i);
    } finally { await cleanup(); }
  });
});

describe('KLEBB_DEMO unset (default behaviour)', () => {
  test('demo-login does not mint a session when flag is off', async () => {
    const box = createSandbox();
    const srv = await spawnServer(box);
    try {
      const r = await req(srv.baseUrl, '/auth/demo-login', { method: 'POST' });
      // /auth/demo-login is only mounted when KLEBB_DEMO=1. Without the
      // flag the request falls through to the static-file router; the
      // critical guarantee is that no session cookie is issued.
      assert.ok(!r.headers['set-cookie'], 'demo-login must not set a session cookie when flag is off');
    } finally {
      await srv.kill();
      cleanupSandbox(box);
    }
  });

  test('GET /api/instance does not include demo:true flag', async () => {
    const box = createSandbox();
    const auth = require('../helpers/sandbox').fakeAuthState();
    cleanupSandbox(box);
    const box2 = createSandbox({ credentials: auth.credentials, sessions: auth.sessions });
    const srv = await spawnServer(box2);
    try {
      const r = await req(srv.baseUrl, '/api/instance', { cookie: auth.cookie });
      assert.equal(r.status, 200);
      assert.equal(r.json.demo, false);
    } finally {
      await srv.kill();
      cleanupSandbox(box2);
    }
  });
});
