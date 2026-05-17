// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests-e2e/carry-over-visual-cue.spec.js
// Regression for #231: cards with fallbackToLatest:true that resolve
// to a PRIOR-day row on Today must visually mark the headline as
// stale (dimmed + dotted underline) and render an `Nd ago` chip
// below any existing secondary line. Logging today's row clears both
// signals.

const { test, expect } = require('./helpers/auth-fixture');
const { todayISO, shiftDays } = require('./helpers/seed-manifests');

// These tests mutate sandbox state (strip today's row, then put it
// back). Run them in serial so a failed mid-test doesn't leak data
// into the next one's assertions.
test.describe.configure({ mode: 'serial' });

test.describe('#231: fallbackToLatest carry-over visual cue', () => {
  // Mark the mood prompt as already-shown today so it doesn't fire
  // mid-spec when a sibling test temporarily strips mood. Without this,
  // a stale prompt modal can intercept clicks meant for the date arrows.
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      const d = new Date();
      const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      try { localStorage.setItem(`klebb-prompt-shown-mood-${today}`, '1'); } catch {}
    });
  });

  test('weight card on Today with no today-row shows dimmed headline + Nd ago chip', async ({ page, sandboxState }) => {
    const today = todayISO();
    const baseUrl = sandboxState.baseUrl;

    // Snapshot weight so we can restore.
    const original = await (await page.request.get(`${baseUrl}/api/manifests/weight/data`)).json();

    // Strip today's row, leave today-1 in place. Weight seed already
    // has rows at today-4, today-2, today-1, today; remove only today.
    const without = original.data.filter(r => r.date !== today);
    const strip = await page.request.post(`${baseUrl}/api/manifests/weight/data`, {
      data: { data: without },
    });
    expect(strip.status()).toBe(200);

    await page.goto('/');
    await expect(page.locator('eh-date-view')).toBeVisible();

    const weightCard = page.locator('eh-generic-card', { hasText: 'Weight' }).first();
    // The most recent prior row is today-1, so the chip should read 1d ago.
    await expect(weightCard.locator('.gen-headline.carry-over')).toBeVisible();
    await expect(weightCard.locator('.gen-carry-chip')).toHaveText('1d ago');

    // Now log a row for today via the API and reload — both signals clear.
    const restore = await page.request.post(`${baseUrl}/api/manifests/weight/data`, {
      data: { data: original.data },
    });
    expect(restore.status()).toBe(200);

    await page.goto('/');
    await expect(weightCard).toBeVisible();
    await expect(weightCard.locator('.gen-headline.carry-over')).toHaveCount(0);
    await expect(weightCard.locator('.gen-carry-chip')).toHaveCount(0);
  });

  test('chip stacks below an existing secondary line (mood card)', async ({ page, sandboxState }) => {
    const today = todayISO();
    const baseUrl = sandboxState.baseUrl;
    const original = await (await page.request.get(`${baseUrl}/api/manifests/mood/data`)).json();

    // Make sure today-1 has a note so the secondary line renders.
    const yesterday = shiftDays(today, -1);
    const seeded = original.data
      .filter(r => r.date !== today)
      .map(r => r.date === yesterday ? { ...r, note: 'felt steady' } : r);
    const seed = await page.request.post(`${baseUrl}/api/manifests/mood/data`, {
      data: { data: seeded },
    });
    expect(seed.status()).toBe(200);

    await page.goto('/');
    await expect(page.locator('eh-date-view')).toBeVisible();

    const moodCard = page.locator('eh-generic-card', { hasText: 'Mood' }).first();
    // Carry-over from today-1 → 1d ago.
    await expect(moodCard.locator('.gen-headline.carry-over')).toBeVisible();
    await expect(moodCard.locator('.gen-carry-chip')).toHaveText('1d ago');
    // Secondary line still rendered with the note.
    await expect(moodCard.locator('.gen-secondary')).toContainText('felt steady');
    // The chip lives in its own line (.gen-carry-line), not inside the
    // secondary, so it never replaces the note.
    await expect(moodCard.locator('.gen-carry-line .gen-carry-chip')).toBeVisible();

    // Restore.
    const restore = await page.request.post(`${baseUrl}/api/manifests/mood/data`, {
      data: { data: original.data },
    });
    expect(restore.status()).toBe(200);
  });

  test('non-fallback card (workouts) on a rest day shows neither dimming nor chip', async ({ page, sandboxState }) => {
    const baseUrl = sandboxState.baseUrl;
    const today = todayISO();
    // workouts is HAE-only by default (fromWebapp: false). Temporarily
    // PATCH it writeable so we can strip today's row via the webapp
    // path, then restore.
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

    const workoutsCard = page.locator('eh-generic-card', { hasText: 'Workouts' }).first();
    // Empty state — no fallback to a previous workout, no chip, no dim.
    await expect(workoutsCard.locator('.gen-headline.carry-over')).toHaveCount(0);
    await expect(workoutsCard.locator('.gen-carry-chip')).toHaveCount(0);
    await expect(workoutsCard).toContainText(/no workout today/i);

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

  test('past-date navigation never shows the chip even on a fallback card', async ({ page, sandboxState }) => {
    const baseUrl = sandboxState.baseUrl;
    // Weight seed already has a today-3 gap (rows at today-4 and today-2,
    // none at today-3). Navigate to today-3 and assert no chip — the
    // fallback path is Today-only.
    await page.goto('/');
    await expect(page.locator('eh-date-view')).toBeVisible();

    await page.locator('.arrow-btn[aria-label="previous day"]').click();
    await page.locator('.arrow-btn[aria-label="previous day"]').click();
    await page.locator('.arrow-btn[aria-label="previous day"]').click();

    const weightCard = page.locator('eh-generic-card', { hasText: 'Weight' }).first();
    await expect(weightCard.locator('.gen-carry-chip')).toHaveCount(0);
    await expect(weightCard.locator('.gen-headline.carry-over')).toHaveCount(0);
  });
});
