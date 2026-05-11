// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests-e2e/schedule-card-nested-cycles.spec.js
// Regression coverage for #186: the schedule card renders when the
// manifest uses the agent-authored shape with item.cycle.cycles[]
// (a nested cycles array under a top-level `cycle` object), as seen
// on klebbtest after klebbius added several peptides.
//
// The default sandbox seed (tests-e2e/helpers/seed-manifests.js) now
// includes a peptides manifest in this shape with a cycle spanning
// today, so this spec just loads the page and asserts the item
// renders.

const { test, expect } = require('./helpers/auth-fixture');

test.describe('#186: schedule card renders manifests with nested cycle.cycles[]', () => {
  test('schedule card shows the seeded peptide by name', async ({ page }) => {
    await page.goto('/');
    const card = page.locator('eh-schedule-card').first();
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card).toContainText('Semax');
  });
});
