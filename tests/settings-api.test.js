// tests/settings-api.test.js
// Integration tests for the Settings backend:
//   - GET /api/settings/cards
//   - POST /api/settings/cards/:id/enable
//   - POST /api/settings/cards/:id/disable
// And the effect on /api/views/view (master meta.enabled hides everywhere).

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createSandbox, cleanupSandbox, spawnServer, req } = require('./helpers/sandbox');

function makeCard(id, { enabled, data = [{ date: '2026-04-20', v: 1 }] } = {}) {
  const meta = {
    id,
    label: id.charAt(0).toUpperCase() + id.slice(1),
    view: { enabled: true, component: 'metric-card' },
    trends: { enabled: true, component: 'line-chart' },
  };
  if (typeof enabled === 'boolean') meta.enabled = enabled;
  return { $schema: 'eddzhealth.datafile.v1', meta, data };
}

describe('settings API', () => {
  let sandbox, server;

  before(async () => {
    sandbox = createSandbox({
      seed: {
        'weight.json': makeCard('weight'),
        'bp.json': makeCard('bp', { enabled: false }),
        'notes.json': makeCard('notes'),
      },
    });
    server = await spawnServer(sandbox);
  });
  after(async () => {
    if (server) await server.kill();
    cleanupSandbox(sandbox);
  });

  test('GET /api/settings/cards returns all cards with enabled flag', async () => {
    const res = await req(server.baseUrl, '/api/settings/cards');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.json.cards));
    assert.equal(res.json.cards.length, 3);

    const byId = Object.fromEntries(res.json.cards.map(c => [c.id, c]));
    assert.equal(byId.weight.enabled, true, 'weight should be enabled (absent meta.enabled)');
    assert.equal(byId.bp.enabled, false, 'bp should be disabled (meta.enabled: false)');
    assert.equal(byId.notes.enabled, true);
  });

  test('GET /api/views/view hides cards with meta.enabled: false', async () => {
    const res = await req(server.baseUrl, '/api/views/view');
    assert.equal(res.status, 200);
    const ids = res.json.cards.map(c => c.id);
    assert.ok(ids.includes('weight'));
    assert.ok(!ids.includes('bp'), 'bp (meta.enabled: false) should NOT appear in view');
    assert.ok(ids.includes('notes'));
  });

  test('POST /api/settings/cards/:id/disable flips flag and persists', async () => {
    const res = await req(server.baseUrl, '/api/settings/cards/weight/disable', { method: 'POST' });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.enabled, false);

    // File on disk should now have meta.enabled: false
    const raw = JSON.parse(fs.readFileSync(path.join(sandbox, 'data', 'weight.json'), 'utf8'));
    assert.equal(raw.meta.enabled, false);

    // And /api/views/view should no longer list it
    const view = await req(server.baseUrl, '/api/views/view');
    const ids = view.json.cards.map(c => c.id);
    assert.ok(!ids.includes('weight'), 'weight should now be hidden from view');
  });

  test('POST /api/settings/cards/:id/enable flips it back', async () => {
    const res = await req(server.baseUrl, '/api/settings/cards/bp/enable', { method: 'POST' });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.enabled, true);

    const raw = JSON.parse(fs.readFileSync(path.join(sandbox, 'data', 'bp.json'), 'utf8'));
    assert.equal(raw.meta.enabled, true);

    const view = await req(server.baseUrl, '/api/views/view');
    const ids = view.json.cards.map(c => c.id);
    assert.ok(ids.includes('bp'), 'bp should now appear in view');
  });

  test('POST /api/settings/cards/unknown/enable → 404', async () => {
    const res = await req(server.baseUrl, '/api/settings/cards/nonexistent/enable', { method: 'POST' });
    assert.equal(res.status, 404);
  });

  test('toggle preserves description and data block', async () => {
    // Write a card with a description and data, toggle it twice, confirm integrity
    const file = path.join(sandbox, 'data', 'preserve-test.json');
    fs.writeFileSync(file, JSON.stringify({
      $schema: 'eddzhealth.datafile.v1',
      meta: { id: 'preserve-test', label: 'Preserve', view: { enabled: true, component: 'metric-card' } },
      description: 'this must survive toggles',
      data: [{ date: '2026-04-20', note: 'keep me' }],
    }));
    // Give fs.watch a chance to pick it up
    await new Promise(r => setTimeout(r, 300));

    const disable = await req(server.baseUrl, '/api/settings/cards/preserve-test/disable', { method: 'POST' });
    assert.equal(disable.status, 200);
    const enable = await req(server.baseUrl, '/api/settings/cards/preserve-test/enable', { method: 'POST' });
    assert.equal(enable.status, 200);

    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(raw.description, 'this must survive toggles');
    assert.equal(raw.data.length, 1);
    assert.equal(raw.data[0].note, 'keep me');
    assert.equal(raw.meta.enabled, true);
  });

  test('deprecated /api/setup endpoints are gone', async () => {
    const a = await req(server.baseUrl, '/api/setup');
    const b = await req(server.baseUrl, '/api/setup/install', { method: 'POST', body: { ids: ['weight'] } });
    // 404 from the fallthrough
    assert.equal(a.status, 404);
    assert.equal(b.status, 404);
  });

  test('deprecated archive/restore endpoints are gone', async () => {
    const a = await req(server.baseUrl, '/api/settings/cards/weight/archive', { method: 'POST' });
    assert.equal(a.status, 404);
  });
});
