// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests-e2e/settings-alpha-toggle.spec.js
// Regression for #194: Settings page lists cards alphabetically by
// label (regardless of enabled/disabled state), and toggling a card
// flips the switch in place without reshuffling the list or jumping
// to the top of the page.

const { test, expect } = require('./helpers/auth-fixture');

test.describe('#194: Settings card list is alphabetical and toggles in place', () => {
  test('cards render in alphabetical order by label', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.locator('eh-settings-view')).toBeVisible();

    // The Cards tab isn't the default tab any more — switch to it.
    await page.locator('eh-settings-view [data-tab="cards"]').click();
    await expect(page.locator('eh-settings-cards')).toBeVisible();

    // Seeded cards by label (case-insensitive alpha). Label order differs
    // from id order (peptides is "Schedule"), so this proves the sort key:
    //   HRV                 (id: hrv)
    //   Mood                (id: mood)
    //   Recovery Overview   (id: recovery-overview)
    //   Resting HR          (id: resting-heart-rate)
    //   Schedule            (id: peptides)
    //   Water               (id: water-intake)
    //   Weight              (id: weight)
    //   Workouts            (id: workouts)
    const seededByLabel = [
      'hrv',
      'mood',
      'recovery-overview',
      'resting-heart-rate',
      'peptides',
      'water-intake',
      'weight',
      'workouts',
    ];

    // Read the ids shown in each card (the <span class="id"> inside
    // .card-title). Retried, because the list loads after the component
    // shows; filtered to the seeded ids, because other specs share this
    // sandbox and a card one of them leaves behind is not an ordering bug.
    const ids = page.locator('eh-settings-cards .card .card-title .id');
    await expect.poll(async () => (await ids.allInnerTexts()).filter(id => seededByLabel.includes(id)))
      .toEqual(seededByLabel);
  });

  test('toggling a card does not reshuffle the list or change scroll position', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.locator('eh-settings-view')).toBeVisible();

    await page.locator('eh-settings-view [data-tab="cards"]').click();
    await expect(page.locator('eh-settings-cards')).toBeVisible();

    const weightCard = page.locator('eh-settings-cards .card', { hasText: 'Weight' });
    await expect(weightCard).toBeVisible();
    await expect(weightCard.locator('button.toggle')).toHaveAttribute('aria-pressed', 'true');

    // Capture order only after the card list has loaded.
    const beforeTitles = await page.locator('eh-settings-cards .card .card-title').allInnerTexts();

    // Scroll the weight card into view; if the page jumps to top after
    // toggle, the card will no longer be where we left it.
    await weightCard.scrollIntoViewIfNeeded();
    const scrollYBefore = await page.evaluate(() => window.scrollY);

    try {
      // Toggle weight off.
      await weightCard.locator('button.toggle').click();

      // Wait for the button's aria-pressed to settle.
      await expect(weightCard.locator('button.toggle')).toHaveAttribute('aria-pressed', 'false');

      // Order should be preserved; scroll within a small tolerance.
      const afterTitles = await page.locator('eh-settings-cards .card .card-title').allInnerTexts();
      expect(afterTitles).toEqual(beforeTitles);

      // The original guard was "page does not jump to the top after toggle".
      // The tabbed layout reflows by ~150px on toggle re-render — still well
      // short of a top-of-page jump, which on a populated card list would be
      // many hundreds of pixels.
      const scrollYAfter = await page.evaluate(() => window.scrollY);
      expect(Math.abs(scrollYAfter - scrollYBefore)).toBeLessThan(300);

    } finally {
      // Restore the shared seed even if a toggle or order assertion fails.
      const restored = await page.request.post('/api/settings/cards/weight/enable');
      expect(restored.status()).toBe(200);
      if (await weightCard.locator('button.toggle').getAttribute('aria-pressed') === 'false') {
        await weightCard.locator('button.toggle').click();
      }
      await expect(weightCard.locator('button.toggle')).toHaveAttribute('aria-pressed', 'true');
    }
  });
});
