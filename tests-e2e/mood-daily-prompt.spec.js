// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests-e2e/mood-daily-prompt.spec.js
// Regression for #193 Part C: the mood card declares
// `prompt.enabled: true` in its template/seed, so on a day with no
// mood entry the modal fires on first page load. The modal's input
// form inherits display.emojiMap + writeable.requireAny from the
// card (parts A + B), so the combined experience is:
//   - 5 emoji buttons for the rating,
//   - an optional note textarea,
//   - Save enabled when either or both are filled.

const { test, expect } = require('./helpers/auth-fixture');

test.describe('#193 Part C: mood daily prompt fires when today has no entry', () => {
  test('prompt modal opens on load if no mood entry for today', async ({ page, sandboxState }) => {
    // Clear today's mood row so the prompt triggers (the seed includes
    // one for today by default — writeable APIs let us drop it).
    const read = await page.request.get(`${sandboxState.baseUrl}/api/manifests/mood/data`);
    const body = await read.json();
    // Both the browser and the sandbox server use the host timezone
    // (global-setup passes TZ: Intl.DateTimeFormat().resolvedOptions()
    // .timeZone into spawnServer), so host-local Date is the common
    // source of truth.
    const todayIso = (() => {
      const d = new Date();
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    })();
    const withoutToday = body.data.filter(r => r.date !== todayIso);
    const put = await page.request.post(
      `${sandboxState.baseUrl}/api/manifests/mood/data`,
      { data: { data: withoutToday } },
    );
    expect(put.status()).toBe(200);

    await page.goto('/');

    // The modal should appear for the Mood card.
    const modal = page.locator('eh-prompt-modal dialog');
    await expect(modal).toBeVisible({ timeout: 10_000 });

    // Heading text carries the card label.
    await expect(modal).toContainText(/mood/i);

    // The modal's input form should pick up the emojiMap + requireAny
    // from the card's meta — five emoji buttons rendered.
    const form = modal.locator('eh-input-form');
    await expect(form).toBeVisible();
    for (const emoji of ['😩', '😔', '😐', '🙂', '😄']) {
      await expect(form).toContainText(emoji);
    }

    // Restore sandbox state so the modal doesn't fire for later specs.
    const restored = [...withoutToday, { date: todayIso, mood: 5 }];
    const restore = await page.request.post(
      `${sandboxState.baseUrl}/api/manifests/mood/data`,
      { data: { data: restored } },
    );
    expect(restore.status()).toBe(200);
  });
});
