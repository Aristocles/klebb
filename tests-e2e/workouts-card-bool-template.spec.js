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

test.describe('#234: workouts on a rest day shows empty state, never carry-over', () => {
  test('no row for today + no fallbackToLatest → empty headline, no chip, no dim', async ({ page, sandboxState }) => {
    const baseUrl = sandboxState.baseUrl;
    const today = (() => {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    })();

    // workouts seed is fromWebapp:false (HAE-only). Temporarily flip it
    // writeable so we can strip today's row from this spec.
    const enable = await page.request.fetch(`${baseUrl}/api/manifests/workouts`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      data: { meta: { writeable: { fromWebapp: true, pastAllowed: true, todayAllowed: true, futureAllowed: false } } },
    });
    expect(enable.status()).toBe(200);

    const original = await (await page.request.get(`${baseUrl}/api/manifests/workouts/data`)).json();
    const without = original.data.filter(r => r.date !== today);
    const strip = await page.request.post(`${baseUrl}/api/manifests/workouts/data`, {
      data: { data: without },
    });
    expect(strip.status()).toBe(200);

    await page.goto('/');
    await expect(page.locator('eh-date-view')).toBeVisible();

    const card = page.locator('eh-generic-card', { hasText: 'Workouts' }).first();
    await expect(card).toBeVisible();
    // Empty state shows the configured emptyHeadline, not a stale prior workout.
    await expect(card).toContainText(/no workout today/i);
    // The carry-over chip + dim from #231 must NOT appear on a card
    // that doesn't opt into fallbackToLatest.
    await expect(card.locator('.gen-carry-chip')).toHaveCount(0);
    await expect(card.locator('.gen-headline.carry-over')).toHaveCount(0);
    // No literal "true" leaks in either.
    const text = (await card.innerText()).toLowerCase();
    expect(text).not.toMatch(/\btrue\b/);

    // Restore.
    const restoreData = await page.request.post(`${baseUrl}/api/manifests/workouts/data`, {
      data: { data: original.data },
    });
    expect(restoreData.status()).toBe(200);
    const restoreMeta = await page.request.fetch(`${baseUrl}/api/manifests/workouts`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      data: { meta: { writeable: { fromWebapp: false } } },
    });
    expect(restoreMeta.status()).toBe(200);
  });
});
