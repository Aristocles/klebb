// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/api/issue-404.test.js
// Regression seed for #404: notifications + schedule_time_of_day validator
// throws are mapped to 422 on POST /api/manifests and PATCH /api/manifests/:id.
// Without the fix these fall through to the generic 500 handler, so any
// well-behaved client interprets them as a server bug and retries.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const {
  createSandbox, cleanupSandbox, spawnServer, req, fakeAuthState,
} = require('../helpers/sandbox');

describe('#404 validator throws map to 422 (POST /api/manifests)', () => {
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

  function baseManifest(id, notifTrigger, scheduleItems) {
    const meta = {
      id,
      label: id,
      view: { enabled: true, component: 'list-card' },
    };
    if (notifTrigger) {
      meta.notifications = {
        enabled: true,
        items: [{
          id: 'n1',
          label: 'L',
          title: 'T',
          body: 'B',
          trigger: notifTrigger,
        }],
      };
    }
    return {
      $schema: 'klebb.datafile.v1',
      meta,
      data: scheduleItems ? { items: scheduleItems } : [],
    };
  }

  test('schedule_due trigger with bad time_of_day token returns 422 with invalid notifications: prefix', async () => {
    const res = await req(server.baseUrl, '/api/manifests', {
      method: 'POST',
      cookie: auth.cookie,
      body: baseManifest('issue404-bad-tod', {
        type: 'schedule_due',
        card: 'some-card',
        time_of_day: 'marning',
        time: '08:00',
      }),
    });
    assert.equal(res.status, 422);
    assert.match(res.json.error, /^invalid notifications:/);
  });

  test('schedule_due trigger missing required card field returns 422', async () => {
    const res = await req(server.baseUrl, '/api/manifests', {
      method: 'POST',
      cookie: auth.cookie,
      body: baseManifest('issue404-missing-card', {
        type: 'schedule_due',
        time_of_day: 'morning',
        time: '08:00',
      }),
    });
    assert.equal(res.status, 422);
    assert.match(res.json.error, /^invalid notifications:/);
  });

  test('schedule_due trigger with array time_of_day (single-token only) returns 422', async () => {
    const res = await req(server.baseUrl, '/api/manifests', {
      method: 'POST',
      cookie: auth.cookie,
      body: baseManifest('issue404-array-tod', {
        type: 'schedule_due',
        card: 'some-card',
        time_of_day: ['morning', 'evening'],
        time: '08:00',
      }),
    });
    assert.equal(res.status, 422);
    assert.match(res.json.error, /^invalid notifications:/);
  });

  test('item schedule.time_of_day with typo returns 422 with invalid schedule.time_of_day prefix', async () => {
    const res = await req(server.baseUrl, '/api/manifests', {
      method: 'POST',
      cookie: auth.cookie,
      body: baseManifest('issue404-bad-item-tod', null, [
        { name: 'Item', schedule: { type: 'daily', time_of_day: 'marning' } },
      ]),
    });
    assert.equal(res.status, 422);
    assert.match(res.json.error, /^invalid schedule\.time_of_day/);
  });
});

describe('#404 validator throws map to 422 (PATCH /api/manifests/:id)', () => {
  let sandbox, server, auth;

  before(async () => {
    auth = fakeAuthState('op');
    sandbox = createSandbox({
      credentials: auth.credentials,
      sessions: auth.sessions,
    });
    server = await spawnServer(sandbox);

    const seed = await req(server.baseUrl, '/api/manifests', {
      method: 'POST',
      cookie: auth.cookie,
      body: {
        $schema: 'klebb.datafile.v1',
        meta: {
          id: 'patch-target',
          label: 'Patch Target',
          view: { enabled: true, component: 'list-card' },
        },
        data: { items: [{ name: 'Item', schedule: { type: 'daily' } }] },
      },
    });
    assert.equal(seed.status, 201);
  });
  after(async () => {
    if (server) await server.kill();
    cleanupSandbox(sandbox);
  });

  test('patching in a malformed notifications block returns 422', async () => {
    const res = await req(server.baseUrl, '/api/manifests/patch-target', {
      method: 'PATCH',
      cookie: auth.cookie,
      body: {
        meta: {
          notifications: {
            enabled: true,
            items: [{
              id: 'n1',
              label: 'L',
              title: 'T',
              body: 'B',
              trigger: {
                type: 'schedule_due',
                card: 'patch-target',
                time_of_day: 'marning',
                time: '08:00',
              },
            }],
          },
        },
      },
    });
    assert.equal(res.status, 422);
    assert.match(res.json.error, /^invalid notifications:/);
  });

});
