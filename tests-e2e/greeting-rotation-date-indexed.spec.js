// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests-e2e/greeting-rotation-date-indexed.spec.js
// Regression for #704: rotation used to be a data write (shift data[0] to
// the end and POST the array back) gated on meta.writeable.fromWebapp, so
// a read-only greeting: the natural authoring for a card with no inputs:
// showed the same message forever. The message is now a pure function of
// the viewed date (daysSinceEpoch % messages.length) and the write path is
// gone entirely, so:
//   - a read-only greeting shows a DIFFERENT message on consecutive days;
//   - the same date always shows the same message (deterministic across
//     devices, no localStorage state);
//   - no greeting, writeable or not, ever POSTs from a passive render.
// The clock is pinned so the expected index is a constant: day 20516
// (2026-03-04) % 3 = 2, day 20517 % 3 = 0.

const { test, expect } = require('./helpers/auth-fixture');

const READONLY_ID = 'e2e_greet_readonly_704';
const WRITEABLE_ID = 'e2e_greet_writeable_704';
const MESSAGES = ['First up.', 'Second thought.', 'Third time.'];
const DAY_ONE = new Date('2026-03-04T09:00:00');
const DAY_TWO = new Date('2026-03-05T09:00:00');
const DAY_ONE_MSG = MESSAGES[2];
const DAY_TWO_MSG = MESSAGES[0];

function greeting(id, label, writeable) {
  const meta = {
    id,
    label,
    emoji: '\u{1F44B}',
    order: 1,
    view: { enabled: true, component: 'greeting-banner', slot: 'top' },
  };
  if (writeable) meta.writeable = { fromWebapp: true, todayAllowed: true };
  return {
    $schema: 'klebb.datafile.v1',
    meta,
    description: `Greeting banner for #704 e2e (${label}).`,
    data: MESSAGES.slice(),
  };
}

test.describe('#704: greeting message is date-indexed, never written', () => {
  test('read-only greeting rotates across days; nothing ever POSTs', async ({ page, sandboxState }) => {
    const baseUrl = sandboxState.baseUrl;

    const mkReadonly = await page.request.post(`${baseUrl}/api/manifests`, {
      data: greeting(READONLY_ID, 'Greet Readonly', false),
    });
    expect(mkReadonly.status()).toBe(201);
    const mkWriteable = await page.request.post(`${baseUrl}/api/manifests`, {
      data: greeting(WRITEABLE_ID, 'Greet Writeable', true),
    });
    expect(mkWriteable.status()).toBe(201);

    try {
      let manifestWrites = 0;
      page.on('request', (req) => {
        if (req.method() === 'GET') return;
        if (new URL(req.url()).pathname.startsWith('/api/manifests')) manifestWrites += 1;
      });

      await page.clock.install({ time: DAY_ONE });
      await page.goto('/');
      const banner = page.locator('eh-greeting-banner').first();
      await expect(banner).toBeVisible();
      await expect(banner.locator('.message')).toHaveText(DAY_ONE_MSG);

      // Same date, fresh load: same message (deterministic, no state).
      await page.reload();
      await expect(banner.locator('.message')).toHaveText(DAY_ONE_MSG);

      // Next day: the message advances without any write having happened.
      await page.clock.install({ time: DAY_TWO });
      await page.reload();
      await expect(banner.locator('.message')).toHaveText(DAY_TWO_MSG);
      expect(DAY_TWO_MSG).not.toBe(DAY_ONE_MSG);

      // Settle, then prove the write path is gone (not merely gated):
      // neither the read-only nor the writeable greeting fired a write.
      await page.waitForTimeout(500);
      expect(manifestWrites).toBe(0);
    } finally {
      await page.request.delete(`${baseUrl}/api/manifests/${READONLY_ID}`);
      await page.request.delete(`${baseUrl}/api/manifests/${WRITEABLE_ID}`);
    }
  });
});
