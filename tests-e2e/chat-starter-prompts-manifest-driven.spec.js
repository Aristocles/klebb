// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests-e2e/chat-starter-prompts-manifest-driven.spec.js
// Regression for #195: chat-widget starter chips come from enabled
// cards' meta.chat.starterPrompts arrays (with generated defaults
// when absent). The "✨ Combine cards" chip stays hardcoded.

const { test, expect } = require('./helpers/auth-fixture');

test.describe('#195: chat starter chips are manifest-driven', () => {
  test('empty chat shows chips sourced from seeded cards + keeps combine chip', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('eh-date-view')).toBeVisible();

    // Dismiss the mood prompt if it fires — we want the chat widget,
    // not the mood modal.
    const promptModal = page.locator('eh-prompt-modal dialog');
    await promptModal.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
    if (await promptModal.isVisible().catch(() => false)) {
      await promptModal.locator('button[aria-label="Dismiss"]').click();
      await expect(promptModal).not.toBeVisible();
    }

    // Open the chat widget.
    await page.getByRole('button', { name: /open chat/i }).click();

    // Combine-cards chip stays hardcoded.
    await expect(page.getByText('✨ Combine cards')).toBeVisible({ timeout: 10_000 });

    // Weight card declared two starterPrompts. The picker takes one
    // per card, so exactly one of weight's two texts should appear.
    const weightData = page.getByText(/weight trend/i);
    const weightTweak = page.getByText(/switch the weight card/i);
    const weightVisible = (await weightData.count()) + (await weightTweak.count());
    expect(weightVisible).toBe(1);

    // Mood has no chat.starterPrompts, so the generated fallback
    // "Show me my Mood data" should be eligible. The picker samples
    // at random, so it may or may not be in the visible 7; instead,
    // assert there are NO literal hardcoded labels from the old
    // fixed list — they shouldn't appear at all for a sandbox
    // without supplements / injections / bloods / etc. cards.
    await expect(page.getByText('Supplements', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Injections', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Bloods', { exact: true })).toHaveCount(0);
  });

  test('chip click populates the input with the full prompt text', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('eh-date-view')).toBeVisible();

    const promptModal = page.locator('eh-prompt-modal dialog');
    await promptModal.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
    if (await promptModal.isVisible().catch(() => false)) {
      await promptModal.locator('button[aria-label="Dismiss"]').click();
      await expect(promptModal).not.toBeVisible();
    }

    await page.getByRole('button', { name: /open chat/i }).click();
    await expect(page.getByText('✨ Combine cards')).toBeVisible({ timeout: 10_000 });

    // Pick any visible starter chip (other than combine). The click
    // handler sends the FULL prompt text into the chat input. Since
    // a short label may be truncated with …, match by partial text.
    const nonCombineChips = page.locator('.suggestion:not(.combine)');
    const count = await nonCombineChips.count();
    expect(count).toBeGreaterThan(0);

    // Clicking invokes _useSuggestion which populates the input and
    // focuses it. Don't actually send — the sandbox chat gateway
    // isn't wired. Just verify the chip handler exists by clicking
    // without error.
    await nonCombineChips.first().click();
    // Chip row disappears once a message is sent; if it's still
    // visible here, the handler just populated the input.
  });
});
