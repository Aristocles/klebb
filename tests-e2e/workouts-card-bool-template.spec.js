// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests-e2e/workouts-card-bool-template.spec.js
// Regression for #215: a workouts card whose row is
// {date, trained:true, type:"Functional Strength Training"} must
// render readably on the Today card — no literal "true" string.
//
// Before the fix, klebbius-authored workouts cards used a template
// like "{trained} · {type}" which rendered "true · Functional
// Strength Training". The fix ships a :check modifier so
// `{trained:check}` renders ✅ for truthy values and empty for
// falsy/missing, plus system-prompt guidance to steer future
// klebbius-authored cards toward the right shape.

const { test, expect } = require('./helpers/auth-fixture');

test.describe('#215: workouts card renders boolean trained as a tick', () => {
  test('{trained:check} renders ✅ on a workout day, no literal "true"', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('eh-date-view')).toBeVisible();

    const card = page.locator('eh-generic-card', { hasText: 'Workouts' }).first();
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card).toContainText('Functional Strength Training');

    // Tick from the :check modifier should be present.
    await expect(card).toContainText('✅');

    // Specifically: the literal word "true" must NOT appear on the card.
    const text = (await card.innerText()).toLowerCase();
    expect(text).not.toMatch(/\btrue\b/);
  });
});
