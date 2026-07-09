// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/orphans-api.test.js
// GET /api/manifests/:id/orphans against a spawned server. The chat-tool
// dispatch lives in tests/orphans-tools.test.js (fresh-required registry
// harness; the two harness styles do not share a file), and the unit-level
// machinery in tests/datastore-fields.test.js.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const { createSandbox, cleanupSandbox, spawnServer, req } = require('./helpers/sandbox');

const WEIGHT = {
  $schema: 'klebb.datafile.v1',
  meta: {
    id: 'weight', label: 'Weight',
    view: { enabled: true, component: 'generic-card', display: { template: '{kg:round(1)}' } },
    writeable: { fromWebapp: true, inputs: [{ key: 'kg', label: 'kg', type: 'number' }] },
    trends: { enabled: true, component: 'line-chart', field: 'kg' },
  },
  // waist_cm was captured by an input that has since been removed.
  data: [
    { date: '2026-06-01', kg: 84, waist_cm: 90 },
    { date: '2026-06-02', kg: 83.6, waist_cm: 89 },
  ],
};

describe('GET /api/manifests/:id/orphans', () => {
  let sandbox, server;
  before(async () => {
    sandbox = createSandbox({ seed: { 'weight.json': WEIGHT } });
    server = await spawnServer(sandbox);
  });
  after(async () => { if (server) await server.kill(); cleanupSandbox(sandbox); });

  test('reports the unreferenced key; rows stay intact', async () => {
    const res = await req(server.baseUrl, '/api/manifests/weight/orphans');
    assert.equal(res.status, 200);
    assert.deepStrictEqual(res.json.orphans, ['waist_cm']);
    assert.ok(res.json.referenced.includes('kg'));

    const data = (await req(server.baseUrl, '/api/manifests/weight/data')).json.data;
    assert.equal(data[0].waist_cm, 90, 'orphaned values still served');
  });

  test('404 on unknown id', async () => {
    const res = await req(server.baseUrl, '/api/manifests/ghost/orphans');
    assert.equal(res.status, 404);
  });
});
