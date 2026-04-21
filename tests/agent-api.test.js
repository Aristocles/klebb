// tests/agent-api.test.js
// Bearer-token (AGENT_API_TOKEN) auth path. This is how external agents
// (Onyx, HAE webhooks, cron jobs, etc.) talk to Klebb without a WebAuthn
// session. Covers:
//   - Valid token → authorised
//   - Wrong / missing token → 401
//   - Token not set on server → bearer header ignored, falls through to
//     session auth
//   - Bearer works regardless of setup vs full-auth mode
//   - Bearer can READ and WRITE (including to master-disabled cards)
//   - Bearer can toggle Settings

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const { createSandbox, cleanupSandbox, spawnServer, req, fakeAuthState } = require('./helpers/sandbox');

const AGENT_TOKEN = 'test-agent-token-ab12cd34ef56';

function makeWeight(overrides = {}) {
  return {
    $schema: 'klebb.datafile.v1',
    meta: {
      id: 'weight',
      label: 'Weight',
      view: { enabled: true, component: 'generic-card', display: { template: '{kg:round(1)}', unit: 'kg' } },
      writeable: { fromWebapp: true, todayAllowed: true, pastAllowed: true, inputs: [{ key: 'kg', type: 'number' }] },
      ...overrides,
    },
    data: [{ date: '2026-04-20', kg: 85 }],
  };
}

describe('bearer-token agent API', () => {
  // ---------- Mode: AGENT_API_TOKEN enabled + WebAuthn credentials exist ----------
  describe('with AGENT_API_TOKEN set AND credentials registered (full auth)', () => {
    let sandbox, server, authState;

    before(async () => {
      authState = fakeAuthState('testuser');
      sandbox = createSandbox({
        credentials: authState.credentials,
        sessions: authState.sessions,
        seed: { 'weight.json': makeWeight() },
      });
      server = await spawnServer(sandbox, { AGENT_API_TOKEN: AGENT_TOKEN });
    });
    after(async () => {
      if (server) await server.kill();
      cleanupSandbox(sandbox);
    });

    test('GET /api/manifests with valid bearer → 200', async () => {
      const res = await req(server.baseUrl, '/api/manifests', {
        headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.entries.length, 1);
    });

    test('GET /api/manifests with WRONG bearer → 401', async () => {
      const res = await req(server.baseUrl, '/api/manifests', {
        headers: { Authorization: 'Bearer totally-wrong-token' },
      });
      assert.equal(res.status, 401);
    });

    test('GET /api/manifests with NO auth → 401', async () => {
      const res = await req(server.baseUrl, '/api/manifests');
      assert.equal(res.status, 401);
    });

    test('GET /api/manifests with malformed Authorization header → 401', async () => {
      const res = await req(server.baseUrl, '/api/manifests', {
        headers: { Authorization: 'NotBearer ' + AGENT_TOKEN },
      });
      assert.equal(res.status, 401);
    });

    test('GET /api/manifests with extra whitespace around bearer value → 200', async () => {
      const res = await req(server.baseUrl, '/api/manifests', {
        headers: { Authorization: `Bearer ${AGENT_TOKEN}  ` },
      });
      assert.equal(res.status, 200);
    });

    test('POST /api/manifests/:id/data with bearer writes data', async () => {
      const res = await req(server.baseUrl, '/api/manifests/weight/data', {
        method: 'POST',
        headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
        body: { data: [{ date: '2026-04-21', kg: 86 }] },
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.ok, true);

      // Verify persisted
      const check = await req(server.baseUrl, '/api/manifests/weight/data', {
        headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
      });
      assert.equal(check.json.data.length, 1);
      assert.equal(check.json.data[0].kg, 86);
    });

    test('POST /api/settings/cards/:id/disable with bearer works', async () => {
      const res = await req(server.baseUrl, '/api/settings/cards/weight/disable', {
        method: 'POST',
        headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.enabled, false);
    });

    test('bearer bypasses session cookie — no cookie needed', async () => {
      // Explicitly empty cookie header
      const res = await req(server.baseUrl, '/api/manifests', {
        headers: { Authorization: `Bearer ${AGENT_TOKEN}`, Cookie: '' },
      });
      assert.equal(res.status, 200);
    });

    test('both cookie + bearer present → still works (bearer wins)', async () => {
      const res = await req(server.baseUrl, '/api/manifests', {
        cookie: authState.cookie,
        headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
      });
      assert.equal(res.status, 200);
    });
  });

  // ---------- Mode: no credentials registered (setup mode) ----------
  describe('with AGENT_API_TOKEN set AND no credentials (setup mode)', () => {
    let sandbox, server;

    before(async () => {
      // No credentials → isSetup()=false → everything is open. Bearer is
      // still accepted as a valid auth, but the endpoints are also
      // reachable without auth. Confirm the bearer path at least works.
      sandbox = createSandbox({ seed: { 'weight.json': makeWeight() } });
      server = await spawnServer(sandbox, { AGENT_API_TOKEN: AGENT_TOKEN });
    });
    after(async () => {
      if (server) await server.kill();
      cleanupSandbox(sandbox);
    });

    test('GET /api/manifests with bearer → 200 (setup mode is open)', async () => {
      const res = await req(server.baseUrl, '/api/manifests', {
        headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
      });
      assert.equal(res.status, 200);
    });

    test('POST /api/manifests/:id/data with bearer writes (setup mode)', async () => {
      const res = await req(server.baseUrl, '/api/manifests/weight/data', {
        method: 'POST',
        headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
        body: { data: [{ date: '2026-04-20', kg: 87 }] },
      });
      assert.equal(res.status, 200);
    });
  });

  // ---------- Mode: no AGENT_API_TOKEN configured ----------
  describe('with AGENT_API_TOKEN NOT set on server', () => {
    let sandbox, server, authState;

    before(async () => {
      authState = fakeAuthState('u');
      sandbox = createSandbox({
        credentials: authState.credentials,
        sessions: authState.sessions,
        seed: { 'weight.json': makeWeight() },
      });
      // Explicit empty override
      server = await spawnServer(sandbox, { AGENT_API_TOKEN: '' });
    });
    after(async () => {
      if (server) await server.kill();
      cleanupSandbox(sandbox);
    });

    test('bearer header is ignored when token unset → 401', async () => {
      const res = await req(server.baseUrl, '/api/manifests', {
        headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
      });
      assert.equal(res.status, 401);
    });

    test('session cookie still works when bearer is disabled', async () => {
      const res = await req(server.baseUrl, '/api/manifests', {
        cookie: authState.cookie,
      });
      assert.equal(res.status, 200);
    });
  });

  // ---------- Writes to a master-disabled card ----------
  describe('writes to master-disabled cards', () => {
    let sandbox, server;

    before(async () => {
      sandbox = createSandbox({
        seed: {
          'weight.json': makeWeight({ enabled: false }), // master-disabled
        },
      });
      server = await spawnServer(sandbox, { AGENT_API_TOKEN: AGENT_TOKEN });
    });
    after(async () => {
      if (server) await server.kill();
      cleanupSandbox(sandbox);
    });

    test('bearer can write to a card with meta.enabled: false', async () => {
      // Per the Onyx integration contract (§10): disabled cards still
      // accept writes. Agents may want to log quietly while the card is
      // off the dashboard.
      const res = await req(server.baseUrl, '/api/manifests/weight/data', {
        method: 'POST',
        headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
        body: { data: [{ date: '2026-04-21', kg: 88 }] },
      });
      assert.equal(res.status, 200, 'disabled cards should still accept writes');
      assert.equal(res.json.ok, true);
    });

    test('but the card is still hidden from /api/views/view', async () => {
      const res = await req(server.baseUrl, '/api/views/view', {
        headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
      });
      assert.equal(res.status, 200);
      const ids = res.json.cards.map(c => c.id);
      assert.ok(!ids.includes('weight'), 'master-disabled card should NOT appear in view');
    });
  });
});
