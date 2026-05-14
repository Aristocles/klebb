// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests-e2e/chat-embellishment-chips-persist.spec.js
// Regression for #191: the CC-embellishment chip row attached to an
// assistant reply must survive a page reload / chat-widget reopen.
//
// Exercises the full round trip: post a history through the server's
// PUT filter, reload the page, open the widget, assert the chips
// render. Before the fix, the server PUT filter stripped every field
// outside {id, role, content}, so the chips were lost even if the
// client had sent them.

const { test, expect } = require('./helpers/auth-fixture');

function historyWithChips() {
  return {
    messages: [
      { id: 'm1', role: 'user', content: 'switch recovery-overview to rings' },
      {
        id: 'm2',
        role: 'assistant',
        content: 'Done! Recovery Overview is now in rings layout.',
        followupText: 'Anything else?',
        embellishments: [
          { label: 'Colour-code the rings', prompt: 'colour-code rings on recovery-overview' },
          { label: 'Switch to stack', prompt: 'switch recovery-overview to stack layout' },
        ],
      },
    ],
  };
}

test.describe('#191: chat embellishment chips persist across reload', () => {
  test('chips round-trip through server PUT and render after reload', async ({ page, sandboxState }) => {
    // Post the history through the real /api/chat/history endpoint so
    // the server-side PUT filter runs. This is the surface that used
    // to drop the embellishments fields.
    const put = await page.request.put(`${sandboxState.baseUrl}/api/chat/history`, {
      data: historyWithChips(),
    });
    expect(put.status()).toBe(200);

    await page.goto('/');
    await expect(page.locator('eh-date-view')).toBeVisible();
    await page.getByRole('button', { name: /open chat/i }).click();

    await expect(page.getByText('Colour-code the rings', { exact: true }))
      .toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Switch to stack', { exact: true }))
      .toBeVisible();

    // Reload to prove the persistence sticks across a fresh load.
    await page.reload();
    await expect(page.locator('eh-date-view')).toBeVisible();
    await page.getByRole('button', { name: /open chat/i }).click();
    await expect(page.getByText('Colour-code the rings', { exact: true }))
      .toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Switch to stack', { exact: true }))
      .toBeVisible();

    // Clear chat history so later specs (chat-starter-prompts-*) see
    // an empty chat and exercise the starter-chip path.
    const cleanup = await page.request.delete(`${sandboxState.baseUrl}/api/chat/history`);
    expect(cleanup.status()).toBe(200);
  });
});
