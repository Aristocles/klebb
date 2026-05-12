// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests-e2e/mood-rating-shows-emojis.spec.js
// Regression for #193 (Path B): when a `rating` input is rendered on
// a manifest whose view.display.emojiMap maps the rating key to
// emojis, the input should render the emoji buttons (😩 😔 😐 🙂 😄)
// instead of plain numbers (1 2 3 4 5). Numbers persist as the
// underlying value on save — the emojis are purely presentation.
//
// Before Path B the rating input ignored display.emojiMap entirely
// and rendered numbers, which clashed with the card's headline that
// DID consult emojiMap (see #183's resolution). The input now
// matches the headline.

const { test, expect } = require('./helpers/auth-fixture');

test.describe('#193 Path B: rating input consults display.emojiMap', () => {
  test('mood input form shows emoji buttons, not number buttons', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('eh-date-view')).toBeVisible();

    const moodCard = page.locator('eh-generic-card', { hasText: 'Mood' }).first();
    await expect(moodCard).toBeVisible({ timeout: 10_000 });

    // Open the edit/add form.
    await moodCard.locator('.edit-btn').click();

    const form = moodCard.locator('eh-input-form');
    await expect(form).toBeVisible();

    // The seeded mood manifest has emojiMap
    // {1:'😩', 2:'😔', 3:'😐', 4:'🙂', 5:'😄'}. All five should appear
    // as buttons in the rating row.
    const ratingRow = form.locator('.rating-row');
    await expect(ratingRow).toBeVisible();
    for (const emoji of ['😩', '😔', '😐', '🙂', '😄']) {
      await expect(ratingRow).toContainText(emoji);
    }

    // Number buttons must NOT appear on their own anymore; the
    // rating row's text content should not contain bare "1"/"2"/.../"5"
    // (beyond what the emoji glyph carries).
    const text = await ratingRow.innerText();
    expect(text).not.toMatch(/^\s*1\s+2\s+3\s+4\s+5\s*$/);
  });

  test('clicking an emoji saves the numeric value', async ({ page, sandboxState }) => {
    await page.goto('/');
    await expect(page.locator('eh-date-view')).toBeVisible();

    const moodCard = page.locator('eh-generic-card', { hasText: 'Mood' }).first();
    await moodCard.locator('.edit-btn').click();
    const form = moodCard.locator('eh-input-form');
    await expect(form).toBeVisible();

    // Click the 😩 button (maps to mood: 1).
    await form.locator('.rating', { hasText: '😩' }).click();

    await form.getByRole('button', { name: /^(save|update|add)$/i }).click();

    // Pull the saved data via the API and assert today's row has
    // mood === 1, not "😩".
    const res = await page.request.get(`${sandboxState.baseUrl}/api/manifests/mood/data`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    const todayIso = (() => {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    })();
    const row = body.data.find(r => r.date === todayIso);
    expect(row).toBeDefined();
    expect(row.mood).toBe(1);

    // Restore sandbox state: specs that run after this one (past-date
    // view-and-edit, smoke) expect today's mood to be the seeded 5.
    // The sandbox is shared across the whole Playwright run; we clean
    // up our mutations explicitly.
    const restored = body.data.map(r =>
      r.date === todayIso ? { ...r, mood: 5 } : r,
    );
    const put = await page.request.post(
      `${sandboxState.baseUrl}/api/manifests/mood/data`,
      { data: { data: restored } },
    );
    expect(put.status()).toBe(200);
  });
});
