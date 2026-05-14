// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests-e2e/mood-headline-emoji-and-note.spec.js
// Regression coverage for the mood headline rendering:
//   1. {mood:emoji} resolves against display.emojiMap in its flat
//      shape ({"1":"😩",...}) — same as the calendar marker (#183)
//      and rating input (#193 Part A). Before this fix, :emoji
//      required the keyed shape (emojiMap[field][value]), so mood
//      cards using a flat map showed the raw number on save.
//   2. {note} appears as a secondary sub-line when a note is logged.
//
// Seed mood data puts today at mood=5 + note="great"; the card
// headline should show 😄 and the secondary line should show
// "great".

const { test, expect } = require('./helpers/auth-fixture');

test.describe('mood card headline — emoji + note', () => {
  test('headline shows emoji (not number) and secondary shows the note', async ({ page, sandboxState }) => {
    // Seed today's mood row with a note so both render surfaces have
    // something to show. The sandbox default seed has mood=5 but no
    // note.
    const todayIso = (() => {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    })();
    const read = await page.request.get(`${sandboxState.baseUrl}/api/manifests/mood/data`);
    const body = await read.json();
    const originalRows = body.data;
    const withoutToday = originalRows.filter(r => r.date !== todayIso);
    const seeded = [...withoutToday, { date: todayIso, mood: 5, note: 'great day at work' }];
    await page.request.post(`${sandboxState.baseUrl}/api/manifests/mood/data`, {
      data: { data: seeded },
    });

    await page.goto('/');
    await expect(page.locator('eh-date-view')).toBeVisible();

    // Dismiss the daily prompt if it fires (today has an entry now, so
    // it shouldn't — but be defensive).
    const promptModal = page.locator('eh-prompt-modal dialog');
    await promptModal.waitFor({ state: 'visible', timeout: 2000 }).catch(() => {});
    if (await promptModal.isVisible().catch(() => false)) {
      await promptModal.locator('button[aria-label="Dismiss"]').click();
    }

    const moodCard = page.locator('eh-generic-card', { hasText: 'Mood' }).first();
    await expect(moodCard).toBeVisible({ timeout: 10_000 });

    // Headline should be the emoji, not "5".
    await expect(moodCard).toContainText('😄');

    // Secondary line should carry the note.
    await expect(moodCard).toContainText('great day at work');

    // Specifically: the literal digit "5" should NOT appear in the
    // card's rendered body text (outside the aria-label on an edit
    // button, which is not part of innerText).
    const bodyText = await moodCard.innerText();
    expect(bodyText).not.toMatch(/\b5\b/);

    // Restore so later specs see the default seed.
    await page.request.post(`${sandboxState.baseUrl}/api/manifests/mood/data`, {
      data: { data: originalRows },
    });
  });
});
