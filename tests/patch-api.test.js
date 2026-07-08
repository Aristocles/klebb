// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/patch-api.test.js
// End-to-end tests for PATCH /api/manifests/:id.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createSandbox, cleanupSandbox, spawnServer, req } = require('./helpers/sandbox');

const MOOD = {
  $schema: 'klebb.datafile.v1',
  meta: {
    id: 'mood',
    label: 'Mood',
    emoji: '🙂',
    writeable: {
      fromWebapp: true,
      inputs: [
        { key: 'mood', type: 'emoji-picker', autoSubmit: true, emitIndex: true },
        { key: 'notes', type: 'textarea' },
      ],
    },
  },
  description: 'Daily mood.',
  data: [{ date: '2026-05-05', mood: 4, notes: 'ok' }],
};

describe('PATCH /api/manifests/:id', () => {
  let sandbox, server;

  before(async () => {
    sandbox = createSandbox({ seed: { 'mood.json': MOOD } });
    server = await spawnServer(sandbox);
  });

  after(async () => {
    if (server) await server.kill();
    if (sandbox) cleanupSandbox(sandbox);
  });

  test('200 on valid patch; meta updated, card data untouched', async () => {
    // Data lives in the datastore now; the manifest file is meta-only. Prove
    // the patch touches meta and leaves the card's data exactly as it was.
    const dataBefore = (await req(server.baseUrl, '/api/manifests/mood/data')).json.data;

    const res = await req(server.baseUrl, '/api/manifests/mood', {
      method: 'PATCH',
      body: {
        meta: {
          writeable: {
            inputs: [
              { key: 'mood', type: 'emoji-picker', autoSubmit: false, emitIndex: true },
              { key: 'notes', type: 'textarea' },
            ],
          },
        },
      },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);

    // fs.watch reload settles
    await new Promise(r => setTimeout(r, 200));

    const after = JSON.parse(fs.readFileSync(path.join(sandbox, 'data', 'mood.json'), 'utf8'));
    assert.equal(after.meta.writeable.inputs[0].autoSubmit, false);
    assert.equal('data' in after, false, 'manifest file carries no data key');
    const dataAfter = (await req(server.baseUrl, '/api/manifests/mood/data')).json.data;
    assert.deepEqual(dataAfter, dataBefore);
  });

  test('400 on patch touching $schema', async () => {
    const res = await req(server.baseUrl, '/api/manifests/mood', {
      method: 'PATCH',
      body: { $schema: 'bad' },
    });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /\$schema/);
  });

  test('400 on patch touching meta.id', async () => {
    const res = await req(server.baseUrl, '/api/manifests/mood', {
      method: 'PATCH',
      body: { meta: { id: 'renamed' } },
    });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /meta\.id/);
  });

  test('400 on patch touching data', async () => {
    const res = await req(server.baseUrl, '/api/manifests/mood', {
      method: 'PATCH',
      body: { data: [] },
    });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /data/);
  });

  test('400 on validation failure (null meta.label) — file unchanged', async () => {
    const filePath = path.join(sandbox, 'data', 'mood.json');
    const before = fs.readFileSync(filePath, 'utf8');
    const res = await req(server.baseUrl, '/api/manifests/mood', {
      method: 'PATCH',
      body: { meta: { label: null } },
    });
    assert.equal(res.status, 400);
    const after = fs.readFileSync(filePath, 'utf8');
    assert.equal(after, before);
  });

  test('400 on malformed JSON body', async () => {
    // raw string body bypasses the helper's default JSON.stringify path
    const url = new URL('/api/manifests/mood', server.baseUrl);
    const http = require('http');
    const r = await new Promise((resolve, reject) => {
      const rq = http.request({
        method: 'PATCH',
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        headers: { 'Content-Type': 'application/json' },
      }, res => {
        let buf = '';
        res.on('data', c => buf += c);
        res.on('end', () => resolve({ status: res.statusCode, body: buf }));
      });
      rq.on('error', reject);
      rq.end('not json{');
    });
    assert.equal(r.status, 400);
  });

  test('404 on unknown id', async () => {
    const res = await req(server.baseUrl, '/api/manifests/ghost', {
      method: 'PATCH',
      body: { meta: { label: 'x' } },
    });
    assert.equal(res.status, 404);
  });
});
