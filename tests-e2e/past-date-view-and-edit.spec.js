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

const fs = require('fs');
const path = require('path');
const { test, expect } = require('./helpers/auth-fixture');
const { todayISO, shiftDays } = require('./helpers/seed-manifests');

const today = todayISO();
const yesterday = shiftDays(today, -1);
const twoDaysAgo = shiftDays(today, -2);

test.describe('#182: cards with dateContext:latest honour past-date navigation', () => {
  test('mood card on yesterday shows yesterday\'s value, not today\'s', async ({ page }) => {
    await page.goto('/');

    // Today shows latest: mood = 5.
    const moodCard = page.locator('eh-generic-card', { hasText: 'Mood' }).first();
    await expect(moodCard).toBeVisible();
    await expect(moodCard).toContainText('5');

    // Navigate to yesterday via the left-arrow.
    await page.locator('.arrow-btn[aria-label="previous day"]').click();

    // Yesterday's mood row is 4 (per seed). The card should now show 4.
    await expect(moodCard).toContainText('4');
  });

  test('weight card on two days ago shows that date\'s value', async ({ page }) => {
    await page.goto('/');

    const weightCard = page.locator('eh-generic-card', { hasText: 'Weight' }).first();
    await expect(weightCard).toBeVisible();
    // Today shows 80.9 kg.
    await expect(weightCard).toContainText('80.9');

    // Step back twice.
    await page.locator('.arrow-btn[aria-label="previous day"]').click();
    await page.locator('.arrow-btn[aria-label="previous day"]').click();

    // Two-days-ago seeded at 81.2.
    await expect(weightCard).toContainText('81.2');
  });

  test('pencil edit on yesterday writes only to that date', async ({ page, sandboxState }) => {
    await page.goto('/');

    // Go to yesterday.
    await page.locator('.arrow-btn[aria-label="previous day"]').click();

    const moodCard = page.locator('eh-generic-card', { hasText: 'Mood' }).first();
    await expect(moodCard).toContainText('4');

    // Open the edit pencil inside the mood card.
    await moodCard.locator('.edit-btn').click();

    // The form is an eh-input-form with a rating input of type "rating".
    // The rating renderer emits buttons 1..5; click the "1" to change
    // mood to 1. Scope to the mood card to avoid catching a weight input.
    await moodCard.locator('eh-input-form').getByRole('button', { name: '1', exact: true }).click();

    // Submit.
    await moodCard.locator('eh-input-form').getByRole('button', { name: /save|update/i }).click();

    // Wait for the card to reflect the new value.
    await expect(moodCard).toContainText('1', { timeout: 5000 });

    // Verify the manifest on disk: ONLY yesterday's row has mood=1.
    // Everything else is untouched.
    const moodPath = path.join(sandboxState.sandbox, 'data', 'mood.json');
    const onDisk = JSON.parse(fs.readFileSync(moodPath, 'utf8'));
    const byDate = Object.fromEntries(onDisk.data.map(r => [r.date, r.mood]));

    expect(byDate[yesterday]).toBe(1);
    expect(byDate[today]).toBe(5);
    expect(byDate[twoDaysAgo]).toBe(3);
    expect(byDate[shiftDays(today, -3)]).toBe(2);
  });
});
