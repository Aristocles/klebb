// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/health-auto-export.status-api.test.js
// End-to-end tests for GET /api/health-auto-export/status and the
// last-push.json side-effect of POST /api/health-auto-export.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createSandbox, cleanupSandbox, spawnServer, req } = require('./helpers/sandbox');

const SUBSCRIBER = {
  'steps.json': {
    $schema: 'klebb.datafile.v1',
    meta: {
      id: 'steps', label: 'Steps', order: 520,
      ingest: { source: 'hae', metric: 'step_count' },
      view: { enabled: true, component: 'generic-card',
              display: { template: '{count}', unit: 'steps' } },
      writeable: { fromWebapp: false },
    },
    data: [],
  },
};

const CANNED_PAYLOAD = {
  data: {
    metrics: [
      { name: 'step_count', data: [{ date: '2026-05-04 08:00:00 +1000', qty: 3500 }] },
      { name: 'sleep_analysis', data: [{ date: '2026-05-04 00:00:00 +1000', totalSleep: 7 }] },
    ],
  },
};

describe('GET /api/health-auto-export/status', () => {
  describe('token unset, no prior pushes', () => {
    let sandbox, server;
    before(async () => {
      sandbox = createSandbox();
      server = await spawnServer(sandbox, { HEALTH_AUTO_EXPORT_TOKEN: '' });
    });
    after(async () => { if (server) await server.kill(); cleanupSandbox(sandbox); });

    test('tokenSet: false, endpointUrl present, lastPush: null', async () => {
      const res = await req(server.baseUrl, '/api/health-auto-export/status');
      assert.equal(res.status, 200);
      assert.equal(res.json.tokenSet, false);
      assert.ok(res.json.endpointUrl.startsWith('http://'));
      assert.ok(res.json.endpointUrl.endsWith('/api/health-auto-export'));
      assert.equal(res.json.lastPush, null);
    });
  });

  describe('after a successful push', () => {
    let sandbox, server;
    const TOKEN = 'diag-token-hex-0123456789abcdef';

    before(async () => {
      sandbox = createSandbox({ seed: SUBSCRIBER });
      server = await spawnServer(sandbox, { HEALTH_AUTO_EXPORT_TOKEN: TOKEN });
    });
    after(async () => { if (server) await server.kill(); cleanupSandbox(sandbox); });

    test('tokenSet: true, lastPush snapshot written after a push', async () => {
      const postRes = await req(server.baseUrl, '/api/health-auto-export', {
        method: 'POST',
        body: CANNED_PAYLOAD,
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      assert.equal(postRes.status, 200);

      // last-push.json materialises on disk.
      const file = path.join(sandbox, 'data', 'auto-export', 'last-push.json');
      assert.ok(fs.existsSync(file));

      const statusRes = await req(server.baseUrl, '/api/health-auto-export/status');
      assert.equal(statusRes.status, 200);
      assert.equal(statusRes.json.tokenSet, true);
      const lp = statusRes.json.lastPush;
      assert.ok(lp);
      assert.ok(lp.receivedAt);
      assert.ok(lp.payloadBytes > 0);
      assert.ok(Array.isArray(lp.subscribers));
      assert.equal(lp.subscribers.length, 1);
      assert.equal(lp.subscribers[0].id, 'steps');
      assert.equal(lp.subscribers[0].rowsWritten, 1);
      assert.ok(lp.availableUnsubscribed.includes('sleep_analysis'));
      assert.deepEqual(lp.warnings, []);
    });
  });

  describe('after a parse-failure push', () => {
    let sandbox, server;
    const TOKEN = 'diag-token-hex-0123456789abcdef';

    before(async () => {
      sandbox = createSandbox();
      server = await spawnServer(sandbox, { HEALTH_AUTO_EXPORT_TOKEN: TOKEN });
    });
    after(async () => { if (server) await server.kill(); cleanupSandbox(sandbox); });

    test('lastPush records the parse-failure warning', async () => {
      const res = await req(server.baseUrl, '/api/health-auto-export', {
        method: 'POST',
        body: 'not json',
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      assert.equal(res.status, 200);
      assert.ok(res.json.warning);

      const statusRes = await req(server.baseUrl, '/api/health-auto-export/status');
      const lp = statusRes.json.lastPush;
      assert.ok(lp);
      assert.ok(lp.warnings.some(w => /parse failed/.test(w)));
      assert.deepEqual(lp.subscribers, []);
    });
  });

  describe('endpoint URL reflects request host', () => {
    let sandbox, server;
    before(async () => {
      sandbox = createSandbox();
      server = await spawnServer(sandbox, { HEALTH_AUTO_EXPORT_TOKEN: '' });
    });
    after(async () => { if (server) await server.kill(); cleanupSandbox(sandbox); });

    test('uses Host header', async () => {
      const res = await req(server.baseUrl, '/api/health-auto-export/status', {
        headers: { Host: 'klebb.example.com' },
      });
      assert.ok(res.json.endpointUrl.includes('klebb.example.com'));
    });

    test('honours X-Forwarded-Proto for https-behind-proxy deployments', async () => {
      const res = await req(server.baseUrl, '/api/health-auto-export/status', {
        headers: { 'X-Forwarded-Proto': 'https' },
      });
      assert.ok(res.json.endpointUrl.startsWith('https://'));
    });
  });
});
