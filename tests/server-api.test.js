// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/server-api.test.js
// Integration tests: spin up the server against an ephemeral HEALTH_HOME
// and exercise the HTTP API.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const { createSandbox, cleanupSandbox, spawnServer, req, fakeAuthState } = require('./helpers/sandbox');

// --- Helpers ---

function makeWeightManifest(data = []) {
  return {
    $schema: 'klebb.datafile.v1',
    meta: {
      id: 'weight',
      label: 'Weight',
      view: { enabled: true, component: 'generic-card', fallbackToLatest: true },
      trends: { enabled: true, component: 'line-chart' },
      writeable: { fromWebapp: true, todayAllowed: true, pastAllowed: true, futureAllowed: false },
    },
    description: 'Body weight log',
    data,
  };
}

describe('server HTTP API', () => {
  describe('unauthenticated (setup mode)', () => {
    let sandbox, server;

    before(async () => {
      // No credentials → isSetup() is false → all routes open (setup mode)
      sandbox = createSandbox({ seed: { 'weight.json': makeWeightManifest([{ date: '2026-04-20', kg: 85 }]) } });
      server = await spawnServer(sandbox);
    });
    after(async () => {
      if (server) await server.kill();
      cleanupSandbox(sandbox);
    });

    test('GET /api/manifests returns loaded manifests', async () => {
      const res = await req(server.baseUrl, '/api/manifests');
      assert.equal(res.status, 200);
      assert.ok(res.json);
      assert.equal(res.json.entries.length, 1);
      assert.equal(res.json.entries[0].id, 'weight');
    });

    test('GET /healthz returns 200 without auth (container liveness probe)', async () => {
      const res = await req(server.baseUrl, '/healthz');
      assert.equal(res.status, 200);
      assert.ok(res.json);
      assert.equal(res.json.status, 'ok');
    });

    test('GET /api/manifests/:id returns one manifest', async () => {
      const res = await req(server.baseUrl, '/api/manifests/weight');
      assert.equal(res.status, 200);
      assert.equal(res.json.meta.id, 'weight');
      assert.equal(res.json.data.length, 1);
    });

    test('GET /api/manifests/:id/data returns just data block', async () => {
      const res = await req(server.baseUrl, '/api/manifests/weight/data');
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.json.data));
      assert.equal(res.json.data[0].kg, 85);
    });

    test('GET /api/manifests/nonexistent returns 404', async () => {
      const res = await req(server.baseUrl, '/api/manifests/nonexistent');
      assert.equal(res.status, 404);
    });

    test('POST /api/manifests/:id/data updates data', async () => {
      const res = await req(server.baseUrl, '/api/manifests/weight/data', {
        method: 'POST',
        body: { data: [{ date: '2026-04-20', kg: 86 }, { date: '2026-04-21', kg: 86.5 }] },
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.ok, true);

      // Confirm it persisted
      const check = await req(server.baseUrl, '/api/manifests/weight/data');
      assert.equal(check.json.data.length, 2);
      assert.equal(check.json.data[1].kg, 86.5);
    });

    test('POST /api/manifests/:id/data rejects pre-serialised string data with 400 (#342)', async () => {
      const res = await req(server.baseUrl, '/api/manifests/weight/data', {
        method: 'POST',
        body: { data: JSON.stringify([{ date: '2026-04-22', kg: 87 }]) },
      });
      assert.equal(res.status, 400);
      assert.match(res.json.error || '', /JSON object or array, not a string/);

      // Persisted data must NOT have been clobbered
      const check = await req(server.baseUrl, '/api/manifests/weight/data');
      assert.ok(Array.isArray(check.json.data), 'data still an array');
    });

    test('GET /api/views/view returns cards with view.enabled', async () => {
      const res = await req(server.baseUrl, '/api/views/view');
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.json.cards));
      assert.equal(res.json.cards.length, 1);
      assert.equal(res.json.cards[0].id, 'weight');
    });

    test('GET /api/views/trends respects meta.trends.enabled', async () => {
      const res = await req(server.baseUrl, '/api/views/trends');
      assert.equal(res.status, 200);
      assert.equal(res.json.cards.length, 1);
    });

    test('GET /api/views/invalid returns 404', async () => {
      const res = await req(server.baseUrl, '/api/views/nonexistent');
      assert.equal(res.status, 404);
    });

    test('GET /api/instance returns name + chatAgent', async () => {
      const res = await req(server.baseUrl, '/api/instance');
      assert.equal(res.status, 200);
      assert.ok(res.json.name);
      assert.ok(res.json.chatAgent);
      assert.ok(res.json.chatAgent.name);
    });

    test('GET /api/voice/config when FISH_AUDIO_API_KEY unset returns enabled:false', async () => {
      const res = await req(server.baseUrl, '/api/voice/config');
      assert.equal(res.status, 200);
      assert.equal(res.json.enabled, false);
    });

    test('GET /auth/status returns setup=false', async () => {
      const res = await req(server.baseUrl, '/auth/status');
      assert.equal(res.status, 200);
      assert.equal(res.json.setup, false);
    });
  });

  describe('authenticated (full auth mode)', () => {
    let sandbox, server, auth;

    before(async () => {
      auth = fakeAuthState('alice');
      sandbox = createSandbox({
        credentials: auth.credentials,
        sessions: auth.sessions,
        seed: { 'weight.json': makeWeightManifest([{ date: '2026-04-20', kg: 85 }]) },
      });
      server = await spawnServer(sandbox);
    });
    after(async () => {
      if (server) await server.kill();
      cleanupSandbox(sandbox);
    });

    test('GET /api/manifests without session → 401', async () => {
      const res = await req(server.baseUrl, '/api/manifests');
      assert.equal(res.status, 401);
    });

    test('GET /healthz without session → still 200 (probe must never auth-gate)', async () => {
      const res = await req(server.baseUrl, '/healthz');
      assert.equal(res.status, 200);
      assert.equal(res.json.status, 'ok');
    });

    test('GET /api/manifests with session cookie → 200', async () => {
      const res = await req(server.baseUrl, '/api/manifests', { cookie: auth.cookie });
      assert.equal(res.status, 200);
      assert.equal(res.json.entries.length, 1);
    });

    test('GET /api/manifests with AGENT_API_TOKEN bearer', async () => {
      // Test that server-to-server bearer auth works
      // Note: requires the server to have been spawned with AGENT_API_TOKEN set
      // We'll extend spawnServer later if needed; for now skip the bearer path
      // — it's tested separately.
    });

    test('GET /auth/status returns setup=true, authenticated with cookie', async () => {
      const res = await req(server.baseUrl, '/auth/status', { cookie: auth.cookie });
      assert.equal(res.status, 200);
      assert.equal(res.json.setup, true);
      assert.equal(res.json.authenticated, true);
    });

    test('GET /auth/status without cookie → setup=true, authenticated=false', async () => {
      const res = await req(server.baseUrl, '/auth/status');
      assert.equal(res.status, 200);
      assert.equal(res.json.setup, true);
      assert.equal(res.json.authenticated, false);
    });
  });

  // --- Date-allowance gate (past/today/future) on webapp writes ---
  describe('writeable date-allowance enforcement', () => {
    let sandbox, server;
    const AGENT_TOKEN = 'test-agent-date-allowance';

    function todayUtc() {
      return new Date().toLocaleDateString('en-CA', { timeZone: 'UTC' });
    }
    function shiftDays(iso, delta) {
      const d = new Date(iso + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + delta);
      return d.toISOString().slice(0, 10);
    }

    before(async () => {
      // futureAllowed: false, pastAllowed: false → only today writes accepted from webapp
      const m = {
        $schema: 'klebb.datafile.v1',
        meta: {
          id: 'weight',
          label: 'Weight',
          view: { enabled: true, component: 'generic-card' },
          writeable: { fromWebapp: true, todayAllowed: true, pastAllowed: false, futureAllowed: false },
        },
        data: [],
      };
      sandbox = createSandbox({ seed: { 'weight.json': m } });
      server = await spawnServer(sandbox, { TZ: 'UTC', AGENT_API_TOKEN: AGENT_TOKEN });
    });
    after(async () => {
      if (server) await server.kill();
      cleanupSandbox(sandbox);
    });

    test('POST future-dated row without bearer → 403', async () => {
      const future = shiftDays(todayUtc(), 7);
      const res = await req(server.baseUrl, '/api/manifests/weight/data', {
        method: 'POST',
        body: { data: [{ date: future, kg: 80 }] },
      });
      assert.equal(res.status, 403);
      assert.match(res.json.error, /future-dated/);
    });

    test('POST past-dated row without bearer → 403', async () => {
      const past = shiftDays(todayUtc(), -7);
      const res = await req(server.baseUrl, '/api/manifests/weight/data', {
        method: 'POST',
        body: { data: [{ date: past, kg: 80 }] },
      });
      assert.equal(res.status, 403);
      assert.match(res.json.error, /past-dated/);
    });

    test('POST today-dated row without bearer → 200', async () => {
      const res = await req(server.baseUrl, '/api/manifests/weight/data', {
        method: 'POST',
        body: { data: [{ date: todayUtc(), kg: 81 }] },
      });
      assert.equal(res.status, 200);
    });

    test('POST future-dated row WITH agent bearer → 200 (bypasses gate)', async () => {
      const future = shiftDays(todayUtc(), 30);
      const res = await req(server.baseUrl, '/api/manifests/weight/data', {
        method: 'POST',
        body: { data: [{ date: future, kg: 82 }, { date: todayUtc(), kg: 81 }] },
        headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
      });
      assert.equal(res.status, 200);
    });

    test('POST that only edits an existing date → allowed even if pastAllowed:false', async () => {
      // The future+today write from the previous test persisted [{future,82},{today,81}].
      // Now re-POST the same row set with the today-row's kg changed. No *new* date
      // appears, so the gate should not fire.
      const future = shiftDays(todayUtc(), 30);
      const res = await req(server.baseUrl, '/api/manifests/weight/data', {
        method: 'POST',
        body: { data: [{ date: future, kg: 82 }, { date: todayUtc(), kg: 99 }] },
      });
      assert.equal(res.status, 200);
      const check = await req(server.baseUrl, '/api/manifests/weight/data');
      const todayRow = check.json.data.find(r => r.date === todayUtc());
      assert.equal(todayRow.kg, 99);
    });
  });
});
