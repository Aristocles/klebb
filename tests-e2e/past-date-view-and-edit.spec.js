// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests-e2e/past-date-view-and-edit.spec.js
// Regression coverage for #182 (supersedes #181): cards with
// `view.dateContext: "latest"` must honour past-date navigation.
// On a past date the card should show THAT date's row (or empty
// state if none), and the pencil-edit should write only to that
// date's row.
//
// Before the fix, both mood and weight cards always render today's
// latest row and the pencil-edit writes to today's row regardless
// of the date the user is viewing.

const { test, expect } = require('./helpers/auth-fixture');
const { todayISO, shiftDays } = require('./helpers/seed-manifests');

const today = todayISO();
const yesterday = shiftDays(today, -1);
const twoDaysAgo = shiftDays(today, -2);

test.describe('#182: cards with dateContext:latest honour past-date navigation', () => {
  test('mood card on yesterday shows yesterday\'s value, not today\'s', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('eh-date-view')).toBeVisible();

    const moodCard = page.locator('eh-generic-card', { hasText: 'Mood' }).first();
    // Mood card headline uses {mood:emoji} with the flat emojiMap,
    // so today (seeded mood=5) shows 😄 and yesterday (mood=4) shows
    // 🙂. Wait for the current (today's) value to paint before
    // navigating to avoid racing the app's _today hydration.
    await expect(moodCard).toContainText('😄');

    await page.locator('.arrow-btn[aria-label="previous day"]').click();
    await expect(moodCard).toContainText('🙂');
  });

  test('weight card on two days ago shows that date\'s value', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('eh-date-view')).toBeVisible();

    const weightCard = page.locator('eh-generic-card', { hasText: 'Weight' }).first();
    await expect(weightCard).toContainText('80.9');

    await page.locator('.arrow-btn[aria-label="previous day"]').click();
    await page.locator('.arrow-btn[aria-label="previous day"]').click();

    await expect(weightCard).toContainText('81.2');
  });

  test('pencil edit on yesterday writes only to that date', async ({ page, sandboxState }) => {
    await page.goto('/');
    await expect(page.locator('eh-date-view')).toBeVisible();

    const moodCard = page.locator('eh-generic-card', { hasText: 'Mood' }).first();
    // Mood headline is {mood:emoji}; today's seeded row (mood=5)
    // renders 😄. Wait for it to paint before navigating.
    await expect(moodCard).toContainText('😄');

    // Go to yesterday (mood=4 → 🙂).
    await page.locator('.arrow-btn[aria-label="previous day"]').click();
    await expect(moodCard).toContainText('🙂');

    // Capture the POST the card sends so we can assert what it asked
    // the server to write, independently of what lands on disk.
    const writeRequest = page.waitForRequest(req =>
      req.url().includes('/api/manifests/mood/data') && req.method() === 'POST',
    );

    // Open the edit pencil inside the mood card.
    await moodCard.locator('.edit-btn').click();

    // The form is an eh-input-form with a rating input of type "rating".
    // When display.emojiMap is present the buttons show emoji labels
    // with aria-label "mood 1" / "mood 2" etc. (see #193). Click by
    // aria-label so the spec is stable whether numbers or emojis
    // render.
    await moodCard.locator('eh-input-form').getByRole('button', { name: 'mood 1' }).click();

    // Submit.
    await moodCard.locator('eh-input-form').getByRole('button', { name: /save|update/i }).click();

    const sentRequest = await writeRequest;
    const sentBody = JSON.parse(sentRequest.postData());
    const sentByDate = Object.fromEntries(sentBody.data.map(r => [r.date, r.mood]));
    expect(sentByDate[yesterday]).toBe(1);
    expect(sentByDate[today]).toBe(5);

    // Wait for the card to reflect the new value — mood=1 → 😩.
    await expect(moodCard).toContainText('😩', { timeout: 5000 });

    // Verify the manifest via the server (authoritative read — avoids
    // any filesystem-buffering surprises with the direct file read).
    const readRes = await page.request.get(`${sandboxState.baseUrl}/api/manifests/mood/data`);
    expect(readRes.status()).toBe(200);
    const onServer = await readRes.json();
    const byDate = Object.fromEntries(onServer.data.map(r => [r.date, r.mood]));

    expect(byDate[yesterday]).toBe(1);
    expect(byDate[today]).toBe(5);
    expect(byDate[twoDaysAgo]).toBe(3);
    expect(byDate[shiftDays(today, -3)]).toBe(2);

    // Restore yesterday's seeded value so specs that run later in
    // the same sandbox run (today-edit-with-no-today-row, etc.) see
    // the original data instead of our mutation.
    const restored = onServer.data.map(r =>
      r.date === yesterday ? { ...r, mood: 4 } : r,
    );
    const restoreRes = await page.request.post(
      `${sandboxState.baseUrl}/api/manifests/mood/data`,
      { data: { data: restored } },
    );
    expect(restoreRes.status()).toBe(200);
  });
});
