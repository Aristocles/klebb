// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests-e2e/schedule-card-checkoff-form.spec.js
// Coverage for #345: schedule-card per-dose metadata + retroactive review.
//
// Seeds a schedule-card with a daily item, a prior taken dose on disk
// (3 days ago), and today's dose unchecked. The manifest declares
// meta.view.checkOffForm and chips/chips-multi inputs for site fields
// and reactions. Drives the UI:
//   1. Tap ✓ on the scheduled item → form expands.
//   2. Verify the "Last:" context line summarises the prior dose.
//   3. Pick reaction chips (those merge onto the PREVIOUS dose).
//   4. Pick site chips (those go on the NEW dose).
//   5. Submit.
// Then reads the data file back and asserts the merged shape.

const { test, expect } = require('./helpers/auth-fixture');

const CARD_ID = 'peptide-checkoff-e2e';

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function shiftDays(iso, delta) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

function manifest() {
  const today = todayISO();
  const startDate = shiftDays(today, -10);
  const priorDoseDate = shiftDays(today, -3);
  return {
    $schema: 'klebb.datafile.v1',
    meta: {
      id: CARD_ID,
      label: 'Peptide check-off (e2e)',
      emoji: '💉',
      order: 9200,
      category: 'protocols',
      view: {
        enabled: true,
        component: 'schedule-card',
        checkOffForm: {
          currentDoseFields: ['site_side', 'site_region', 'site_position'],
          previousDoseFields: ['reactions'],
          previousDosePrompt: 'How does the last injection site look?',
        },
      },
      writeable: {
        fromWebapp: true,
        todayAllowed: true,
        pastAllowed: true,
        futureAllowed: false,
        inputs: [
          { key: 'site_side',     label: 'Side',     type: 'chips',
            options: ['left', 'right', 'centre'] },
          { key: 'site_region',   label: 'Region',   type: 'chips',
            options: ['belly', 'flank', 'thigh', 'delt', 'glute', 'tricep'] },
          { key: 'site_position', label: 'Position', type: 'chips',
            options: ['upper', 'middle', 'lower'] },
          { key: 'reactions',     label: 'Reactions', type: 'chips-multi',
            options: ['none', 'bruised', 'red', 'swollen', 'itchy', 'tender', 'welt', 'lump'] },
        ],
      },
    },
    description: 'Schedule-card with checkOffForm exercising per-dose metadata + retroactive review (#345).',
    data: {
      items: [
        {
          name: 'TestPeptide-345',
          short_name: 'TP-345',
          dose_mg: 0.25, dose_units: 'mg', route: 'subcutaneous',
          schedule: { type: 'daily', times_per_day: 1, start_date: startDate, cycle_weeks: 4 },
          doses: [
            // A prior taken dose three days ago, with site fields
            // already filled in. Reactions field is absent — we want
            // the e2e to add it via the form.
            {
              scheduledDate: priorDoseDate,
              takenAt: `${priorDoseDate}T08:30:00Z`,
              site_side: 'right',
              site_region: 'belly',
              site_position: 'upper',
            },
          ],
        },
      ],
    },
  };
}

async function seed(request, baseUrl, m) {
  await request.delete(`${baseUrl}/api/manifests/${m.meta.id}`).catch(() => {});
  const r = await request.post(`${baseUrl}/api/manifests`, { data: m });
  expect([201, 409]).toContain(r.status());
}

async function cleanup(request, baseUrl, id) {
  await request.delete(`${baseUrl}/api/manifests/${id}`).catch(() => {});
}

test.describe('#345: schedule-card check-off form with per-dose metadata', () => {
  test('submitting the check-off form writes site fields onto new dose and reactions onto previous dose', async ({ page, sandboxState }) => {
    const m = manifest();
    await seed(page.request, sandboxState.baseUrl, m);

    await page.goto('/');
    await expect(page.locator('eh-date-view')).toBeVisible({ timeout: 10_000 });

    const card = page.locator(`[data-card-id="${CARD_ID}"] eh-schedule-card`);
    await expect(card).toBeVisible({ timeout: 10_000 });

    // Tap the ✓ checkbox to expand the inline form.
    await card.locator('.checkbox').first().click();

    const form = card.locator('.checkoff-form');
    await expect(form).toBeVisible();

    // The prior-dose context line should summarise "Nd ago · right belly upper".
    const prevLine = form.locator('.prev-dose-summary');
    await expect(prevLine).toContainText('right belly upper');

    // Reactions (chips-multi) lives in the previous-dose section. Pick two.
    const innerForm = form.locator('eh-input-form');
    const chipRows = innerForm.locator('.chip-row');
    // The form renders previousDoseFields first, then currentDoseFields,
    // each input getting one .chip-row. So:
    //   chipRows[0] = reactions (chips-multi, from previousDoseFields)
    //   chipRows[1] = site_side
    //   chipRows[2] = site_region
    //   chipRows[3] = site_position
    await chipRows.nth(0).locator('.chip', { hasText: 'bruised' }).click();
    await chipRows.nth(0).locator('.chip', { hasText: 'itchy' }).click();
    await chipRows.nth(1).locator('.chip', { hasText: 'left' }).click();
    await chipRows.nth(2).locator('.chip', { hasText: 'thigh' }).click();
    await chipRows.nth(3).locator('.chip', { hasText: 'upper' }).click();

    // Submit.
    await innerForm.getByRole('button', { name: /log dose/i }).click();

    // Form should collapse.
    await expect(form).toHaveCount(0);

    // Round-trip: the data file should now have the previous dose with
    // a `reactions` array, AND a new dose for today with the site
    // fields stamped on.
    const res = await page.request.get(`${sandboxState.baseUrl}/api/manifests/${CARD_ID}/data`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    const doses = body.data.items[0].doses;
    expect(doses.length).toBe(2);

    // The earlier dose (index 0) is the prior dose. It originally had
    // {site_side: right, site_region: belly, site_position: upper}; the
    // form merge should have added `reactions`.
    const priorDose = doses[0];
    expect(priorDose.site_region).toBe('belly');
    expect(Array.isArray(priorDose.reactions)).toBe(true);
    expect(priorDose.reactions.sort()).toEqual(['bruised', 'itchy']);

    // The new dose (index 1) should be today's, with site fields.
    const newDose = doses[1];
    expect(newDose.scheduledDate).toBe(todayISO());
    expect(newDose.takenAt).toBeTruthy();
    expect(newDose.site_side).toBe('left');
    expect(newDose.site_region).toBe('thigh');
    expect(newDose.site_position).toBe('upper');
    // Reactions should NOT have leaked onto the new dose; they belong
    // on the previous one.
    expect(newDose.reactions).toBeUndefined();

    await cleanup(page.request, sandboxState.baseUrl, CARD_ID);
  });

  test('cancelling the check-off form leaves data unchanged', async ({ page, sandboxState }) => {
    const m = manifest();
    await seed(page.request, sandboxState.baseUrl, m);

    await page.goto('/');
    const card = page.locator(`[data-card-id="${CARD_ID}"] eh-schedule-card`);
    await expect(card).toBeVisible({ timeout: 10_000 });

    await card.locator('.checkbox').first().click();
    const form = card.locator('.checkoff-form');
    await expect(form).toBeVisible();

    // Tap a chip then cancel.
    await form.locator('.chip', { hasText: 'bruised' }).click();
    await form.getByRole('button', { name: /cancel/i }).click();
    await expect(form).toHaveCount(0);

    // Data file unchanged: still one dose, no reactions on it.
    const res = await page.request.get(`${sandboxState.baseUrl}/api/manifests/${CARD_ID}/data`);
    const body = await res.json();
    expect(body.data.items[0].doses.length).toBe(1);
    expect(body.data.items[0].doses[0].reactions).toBeUndefined();

    await cleanup(page.request, sandboxState.baseUrl, CARD_ID);
  });
});
