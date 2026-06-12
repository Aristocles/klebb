// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/notifications-routes.test.js
//
// Integration tests for the /api/push/* and /api/notifications/*
// endpoints in routes/notifications.js. Uses the sandbox helper to
// spin up a real server with a seeded session.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  createSandbox, cleanupSandbox,
  spawnServer, req,
  fakeAuthState, sessionCookie,
} = require('./helpers/sandbox');

const ALLOWED_ORIGIN = 'http://127.0.0.1';

const VALID_SUB = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/test-AAAA',
  keys: { p256dh: 'a-p256dh-key', auth: 'an-auth-secret' },
};

test.describe('notifications routes (#386, authenticated)', () => {
  let sandbox, srv, cookie;

  test.before(async () => {
    const auth = fakeAuthState();
    sandbox = createSandbox({
      credentials: auth.credentials,
      sessions: auth.sessions,
      seed: {
        'mood.json': {
          $schema: 'klebb.datafile.v1',
          meta: {
            id: 'mood', label: 'Mood', emoji: '🙂',
            view: { enabled: true, component: 'generic-card' },
            notifications: {
              enabled: true,
              items: [{
                id: 'evening-log',
                label: 'Evening log',
                title: 'Mood',
                body: 'How are you feeling?',
                trigger: { type: 'daily', time: '20:00' },
                privacy: 'private',
              }],
            },
          },
          data: [],
        },
      },
    });
    cookie = sessionCookie(auth.token);
    srv = await spawnServer(sandbox, { HEALTH_ORIGIN: ALLOWED_ORIGIN });
  });

  test.after(async () => {
    if (srv) await srv.kill();
    if (sandbox) cleanupSandbox(sandbox);
  });

  test('GET /api/push/vapid-public-key returns key + 8-char keyId', async () => {
    const r = await req(srv.baseUrl, '/api/push/vapid-public-key', { cookie });
    assert.equal(r.status, 200);
    assert.ok(typeof r.json.key === 'string' && r.json.key.length > 60);
    assert.match(r.json.keyId, /^[a-f0-9]{8}$/);
  });

  test('POST /api/push/subscribe: persists, dedupes on second call', async () => {
    const r1 = await req(srv.baseUrl, '/api/push/subscribe', {
      method: 'POST',
      cookie,
      headers: { 'Origin': ALLOWED_ORIGIN },
      body: VALID_SUB,
    });
    assert.equal(r1.status, 201);
    assert.match(r1.json.id, /^[a-f0-9]{64}$/);

    const r2 = await req(srv.baseUrl, '/api/push/subscribe', {
      method: 'POST',
      cookie,
      headers: { 'Origin': ALLOWED_ORIGIN },
      body: VALID_SUB,
    });
    assert.equal(r2.status, 200);
    assert.equal(r2.json.created, false);

    const persisted = JSON.parse(fs.readFileSync(path.join(sandbox, 'push-subscriptions.json'), 'utf8'));
    assert.equal(persisted.subscriptions.length, 1);
  });

  test('POST /api/push/subscribe REJECTS cross-origin (Origin allowlist)', async () => {
    const r = await req(srv.baseUrl, '/api/push/subscribe', {
      method: 'POST',
      cookie,
      headers: { 'Origin': 'https://attacker.example' },
      body: VALID_SUB,
    });
    assert.equal(r.status, 403);
    assert.match(r.json.error, /origin/);
  });

  test('POST /api/push/subscribe REJECTS malformed sub with 400', async () => {
    const r = await req(srv.baseUrl, '/api/push/subscribe', {
      method: 'POST',
      cookie,
      headers: { 'Origin': ALLOWED_ORIGIN },
      body: { endpoint: 'x' },
    });
    assert.equal(r.status, 400);
  });

  test('POST /api/push/subscribe/heartbeat: 200 known, 404 unknown', async () => {
    const ok = await req(srv.baseUrl, '/api/push/subscribe/heartbeat', {
      method: 'POST', cookie, headers: { 'Origin': ALLOWED_ORIGIN },
      body: { endpoint: VALID_SUB.endpoint },
    });
    assert.equal(ok.status, 200);

    const miss = await req(srv.baseUrl, '/api/push/subscribe/heartbeat', {
      method: 'POST', cookie, headers: { 'Origin': ALLOWED_ORIGIN },
      body: { endpoint: 'https://other.example/x' },
    });
    assert.equal(miss.status, 404);
  });

  test('POST /api/push/unsubscribe: 204 and removes the row', async () => {
    const r = await req(srv.baseUrl, '/api/push/unsubscribe', {
      method: 'POST', cookie, headers: { 'Origin': ALLOWED_ORIGIN },
      body: { endpoint: VALID_SUB.endpoint },
    });
    assert.equal(r.status, 204);
    const persisted = JSON.parse(fs.readFileSync(path.join(sandbox, 'push-subscriptions.json'), 'utf8'));
    assert.equal(persisted.subscriptions.length, 0);
  });

  test('GET /api/notifications: aggregates declared items', async () => {
    const r = await req(srv.baseUrl, '/api/notifications', { cookie });
    assert.equal(r.status, 200);
    assert.equal(r.json.notifications.length, 1);
    assert.equal(r.json.notifications[0].id, 'mood#evening-log');
    assert.equal(r.json.notifications[0].card_emoji, '🙂');
    assert.equal(r.json.notifications[0].privacy, 'private');
  });

  test('POST /api/notifications/state: toggles enabled, persists', async () => {
    const r = await req(srv.baseUrl, '/api/notifications/state', {
      method: 'POST', cookie, headers: { 'Origin': ALLOWED_ORIGIN },
      body: { id: 'mood#evening-log', enabled: false },
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.state.enabled, false);

    const list = await req(srv.baseUrl, '/api/notifications', { cookie });
    assert.equal(list.json.notifications[0].enabled, false);
  });

  test('POST /api/notifications/state: privacy override persists across GET', async () => {
    // The manifest declares privacy:"private" by default. A POST that
    // sets privacy:"public" must round-trip through the GET aggregate
    // so the client toggle reflects the user's choice on next page
    // load. Regression for the "toggle resets after navigating away"
    // bug: GET was reading manifest privacy and ignoring the state
    // file override.
    const post = await req(srv.baseUrl, '/api/notifications/state', {
      method: 'POST', cookie, headers: { 'Origin': ALLOWED_ORIGIN },
      body: { id: 'mood#evening-log', privacy: 'public' },
    });
    assert.equal(post.status, 200);
    assert.equal(post.json.state.privacy, 'public');

    const list = await req(srv.baseUrl, '/api/notifications', { cookie });
    const item = list.json.notifications.find(n => n.id === 'mood#evening-log');
    assert.equal(item.privacy, 'public', 'GET must reflect state-file privacy override, not manifest default');

    // Flipping back to private also round-trips.
    await req(srv.baseUrl, '/api/notifications/state', {
      method: 'POST', cookie, headers: { 'Origin': ALLOWED_ORIGIN },
      body: { id: 'mood#evening-log', privacy: 'private' },
    });
    const list2 = await req(srv.baseUrl, '/api/notifications', { cookie });
    assert.equal(
      list2.json.notifications.find(n => n.id === 'mood#evening-log').privacy,
      'private',
    );
  });

  test('POST /api/notifications/state REJECTS bad id format with 400', async () => {
    const r = await req(srv.baseUrl, '/api/notifications/state', {
      method: 'POST', cookie, headers: { 'Origin': ALLOWED_ORIGIN },
      body: { id: 'totally-bogus', enabled: false },
    });
    assert.equal(r.status, 400);
  });

  test('POST /api/notifications/global-state: persists quiet_hours and paused_until', async () => {
    const r = await req(srv.baseUrl, '/api/notifications/global-state', {
      method: 'POST', cookie, headers: { 'Origin': ALLOWED_ORIGIN },
      body: { quiet_hours: { start: '22:00', end: '07:00' }, paused_until: '2026-06-13T00:00:00Z' },
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.quiet_hours, { start: '22:00', end: '07:00' });
    assert.equal(r.json.paused_until, '2026-06-13T00:00:00Z');
  });

  test('POST /api/notifications/test: rate-limited at 1/minute per notification', async () => {
    // Re-subscribe so testFire has somewhere to (try to) send.
    await req(srv.baseUrl, '/api/push/subscribe', {
      method: 'POST', cookie, headers: { 'Origin': ALLOWED_ORIGIN }, body: VALID_SUB,
    });
    // First call: rate-limit allows it. The send will fail (fake endpoint),
    // but we only care that the rate-limit / dispatch path was reached.
    const r1 = await req(srv.baseUrl, '/api/notifications/test', {
      method: 'POST', cookie, headers: { 'Origin': ALLOWED_ORIGIN },
      body: { id: 'mood#evening-log' },
    });
    assert.equal(r1.status, 200);

    const r2 = await req(srv.baseUrl, '/api/notifications/test', {
      method: 'POST', cookie, headers: { 'Origin': ALLOWED_ORIGIN },
      body: { id: 'mood#evening-log' },
    });
    assert.equal(r2.status, 429);
  });

  test('POST /api/notifications/test 404s for unknown card or item', async () => {
    const r = await req(srv.baseUrl, '/api/notifications/test', {
      method: 'POST', cookie, headers: { 'Origin': ALLOWED_ORIGIN },
      body: { id: 'mood#nope' },
    });
    assert.equal(r.status, 404);
  });

  test('GET /api/diagnostics returns tz, vapid_key_id, subscriptions, recent_fires', async () => {
    const r = await req(srv.baseUrl, '/api/diagnostics', { cookie });
    assert.equal(r.status, 200);
    assert.match(r.json.vapid_key_id, /^[a-f0-9]{8}$/);
    assert.ok(Array.isArray(r.json.subscriptions));
    assert.ok(Array.isArray(r.json.recent_fires));
    assert.ok('quiet_hours' in r.json);
    assert.ok('paused_until' in r.json);
    // Diagnostics MUST NOT leak raw endpoints.
    for (const sub of r.json.subscriptions) {
      assert.equal(typeof sub.endpoint, 'undefined');
      assert.match(sub.id, /^[a-f0-9]{64}$/);
    }
  });
});

test.describe('notifications routes (#386, demo mode)', () => {
  let sandbox, srv, cookie;

  test.before(async () => {
    const auth = fakeAuthState();
    sandbox = createSandbox({
      credentials: auth.credentials,
      sessions: auth.sessions,
    });
    cookie = sessionCookie(auth.token);
    srv = await spawnServer(sandbox, { KLEBB_DEMO: '1', HEALTH_ORIGIN: ALLOWED_ORIGIN });
  });

  test.after(async () => {
    if (srv) await srv.kill();
    if (sandbox) cleanupSandbox(sandbox);
  });

  test('every push and notifications endpoint 410s in KLEBB_DEMO=1', async () => {
    const paths = [
      ['GET', '/api/push/vapid-public-key'],
      ['POST', '/api/push/subscribe'],
      ['POST', '/api/push/unsubscribe'],
      ['GET', '/api/notifications'],
      ['POST', '/api/notifications/state'],
      ['POST', '/api/notifications/test'],
      ['GET', '/api/diagnostics'],
    ];
    for (const [method, path] of paths) {
      const r = await req(srv.baseUrl, path, {
        method,
        cookie,
        headers: { 'Origin': ALLOWED_ORIGIN },
        body: method === 'POST' ? {} : null,
      });
      assert.equal(r.status, 410, `${method} ${path} should 410 in demo, got ${r.status}`);
    }
  });
});
