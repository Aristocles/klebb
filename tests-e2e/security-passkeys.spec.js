// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests-e2e/security-passkeys.spec.js
// Settings > Security passkeys section (#471). The WebAuthn create ceremony
// needs a real platform authenticator, which headless Chromium doesn't
// provide, so this covers the UI around it: the seeded passkey lists as the
// current device, the last-passkey Remove is blocked, and the add flow opens
// its nickname input. The API-level add/delete behaviour is covered in
// tests/api/issue-469-credentials.test.js and issue-471-add-device.test.js.

const { test, expect } = require('./helpers/auth-fixture');

test.describe('#471 Settings > Security passkeys', () => {
  test('lists the current passkey and blocks removing the only one', async ({ page }) => {
    await page.goto('/settings');
    await page.locator('eh-settings-view [data-tab="security"]').click();

    const security = page.locator('eh-settings-security');
    await expect(security).toBeVisible();
    await expect(security).toContainText('Passkeys');

    // The seeded session credential shows up as a row flagged "This device".
    const rows = security.locator('.passkey-row');
    await expect(rows).toHaveCount(1);
    await expect(security.locator('.this-device')).toBeVisible();

    // With a single passkey, Remove is disabled (removing it would empty the
    // store and re-open bootstrap).
    const removeBtn = rows.first().locator('.unhide-btn.danger');
    await expect(removeBtn).toBeDisabled();
  });

  test('Add a passkey opens a nickname input with continue/cancel', async ({ page }) => {
    await page.goto('/settings');
    await page.locator('eh-settings-view [data-tab="security"]').click();

    const security = page.locator('eh-settings-security');
    await expect(security).toBeVisible();

    await security.locator('.add-passkey-btn').click();
    await expect(security.locator('.nick-input')).toBeVisible();
    await expect(security.locator('.passkey-add-actions')).toContainText('Continue');

    // Cancel closes the form without starting a ceremony.
    await security.locator('.passkey-add-actions button', { hasText: /Cancel/i }).click();
    await expect(security.locator('.nick-input')).toHaveCount(0);
    await expect(security.locator('.add-passkey-btn')).toBeVisible();
  });
});
