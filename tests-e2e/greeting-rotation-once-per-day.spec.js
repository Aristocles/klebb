// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests-e2e/greeting-rotation-once-per-day.spec.js
// Regression for #495: the greeting banner used to POST its full data
// array on effectively every today-view render — the once-per-day guard
// read a meta._state stamp that nothing ever wrote, and the localStorage
// stamp it did write was never read back. Two things must now hold:
//   - a writeable greeting rotates at most once per day (the localStorage
//     YYYY-MM-DD stamp guards it, and it survives a page reload); and
//   - a read-only greeting (no writeable.fromWebapp) never POSTs at all.

const { test, expect } = require('./helpers/auth-fixture');

const WRITEABLE_ID = 'e2e_greet_writeable_495';
const READONLY_ID = 'e2e_greet_readonly_495';

function greeting(id, label, writeable) {
  const meta = {
    id,
    label,
    emoji: '👋',
    order: 1,
    view: { enabled: true, component: 'greeting-banner', slot: 'top' },
  };
  if (writeable) meta.writeable = { fromWebapp: true, todayAllowed: true };
  return {
    $schema: 'klebb.datafile.v1',
    meta,
    description: `Greeting banner for #495 e2e (${label}).`,
    // Three messages so rotation has something to do (length >= 2).
    data: ['First up.', 'Second thought.', 'Third time.'],
  };
}

test.describe('#495: greeting rotation posts at most once per day', () => {
  test('writeable greeting rotates once across two same-day loads; read-only never posts', async ({ page, sandboxState }) => {
    const baseUrl = sandboxState.baseUrl;

    const mkWriteable = await page.request.post(`${baseUrl}/api/manifests`, {
      data: greeting(WRITEABLE_ID, 'Greet Writeable', true),
    });
    expect(mkWriteable.status()).toBe(201);
    const mkReadonly = await page.request.post(`${baseUrl}/api/manifests`, {
      data: greeting(READONLY_ID, 'Greet Readonly', false),
    });
    expect(mkReadonly.status()).toBe(201);

    try {
      // Count data-write POSTs per card id across the whole test.
      const posts = { [WRITEABLE_ID]: 0, [READONLY_ID]: 0 };
      page.on('request', (req) => {
        if (req.method() !== 'POST') return;
        const m = new URL(req.url()).pathname.match(/^\/api\/manifests\/([^/]+)\/data$/);
        if (!m) return;
        const id = decodeURIComponent(m[1]);
        if (id in posts) posts[id] += 1;
      });

      // Two loads on the same page (same origin => localStorage persists),
      // simulating "the today view rendered twice on the same day".
      await page.goto('/');
      await expect(page.locator(`eh-greeting-banner`).first()).toBeVisible();
      // Give the fire-and-forget rotation POST time to land.
      await expect.poll(() => posts[WRITEABLE_ID]).toBe(1);

      await page.reload();
      await expect(page.locator(`eh-greeting-banner`).first()).toBeVisible();
      // Settle: a second rotation would have fired by now if the guard failed.
      await page.waitForTimeout(500);

      expect(posts[WRITEABLE_ID]).toBe(1);
      expect(posts[READONLY_ID]).toBe(0);
    } finally {
      await page.request.delete(`${baseUrl}/api/manifests/${WRITEABLE_ID}`);
      await page.request.delete(`${baseUrl}/api/manifests/${READONLY_ID}`);
    }
  });
});
