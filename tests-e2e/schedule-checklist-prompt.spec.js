// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests-e2e/schedule-checklist-prompt.spec.js
// Regression for #185: when a schedule-card manifest declares
// `meta.prompt.mode: "checklist"`, the daily prompt renders as a list of
// today's scheduled doses with a single "Taken" button per row. Tapping
// each Taken button stamps `{scheduledDate, takenAt}` into that item's
// `doses[]` and updates in place; the modal auto-closes once every
// scheduled item is marked.

const { test, expect } = require('./helpers/auth-fixture');

function todayISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function shiftDays(iso, delta) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

test.describe('#185: schedule-card checklist-mode prompt', () => {
  test('renders one row per scheduled item, marks each Taken, auto-closes', async ({ page, sandboxState }) => {
    const today = todayISO();
    const baseUrl = sandboxState.baseUrl;

    // Snapshot original manifest so we can restore at end.
    const original = await (await page.request.get(`${baseUrl}/api/manifests/peptides`)).json();

    // Seed two scheduled-today items with no doses, and turn the prompt
    // on in checklist mode.
    const seedData = {
      items: [
        {
          id: 'semax',
          name: 'Semax',
          short_name: 'Semax',
          dose_mg: 1,
          dose_units: 'mcg',
          route: 'subQ',
          schedule: { type: 'daily_straight', duration_days: 20 },
          cycle: { cycles: [{ cycle_number: 1, start_date: shiftDays(today, -2), end_date: shiftDays(today, 17) }] },
        },
        {
          id: 'selank',
          name: 'Selank',
          short_name: 'Selank',
          dose_mg: 0.5,
          dose_units: 'mcg',
          route: 'subQ',
          schedule: { type: 'daily_straight', duration_days: 20 },
          cycle: { cycles: [{ cycle_number: 1, start_date: shiftDays(today, -2), end_date: shiftDays(today, 17) }] },
        },
      ],
    };
    const writeData = await page.request.post(`${baseUrl}/api/manifests/peptides/data`, { data: { data: seedData } });
    expect(writeData.status()).toBe(200);

    const patch = await page.request.fetch(`${baseUrl}/api/manifests/peptides`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      data: { meta: { prompt: { enabled: true, mode: 'checklist', whenMissing: true } } },
    });
    expect(patch.status()).toBe(200);

    // Clear any prior shown-today marker so the prompt is eligible.
    await page.addInitScript((id) => {
      const today = (() => {
        const d = new Date();
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
      })();
      try { localStorage.removeItem(`klebb-prompt-shown-${id}-${today}`); } catch {}
    }, 'peptides');

    await page.goto('/');

    const modal = page.locator('eh-prompt-modal dialog');
    await expect(modal).toBeVisible({ timeout: 10_000 });
    await expect(modal).toContainText(/schedule|peptide/i);

    // Two rows, two Taken buttons.
    const rows = modal.locator('.row');
    await expect(rows).toHaveCount(2);
    await expect(modal).toContainText('Semax');
    await expect(modal).toContainText('Selank');

    // No free-text item input, no editable date picker, no time picker.
    await expect(modal.locator('input[type="text"]')).toHaveCount(0);
    await expect(modal.locator('input[type="date"]')).toHaveCount(0);
    await expect(modal.locator('input[type="time"]')).toHaveCount(0);

    // Tap Taken on the first row → row toggles, modal stays open.
    await rows.nth(0).locator('button.taken-btn').click();
    await expect(rows.nth(0).locator('button.taken-btn')).toHaveText(/Taken/);
    await expect(rows.nth(0).locator('button.taken-btn')).toBeDisabled();
    await expect(modal).toBeVisible();

    // Tap Taken on the second row → auto-close.
    await rows.nth(1).locator('button.taken-btn').click();
    await expect(modal).toBeHidden({ timeout: 5_000 });

    // Verify writes landed on disk.
    const after = await (await page.request.get(`${baseUrl}/api/manifests/peptides/data`)).json();
    const items = after.data.items;
    for (const it of items) {
      const dose = (it.doses || []).find(d => d.scheduledDate === today);
      expect(dose, `item ${it.name} should have a dose for today`).toBeTruthy();
      expect(dose.takenAt, `item ${it.name} dose should have takenAt`).toBeTruthy();
    }

    // Reload — prompt should NOT re-fire (every item already taken,
    // and the shown-today marker is set anyway).
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('eh-prompt-modal dialog')).toHaveCount(0);

    // Restore the original manifest so unrelated specs remain unaffected.
    const restoreData = await page.request.post(`${baseUrl}/api/manifests/peptides/data`, {
      data: { data: original.data },
    });
    expect(restoreData.status()).toBe(200);
    const restoreMeta = await page.request.fetch(`${baseUrl}/api/manifests/peptides`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      data: { meta: { prompt: null } },
    });
    expect(restoreMeta.status()).toBe(200);
  });
});
