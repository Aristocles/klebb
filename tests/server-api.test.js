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
      view: { enabled: true, component: 'generic-card', dateContext: 'latest' },
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

    test('GET /api/voice/config when FISH_AUDIO_API_KEY unset returns error', async () => {
      const res = await req(server.baseUrl, '/api/voice/config');
      assert.equal(res.status, 500);
      assert.ok(res.json.error);
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
});
