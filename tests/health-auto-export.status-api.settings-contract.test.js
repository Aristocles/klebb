// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/health-auto-export.status-api.settings-contract.test.js
//
// Pins the exact fields in /api/health-auto-export/status that the
// settings-view Health Auto Export panel depends on. A regression here
// would silently break the panel UI, so we assert the contract
// explicitly — even though the shape is already covered more
// functionally in health-auto-export.status-api.test.js.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const { createSandbox, cleanupSandbox, spawnServer, req } = require('./helpers/sandbox');

const TOKEN = 'contract-token-hex-0123456789abcdef';

const SUBSCRIBER = {
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

describe('Settings HAE panel ↔ /status contract', () => {
  let sandbox, server;
  before(async () => {
    sandbox = createSandbox({ seed: SUBSCRIBER });
    server = await spawnServer(sandbox, { HEALTH_AUTO_EXPORT_TOKEN: TOKEN });
  });
  after(async () => { if (server) await server.kill(); cleanupSandbox(sandbox); });

  test('fresh install: status has {tokenSet, endpointUrl, lastPush:null}', async () => {
    const res = await req(server.baseUrl, '/api/health-auto-export/status');
    assert.equal(res.status, 200);
    assert.equal(typeof res.json.tokenSet, 'boolean');
    assert.equal(typeof res.json.endpointUrl, 'string');
    assert.equal(res.json.lastPush, null);
  });

  test('post-push: lastPush has all fields the panel renders', async () => {
    await req(server.baseUrl, '/api/health-auto-export', {
      method: 'POST',
      body: { data: { metrics: [
        { name: 'step_count', data: [{ date: '2026-05-04', qty: 1234 }] },
        { name: 'heart_rate_variability', data: [{ date: '2026-05-04', qty: 55 }] },
      ]}},
      headers: { Authorization: `Bearer ${TOKEN}` },
    });

    const res = await req(server.baseUrl, '/api/health-auto-export/status');
    const lp = res.json.lastPush;

    // Top-level fields the panel reads.
    assert.equal(typeof lp.receivedAt, 'string');
    assert.equal(typeof lp.payloadBytes, 'number');
    assert.ok(Array.isArray(lp.subscribers));
    assert.ok(Array.isArray(lp.availableUnsubscribed));
    assert.ok(Array.isArray(lp.warnings));

    // Subscriber rows carry the fields the panel prints.
    const sub = lp.subscribers[0];
    assert.equal(typeof sub.id, 'string');
    assert.equal(typeof sub.metric, 'string');
    assert.equal(typeof sub.rowsWritten, 'number');

    // availableUnsubscribed is a flat string array (panel joins with ', ').
    assert.ok(lp.availableUnsubscribed.every(m => typeof m === 'string'));
  });
});
