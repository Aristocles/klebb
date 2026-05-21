// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests-e2e/schedule-card-selected-day-ring.spec.js
// Regression coverage for #282: the highlight ring on the week-dots
// row in eh-schedule-card must follow the date currently being viewed,
// not the real calendar today. Before the fix the ring stayed glued to
// real-today's slot in the visible week and disappeared entirely once
// the user navigated more than ~7 days from today.

const { test, expect } = require('./helpers/auth-fixture');
const { todayISO, shiftDays } = require('./helpers/seed-manifests');

const DAY_LETTERS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

function dayLetterFor(isoDate) {
  // Mon=0..Sun=6 to match the renderer's Mon-first week.
  const d = new Date(isoDate + 'T00:00:00');
  const js = d.getDay();
  return DAY_LETTERS[js === 0 ? 6 : js - 1];
}

test.describe('#282: schedule-card week-dots ring follows the viewed date', () => {
  test('ring tracks the selected day as you step backwards', async ({ page }) => {
    await page.goto('/');
    const card = page.locator('eh-schedule-card').first();
    await expect(card).toBeVisible({ timeout: 10_000 });

    // Today: ring should be on today's letter.
    const today = todayISO();
    const ring = card.locator('.dot.selected-ring');
    await expect(ring).toHaveCount(1);
    await expect(ring).toHaveText(dayLetterFor(today));

    // Step back one day; the ring should follow.
    await page.locator('.arrow-btn[aria-label="previous day"]').click();
    const yesterday = shiftDays(today, -1);
    await expect(ring).toHaveText(dayLetterFor(yesterday));

    // Step back two more days (still inside the seeded cycle which
    // starts today-2 — the card stays visible).
    await page.locator('.arrow-btn[aria-label="previous day"]').click();
    const twoDaysAgo = shiftDays(today, -2);
    await expect(card).toBeVisible();
    await expect(ring).toHaveText(dayLetterFor(twoDaysAgo));
    // Exactly one ring at any time.
    await expect(card.locator('.dot.selected-ring')).toHaveCount(1);
  });

  test('ring stays present and tracks the selected day going forward', async ({ page }) => {
    await page.goto('/');
    const card = page.locator('eh-schedule-card').first();
    await expect(card).toBeVisible({ timeout: 10_000 });

    const today = todayISO();
    const ring = card.locator('.dot.selected-ring');
    await expect(ring).toHaveText(dayLetterFor(today));

    // Step forward several days. The seeded cycle ends today+17 so the
    // card is still in-cycle at +5 and the ring must remain visible
    // and track the viewed date.
    for (let i = 1; i <= 5; i++) {
      await page.locator('.arrow-btn[aria-label="next day"]').click();
      const target = shiftDays(today, i);
      await expect(card).toBeVisible();
      await expect(ring).toHaveText(dayLetterFor(target));
      await expect(card.locator('.dot.selected-ring')).toHaveCount(1);
    }
  });
});
