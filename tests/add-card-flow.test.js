// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/add-card-flow.test.js
// Integration test: simulate the Add Card modal's submit path by fetching
// /api/templates, substituting placeholders, POSTing to /api/manifests,
// and verifying the manifest lands on disk.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const {
  createSandbox, cleanupSandbox, spawnServer, req,
} = require('./helpers/sandbox');

let substituteLib;
test.before(async () => {
  substituteLib = await import(
    'file://' + path.resolve(__dirname, '..', 'public', 'js', 'lib', 'template-substitute.js')
      .replace(/\\/g, '/'),
  );
});

describe('Add Card end-to-end flow', () => {
  let sandbox, server;

  before(async () => {
    sandbox = createSandbox();
    server = await spawnServer(sandbox);
  });
  after(async () => {
    if (server) await server.kill();
    cleanupSandbox(sandbox);
  });

  test('fetch templates, substitute, create, confirm on disk', async () => {
    const r = await req(server.baseUrl, '/api/templates');
    assert.equal(r.status, 200);
    const weight = r.json.templates.find(t => t.id === 'weight');
    assert.ok(weight, 'weight template must be present');

    const raw = JSON.stringify(weight.manifest);
    const { manifest, error } = substituteLib.parseSubstituted(raw, {
      id: 'weight',
      label: 'Weight',
      unit: 'kg',
    });
    assert.equal(error, null, 'substitution failed');
    assert.equal(manifest.meta.id, 'weight');
    assert.equal(manifest.meta.label, 'Weight');

    const create = await req(server.baseUrl, '/api/manifests', {
      method: 'POST',
      body: manifest,
    });
    assert.equal(create.status, 201);
    assert.equal(create.json.id, 'weight');

    const file = path.join(sandbox, 'data', 'weight.json');
    assert.ok(fs.existsSync(file), 'manifest file written to disk');
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(onDisk.meta.id, 'weight');
    assert.equal(onDisk.meta.label, 'Weight');
    // Placeholder for unit was substituted
    assert.equal(onDisk.meta.view.display.unit, 'kg');
  });

  test('duplicate id returns 409 so the client can retry with a suffix', async () => {
    const r = await req(server.baseUrl, '/api/templates');
    const waist = r.json.templates.find(t => t.id === 'waist');
    const raw = JSON.stringify(waist.manifest);
    const first = substituteLib.parseSubstituted(raw, { id: 'waist', label: 'Waist', unit: 'cm' });
    const c1 = await req(server.baseUrl, '/api/manifests', { method: 'POST', body: first.manifest });
    assert.equal(c1.status, 201);

    const second = substituteLib.parseSubstituted(raw, { id: 'waist', label: 'Waist', unit: 'cm' });
    const c2 = await req(server.baseUrl, '/api/manifests', { method: 'POST', body: second.manifest });
    assert.equal(c2.status, 409,
      'second create of same id must return 409 so client can auto-suffix');

    // Simulate the client retry with waist-2.
    const retry = { ...second.manifest, meta: { ...second.manifest.meta, id: 'waist-2' } };
    const c3 = await req(server.baseUrl, '/api/manifests', { method: 'POST', body: retry });
    assert.equal(c3.status, 201);
    assert.equal(c3.json.id, 'waist-2');
  });
});
