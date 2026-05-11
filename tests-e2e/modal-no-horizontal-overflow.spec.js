// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests-e2e/modal-no-horizontal-overflow.spec.js
// Regression for #188: dialog/modal surfaces must not show a horizontal
// scrollbar. Opening a prompt modal or the inline edit form on a card
// with a full-width input (number, date, text) used to push the panel
// wider than its max-width, producing a small but visible horizontal
// scrollbar at the bottom of the modal body.

const { test, expect } = require('./helpers/auth-fixture');

// Compare scrollWidth with clientWidth on a given element. If scrollWidth
// exceeds clientWidth, the element has horizontally-overflowed content
// and would show a scrollbar. Works for both shadow-DOM and light-DOM
// roots via the same expression.
async function horizontalOverflowOf(page, locator) {
  return locator.evaluate(el => ({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
    overflow: el.scrollWidth > el.clientWidth,
  }));
}

test.describe('#188: modal + inline-edit surfaces have no horizontal overflow', () => {
  test('weight card inline edit form does not overflow', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('eh-date-view')).toBeVisible();

    const weightCard = page.locator('eh-generic-card', { hasText: 'Weight' }).first();
    await expect(weightCard).toContainText('kg');

    // Open the edit form by clicking the pencil/+.
    await weightCard.locator('.edit-btn').click();

    const form = weightCard.locator('eh-input-form');
    await expect(form).toBeVisible();

    // Probe the form container for horizontal overflow.
    const probe = await horizontalOverflowOf(page, form);
    expect(
      probe.overflow,
      `eh-input-form overflowed: scrollWidth=${probe.scrollWidth}, clientWidth=${probe.clientWidth}`,
    ).toBe(false);
  });
});
