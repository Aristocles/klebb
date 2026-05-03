// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/manifests-create-api.test.js
// End-to-end coverage of POST /api/manifests (create) and DELETE
// /api/manifests/:id (delete) against a live spawned server + sandbox
// HEALTH_HOME.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const {
  createSandbox, cleanupSandbox, spawnServer, req, fakeAuthState,
} = require('./helpers/sandbox');

describe('POST /api/manifests + DELETE /api/manifests/:id', () => {
  let sandbox, server, auth;

  before(async () => {
    auth = fakeAuthState('op');
    sandbox = createSandbox({
      credentials: auth.credentials,
      sessions: auth.sessions,
    });
    server = await spawnServer(sandbox);
  });
  after(async () => {
    if (server) await server.kill();
    cleanupSandbox(sandbox);
  });

  test('401 without auth', async () => {
    const res = await req(server.baseUrl, '/api/manifests', {
      method: 'POST',
      body: {
        $schema: 'klebb.datafile.v1',
        meta: { id: 'noauth', label: 'NoAuth' },
        data: [],
      },
    });
    assert.equal(res.status, 401);
  });

  test('201 happy path; GET round-trips the body; file lives on disk', async () => {
    const body = {
      $schema: 'klebb.datafile.v1',
      meta: {
        id: 'blood-pressure',
        label: 'Blood Pressure',
        emoji: '🩺',
        view: { enabled: true, component: 'list-card' },
      },
      description: 'Home BP readings.',
      data: [{ date: '2026-04-20', systolic: 120, diastolic: 80 }],
    };
    const post = await req(server.baseUrl, '/api/manifests', {
      method: 'POST',
      cookie: auth.cookie,
      body,
    });
    assert.equal(post.status, 201);
    assert.equal(post.json.ok, true);
    assert.equal(post.json.id, 'blood-pressure');
    assert.equal(post.json.source, 'blood-pressure.json');

    const get = await req(server.baseUrl, '/api/manifests/blood-pressure', {
      cookie: auth.cookie,
    });
    assert.equal(get.status, 200);
    assert.equal(get.json.meta.label, 'Blood Pressure');
    assert.equal(get.json.description, 'Home BP readings.');

    const onDisk = path.join(sandbox, 'data', 'blood-pressure.json');
    assert.ok(fs.existsSync(onDisk), 'manifest file should be on disk');
  });

  test('409 on duplicate id', async () => {
    const res = await req(server.baseUrl, '/api/manifests', {
      method: 'POST',
      cookie: auth.cookie,
      body: {
        $schema: 'klebb.datafile.v1',
        meta: { id: 'blood-pressure', label: 'Dup' },
        data: [],
      },
    });
    assert.equal(res.status, 409);
    assert.match(res.json.error, /duplicate id/);
  });

  test('400 on invalid JSON body', async () => {
    // req() stringifies object bodies; send a raw malformed string instead.
    const res = await req(server.baseUrl, '/api/manifests', {
      method: 'POST',
      cookie: auth.cookie,
      body: '{not valid',
    });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /invalid JSON/);
  });

  test('400 on missing $schema', async () => {
    const res = await req(server.baseUrl, '/api/manifests', {
      method: 'POST',
      cookie: auth.cookie,
      body: { meta: { id: 'noschema', label: 'No Schema' } },
    });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /\$schema/);
  });

  test('400 on missing meta.label', async () => {
    const res = await req(server.baseUrl, '/api/manifests', {
      method: 'POST',
      cookie: auth.cookie,
      body: {
        $schema: 'klebb.datafile.v1',
        meta: { id: 'no-label' },
        data: [],
      },
    });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /meta\.label/);
  });

  test('422 on invalid id format', async () => {
    const res = await req(server.baseUrl, '/api/manifests', {
      method: 'POST',
      cookie: auth.cookie,
      body: {
        $schema: 'klebb.datafile.v1',
        meta: { id: 'Bad Id With Spaces', label: 'Bad' },
        data: [],
      },
    });
    assert.equal(res.status, 422);
    assert.match(res.json.error, /invalid id/);
  });

  test('422 on reserved id', async () => {
    const res = await req(server.baseUrl, '/api/manifests', {
      method: 'POST',
      cookie: auth.cookie,
      body: {
        $schema: 'klebb.datafile.v1',
        meta: { id: '_archive', label: 'Reserved' },
        data: [],
      },
    });
    assert.equal(res.status, 422);
    assert.match(res.json.error, /invalid id/);
  });

  test('ad-hoc path: unknown renderer names are accepted (escape hatch)', async () => {
    const res = await req(server.baseUrl, '/api/manifests', {
      method: 'POST',
      cookie: auth.cookie,
      body: {
        $schema: 'klebb.datafile.v1',
        meta: {
          id: 'sleep-arch',
          label: 'Sleep Architecture',
          view: { enabled: true, component: 'sleep-stages-sunburst' },
        },
        data: { stages: [{ name: 'REM', pct: 22 }] },
      },
    });
    assert.equal(res.status, 201);

    const get = await req(server.baseUrl, '/api/manifests/sleep-arch', {
      cookie: auth.cookie,
    });
    assert.equal(get.status, 200);
    assert.equal(get.json.meta.view.component, 'sleep-stages-sunburst');
  });

  test('DELETE removes the card; GET then 404s; file unlinked', async () => {
    const del = await req(server.baseUrl, '/api/manifests/blood-pressure', {
      method: 'DELETE',
      cookie: auth.cookie,
    });
    assert.equal(del.status, 200);
    assert.equal(del.json.ok, true);
    assert.equal(del.json.id, 'blood-pressure');

    const get = await req(server.baseUrl, '/api/manifests/blood-pressure', {
      cookie: auth.cookie,
    });
    assert.equal(get.status, 404);

    const onDisk = path.join(sandbox, 'data', 'blood-pressure.json');
    assert.ok(!fs.existsSync(onDisk), 'manifest file should be gone');
  });

  test('DELETE unknown id → 404', async () => {
    const res = await req(server.baseUrl, '/api/manifests/does-not-exist', {
      method: 'DELETE',
      cookie: auth.cookie,
    });
    assert.equal(res.status, 404);
  });
});
