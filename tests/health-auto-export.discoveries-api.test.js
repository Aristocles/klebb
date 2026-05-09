// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/health-auto-export.discoveries-api.test.js
// Integration tests for the discoveries API + dispatcher interaction.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createSandbox, cleanupSandbox, spawnServer, req } = require('./helpers/sandbox');

// Flatten the grouped+partitioned undismissed shape into a single array
// of metric names so tests can remain readable.
function allUndismissed(body) {
  const supportedGroups = body?.undismissed?.supported || {};
  const unsupported = body?.undismissed?.unsupported || [];
  const out = [];
  for (const group of Object.values(supportedGroups)) {
    for (const e of group) out.push(e.metric);
  }
  for (const e of unsupported) out.push(e.metric);
  return out;
}

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

    test('returns empty partitions', async () => {
      const res = await req(server.baseUrl, '/api/health-auto-export/discoveries');
      assert.equal(res.status, 200);
      assert.deepEqual(res.json.undismissed, { supported: {}, unsupported: [] });
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

    test('lists sleep_analysis + heart_rate_variability as undismissed, grouped by category', async () => {
      await req(server.baseUrl, '/api/health-auto-export', {
        method: 'POST', body: CANNED_PAYLOAD,
        headers: { Authorization: `Bearer ${TOKEN}` },
      });

      const res = await req(server.baseUrl, '/api/health-auto-export/discoveries');
      assert.equal(res.status, 200);
      assert.deepEqual(allUndismissed(res.json).sort(),
        ['heart_rate_variability', 'sleep_analysis']);
      // sleep_analysis lives under `sleep`, HRV under `recovery`.
      const supported = res.json.undismissed.supported;
      assert.deepEqual(supported.sleep.map(e => e.metric), ['sleep_analysis']);
      assert.deepEqual(supported.recovery.map(e => e.metric), ['heart_rate_variability']);
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
      assert.deepEqual(allUndismissed(res.json), ['heart_rate_variability']);
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
      assert.deepEqual(allUndismissed(res.json).sort(),
        ['heart_rate_variability', 'sleep_analysis']);
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
      assert.ok(!allUndismissed(res.json).includes('heart_rate_variability'));
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
      assert.ok(allUndismissed(res.json).includes('sleep_analysis'));

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
      assert.ok(!allUndismissed(res.json).includes('sleep_analysis'),
        'sleep_analysis should have graduated out of undismissed');
      assert.ok(!res.json.dismissed.some(e => e.metric === 'sleep_analysis'),
        'sleep_analysis should also not linger in dismissed');
    });
  });

  describe('catalogue-unsupported metrics land in the unsupported bucket', () => {
    let sandbox, server;
    before(async () => {
      sandbox = createSandbox();
      server = await spawnServer(sandbox, { HEALTH_AUTO_EXPORT_TOKEN: TOKEN });
    });
    after(async () => { if (server) await server.kill(); cleanupSandbox(sandbox); });

    test('vo2_max and respiratory_rate are unsupported; step_count is supported', async () => {
      const payload = { data: { metrics: [
        { name: 'step_count',       data: [{ date: '2026-05-09', qty: 4000 }] },
        { name: 'vo2_max',          data: [{ date: '2026-05-09', qty: 42 }] },
        { name: 'respiratory_rate', data: [{ date: '2026-05-09', qty: 16 }] },
      ]}};
      await req(server.baseUrl, '/api/health-auto-export', {
        method: 'POST', body: payload,
        headers: { Authorization: `Bearer ${TOKEN}` },
      });

      const res = await req(server.baseUrl, '/api/health-auto-export/discoveries');
      const supported = res.json.undismissed.supported;
      const unsupported = res.json.undismissed.unsupported;

      assert.ok(supported.activity, 'activity group should exist for step_count');
      assert.deepEqual(
        supported.activity.map(e => e.metric),
        ['step_count']);

      assert.deepEqual(
        unsupported.map(e => e.metric).sort(),
        ['respiratory_rate', 'vo2_max']);
    });
  });
});
