// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/api/issue-702.test.js
// Regression seed for #702: patchManifest silently dropped a non-object
// patch.meta and any unknown top-level key, then reported success (and
// still rewrote the manifest file, so even an mtime check "confirmed"
// the phantom write). Over REST that was a 200 {ok:true} no-op. Every
// dropped-payload shape must now be a 400, and the meta must be provably
// unchanged after each rejection.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createSandbox, cleanupSandbox, spawnServer, req } = require('../helpers/sandbox');

function moodManifest() {
  return {
    $schema: 'klebb.datafile.v1',
    meta: {
      id: 'mood',
      label: 'Mood',
      emoji: '\u{1F642}',
      view: { enabled: true, component: 'generic-card' },
      writeable: { fromWebapp: true, inputs: [{ key: 'mood', type: 'number' }] },
    },
    description: 'Daily mood tracker.',
    data: [{ date: '2026-05-04', mood: 4 }],
  };
}

async function readMeta(server) {
  const res = await req(server.baseUrl, '/api/manifests');
  return res.json.entries.find(e => e.id === 'mood').meta;
}

describe('issue #702: patchManifest silent drops', () => {
  let sandbox, server;

  before(async () => {
    sandbox = createSandbox({ seed: { 'mood.json': moodManifest() } });
    server = await spawnServer(sandbox);
  });
  after(async () => {
    if (server) await server.kill();
    cleanupSandbox(sandbox);
  });

  test('PATCH with a stringified meta is rejected with 400, not silently dropped', async () => {
    const res = await req(server.baseUrl, '/api/manifests/mood', {
      method: 'PATCH',
      body: { meta: JSON.stringify({ label: 'Sneaky' }) },
    });
    assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.json)}`);
    assert.match(res.json.error || '', /object, not a string/);
    assert.equal((await readMeta(server)).label, 'Mood', 'meta unchanged after rejection');
  });

  test('PATCH with an unknown top-level key is rejected with 400, file untouched', async () => {
    const manifestFile = path.join(sandbox, 'data', 'mood.json');
    const mtimeBefore = fs.statSync(manifestFile).mtimeMs;
    const res = await req(server.baseUrl, '/api/manifests/mood', {
      method: 'PATCH',
      body: { label: 'Sneaky' },
    });
    assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.json)}`);
    assert.match(res.json.error || '', /unknown patch key: label/);
    assert.equal((await readMeta(server)).label, 'Mood', 'meta unchanged after rejection');
    // The old failure mode also REWROTE the manifest file on a dropped
    // patch, so even an mtime check "confirmed" the phantom write.
    assert.equal(fs.statSync(manifestFile).mtimeMs, mtimeBefore, 'manifest file not rewritten');
  });

  test('PATCH with a wholly double-serialised body is rejected with 400', async () => {
    const res = await req(server.baseUrl, '/api/manifests/mood', {
      method: 'PATCH',
      body: JSON.stringify(JSON.stringify({ meta: { label: 'Sneaky' } })),
    });
    assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.json)}`);
    assert.match(res.json.error || '', /patch must be a JSON object/);
    assert.equal((await readMeta(server)).label, 'Mood', 'meta unchanged after rejection');
  });

  test('an unknown key spelling out "unknown manifest" still maps to 400, not 404', async () => {
    const res = await req(server.baseUrl, '/api/manifests/mood', {
      method: 'PATCH',
      body: { 'unknown manifest x': 1 },
    });
    assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.json)}`);
  });

  test('PATCH with meta: null is rejected with 400', async () => {
    const res = await req(server.baseUrl, '/api/manifests/mood', {
      method: 'PATCH',
      body: { meta: null },
    });
    assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.json)}`);
    assert.match(res.json.error || '', /patch\.meta must be an object/);
    assert.equal((await readMeta(server)).label, 'Mood');
  });

  test('PATCH with an array meta is rejected with 400', async () => {
    const res = await req(server.baseUrl, '/api/manifests/mood', {
      method: 'PATCH',
      body: { meta: [{ label: 'Sneaky' }] },
    });
    assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.json)}`);
    assert.match(res.json.error || '', /patch\.meta must be an object/);
    assert.equal((await readMeta(server)).label, 'Mood');
  });

  test('a real meta patch still applies (no regression)', async () => {
    const res = await req(server.baseUrl, '/api/manifests/mood', {
      method: 'PATCH',
      body: { meta: { label: 'Mood log' } },
    });
    assert.equal(res.status, 200);
    assert.equal((await readMeta(server)).label, 'Mood log');
  });

  test('protected fields keep their specific errors', async () => {
    const res = await req(server.baseUrl, '/api/manifests/mood', {
      method: 'PATCH',
      body: { $schema: 'klebb.datafile.v2' },
    });
    assert.equal(res.status, 400);
    assert.match(res.json.error || '', /protected field: \$schema/);
  });
});

describe('issue #702: demo mode cannot be bypassed by a stringified body', () => {
  let sandbox, server, cookie;

  before(async () => {
    sandbox = createSandbox({ seed: { 'mood.json': moodManifest() } });
    server = await spawnServer(sandbox, { KLEBB_DEMO: '1' });
    const login = await req(server.baseUrl, '/auth/demo-login', { method: 'POST' });
    assert.equal(login.status, 200);
    cookie = login.headers['set-cookie'][0].split(';')[0];
  });
  after(async () => {
    if (server) await server.kill();
    cleanupSandbox(sandbox);
  });

  test('a double-serialised enabled-flip is a 400, never a rescued 200', async () => {
    const res = await req(server.baseUrl, '/api/manifests/mood', {
      method: 'PATCH',
      cookie,
      body: JSON.stringify(JSON.stringify({ meta: { enabled: false } })),
    });
    assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.json)}`);
    const check = await req(server.baseUrl, '/api/manifests', { cookie });
    const meta = check.json.entries.find(e => e.id === 'mood').meta;
    assert.notEqual(meta.enabled, false, 'card was not hidden');
  });

  test('the demo hide gate itself still fires on an object patch', async () => {
    const res = await req(server.baseUrl, '/api/manifests/mood', {
      method: 'PATCH',
      cookie,
      body: { meta: { enabled: false } },
    });
    assert.equal(res.status, 403);
    assert.match(res.json.error || '', /demo mode/);
  });
});
