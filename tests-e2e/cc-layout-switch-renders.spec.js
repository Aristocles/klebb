// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests-e2e/cc-layout-switch-renders.spec.js
// Regression for #190: after a combination-card layout is switched
// (e.g. rings -> stack via klebbius or a direct manifest PATCH), the
// reloaded view must show the stack content, not an empty card.
//
// The sandbox seed starts recovery-overview in stack layout and
// declares two donors (hrv, resting-heart-rate) with per-day data
// anchored to today. This spec asserts the stack body actually shows
// the primary donor's value. Then it PATCHes the manifest to rings
// and back, reloads, and asserts the stack still renders correctly.

const { test, expect } = require('./helpers/auth-fixture');

test.describe('#190: combination-card stack renders after layout switch', () => {
  test('seeded stack layout shows donor values on load', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('eh-date-view')).toBeVisible();

    const cc = page.locator('eh-combination-card').first();
    await expect(cc).toBeVisible({ timeout: 10_000 });
    await expect(cc).toContainText('Recovery Overview');
    // HRV is the primary donor; today's seeded value is 55ms.
    await expect(cc).toContainText('55');
  });

  test('stack renders correctly after rings round trip', async ({ page, sandboxState }) => {
    // Flip to rings, then back to stack, via the canonical PATCH path.
    const toRings = await page.request.patch(
      `${sandboxState.baseUrl}/api/manifests/recovery-overview`,
      {
        data: { meta: { view: { layout: 'rings' } } },
      },
    );
    expect(toRings.status()).toBe(200);

    const toStack = await page.request.patch(
      `${sandboxState.baseUrl}/api/manifests/recovery-overview`,
      {
        data: { meta: { view: { layout: 'stack' } } },
      },
    );
    expect(toStack.status()).toBe(200);

    await page.goto('/');
    await expect(page.locator('eh-date-view')).toBeVisible();

    const cc = page.locator('eh-combination-card').first();
    await expect(cc).toBeVisible({ timeout: 10_000 });
    await expect(cc).toContainText('Recovery Overview');
    // HRV primary donor value should still resolve against today's row.
    await expect(cc).toContainText('55');
  });
});
