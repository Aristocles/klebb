// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests-e2e/chat-clear-aborts-inflight.spec.js
// Regression for #325: clicking the "new chat" button while a chat
// reply is in flight must abort the request immediately, re-enable
// the textarea, and not push a stale "Request timed out" error into
// the cleared chat.

const { test, expect } = require('./helpers/auth-fixture');

test.describe('#325: clear chat aborts in-flight reply', () => {
  test('new-chat button re-enables the textarea while /api/chat is pending', async ({ page }) => {
    // Stall /api/chat so the reply is still in flight when we click
    // "new chat". We never resolve it; aborting on the client side is
    // the whole point.
    await page.route('**/api/chat', async (route) => {
      const req = route.request();
      // Only stall the POST that actually triggers a reply.
      if (req.method() !== 'POST') return route.fallback();
      // Hold the route open. If the test ends first, Playwright tears
      // it down; if the client aborts, fulfill rejects harmlessly.
      await new Promise((resolve) => setTimeout(resolve, 30_000));
      try {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ reply: 'never sent' }),
        });
      } catch {}
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

    await input.fill('this question takes forever');
    await input.press('Enter');

    // Textarea should be disabled while the request is in flight.
    await expect(input).toBeDisabled();

    // Click the "new chat" button. It's the 📝 button in the header.
    await widget.locator('button[aria-label="New chat"]').click();

    // Textarea must re-enable immediately, without waiting for the
    // server to respond.
    await expect(input).toBeEnabled({ timeout: 2_000 });

    // No spurious error bubble in the cleared chat.
    await expect(widget.locator('.msg.error')).toHaveCount(0);
    // The user's own message has been cleared too.
    await expect(widget.locator('.msg.user')).toHaveCount(0);
  });
});
