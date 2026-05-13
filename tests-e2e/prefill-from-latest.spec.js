// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests-e2e/prefill-from-latest.spec.js
// Regression for #217: when a manifest declares
// `meta.writeable.prefillFromLatest: true`, opening the add form on
// a date with no existing row pre-fills the inputs with the most
// recent prior row's values (minus the date). Great for once-daily
// measurements like weight, where today's value is almost always
// close to yesterday's.
//
// The sandbox's weight seed opts into the flag. Today has no row by
// default.

const { test, expect } = require('./helpers/auth-fixture');

test.describe('#217: writeable.prefillFromLatest pre-fills the add form', () => {
  test('weight add form on a past date with no row pre-fills from the latest prior entry', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('eh-date-view')).toBeVisible();

    const weightCard = page.locator('eh-generic-card', { hasText: 'Weight' }).first();
    // Ensure today's seeded value is visible before navigating —
    // otherwise the ← click may fire before the page has hydrated.
    await expect(weightCard).toContainText('80.9');

    // Weight seed has rows at today-4 (81.3), today-2 (81.2), today-1
    // (81.0), today (80.9). Navigate back 3 days to today-3 — the gap
    // between today-4 and today-2 — where no row exists.
    // dateContext:"latest" still applies, but #182's fix means past-
    // date navigation uses exact-date lookup, so hasEntry will be
    // false and prefillFromLatest fires.
    await page.locator('.arrow-btn[aria-label="previous day"]').click();
    await page.locator('.arrow-btn[aria-label="previous day"]').click();
    await page.locator('.arrow-btn[aria-label="previous day"]').click();

    // Card on today-3 has no entry — empty state.
    await expect(weightCard).toContainText(/no entry|empty/i);

    // Open the add form. With prefillFromLatest, the input should
    // show today-4's value (81.3) — the most recent row dated
    // strictly before today-3.
    await weightCard.locator('.edit-btn').click();
    const form = weightCard.locator('eh-input-form');
    await expect(form).toBeVisible();

    const input = form.locator('input[type="number"]');
    await expect(input).toHaveValue('81.3');
  });

});
