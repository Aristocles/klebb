// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests-e2e/chat-survives-tab-background.spec.js
// Regression for #372: a chat reply that's in flight while the tab is
// backgrounded must NOT be aborted by the widget. Browsers do not kill
// in-flight network requests in hidden tabs, so the previous defensive
// AbortController.abort() on a >=3s hidden window was a self-inflicted
// footgun that lost legitimate tool-using replies.

const { test, expect } = require('./helpers/auth-fixture');

test.describe('#372: chat reply survives tab backgrounding', () => {
  test('visibilitychange while /api/chat is in flight does not abort', async ({ page }) => {
    // Stall /api/chat for ~6s, then return a normal reply. Long enough
    // that the test's simulated 4s background window straddles the
    // in-flight fetch.
    await page.route('**/api/chat', async (route) => {
      const req = route.request();
      if (req.method() !== 'POST') return route.fallback();
      await new Promise((resolve) => setTimeout(resolve, 6000));
      try {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ reply: 'reply that survived' }),
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

    await input.fill('long-running tool turn');
    await input.press('Enter');

    // Textarea is disabled while the request is in flight.
    await expect(input).toBeDisabled();

    // Simulate the tab going to the background for 4s, then coming
    // back. Real Chromium tab hiding requires multi-tab orchestration;
    // the widget keys off document.visibilityState + the
    // visibilitychange event, so dispatching the event directly
    // exercises the same code path. 4s is well beyond the previous 3s
    // self-abort threshold.
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true, get: () => 'hidden',
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForTimeout(4000);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true, get: () => 'visible',
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    // The reply must still arrive (route resolves at ~6s total).
    await expect(widget.locator('.msg.assistant'))
      .toContainText('reply that survived', { timeout: 10_000 });

    // No "tab was backgrounded" or other error bubble.
    await expect(widget.locator('.msg.error')).toHaveCount(0);
    await expect(input).toBeEnabled();
  });
});
