// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/api/hygiene-api.test.js
// GET /api/hygiene surfaces high-confidence staleness; POST .../dismiss
// suppresses it. Mirrors the cc-suggestions dismissal model.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createSandbox, cleanupSandbox, spawnServer, req } = require('../helpers/sandbox');

// A generic-card with dated rows ending ~40 days ago: comfortably stale, and
// enough rows to clear the near-empty suppression.
function staleCard(id) {
  const rows = [];
  const base = Date.parse('2000-01-01T00:00:00Z'); // any fixed past; ages are huge
  for (let i = 0; i < 5; i++) {
    rows.push({ date: new Date(base + i * 86400000).toISOString().slice(0, 10), kg: 80 + i });
  }
  return {
    $schema: 'klebb.datafile.v1',
    meta: {
      id, label: `Card ${id}`, view: { enabled: true, component: 'generic-card' },
      // Staleness is opt-in per card (#570): without a declared cadence nothing
      // is ever flagged, so a fixture that means to exercise it has to declare
      // one. It also only applies to cards the user can write to (#564): a card
      // with no input form cannot be brought up to date, so nagging about it
      // asks the impossible. A fixture without both is not exercising the rule.
      cadence: { expectDays: 21 },
      writeable: {
        fromWebapp: true, todayAllowed: true, pastAllowed: true,
        inputs: [{ key: 'kg', label: 'Weight', type: 'number' }],
      },
    },
    data: rows,
  };
}

describe('GET /api/hygiene', () => {
  let sandbox, server;
  before(async () => {
    sandbox = createSandbox({ seed: { 'old.json': staleCard('old') } });
    server = await spawnServer(sandbox);
  });
  after(async () => { if (server) await server.kill(); cleanupSandbox(sandbox); });

  test('surfaces a stale finding for an old card', async () => {
    const res = await req(server.baseUrl, '/api/hygiene');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.json.findings));
    const f = res.json.findings.find(x => x.cardId === 'old');
    assert.ok(f, 'expected a stale finding for the old card');
    assert.equal(f.kind, 'stale');
  });

  test('dismiss suppresses the finding and persists', async () => {
    const d = await req(server.baseUrl, '/api/hygiene/old/dismiss', {
      method: 'POST', body: { kind: 'stale' },
    });
    assert.equal(d.status, 200);
    assert.equal(d.json.ok, true);

    const file = path.join(sandbox, 'data', '_meta', 'hygiene-dismissed.json');
    assert.ok(fs.existsSync(file), 'dismissal sidecar created');
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(state['old::stale'], 'dismissal keyed by cardId::kind');

    const res = await req(server.baseUrl, '/api/hygiene');
    assert.equal(res.json.findings.find(x => x.cardId === 'old'), undefined,
      'dismissed finding no longer surfaces');
  });

  test('invalid json on dismiss returns 400', async () => {
    const res = await req(server.baseUrl, '/api/hygiene/old/dismiss', {
      method: 'POST', body: '{nope', headers: { 'Content-Type': 'application/json' },
    });
    assert.equal(res.status, 400);
  });
});
