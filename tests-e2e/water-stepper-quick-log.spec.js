// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests-e2e/water-stepper-quick-log.spec.js
// Regression for #189: count-like quick-log manifests (water, caffeine
// cups, etc.) should use `type: "stepper"` so tapping +/- is the
// primary interaction rather than a bare number input with hover
// spinners.
//
// The canonical `templates/hydration.klebb.json` template has always
// used a stepper; the system-prompt guidance landed in this PR pushes
// the chat agent to do the same for future ad-hoc counter cards. This
// spec exercises the stepper shape end-to-end: open the water card's
// input form, tap `+` several times, save, assert the count lands
// correctly on disk.

const { test, expect } = require('./helpers/auth-fixture');

test.describe('#189: water card stepper input logs by tap-count', () => {
  test('tapping + three times then save lands glasses=3 for today', async ({ page, sandboxState }) => {
    await page.goto('/');
    await expect(page.locator('eh-date-view')).toBeVisible();

    const waterCard = page.locator('eh-generic-card', { hasText: 'Water' }).first();
    await expect(waterCard).toBeVisible({ timeout: 10_000 });

    // Open the edit form via the add/edit button.
    await waterCard.locator('.edit-btn').click();

    const form = waterCard.locator('eh-input-form');
    await expect(form).toBeVisible();

    // Capture whatever the stepper starts at (on Today with no row yet,
    // the form prefills from the latest available donor value — per
    // the #182 resolver contract). We care that +1 taps increment
    // correctly, not the starting value.
    const stepperValue = form.locator('.stepper-value');
    const startValue = Number(await stepperValue.inputValue());

    const incButton = form.locator('.stepper-btn', { hasText: '+' });
    await expect(incButton).toBeVisible();
    await incButton.click();
    await incButton.click();
    await incButton.click();

    const expected = String(startValue + 3);
    await expect(stepperValue).toHaveValue(expected);

    // Save.
    await form.getByRole('button', { name: /^(save|update|add)$/i }).click();

    // After save, the card shows today's glasses count.
    await expect(waterCard).toContainText(`${expected} glasses`, { timeout: 5_000 });

    // Authoritatively verify via the server so we know disk matches.
    const res = await page.request.get(`${sandboxState.baseUrl}/api/manifests/water-intake/data`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    const today = new Date();
    const todayISO = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const todayRow = body.data.find(r => r.date === todayISO);
    expect(todayRow).toBeDefined();
    expect(todayRow.glasses).toBe(startValue + 3);
  });
});
