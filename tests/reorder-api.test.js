// tests/reorder-api.test.js
// Integration tests for POST /api/manifests/reorder.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createSandbox, cleanupSandbox, spawnServer, req } = require('./helpers/sandbox');

function makeCard(id, order) {
  return {
    $schema: 'klebb.datafile.v1',
    meta: {
      id,
      label: id.charAt(0).toUpperCase() + id.slice(1),
      order,
      view: { enabled: true, component: 'generic-card' },
    },
    description: `${id} card`,
    data: [{ date: '2026-04-22', v: 1 }],
  };
}

describe('POST /api/manifests/reorder', () => {
  describe('happy path', () => {
    let sandbox, server;

    before(async () => {
      sandbox = createSandbox({
        seed: {
          'weight.json': makeCard('weight', 100),
          'bp.json': makeCard('bp', 200),
          'mood.json': makeCard('mood', 300),
        },
      });
      server = await spawnServer(sandbox);
    });
    after(async () => {
      if (server) await server.kill();
      cleanupSandbox(sandbox);
    });

    test('reorders three cards end-to-end', async () => {
      // Initial order is weight, bp, mood (100, 200, 300)
      const before = await req(server.baseUrl, '/api/views/view');
      assert.deepEqual(before.json.cards.map(c => c.id), ['weight', 'bp', 'mood']);

      // Reorder: mood first, then weight, then bp
      const res = await req(server.baseUrl, '/api/manifests/reorder', {
        method: 'POST',
        body: { order: ['mood', 'weight', 'bp'] },
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.ok, true);
      assert.deepEqual(res.json.updated, ['mood', 'weight', 'bp']);

      const after = await req(server.baseUrl, '/api/views/view');
      assert.deepEqual(after.json.cards.map(c => c.id), ['mood', 'weight', 'bp']);
    });

    test('writes sparse-numbered meta.order to each file', async () => {
      const mood = JSON.parse(fs.readFileSync(path.join(sandbox, 'data', 'mood.json'), 'utf8'));
      const weight = JSON.parse(fs.readFileSync(path.join(sandbox, 'data', 'weight.json'), 'utf8'));
      const bp = JSON.parse(fs.readFileSync(path.join(sandbox, 'data', 'bp.json'), 'utf8'));
      assert.equal(mood.meta.order, 100);
      assert.equal(weight.meta.order, 200);
      assert.equal(bp.meta.order, 300);
    });

    test('preserves every other meta field + data block', async () => {
      const mood = JSON.parse(fs.readFileSync(path.join(sandbox, 'data', 'mood.json'), 'utf8'));
      assert.equal(mood.description, 'mood card');
      assert.equal(mood.meta.label, 'Mood');
      assert.equal(mood.meta.view.enabled, true);
      assert.equal(mood.data.length, 1);
      assert.equal(mood.data[0].v, 1);
    });

    test('is idempotent — same order twice is a no-op', async () => {
      const mtimeBefore = fs.statSync(path.join(sandbox, 'data', 'mood.json')).mtimeMs;
      const res = await req(server.baseUrl, '/api/manifests/reorder', {
        method: 'POST',
        body: { order: ['mood', 'weight', 'bp'] },
      });
      assert.equal(res.status, 200);
      const mtimeAfter = fs.statSync(path.join(sandbox, 'data', 'mood.json')).mtimeMs;
      // Idempotent: file wasn't rewritten (mtime unchanged)
      assert.equal(mtimeAfter, mtimeBefore);
    });
  });

  describe('validation', () => {
    let sandbox, server;

    before(async () => {
      sandbox = createSandbox({
        seed: {
          'weight.json': makeCard('weight', 100),
          'bp.json': makeCard('bp', 200),
        },
      });
      server = await spawnServer(sandbox);
    });
    after(async () => {
      if (server) await server.kill();
      cleanupSandbox(sandbox);
    });

    test('missing order[] → 400', async () => {
      const res = await req(server.baseUrl, '/api/manifests/reorder', {
        method: 'POST',
        body: {},
      });
      assert.equal(res.status, 400);
      assert.ok(/order/.test(res.json.error));
    });

    test('order is not an array → 400', async () => {
      const res = await req(server.baseUrl, '/api/manifests/reorder', {
        method: 'POST',
        body: { order: 'not-an-array' },
      });
      assert.equal(res.status, 400);
    });

    test('empty order[] → 400', async () => {
      const res = await req(server.baseUrl, '/api/manifests/reorder', {
        method: 'POST',
        body: { order: [] },
      });
      assert.equal(res.status, 400);
    });

    test('unknown id in order[] → 404, no writes', async () => {
      const weightBefore = JSON.parse(fs.readFileSync(path.join(sandbox, 'data', 'weight.json'), 'utf8'));
      const res = await req(server.baseUrl, '/api/manifests/reorder', {
        method: 'POST',
        body: { order: ['weight', 'nonexistent', 'bp'] },
      });
      assert.equal(res.status, 404);
      assert.ok(/unknown/.test(res.json.error));
      // No partial-write: weight.json unchanged
      const weightAfter = JSON.parse(fs.readFileSync(path.join(sandbox, 'data', 'weight.json'), 'utf8'));
      assert.equal(weightAfter.meta.order, weightBefore.meta.order);
    });

    test('duplicate id in order[] → 400', async () => {
      const res = await req(server.baseUrl, '/api/manifests/reorder', {
        method: 'POST',
        body: { order: ['weight', 'weight', 'bp'] },
      });
      assert.equal(res.status, 400);
      assert.ok(/duplicate/i.test(res.json.error));
    });

    test('malformed JSON body → 400', async () => {
      const res = await req(server.baseUrl, '/api/manifests/reorder', {
        method: 'POST',
        body: '{not valid json',
        headers: { 'Content-Type': 'application/json' },
      });
      assert.equal(res.status, 400);
    });
  });

  describe('partial reorder (only some ids)', () => {
    let sandbox, server;

    before(async () => {
      sandbox = createSandbox({
        seed: {
          'a.json': makeCard('a', 100),
          'b.json': makeCard('b', 200),
          'c.json': makeCard('c', 300),
          'd.json': makeCard('d', 400),
        },
      });
      server = await spawnServer(sandbox);
    });
    after(async () => {
      if (server) await server.kill();
      cleanupSandbox(sandbox);
    });

    test('partial order[] reorders only listed cards; others keep their order', async () => {
      // Reorder only c and a — give them slots 100 + 200
      // b + d should keep their existing order values (200, 400)
      const res = await req(server.baseUrl, '/api/manifests/reorder', {
        method: 'POST',
        body: { order: ['c', 'a'] },
      });
      assert.equal(res.status, 200);

      const c = JSON.parse(fs.readFileSync(path.join(sandbox, 'data', 'c.json'), 'utf8'));
      const a = JSON.parse(fs.readFileSync(path.join(sandbox, 'data', 'a.json'), 'utf8'));
      const b = JSON.parse(fs.readFileSync(path.join(sandbox, 'data', 'b.json'), 'utf8'));
      const d = JSON.parse(fs.readFileSync(path.join(sandbox, 'data', 'd.json'), 'utf8'));
      assert.equal(c.meta.order, 100);
      assert.equal(a.meta.order, 200);
      // Untouched cards keep original values
      assert.equal(b.meta.order, 200);
      assert.equal(d.meta.order, 400);
      // Note: after this partial reorder, a and b both have order=200.
      // listForView sorts by order asc then label asc, so they're stable.
    });
  });
});
