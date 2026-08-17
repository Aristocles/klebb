// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/admin-api.test.js
// Response-shape pins for the /api/admin/* control-plane surface (#479).
// The klebb-web portal consumes these fields server-to-server; a silent
// shape change here breaks provisioning and recovery emails downstream
// even when this repo's own CI is green. Every assertion below is a
// contract, not an implementation detail.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const {
  createSandbox, cleanupSandbox, spawnServer, req, fakeAuthState,
} = require('./helpers/sandbox');

const ADMIN_TOKEN = 'test-admin-token-479';

describe('admin API shape pins (#479)', () => {
  let sandbox, srv, userCookie;
  const admin = { 'Authorization': `Bearer ${ADMIN_TOKEN}` };

  before(async () => {
    const auth = fakeAuthState('customer');
    userCookie = auth.cookie;
    sandbox = createSandbox({ credentials: auth.credentials, sessions: auth.sessions });
    srv = await spawnServer(sandbox, { KLEBB_ADMIN_TOKEN: ADMIN_TOKEN, KLEBB_CLOUD: '1' });
  });
  after(async () => { if (srv) await srv.kill(); cleanupSandbox(sandbox); });

  test('every admin route 401s without the bearer', async () => {
    for (const [method, path] of [
      ['GET', '/api/admin/health'],
      ['GET', '/api/admin/credentials'],
      ['POST', '/api/admin/invites'],
      ['GET', '/api/admin/feedback'],
    ]) {
      const r = await req(srv.baseUrl, path, { method, body: method === 'POST' ? {} : null });
      assert.equal(r.status, 401, `${method} ${path} without token`);
      const bad = await req(srv.baseUrl, path, {
        method, body: method === 'POST' ? {} : null,
        headers: { 'Authorization': 'Bearer wrong' },
      });
      assert.equal(bad.status, 401, `${method} ${path} with wrong token`);
    }
  });

  test('GET /api/admin/health carries the provisioner readiness fields', async () => {
    const r = await req(srv.baseUrl, '/api/admin/health', { headers: admin });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.setup, true);
    assert.equal(r.json.cloud, true);
    assert.equal(r.json.rpId, '127.0.0.1');
    assert.equal(r.json.origin, srv.baseUrl);
    assert.equal(r.json.credentialCount, 1);
  });

  test('GET /api/admin/credentials lists safe fields only', async () => {
    const r = await req(srv.baseUrl, '/api/admin/credentials', { headers: admin });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json.credentials));
    assert.equal(r.json.credentials.length, 1);
    const c = r.json.credentials[0];
    assert.equal(c.label, 'customer');
    assert.equal(typeof c.id, 'string');
    assert.ok('nickname' in c);
    assert.ok('registeredAt' in c);
    // The portal renders these; secrets must never ride along.
    assert.equal(c.publicKey, undefined, 'public key material not exposed');
    assert.equal(c.counter, undefined, 'signature counter not exposed');
  });

  test('POST /api/admin/invites mints a register link bound to the instance origin', async () => {
    const r = await req(srv.baseUrl, '/api/admin/invites', {
      method: 'POST', headers: admin, body: { label: 'Customer Name!', expiresInDays: 999 },
    });
    assert.equal(r.status, 201);
    assert.match(r.json.code, /^[A-Za-z0-9_-]{8,}$/);
    assert.equal(r.json.label, 'customername', 'label sanitised to the credential charset');
    assert.ok(r.json.expiresAt, 'expiry present');
    // The portal emails registerUrl verbatim: it must point at THIS instance
    // (passkeys bind to this RP_ID; any other origin mints a dead credential).
    assert.equal(r.json.registerUrl, `${srv.baseUrl}/register?code=${encodeURIComponent(r.json.code)}`);
    // expiresInDays clamps to 30: codes must not stay brute-forceable for months.
    const days = (Date.parse(r.json.expiresAt) - Date.now()) / 86400000;
    assert.ok(days <= 31, `expiry clamped (${days.toFixed(1)}d)`);
  });

  test('invite body defaults are safe (no body → label "user", short expiry)', async () => {
    const r = await req(srv.baseUrl, '/api/admin/invites', { method: 'POST', headers: admin, body: {} });
    assert.equal(r.status, 201);
    assert.equal(r.json.label, 'user');
    const days = (Date.parse(r.json.expiresAt) - Date.now()) / 86400000;
    assert.ok(days <= 4, `default expiry is days-not-weeks (${days.toFixed(1)}d)`);
  });

  test('no delete surface exists (compromised control plane cannot lock the customer out)', async () => {
    for (const path of ['/api/admin/credentials', '/api/admin/credentials/abc']) {
      const r = await req(srv.baseUrl, path, { method: 'DELETE', headers: admin });
      assert.ok([404, 405].includes(r.status), `DELETE ${path} → ${r.status}`);
    }
  });

  test('GET /api/admin/feedback returns the log with a working since cursor (#608)', async () => {
    // Write two entries through the same session-gated endpoint the in-app
    // form feeds (the chat tool writes the identical shape in-process).
    const first = await req(srv.baseUrl, '/api/feedback', {
      method: 'POST',
      cookie: userCookie,
      body: { kind: 'bug', intent: 'sparkline renders blank after a goal line' },
    });
    assert.equal(first.status, 200, JSON.stringify(first.json));
    await new Promise(r => setTimeout(r, 5));
    const second = await req(srv.baseUrl, '/api/feedback', {
      method: 'POST',
      cookie: userCookie,
      body: { intent: 'wants a heatmap renderer' },
    });
    assert.equal(second.status, 200);

    const all = await req(srv.baseUrl, '/api/admin/feedback', { headers: admin });
    assert.equal(all.status, 200);
    assert.equal(all.json.count, 2);
    assert.equal(all.json.entries[0].kind, 'bug');
    assert.equal(all.json.entries[1].kind, 'feature', 'kindless writes degrade to feature');
    assert.ok(all.json.entries.every(e => e.ts && e.intent));

    const cursor = all.json.entries[0].ts;
    const newer = await req(srv.baseUrl, `/api/admin/feedback?since=${encodeURIComponent(cursor)}`, { headers: admin });
    assert.equal(newer.status, 200);
    assert.equal(newer.json.count, 1, 'the cursor excludes entries at or before it');
    assert.equal(newer.json.entries[0].intent, 'wants a heatmap renderer');
  });
});
