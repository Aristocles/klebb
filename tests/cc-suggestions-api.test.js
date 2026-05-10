// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/cc-suggestions-api.test.js
// End-to-end: CC-suggestion GET + dismiss endpoints backed by the live
// registry on a sandbox.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createSandbox, cleanupSandbox, spawnServer, req } = require('./helpers/sandbox');

function seedCard(id, category, extra = {}) {
  return {
    $schema: 'klebb.datafile.v1',
    meta: {
      id,
      label: id,
      category,
      view: { enabled: true, component: 'generic-card',
              display: { template: 'x' } },
      ...extra,
    },
    data: [],
  };
}

describe('GET /api/cc-suggestions', () => {
  describe('fewer than 3 same-category cards → empty', () => {
    let sandbox, server;
    before(async () => {
      sandbox = createSandbox({ seed: {
        'a.json': seedCard('a', 'recovery'),
        'b.json': seedCard('b', 'recovery'),
      }});
      server = await spawnServer(sandbox);
    });
    after(async () => { if (server) await server.kill(); cleanupSandbox(sandbox); });

    test('returns empty suggestions', async () => {
      const res = await req(server.baseUrl, '/api/cc-suggestions');
      assert.equal(res.status, 200);
      assert.deepEqual(res.json.suggestions, []);
    });
  });

  describe('3 same-category cards → single suggestion', () => {
    let sandbox, server;
    before(async () => {
      sandbox = createSandbox({ seed: {
        'hrv.json':   seedCard('hrv', 'recovery'),
        'rhr.json':   seedCard('rhr', 'recovery'),
        'sleep.json': seedCard('sleep', 'recovery'),
      }});
      server = await spawnServer(sandbox);
    });
    after(async () => { if (server) await server.kill(); cleanupSandbox(sandbox); });

    test('returns one recovery suggestion with three card IDs', async () => {
      const res = await req(server.baseUrl, '/api/cc-suggestions');
      assert.equal(res.status, 200);
      assert.equal(res.json.suggestions.length, 1);
      const s = res.json.suggestions[0];
      assert.equal(s.category, 'recovery');
      assert.deepEqual(s.cardIds.sort(), ['hrv', 'rhr', 'sleep']);
    });
  });

  describe('dismiss + re-check', () => {
    let sandbox, server;
    before(async () => {
      sandbox = createSandbox({ seed: {
        'hrv.json':   seedCard('hrv', 'recovery'),
        'rhr.json':   seedCard('rhr', 'recovery'),
        'sleep.json': seedCard('sleep', 'recovery'),
      }});
      server = await spawnServer(sandbox);
    });
    after(async () => { if (server) await server.kill(); cleanupSandbox(sandbox); });

    test('dismiss endpoint persists and suppresses', async () => {
      const d = await req(server.baseUrl,
        '/api/cc-suggestions/recovery/dismiss', {
          method: 'POST',
          body: { cardIds: ['hrv', 'rhr', 'sleep'] },
        });
      assert.equal(d.status, 200);
      assert.equal(d.json.ok, true);

      // File created on disk.
      const file = path.join(sandbox, 'data', '_meta', 'cc-suggestions-dismissed.json');
      assert.ok(fs.existsSync(file));

      const res = await req(server.baseUrl, '/api/cc-suggestions');
      assert.deepEqual(res.json.suggestions, []);
    });

    test('dismiss with empty cardIds returns 400', async () => {
      const r = await req(server.baseUrl,
        '/api/cc-suggestions/recovery/dismiss',
        { method: 'POST', body: {} });
      assert.equal(r.status, 400);
    });
  });

  describe('cards already in a CC are excluded', () => {
    let sandbox, server;
    before(async () => {
      sandbox = createSandbox({ seed: {
        'hrv.json':   seedCard('hrv', 'recovery'),
        'rhr.json':   seedCard('rhr', 'recovery'),
        'sleep.json': seedCard('sleep', 'recovery'),
        'recovery-ring.json': {
          $schema: 'klebb.datafile.v1',
          meta: {
            id: 'recovery-ring',
            label: 'Recovery',
            category: 'recovery',
            view: {
              enabled: true,
              component: 'combination-card',
              combines: [
                { sourceId: 'hrv', role: 'primary' },
                { sourceId: 'rhr', role: 'secondary' },
                { sourceId: 'sleep', role: 'secondary' },
              ],
            },
          },
          data: [],
        },
      }});
      server = await spawnServer(sandbox);
    });
    after(async () => { if (server) await server.kill(); cleanupSandbox(sandbox); });

    test('the three donors are excluded; no cluster remains', async () => {
      const res = await req(server.baseUrl, '/api/cc-suggestions');
      assert.deepEqual(res.json.suggestions, []);
    });
  });
});
