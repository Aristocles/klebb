// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/health-auto-export.discoveries-api.test.js
// Integration tests for the discoveries API + dispatcher interaction.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createSandbox, cleanupSandbox, spawnServer, req } = require('./helpers/sandbox');

const TOKEN = 'disc-token-hex-0123456789abcdef';

const STEPS_SUBSCRIBER = {
  'steps.json': {
    $schema: 'klebb.datafile.v1',
    meta: {
      id: 'steps', label: 'Steps',
      ingest: { source: 'hae', metric: 'step_count' },
      view: { enabled: true, component: 'generic-card',
              display: { template: '{count}', unit: 'steps' } },
      writeable: { fromWebapp: false },
    },
    data: [],
  },
};

const SLEEP_SUBSCRIBER = {
  'sleep-hours.json': {
    $schema: 'klebb.datafile.v1',
    meta: {
      id: 'sleep-hours', label: 'Sleep',
      ingest: { source: 'hae', metric: 'sleep_analysis' },
      view: { enabled: true, component: 'generic-card',
              display: { template: '{hours}' } },
      writeable: { fromWebapp: false },
    },
    data: [],
  },
};

// Has steps, sleep, and HRV samples.
const CANNED_PAYLOAD = {
  data: {
    metrics: [
      { name: 'step_count', data: [{ date: '2026-05-04', qty: 3500 }] },
      { name: 'sleep_analysis', data: [{ date: '2026-05-04', totalSleep: 7.5 }] },
      { name: 'heart_rate_variability', data: [{ date: '2026-05-04', qty: 55 }] },
    ],
  },
};

describe('GET /api/health-auto-export/discoveries', () => {
  describe('no discoveries yet', () => {
    let sandbox, server;
    before(async () => {
      sandbox = createSandbox();
      server = await spawnServer(sandbox, { HEALTH_AUTO_EXPORT_TOKEN: TOKEN });
    });
    after(async () => { if (server) await server.kill(); cleanupSandbox(sandbox); });

    test('returns empty arrays', async () => {
      const res = await req(server.baseUrl, '/api/health-auto-export/discoveries');
      assert.equal(res.status, 200);
      assert.deepEqual(res.json.undismissed, []);
      assert.deepEqual(res.json.dismissed, []);
    });
  });

  describe('after a push with unsubscribed metrics', () => {
    let sandbox, server;
    before(async () => {
      sandbox = createSandbox({ seed: STEPS_SUBSCRIBER });
      server = await spawnServer(sandbox, { HEALTH_AUTO_EXPORT_TOKEN: TOKEN });
    });
    after(async () => { if (server) await server.kill(); cleanupSandbox(sandbox); });

    test('lists sleep_analysis + heart_rate_variability as undismissed', async () => {
      await req(server.baseUrl, '/api/health-auto-export', {
        method: 'POST', body: CANNED_PAYLOAD,
        headers: { Authorization: `Bearer ${TOKEN}` },
      });

      const res = await req(server.baseUrl, '/api/health-auto-export/discoveries');
      assert.equal(res.status, 200);
      const metrics = res.json.undismissed.map(e => e.metric).sort();
      assert.deepEqual(metrics, ['heart_rate_variability', 'sleep_analysis']);
      assert.deepEqual(res.json.dismissed, []);

      // File materialised on disk.
      const file = path.join(sandbox, 'data', 'auto-export', 'discovered.json');
      assert.ok(fs.existsSync(file));
    });

    test('dismiss endpoint moves entry to dismissed', async () => {
      const d = await req(server.baseUrl,
        '/api/health-auto-export/discoveries/sleep_analysis/dismiss',
        { method: 'POST' });
      assert.equal(d.status, 200);
      assert.equal(d.json.ok, true);

      const res = await req(server.baseUrl, '/api/health-auto-export/discoveries');
      assert.equal(res.json.undismissed.length, 1);
      assert.equal(res.json.undismissed[0].metric, 'heart_rate_variability');
      assert.equal(res.json.dismissed.length, 1);
      assert.equal(res.json.dismissed[0].metric, 'sleep_analysis');
      assert.ok(res.json.dismissed[0].dismissedAt);
    });

    test('unhide endpoint moves entry back to undismissed', async () => {
      const u = await req(server.baseUrl,
        '/api/health-auto-export/discoveries/sleep_analysis/unhide',
        { method: 'POST' });
      assert.equal(u.status, 200);
      assert.equal(u.json.ok, true);

      const res = await req(server.baseUrl, '/api/health-auto-export/discoveries');
      const metrics = res.json.undismissed.map(e => e.metric).sort();
      assert.deepEqual(metrics, ['heart_rate_variability', 'sleep_analysis']);
      assert.deepEqual(res.json.dismissed, []);
    });

    test('dismiss an unknown metric returns 404', async () => {
      const r = await req(server.baseUrl,
        '/api/health-auto-export/discoveries/no_such_thing/dismiss',
        { method: 'POST' });
      assert.equal(r.status, 404);
    });
  });

  describe('dismissal persists across subsequent pushes', () => {
    let sandbox, server;
    before(async () => {
      sandbox = createSandbox();
      server = await spawnServer(sandbox, { HEALTH_AUTO_EXPORT_TOKEN: TOKEN });
    });
    after(async () => { if (server) await server.kill(); cleanupSandbox(sandbox); });

    test('push again after dismiss does not resurface the metric', async () => {
      await req(server.baseUrl, '/api/health-auto-export', {
        method: 'POST', body: CANNED_PAYLOAD,
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      await req(server.baseUrl,
        '/api/health-auto-export/discoveries/heart_rate_variability/dismiss',
        { method: 'POST' });

      await req(server.baseUrl, '/api/health-auto-export', {
        method: 'POST', body: CANNED_PAYLOAD,
        headers: { Authorization: `Bearer ${TOKEN}` },
      });

      const res = await req(server.baseUrl, '/api/health-auto-export/discoveries');
      const dismissedMetrics = res.json.dismissed.map(e => e.metric);
      assert.ok(dismissedMetrics.includes('heart_rate_variability'));
      const undismissedMetrics = res.json.undismissed.map(e => e.metric);
      assert.ok(!undismissedMetrics.includes('heart_rate_variability'));
    });
  });

  describe('graduating a discovery (subscribe after seeing)', () => {
    let sandbox, server;
    before(async () => {
      sandbox = createSandbox();
      server = await spawnServer(sandbox, { HEALTH_AUTO_EXPORT_TOKEN: TOKEN });
    });
    after(async () => { if (server) await server.kill(); cleanupSandbox(sandbox); });

    test('adding a subscriber removes the metric from discoveries on next push', async () => {
      // First push — no subscribers, sleep lands in discoveries.
      await req(server.baseUrl, '/api/health-auto-export', {
        method: 'POST', body: CANNED_PAYLOAD,
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      let res = await req(server.baseUrl, '/api/health-auto-export/discoveries');
      assert.ok(res.json.undismissed.some(e => e.metric === 'sleep_analysis'));

      // Drop a sleep subscriber on disk.
      fs.writeFileSync(
        path.join(sandbox, 'data', 'sleep-hours.json'),
        JSON.stringify(SLEEP_SUBSCRIBER['sleep-hours.json'], null, 2));

      // Give the registry fs.watch a moment to reload.
      await new Promise(r => setTimeout(r, 400));

      // Second push — dispatcher now sees the sleep subscriber and clears it.
      await req(server.baseUrl, '/api/health-auto-export', {
        method: 'POST', body: CANNED_PAYLOAD,
        headers: { Authorization: `Bearer ${TOKEN}` },
      });

      res = await req(server.baseUrl, '/api/health-auto-export/discoveries');
      assert.ok(!res.json.undismissed.some(e => e.metric === 'sleep_analysis'),
        'sleep_analysis should have graduated out of undismissed');
      assert.ok(!res.json.dismissed.some(e => e.metric === 'sleep_analysis'),
        'sleep_analysis should also not linger in dismissed');
    });
  });
});
