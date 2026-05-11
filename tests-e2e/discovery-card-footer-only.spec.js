// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests-e2e/discovery-card-footer-only.spec.js
// Regression coverage for #192: when every catalogue-supported HAE
// metric already has a subscriber (the steady state on a configured
// instance) but `discovered.json` still carries undismissed
// unsupported metrics, the discovery card must render a compact
// footer-only surface so the operator can still dismiss those
// metrics from Today view.
//
// Before the fix, `render()` bailed early on `supportedCount === 0`
// and the entire card disappeared, stranding the footer dismiss UI.

const { test, expect } = require('./helpers/auth-fixture');

test.describe('#192: discovery card surfaces footer-only when only unsupported metrics are pending', () => {
  test('footer renders on Today view when supportedCount === 0', async ({ page }) => {
    await page.goto('/');

    const card = page.locator('eh-hae-discovery-card').first();
    await expect(card).toBeVisible({ timeout: 10_000 });

    // Footer toggle mentions "metric(s) received but not supported yet"
    // and surfaces the unsupported-count. Assert that string renders.
    await expect(card).toContainText(/metric[s]? received but not supported yet/);

    // The seeded unsupported metric key should be reachable once the
    // footer is expanded. The toggle is a button; click it.
    await card.getByRole('button', { name: /received but not supported yet/ }).click();
    await expect(card).toContainText('e2e_unsupported_metric');
  });
});
