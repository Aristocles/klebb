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
    srv = await spawnServer(sandbox, { KLEBB_ADMIN_TOKEN: ADMIN_TOKEN, KLEBB_CLOUD: '1', AGENT_API_TOKEN: 'agent-token-664' });
  });
  after(async () => { if (srv) await srv.kill(); cleanupSandbox(sandbox); });

  test('every admin route 401s without the bearer', async () => {
    for (const [method, path] of [
      ['GET', '/api/admin/health'],
      ['GET', '/api/admin/info'],
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

  test('GET /api/admin/info is meta-only with an exact key set (#662)', async () => {
    const r = await req(srv.baseUrl, '/api/admin/info', { headers: admin });
    assert.equal(r.status, 200);
    // Exact keys: consumers pin this shape downstream, so even an ADDITIVE
    // field must be a deliberate act in three repos, not a drive-by.
    assert.deepEqual(Object.keys(r.json).sort(), [
      'activeDays7', 'appVersion', 'cardCount', 'cardErrorCount', 'commit',
      'dbSizeBytes', 'lastActiveAt', 'lastHaePayloadBytes', 'lastHaePushAt', 'uptimeSeconds',
    ]);
    assert.equal(r.json.appVersion, require('../package.json').version);
    assert.equal(r.json.commit, null, 'no SOURCE_COMMIT on a local build');
    assert.equal(typeof r.json.cardCount, 'number');
    assert.equal(r.json.cardErrorCount, 0);
    assert.ok(Number.isFinite(r.json.uptimeSeconds) && r.json.uptimeSeconds >= 0);
    // A fresh sandbox has a datastore (init creates it) but no HAE push yet:
    // the empty states are nulls, never errors.
    assert.ok(r.json.dbSizeBytes === null || r.json.dbSizeBytes > 0);
    assert.equal(r.json.lastHaePushAt, null);
    assert.equal(r.json.lastHaePayloadBytes, null);
    assert.equal(r.json.lastActiveAt, null, 'no interaction recorded yet');
    assert.equal(r.json.activeDays7, 0);
    // Meta-only means about the instance, never from it: nothing resembling
    // a card id, metric name or subscriber list may ride along.
    const flat = JSON.stringify(r.json);
    for (const needle of ['subscribers', 'warnings', 'metric', 'meta']) {
      assert.ok(!flat.includes(needle), `info response must not carry ${needle}`);
    }
  });

  test('GET /api/admin/info reflects an HAE push without serving its contents', async () => {
    // Simulate what the ingest route records: the diagnostic carries
    // subscriber card ids, and only the timestamp + size may surface.
    const fs = require('node:fs');
    const path = require('node:path');
    const dir = path.join(sandbox, 'data', 'auto-export');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'last-push.json'), JSON.stringify({
      receivedAt: '2026-08-27T00:00:00.000Z', payloadBytes: 48213,
      subscribers: [{ id: 'secret-card-name', metric: 'heart_rate' }],
      availableUnsubscribed: ['sleep_analysis'], warnings: [],
    }));
    const r = await req(srv.baseUrl, '/api/admin/info', { headers: admin });
    assert.equal(r.json.lastHaePushAt, '2026-08-27T00:00:00.000Z');
    assert.equal(r.json.lastHaePayloadBytes, 48213);
    const flat = JSON.stringify(r.json);
    assert.ok(!flat.includes('secret-card-name'), 'subscriber card ids never surface');
    assert.ok(!flat.includes('heart_rate'), 'metric names never surface');
    assert.ok(!flat.includes('sleep_analysis'), 'available metrics never surface');
  });

  test('activity moves only on the requests that mean a person (#664)', async () => {
    const info = async () => (await req(srv.baseUrl, '/api/admin/info', { headers: admin })).json;

    // Traffic that must NOT count: a polled session GET, an agent-bearer
    // write, and the admin API reads themselves (a dashboard must not mark
    // instances active by looking at them).
    await req(srv.baseUrl, '/api/manifests', { headers: { Cookie: userCookie } });
    await req(srv.baseUrl, '/api/manifests', {
      method: 'POST', headers: { 'Authorization': 'Bearer agent-token-664' },
      body: { $schema: 'klebb.datafile.v1', meta: { id: 'agentcard', label: 'A', view: { enabled: true, component: 'generic-card' } } },
    });
    const before2 = await info();
    assert.equal(before2.lastActiveAt, null,
      'a session GET poll, an agent write and admin reads left no trace');

    await req(srv.baseUrl, '/', { headers: { Cookie: userCookie } });
    const after = await info();
    assert.ok(after.lastActiveAt, 'loading the app shell is a person');
    assert.equal(after.activeDays7, 1);

    await new Promise(r2 => setTimeout(r2, 5));
    await req(srv.baseUrl, '/api/manifests', {
      method: 'POST', headers: { Cookie: userCookie },
      body: { $schema: 'klebb.datafile.v1', meta: { id: 'humancard', label: 'H', view: { enabled: true, component: 'generic-card' } } },
    });
    const later = await info();
    assert.ok(Date.parse(later.lastActiveAt) >= Date.parse(after.lastActiveAt));
    assert.equal(later.activeDays7, 1, 'same day, still one day');
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
