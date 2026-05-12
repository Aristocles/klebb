// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests-e2e/discovery-dismiss-all-unsupported.spec.js
// Regression for #218: the discovery card's unsupported-metrics
// footer has a "Dismiss all" button that flips every listed metric
// to dismissed in one click. Per-row Dismiss buttons are removed
// as part of the simplification — the operator can un-hide from
// Settings if they want a specific metric back.

const { test, expect } = require('./helpers/auth-fixture');

test.describe('#218: discovery card supports dismiss-all for unsupported metrics', () => {
  test('clicking Dismiss all hides the footer and flips every metric on the server', async ({ page, sandboxState }) => {
    await page.goto('/');
    await expect(page.locator('eh-date-view')).toBeVisible();

    const card = page.locator('eh-hae-discovery-card').first();
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card).toContainText(/metric[s]? received but not supported yet/);

    // Click Dismiss all (must be visible without expanding the list
    // per the #218 design).
    const dismissAll = card.getByRole('button', { name: /dismiss all/i });
    await expect(dismissAll).toBeVisible();
    await dismissAll.click();

    // Footer should disappear when unsupportedCount drops to zero.
    await expect(card).not.toContainText(/metric[s]? received but not supported yet/, {
      timeout: 5_000,
    });

    // Verify the server-side state: every seeded unsupported metric
    // should now be in the dismissed list.
    const res = await page.request.get(`${sandboxState.baseUrl}/api/health-auto-export/discoveries`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    const dismissedKeys = (body.dismissed || []).map(d => d.metric).sort();
    expect(dismissedKeys).toEqual([
      'e2e_unsupported_beta',
      'e2e_unsupported_gamma',
      'e2e_unsupported_metric',
    ]);
  });
});
