// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests-e2e/manifest-validation-422.spec.js
// Coverage for #404: notifications + schedule.time_of_day strict-mode
// validator throws are mapped to HTTP 422 (not 500) on POST /api/manifests
// and PATCH /api/manifests/:id. The chat agent reads the status code to
// decide retry vs apologise; 500 means "server bug, retry", 422 means
// "your input was wrong, here is what".

const { test, expect } = require('./helpers/auth-fixture');

const POST_BAD_TOD = 'iss404-post-bad-tod';
const POST_MISSING_CARD = 'iss404-post-missing-card';
const POST_ARRAY_TOD = 'iss404-post-array-tod';
const POST_BAD_ITEM_TOD = 'iss404-post-bad-item-tod';
const PATCH_TARGET = 'iss404-patch-target';

async function cleanup(request, baseUrl, id) {
  await request.delete(`${baseUrl}/api/manifests/${id}`).catch(() => {});
}

function notifManifest(id, trigger) {
  return {
    $schema: 'klebb.datafile.v1',
    meta: {
      id,
      label: id,
      view: { enabled: true, component: 'list-card' },
      notifications: {
        enabled: true,
        items: [{
          id: 'n1',
          label: 'L',
          title: 'T',
          body: 'B',
          trigger,
        }],
      },
    },
    data: [],
  };
}

function scheduleItemManifest(id, items) {
  return {
    $schema: 'klebb.datafile.v1',
    meta: {
      id,
      label: id,
      view: { enabled: true, component: 'list-card' },
    },
    data: { items },
  };
}

test.describe('#404 POST /api/manifests maps validator throws to 422', () => {
  test('schedule_due trigger with bad time_of_day token returns 422', async ({ page, sandboxState }) => {
    const r = await page.request.post(`${sandboxState.baseUrl}/api/manifests`, {
      data: notifManifest(POST_BAD_TOD, {
        type: 'schedule_due',
        card: 'some-card',
        time_of_day: 'marning',
        time: '08:00',
      }),
    });
    expect(r.status()).toBe(422);
    const body = await r.json();
    expect(body.error).toMatch(/^invalid notifications:/);
    await cleanup(page.request, sandboxState.baseUrl, POST_BAD_TOD);
  });

  test('schedule_due trigger missing card returns 422', async ({ page, sandboxState }) => {
    const r = await page.request.post(`${sandboxState.baseUrl}/api/manifests`, {
      data: notifManifest(POST_MISSING_CARD, {
        type: 'schedule_due',
        time_of_day: 'morning',
        time: '08:00',
      }),
    });
    expect(r.status()).toBe(422);
    const body = await r.json();
    expect(body.error).toMatch(/^invalid notifications:/);
    await cleanup(page.request, sandboxState.baseUrl, POST_MISSING_CARD);
  });

  test('schedule_due trigger time_of_day as array (single-token only) returns 422', async ({ page, sandboxState }) => {
    const r = await page.request.post(`${sandboxState.baseUrl}/api/manifests`, {
      data: notifManifest(POST_ARRAY_TOD, {
        type: 'schedule_due',
        card: 'some-card',
        time_of_day: ['morning', 'evening'],
        time: '08:00',
      }),
    });
    expect(r.status()).toBe(422);
    const body = await r.json();
    expect(body.error).toMatch(/^invalid notifications:/);
    await cleanup(page.request, sandboxState.baseUrl, POST_ARRAY_TOD);
  });

  test('item schedule.time_of_day typo returns 422 with invalid schedule.time_of_day prefix', async ({ page, sandboxState }) => {
    const r = await page.request.post(`${sandboxState.baseUrl}/api/manifests`, {
      data: scheduleItemManifest(POST_BAD_ITEM_TOD, [
        { name: 'Item', schedule: { type: 'daily', time_of_day: 'marning' } },
      ]),
    });
    expect(r.status()).toBe(422);
    const body = await r.json();
    expect(body.error).toMatch(/^invalid schedule\.time_of_day/);
    await cleanup(page.request, sandboxState.baseUrl, POST_BAD_ITEM_TOD);
  });
});

test.describe('#404 PATCH /api/manifests/:id maps validator throws to 422', () => {
  test('PATCH that introduces a malformed notifications block returns 422', async ({ page, sandboxState }) => {
    const baseUrl = sandboxState.baseUrl;
    await cleanup(page.request, baseUrl, PATCH_TARGET);
    const seed = await page.request.post(`${baseUrl}/api/manifests`, {
      data: {
        $schema: 'klebb.datafile.v1',
        meta: {
          id: PATCH_TARGET,
          label: 'Patch target',
          view: { enabled: true, component: 'list-card' },
        },
        data: [],
      },
    });
    expect(seed.status()).toBe(201);

    const r = await page.request.patch(`${baseUrl}/api/manifests/${PATCH_TARGET}`, {
      data: {
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
                card: PATCH_TARGET,
                time_of_day: 'marning',
                time: '08:00',
              },
            }],
          },
        },
      },
    });
    expect(r.status()).toBe(422);
    const body = await r.json();
    expect(body.error).toMatch(/^invalid notifications:/);

    await cleanup(page.request, baseUrl, PATCH_TARGET);
  });
});
