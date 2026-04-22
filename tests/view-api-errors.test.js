// tests/view-api-errors.test.js
// Verifies that GET /api/views/:name exposes manifest parse errors to the
// frontend so eh-view-renderer can surface a warning pill.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createSandbox, cleanupSandbox, spawnServer, req } = require('./helpers/sandbox');

function makeValidCard() {
  return {
    $schema: 'klebb.datafile.v1',
    meta: {
      id: 'weight',
      label: 'Weight',
      view: { enabled: true, component: 'generic-card' },
    },
    data: [{ date: '2026-04-20', kg: 85 }],
  };
}

describe('/api/views/:name errors surface', () => {
  describe('with only valid manifests', () => {
    let sandbox, server;

    before(async () => {
      sandbox = createSandbox({ seed: { 'weight.json': makeValidCard() } });
      server = await spawnServer(sandbox);
    });
    after(async () => {
      if (server) await server.kill();
      cleanupSandbox(sandbox);
    });

    test('errors is an empty array', async () => {
      const res = await req(server.baseUrl, '/api/views/view');
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.json.errors));
      assert.equal(res.json.errors.length, 0);
      assert.equal(res.json.cards.length, 1);
    });
  });

  describe('with one malformed manifest alongside a good one', () => {
    let sandbox, server;

    before(async () => {
      sandbox = createSandbox({ seed: { 'weight.json': makeValidCard() } });
      // Add a malformed file
      fs.writeFileSync(path.join(sandbox, 'data', 'broken.json'), '{not valid json');
      server = await spawnServer(sandbox);
    });
    after(async () => {
      if (server) await server.kill();
      cleanupSandbox(sandbox);
    });

    test('good card still renders, bad card appears in errors', async () => {
      const res = await req(server.baseUrl, '/api/views/view');
      assert.equal(res.status, 200);
      assert.equal(res.json.cards.length, 1, 'good card still visible');
      assert.equal(res.json.cards[0].id, 'weight');
      assert.ok(Array.isArray(res.json.errors));
      assert.equal(res.json.errors.length, 1);
      assert.equal(res.json.errors[0].file, 'broken.json');
    });

    test('errors field is also on /api/manifests', async () => {
      const res = await req(server.baseUrl, '/api/manifests');
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.json.errors));
      assert.equal(res.json.errors.length, 1);
    });
  });

  describe('with a manifest that has an unsupported schema', () => {
    let sandbox, server;

    before(async () => {
      sandbox = createSandbox({
        seed: {
          'weird.json': {
            $schema: 'some.other.schema.v1',
            meta: { id: 'weird' },
            data: [],
          },
        },
      });
      server = await spawnServer(sandbox);
    });
    after(async () => {
      if (server) await server.kill();
      cleanupSandbox(sandbox);
    });

    test('unsupported-schema file appears in errors with a descriptive message', async () => {
      const res = await req(server.baseUrl, '/api/views/view');
      assert.equal(res.status, 200);
      assert.ok(res.json.errors.length > 0);
      const err = res.json.errors.find(e => e.file === 'weird.json');
      assert.ok(err, 'weird.json should be in errors');
      assert.ok(/schema/i.test(err.error), `error should mention schema: ${err.error}`);
    });
  });
});
