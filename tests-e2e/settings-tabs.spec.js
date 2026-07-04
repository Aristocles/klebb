// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests-e2e/settings-tabs.spec.js
// Coverage for the tabbed Settings shell (#383): tab strip renders all
// five tabs, switching tabs swaps the visible pane, and the Dark theme
// toggle in General persists and stays the only entry point (the
// wordmark click handler is gone).

const { test, expect } = require('./helpers/auth-fixture');

test.describe('#383: tabbed settings shell', () => {
  test('tab strip lists General/Notifications/Security/Cards/Diagnostics and switches panes', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.locator('eh-settings-view')).toBeVisible();

    const tabs = page.locator('eh-settings-view [role="tab"]');
    await expect(tabs).toHaveCount(5);

    // General is the default.
    await expect(page.locator('eh-settings-view [data-tab="general"]')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('eh-settings-general')).toBeVisible();

    // Notifications: placeholder + footer note exact copy.
    await page.locator('eh-settings-view [data-tab="notifications"]').click();
    await expect(page.locator('eh-settings-notifications')).toBeVisible();
    await expect(page.locator('eh-settings-notifications')).toContainText(
      'If a notification you want is missing, ask Klebbius to add it.',
    );

    // Security: passkeys + HAE panel mount.
    await page.locator('eh-settings-view [data-tab="security"]').click();
    await expect(page.locator('eh-settings-security')).toBeVisible();
    await expect(page.locator('eh-settings-security')).toContainText('Passkeys');

    // Cards: lists the seeded cards.
    await page.locator('eh-settings-view [data-tab="cards"]').click();
    await expect(page.locator('eh-settings-cards')).toBeVisible();
    await expect(page.locator('eh-settings-cards .card').first()).toBeVisible();

    // Diagnostics: placeholder.
    await page.locator('eh-settings-view [data-tab="diagnostics"]').click();
    await expect(page.locator('eh-settings-diagnostics')).toBeVisible();
  });

  test('General tab toggles dark theme; wordmark click does NOT', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.locator('eh-settings-view')).toBeVisible();

    // Force a known starting state: light.
    await page.evaluate(() => {
      localStorage.setItem('klebb-theme', 'light');
      document.documentElement.setAttribute('data-theme', 'light');
    });
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

    // Click the wordmark — should NOT toggle theme.
    await page.locator('health-app .logo').first().click().catch(() => { /* logo isn't clickable */ });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

    // Flip via the General toggle.
    await page.locator('eh-settings-view [data-tab="general"]').click();
    const toggle = page.locator('eh-settings-general input.toggle');
    await expect(toggle).toBeVisible();
    await toggle.check();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    // Persists across reload.
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    // Restore for other specs.
    await page.locator('eh-settings-view [data-tab="general"]').click();
    await page.locator('eh-settings-general input.toggle').uncheck();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  });

  test('Cards tab Reorder button navigates to Today and enters reorder mode (#395)', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.locator('eh-settings-view')).toBeVisible();

    await page.locator('eh-settings-view [data-tab="cards"]').click();
    const reorderBtn = page.locator('eh-settings-cards .reorder-btn');
    await expect(reorderBtn).toBeVisible();

    await reorderBtn.click();

    // URL flips to / and the Today renderer drops into reorder mode.
    await expect(page).toHaveURL(/\/$/);
    const reorderBar = page.locator('eh-view-renderer').first().locator('.reorder-bar');
    await expect(reorderBar).toBeVisible();
    await expect(reorderBar.locator('.reorder-bar-done')).toBeVisible();

    // The one-shot flag is consumed, so a fresh reload of / does NOT
    // re-enter reorder mode.
    await page.goto('/');
    await expect(page.locator('eh-view-renderer').first().locator('.reorder-bar')).toHaveCount(0);
  });
});
