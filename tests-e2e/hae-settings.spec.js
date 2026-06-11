// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests-e2e/hae-settings.spec.js
// Walks the operator-facing flow for HAE token management: generate,
// copy, ingest with the displayed token, regenerate, confirm rotation.

const { test, expect } = require('./helpers/auth-fixture');

async function getDisplayedToken(page) {
  // After Generate / Regenerate the panel briefly reveals the full
  // token unmasked. Read it from the .endpoint-code element inside the
  // hae-token-value row (matches eh-settings-view styles).
  return await page.locator('eh-settings-connections .hae-token-value .endpoint-code').innerText();
}

async function ingestWithToken(request, baseURL, token) {
  return await request.post(`${baseURL}/api/health-auto-export`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { data: { metrics: [] } },
  });
}

test.describe('#278 HAE token Settings flow', () => {
  test('generate, copy, ingest, regenerate rotates', async ({ page, request, baseURL }) => {
    // Start clean: clear any token a previous spec may have left behind.
    await request.delete(`${baseURL}/api/health-auto-export/token`);

    await page.goto('/settings');
    await expect(page.locator('eh-settings-view')).toBeVisible();

    // HAE lives in the Connections tab now.
    await page.locator('eh-settings-view [data-tab="connections"]').click();
    await expect(page.locator('eh-settings-connections')).toBeVisible();

    // State A: Generate button visible, no token displayed yet.
    const generateBtn = page.locator('eh-settings-connections .hae-token-empty button', {
      hasText: /Generate token/i,
    });
    await expect(generateBtn).toBeVisible();

    await generateBtn.click();

    // State C: token revealed; capture it for the ingest assertion.
    await expect(page.locator('eh-settings-connections .hae-token-value')).toBeVisible();
    const firstToken = await getDisplayedToken(page);
    expect(firstToken).toMatch(/^[a-f0-9]{64}$/);

    // Token authenticates the ingest webhook.
    const ingestOk = await ingestWithToken(request, baseURL, firstToken);
    expect(ingestOk.status()).toBe(200);

    // Click Regenerate; the inline confirm strip should appear.
    await page.locator('eh-settings-connections .hae-token-value button', { hasText: /Regenerate/i }).click();
    const confirmBtn = page.locator('eh-settings-connections .hae-regen-actions button', {
      hasText: /Yes, regenerate/i,
    });
    await expect(confirmBtn).toBeVisible();
    await confirmBtn.click();

    // New token visible; differs from the first.
    await expect(page.locator('eh-settings-connections .hae-token-value')).toBeVisible();
    const secondToken = await getDisplayedToken(page);
    expect(secondToken).toMatch(/^[a-f0-9]{64}$/);
    expect(secondToken).not.toBe(firstToken);

    // Old token rejected; new token accepted.
    const ingestOld = await ingestWithToken(request, baseURL, firstToken);
    expect(ingestOld.status()).toBe(401);
    const ingestNew = await ingestWithToken(request, baseURL, secondToken);
    expect(ingestNew.status()).toBe(200);

    // Tidy up so subsequent specs that hit /settings see the no-token
    // state (and so Cards section, etc., aren't perturbed).
    await request.delete(`${baseURL}/api/health-auto-export/token`);
  });
});
