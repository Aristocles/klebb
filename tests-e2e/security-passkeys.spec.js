// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests-e2e/security-passkeys.spec.js
// Settings > Security passkeys section (#471, #482). The WebAuthn create
// ceremony needs a real platform authenticator, which headless Chromium
// doesn't provide, so this covers the UI around it: the seeded passkey lists
// as the current device, the last-passkey Remove is blocked, the QR/link
// invite panel renders (and its code genuinely opens registration), and the
// on-device create remains as the secondary action. API-level behaviour is
// covered in tests/api/issue-469/471/482 tests.

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

  test('Add a device mints an invite and renders QR + copyable link (#482)', async ({ page }) => {
    await page.goto('/settings');
    await page.locator('eh-settings-view [data-tab="security"]').click();

    const security = page.locator('eh-settings-security');
    await expect(security).toBeVisible();

    await security.locator('.add-device-btn').click();

    // The invite panel: QR code, register URL, expiry note.
    const panel = security.locator('.invite-panel');
    await expect(panel).toBeVisible();
    await expect(panel.locator('.invite-qr svg')).toBeVisible();
    const url = (await panel.locator('.endpoint-code').textContent()).trim();
    expect(url).toMatch(/\/register\?code=/);
    await expect(panel.locator('.invite-lede')).toContainText('works once');

    // Not a Cloud instance in e2e: no portal hint.
    await expect(panel.locator('.invite-cloud-hint')).toHaveCount(0);

    // The minted code genuinely opens registration (as the other device
    // would see it: no session on that check, only the code).
    const code = new URL(url).searchParams.get('code');
    const avail = await page.evaluate(async c => {
      const r = await fetch(`/auth/register/available?code=${encodeURIComponent(c)}`);
      return r.json();
    }, code);
    expect(avail.available).toBe(true);
    expect(avail.reason).toBe('invite');

    await panel.locator('button', { hasText: /Done/i }).click();
    await expect(security.locator('.invite-panel')).toHaveCount(0);
    await expect(security.locator('.add-device-btn')).toBeVisible();
  });

  test('on-device create is demoted to a secondary action (#482)', async ({ page }) => {
    await page.goto('/settings');
    await page.locator('eh-settings-view [data-tab="security"]').click();

    const security = page.locator('eh-settings-security');
    await expect(security).toBeVisible();

    // Secondary link opens the old nickname form.
    await security.locator('.on-this-device').click();
    await expect(security.locator('.nick-input')).toBeVisible();
    await expect(security.locator('.passkey-add-actions')).toContainText('Continue');

    // Cancel closes the form without starting a ceremony.
    await security.locator('.passkey-add-actions button', { hasText: /Cancel/i }).click();
    await expect(security.locator('.nick-input')).toHaveCount(0);
    await expect(security.locator('.add-device-btn')).toBeVisible();
  });
});
