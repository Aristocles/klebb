// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests-e2e/today-edit-with-no-today-row.spec.js
// Regression for a latent bug surfaced on klebbtest 2026-05-14:
//
// When a card uses dateContext:"latest" and there's no row for
// today, the card's display correctly falls back to the latest
// prior row (per #182's fix). But clicking the edit button on
// that card used to open the form pre-filled from the prior
// row — INCLUDING that row's date field — so saving rewrote the
// PRIOR day's row instead of creating a new row for today.
//
// Net effect for the operator: editing "today" on mood (which has
// yesterday's row displayed as the fallback) silently clobbered
// yesterday. Both days appeared to change together because today
// view kept showing yesterday's row as the latest.
//
// This spec exercises the full loop end-to-end on the mood card:
// clear today, navigate to Today, click edit, pick a mood, save,
// assert today now has a NEW row and yesterday is untouched.

const { test, expect } = require('./helpers/auth-fixture');

test.describe('edit on Today with dateContext:latest + no today-row targets today, not the fallback day', () => {
  test('clearing today, editing, saving — writes a NEW row for today', async ({ page, sandboxState }) => {
    const todayIso = (() => {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    })();

    // Drop today's mood so the Today view falls back to yesterday.
    const read = await page.request.get(`${sandboxState.baseUrl}/api/manifests/mood/data`);
    const body = await read.json();
    const originalRows = body.data;
    const withoutToday = originalRows.filter(r => r.date !== todayIso);
    await page.request.post(`${sandboxState.baseUrl}/api/manifests/mood/data`, {
      data: { data: withoutToday },
    });

    await page.goto('/');
    await expect(page.locator('eh-date-view')).toBeVisible();

    // Dismiss the daily prompt if it fires.
    const promptModal = page.locator('eh-prompt-modal dialog');
    await promptModal.waitFor({ state: 'visible', timeout: 2000 }).catch(() => {});
    if (await promptModal.isVisible().catch(() => false)) {
      await promptModal.locator('button[aria-label="Dismiss"]').click();
      await expect(promptModal).not.toBeVisible();
    }

    const moodCard = page.locator('eh-generic-card', { hasText: 'Mood' }).first();
    await expect(moodCard).toBeVisible({ timeout: 10_000 });

    // Open the edit form. The ➕ / ✏️ icon depends on whether the
    // renderer thinks today has an entry — we don't care which,
    // just click it.
    await moodCard.locator('.edit-btn').click();
    const form = moodCard.locator('eh-input-form');
    await expect(form).toBeVisible();

    // Pick mood=1 via the aria-label (emoji labels don't have
    // stable "name: '1'" text).
    await form.getByRole('button', { name: 'mood 1' }).click();

    // Submit.
    await form.getByRole('button', { name: /^(save|update|add)$/i }).click();

    // Read back from the server. Assertions:
    //   - today now has mood = 1
    //   - yesterday's row is STILL the seed value (4) — not clobbered
    //   - every other prior row unchanged
    await expect(async () => {
      const res = await page.request.get(`${sandboxState.baseUrl}/api/manifests/mood/data`);
      const j = await res.json();
      const byDate = Object.fromEntries(j.data.map(r => [r.date, r.mood]));
      const yesterdayIso = (() => {
        const d = new Date();
        d.setDate(d.getDate() - 1);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      })();
      expect(byDate[todayIso], `expected a NEW today row; disk: ${JSON.stringify(j.data.slice(-3))}`).toBe(1);
      expect(byDate[yesterdayIso], `yesterday must be unchanged; disk: ${JSON.stringify(j.data.slice(-3))}`).toBe(4);
    }).toPass({ timeout: 5000 });

    // Restore full seed so later specs see the default state.
    await page.request.post(`${sandboxState.baseUrl}/api/manifests/mood/data`, {
      data: { data: originalRows },
    });
  });
});
