// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests-e2e/smoke.spec.js
// Smoke test: the E2E harness boots, auth cookie is accepted, Today
// view renders the seeded cards. Any future bug-fix spec in this
// directory should assume this passes first.

const { test, expect } = require('./helpers/auth-fixture');

test.describe('smoke', () => {
  test('today view renders seeded cards', async ({ page }) => {
    await page.goto('/');

    await expect(page).not.toHaveURL(/setup\.html/);
    await expect(page).not.toHaveURL(/login\.html/);

    await expect(page.locator('eh-date-view')).toBeVisible({ timeout: 10_000 });

    // Core seed includes at least Weight + Mood + HRV + Resting HR as
    // generic-cards; additional fixtures can be layered in by other
    // specs without this assertion getting brittle.
    await expect(page.locator('eh-generic-card', { hasText: 'Weight' })).toBeVisible();
    await expect(page.locator('eh-generic-card', { hasText: 'Mood' })).toBeVisible();
  });

  test('API returns the seeded manifests', async ({ page, sandboxState }) => {
    await page.goto('/');
    const res = await page.request.get(`${sandboxState.baseUrl}/api/manifests`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    const ids = body.entries.map(e => e.id).sort();
    expect(ids).toContain('weight');
    expect(ids).toContain('mood');
  });
});
