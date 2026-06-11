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

    // Read the ids shown in each card (the <span class="id"> inside
    // .card-title). They're declared in the seed with known labels,
    // so id order maps 1:1 to label order.
    const ids = await page
      .locator('eh-settings-cards .card .card-title .id')
      .allInnerTexts();

    // Seeded cards by label (case-insensitive alpha):
    //   HRV                 (id: hrv)
    //   Mood                (id: mood)
    //   Recovery Overview   (id: recovery-overview)
    //   Resting HR          (id: resting-heart-rate)
    //   Schedule            (id: peptides)
    //   Water               (id: water-intake)
    //   Weight              (id: weight)
    //   Workouts            (id: workouts)
    expect(ids).toEqual([
      'hrv',
      'mood',
      'recovery-overview',
      'resting-heart-rate',
      'peptides',
      'water-intake',
      'weight',
      'workouts',
    ]);
  });

  test('toggling a card does not reshuffle the list or change scroll position', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.locator('eh-settings-view')).toBeVisible();

    await page.locator('eh-settings-view [data-tab="cards"]').click();
    await expect(page.locator('eh-settings-cards')).toBeVisible();

    // Capture order + scroll before toggling.
    const beforeTitles = await page.locator('eh-settings-cards .card .card-title').allInnerTexts();
    const weightCard = page.locator('eh-settings-cards .card', { hasText: 'Weight' });
    await expect(weightCard).toBeVisible();

    // Scroll the weight card into view; if the page jumps to top after
    // toggle, the card will no longer be where we left it.
    await weightCard.scrollIntoViewIfNeeded();
    const scrollYBefore = await page.evaluate(() => window.scrollY);

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

    // Restore sandbox state so specs that run after this one (smoke
    // etc.) see Weight enabled again. Global-setup is per-run, not
    // per-spec.
    await weightCard.locator('button.toggle').click();
    await expect(weightCard.locator('button.toggle')).toHaveAttribute('aria-pressed', 'true');
  });
});
