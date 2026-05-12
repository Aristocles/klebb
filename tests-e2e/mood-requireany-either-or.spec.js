// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests-e2e/mood-requireany-either-or.spec.js
// Regression for #193 Part B: an edit form for a manifest declaring
// `writeable.requireAny: ["mood", "note"]` enables the Save button
// when EITHER field is filled, and stays disabled only when both
// are empty.
//
// Before Part B, mood's rating input was `required: true`, which
// meant Save stayed disabled until a number was picked — logging
// just a note wasn't possible. The operator's 2026-05-11 QA
// feedback: "save enabled when emoji OR text entered (or both),
// disabled when neither".

const { test, expect } = require('./helpers/auth-fixture');

// The seed switches mood to requireAny: ["mood", "note"] so both
// halves of the assertion can fire against a live card.
test.describe('#193 Part B: form requireAny enables save when any listed field is present', () => {
  test('save disabled when neither mood nor note is present', async ({ page }) => {
    await page.goto('/');
    const moodCard = page.locator('eh-generic-card', { hasText: 'Mood' }).first();
    await expect(moodCard).toBeVisible({ timeout: 10_000 });

    await moodCard.locator('.edit-btn').click();
    const form = moodCard.locator('eh-input-form');
    await expect(form).toBeVisible();

    // Clear the prefilled mood + note so neither is present.
    await form.evaluate(el => {
      el._state = { ...(el._state || {}), mood: null, note: '' };
      el.requestUpdate();
    });

    const save = form.getByRole('button', { name: /^(save|update|add)$/i });
    await expect(save).toBeDisabled();
  });

  test('save enabled when only note is filled', async ({ page }) => {
    await page.goto('/');
    const moodCard = page.locator('eh-generic-card', { hasText: 'Mood' }).first();
    await moodCard.locator('.edit-btn').click();
    const form = moodCard.locator('eh-input-form');
    await expect(form).toBeVisible();

    // Reset, then type a note — mood stays null.
    await form.evaluate(el => {
      el._state = { ...(el._state || {}), mood: null, note: '' };
      el.requestUpdate();
    });
    await form.locator('textarea').fill('felt decent');

    const save = form.getByRole('button', { name: /^(save|update|add)$/i });
    await expect(save).toBeEnabled();
  });

  test('save enabled when only mood is picked', async ({ page }) => {
    await page.goto('/');
    const moodCard = page.locator('eh-generic-card', { hasText: 'Mood' }).first();
    await moodCard.locator('.edit-btn').click();
    const form = moodCard.locator('eh-input-form');
    await expect(form).toBeVisible();

    await form.evaluate(el => {
      el._state = { ...(el._state || {}), mood: null, note: '' };
      el.requestUpdate();
    });
    await form.getByRole('button', { name: 'mood 4' }).click();

    const save = form.getByRole('button', { name: /^(save|update|add)$/i });
    await expect(save).toBeEnabled();
  });
});
