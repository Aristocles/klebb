// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests-e2e/chat-embellish-chips-live-reply.spec.js
// Diagnostic for #463: chips must render on a LIVE reply (not just when
// loaded from history, which chat-embellishment-chips-persist.spec.js
// already covers). Stubs POST /api/chat with a reply carrying followup.

const { test, expect } = require('./helpers/auth-fixture');

test.describe('#463: embellishment chips render on a live reply', () => {
  test('typed send renders the chip row under the fresh assistant message', async ({ page }) => {
    await page.route('**/api/chat', async (route) => {
      const req = route.request();
      if (req.method() !== 'POST') return route.fallback();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          reply: 'Done! Water Intake card created.',
          followup: {
            text: 'Want to flesh it out?',
            embellishments: [
              { id: 'add-trends-line', label: 'Include in Trends', prompt: 'Include the Water Intake card in the Trends view as a line chart.' },
              { id: 'add-thresholds', label: 'Add a target range', prompt: 'Add coloured target thresholds to the Water Intake card.' },
            ],
          },
        }),
      });
    });

    await page.goto('/');
    await expect(page.locator('eh-date-view')).toBeVisible();

    const promptModal = page.locator('eh-prompt-modal dialog');
    await promptModal.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
    if (await promptModal.isVisible().catch(() => false)) {
      await promptModal.locator('button[aria-label="Dismiss"]').click();
      await expect(promptModal).not.toBeVisible();
    }

    await page.getByRole('button', { name: /open chat/i }).click();

    const widget = page.locator('health-chat');
    const input = widget.locator('.chat-input');
    await expect(input).toBeVisible();
    await input.fill('create a water intake card');
    await input.press('Enter');

    await expect(widget.locator('.msg.assistant')).toContainText('Water Intake card created');
    await expect(page.getByText('Want to flesh it out?', { exact: true })).toBeVisible();
    await expect(page.getByText('Include in Trends', { exact: true })).toBeVisible();
    await expect(page.getByText('Add a target range', { exact: true })).toBeVisible();
  });
});
