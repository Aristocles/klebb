// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/health-auto-export.replay-integration.test.js
// End-to-end: push arrives → later a subscriber is created → subscriber
// manifest materialises with the archived data already in place.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createSandbox, cleanupSandbox, spawnServer, req } = require('./helpers/sandbox');

const TOKEN = 'replay-token-hex-0123456789abcdef';

const PAYLOAD = {
  data: {
    metrics: [
      { name: 'sleep_analysis', data: [
        { date: '2026-05-06 00:00:00 +1000', totalSleep: 7.2, source: 'Apple Watch' },
      ]},
      { name: 'step_count', data: [
        { date: '2026-05-06 08:00:00 +1000', qty: 4200 },
      ]},
    ],
  },
};

describe('createManifest → replay from archive', () => {
  let sandbox, server;
  before(async () => {
    sandbox = createSandbox();
    server = await spawnServer(sandbox, { HEALTH_AUTO_EXPORT_TOKEN: TOKEN });
  });
  after(async () => { if (server) await server.kill(); cleanupSandbox(sandbox); });

  test('manifest created after a push is backfilled with archived data', async () => {
    // Step 1: push with no subscribers → raw archive populated, no
    // manifest files.
    const pushRes = await req(server.baseUrl, '/api/health-auto-export', {
      method: 'POST', body: PAYLOAD,
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(pushRes.status, 200);
    assert.deepEqual(pushRes.json.ingested, {});

    // Confirm raw file exists, no manifest created.
    const rawDir = path.join(sandbox, 'data', 'auto-export', 'raw');
    assert.ok(fs.readdirSync(rawDir).length >= 1);
    assert.equal(fs.existsSync(path.join(sandbox, 'data', 'sleep-hours.json')), false);

    // Step 2: create a sleep-analysis subscriber via the manifest-create API.
    const createRes = await req(server.baseUrl, '/api/manifests', {
      method: 'POST',
      body: {
        $schema: 'klebb.datafile.v1',
        meta: {
          id: 'sleep-hours',
          label: 'Sleep',
          emoji: '😴',
          ingest: { source: 'hae', metric: 'sleep_analysis' },
          view: { enabled: true, component: 'generic-card',
                  display: { template: '{hours:round(1)}', unit: 'hrs' } },
          writeable: { fromWebapp: false },
        },
        data: [],
      },
    });
    assert.ok(createRes.status === 200 || createRes.status === 201,
      `create failed (${createRes.status}): ${createRes.body}`);

    // Step 3: manifest should already have data from the replay.
    await new Promise(r => setTimeout(r, 200));
    const dataRes = await req(server.baseUrl, '/api/manifests/sleep-hours/data');
    assert.equal(dataRes.status, 200);
    assert.ok(Array.isArray(dataRes.json.data));
    assert.equal(dataRes.json.data.length, 1);
    assert.equal(dataRes.json.data[0].hours, 7.2);
    assert.equal(dataRes.json.data[0].source, 'Apple Watch');
  });

  test('creating a subscriber graduates the metric out of discoveries', async () => {
    // At this point sleep-hours exists; discoveries should not include
    // sleep_analysis (it was graduated). The original push also had
    // step_count, which is still unsubscribed — assert it stays present
    // to confirm we only graduate the newly-subscribed one.
    const discRes = await req(server.baseUrl, '/api/health-auto-export/discoveries');
    const supported = discRes.json.undismissed.supported || {};
    const allSupported = Object.values(supported).flat().map(e => e.metric);
    assert.ok(!allSupported.includes('sleep_analysis'),
      'sleep_analysis should have graduated');
    assert.ok(allSupported.includes('step_count'),
      'step_count is still unsubscribed; should remain a discovery');
  });

  test('re-creating fails cleanly; existing data untouched', async () => {
    // Attempt to re-create with same id — should fail with duplicate.
    const r = await req(server.baseUrl, '/api/manifests', {
      method: 'POST',
      body: {
        $schema: 'klebb.datafile.v1',
        meta: {
          id: 'sleep-hours',
          label: 'Sleep again',
          ingest: { source: 'hae', metric: 'sleep_analysis' },
          view: { enabled: true, component: 'generic-card',
                  display: { template: '{hours}' } },
        },
        data: [],
      },
    });
    assert.ok(r.status >= 400);

    // Existing data is preserved.
    const dataRes = await req(server.baseUrl, '/api/manifests/sleep-hours/data');
    assert.equal(dataRes.json.data.length, 1);
  });
});
