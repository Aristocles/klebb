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

test.describe('#354: schedule-card surfaces logged per-dose metadata + edit on re-tap', () => {
  test('logged dose surfaces a summary line on the card after submit', async ({ page, sandboxState }) => {
    const m = manifest();
    await seed(page.request, sandboxState.baseUrl, m);

    await page.goto('/');
    const card = page.locator(`[data-card-id="${CARD_ID}"] eh-schedule-card`);
    await expect(card).toBeVisible({ timeout: 10_000 });

    await card.locator('.checkbox').first().click();
    const form = card.locator('.checkoff-form');
    const innerForm = form.locator('eh-input-form');
    const chipRows = innerForm.locator('.chip-row');

    // Submit with site fields + a chips-multi reaction.
    await chipRows.nth(0).locator('.chip', { hasText: 'bruised' }).click();
    await chipRows.nth(1).locator('.chip', { hasText: 'left' }).click();
    await chipRows.nth(2).locator('.chip', { hasText: 'thigh' }).click();
    await chipRows.nth(3).locator('.chip', { hasText: 'upper' }).click();
    await innerForm.getByRole('button', { name: /log dose/i }).click();
    await expect(form).toHaveCount(0);

    // The card should now show a summary line carrying the new-dose
    // site fields. The chips-multi `bruised` reaction sits on the
    // PREVIOUS dose (per the merge behaviour) so it surfaces on the
    // card's last-completed-dose line for that prior dose, not on
    // today's summary. Today's summary is current-fields only.
    const summary = card.locator('.dose-summary').first();
    await expect(summary).toBeVisible();
    await expect(summary).toContainText('left thigh upper');

    await cleanup(page.request, sandboxState.baseUrl, CARD_ID);
  });

  test('re-tapping the ✓ on a logged dose pre-fills the form for editing', async ({ page, sandboxState }) => {
    const m = manifest();
    await seed(page.request, sandboxState.baseUrl, m);

    await page.goto('/');
    const card = page.locator(`[data-card-id="${CARD_ID}"] eh-schedule-card`);
    await expect(card).toBeVisible({ timeout: 10_000 });

    // First submit: log "left thigh upper".
    await card.locator('.checkbox').first().click();
    let form = card.locator('.checkoff-form');
    let innerForm = form.locator('eh-input-form');
    let chipRows = innerForm.locator('.chip-row');
    await chipRows.nth(1).locator('.chip', { hasText: 'left' }).click();
    await chipRows.nth(2).locator('.chip', { hasText: 'thigh' }).click();
    await chipRows.nth(3).locator('.chip', { hasText: 'upper' }).click();
    await innerForm.getByRole('button', { name: /log dose/i }).click();
    await expect(form).toHaveCount(0);

    // Re-tap the now-checked checkbox to UNTICK first (immediate save,
    // no form), then tap again to expand the form for editing. The
    // dose entry persists on disk through the untick (just takenAt
    // cleared), so the prefill should kick in.
    await card.locator('.checkbox').first().click(); // untick
    await card.locator('.checkbox').first().click(); // re-tick → form opens

    form = card.locator('.checkoff-form');
    await expect(form).toBeVisible();
    innerForm = form.locator('eh-input-form');
    chipRows = innerForm.locator('.chip-row');

    // The site chips should be pre-selected from the previous submit.
    await expect(chipRows.nth(1).locator('.chip.selected', { hasText: 'left' })).toBeVisible();
    await expect(chipRows.nth(2).locator('.chip.selected', { hasText: 'thigh' })).toBeVisible();
    await expect(chipRows.nth(3).locator('.chip.selected', { hasText: 'upper' })).toBeVisible();

    // Edit: clear `left` (tap to deselect), pick `right` instead.
    await chipRows.nth(1).locator('.chip.selected', { hasText: 'left' }).click();
    await chipRows.nth(1).locator('.chip', { hasText: 'right' }).click();
    await innerForm.getByRole('button', { name: /log dose/i }).click();

    // The data file should reflect the edit, not stack a second dose.
    const res = await page.request.get(`${sandboxState.baseUrl}/api/manifests/${CARD_ID}/data`);
    const body = await res.json();
    const doses = body.data.items[0].doses;
    // The seed had 1 prior dose; we logged 1 today; total 2. The edit
    // replaces in place, doesn't append.
    expect(doses.length).toBe(2);
    expect(doses[1].site_side).toBe('right');
    expect(doses[1].site_region).toBe('thigh');
    expect(doses[1].site_position).toBe('upper');

    await cleanup(page.request, sandboxState.baseUrl, CARD_ID);
  });

  test('reactions:["none"] is filtered from the on-card summary', async ({ page, sandboxState }) => {
    // Seed a manifest where the prior dose ALREADY has both site
    // fields and reactions:["none"]. The card's summary line for that
    // prior dose's date should show site only — no `· none` suffix.
    const today = todayISO();
    const priorDate = shiftDays(today, -3);
    const startDate = shiftDays(today, -10);
    const m = {
      $schema: 'klebb.datafile.v1',
      meta: {
        id: CARD_ID,
        label: 'Chips none filtering (e2e)',
        emoji: '💉',
        order: 9201,
        category: 'protocols',
        view: {
          enabled: true,
          component: 'schedule-card',
          checkOffForm: {
            currentDoseFields: ['site_side', 'site_region', 'site_position'],
            previousDoseFields: ['reactions'],
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
              options: ['belly', 'flank', 'thigh', 'delt'] },
            { key: 'site_position', label: 'Position', type: 'chips',
              options: ['upper', 'middle', 'lower'] },
            { key: 'reactions',     label: 'Reactions', type: 'chips-multi',
              options: ['none', 'bruised', 'red', 'swollen', 'itchy'] },
          ],
        },
      },
      description: 'Reactions:["none"] visibility test (#354).',
      data: {
        items: [
          {
            name: 'Test',
            short_name: 'T',
            schedule: { type: 'daily', start_date: startDate, cycle_weeks: 4 },
            doses: [
              {
                scheduledDate: priorDate,
                takenAt: `${priorDate}T08:00:00Z`,
                site_side: 'left',
                site_region: 'thigh',
                site_position: 'upper',
                reactions: ['none'],
              },
            ],
          },
        ],
      },
    };
    await seed(page.request, sandboxState.baseUrl, m);

    await page.goto('/');
    const card = page.locator(`[data-card-id="${CARD_ID}"] eh-schedule-card`);
    await expect(card).toBeVisible({ timeout: 10_000 });

    // Step back to the prior date so the card surfaces THAT day's dose.
    // Use the date-view's prev-date affordance — three taps back.
    for (let i = 0; i < 3; i++) {
      await page.locator('eh-date-view button[aria-label*="previous"], eh-date-view button[aria-label*="Previous"]').first().click();
    }

    const summary = card.locator('.dose-summary').first();
    await expect(summary).toBeVisible();
    await expect(summary).toContainText('left thigh upper');
    // Crucially, NO " · none" suffix from reactions:["none"].
    await expect(summary).not.toContainText('none');

    await cleanup(page.request, sandboxState.baseUrl, CARD_ID);
  });
});

test.describe('#359: previous-dose section is visually separated from new-dose fields', () => {
  test('form renders a divider after reactions, panel wraps the prev-dose context', async ({ page, sandboxState }) => {
    const m = manifest();
    await seed(page.request, sandboxState.baseUrl, m);

    await page.goto('/');
    const card = page.locator(`[data-card-id="${CARD_ID}"] eh-schedule-card`);
    await expect(card).toBeVisible({ timeout: 10_000 });

    await card.locator('.checkbox').first().click();
    const form = card.locator('.checkoff-form');
    await expect(form).toBeVisible();

    // The "Last:" panel exists and is rendered as a discrete block
    // (the renderer wraps it in .prev-dose).
    const prevDose = form.locator('.prev-dose');
    await expect(prevDose).toBeVisible();
    await expect(prevDose).toContainText('Last:');
    // The panel should NOT carry the old dashed bottom border. Sanity
    // check that the new tinted background is set instead. The
    // browser will resolve the var to whichever theme is active; we
    // just need to confirm a non-transparent background was applied.
    const bg = await prevDose.evaluate(el => getComputedStyle(el).backgroundColor);
    expect(bg).not.toBe('rgba(0, 0, 0, 0)');
    expect(bg).not.toBe('transparent');

    // The form-divider <hr> renders inside eh-input-form. Its
    // position relative to the chip-rows is what we care about: it
    // should sit AFTER the reactions chip-row (index 0 — see the
    // existing #354 test for the order of chipRows) and BEFORE
    // site_side, site_region, site_position.
    const innerForm = form.locator('eh-input-form');
    // Build flat lists of all chip-row + divider elements in DOM
    // order, then assert the divider falls between row 0 and row 1.
    const orderedSelectors = await innerForm.evaluate((root) => {
      const sr = root.shadowRoot;
      if (!sr) return [];
      // The form's render uses .field wrappers + hr.form-divider +
      // .form-section-label (the optional new-dose heading).
      const els = Array.from(sr.querySelectorAll('.field, hr.form-divider, .form-section-label'));
      return els.map(el => {
        if (el.tagName === 'HR') return 'divider';
        if (el.classList.contains('form-section-label')) return 'heading:' + el.textContent.trim();
        const label = el.querySelector('label');
        return label ? label.textContent.trim() : '(no-label)';
      });
    });
    // Expected order: Reactions, divider, heading, Side, Region, Position.
    // Stripping the trailing " *" required marker (none of our chips
    // are required, so this is a no-op, but defensive).
    const cleaned = orderedSelectors.map(s => s.replace(/\s*\*\s*$/, ''));
    const reactionsIdx = cleaned.indexOf('Reactions');
    const dividerIdx = cleaned.indexOf('divider');
    const headingIdx = cleaned.findIndex(s => s.startsWith('heading:'));
    const sideIdx = cleaned.indexOf('Side');
    expect(reactionsIdx).toBeGreaterThanOrEqual(0);
    expect(dividerIdx).toBe(reactionsIdx + 1);
    // The heading sits between the divider and the first new-dose
    // field. The default fallback when currentDosePrompt is unset is
    // "This dose"; the seed manifest in this spec does NOT set it,
    // so we expect the fallback.
    expect(headingIdx).toBe(dividerIdx + 1);
    expect(cleaned[headingIdx]).toBe('heading:This dose');
    expect(sideIdx).toBe(headingIdx + 1);

    await cleanup(page.request, sandboxState.baseUrl, CARD_ID);
  });
});

test.describe('#361: new-dose section is labelled by currentDosePrompt', () => {
  test('manifest currentDosePrompt overrides the "This dose" fallback', async ({ page, sandboxState }) => {
    // Seed a variant with currentDosePrompt set explicitly.
    const today = todayISO();
    const startDate = shiftDays(today, -10);
    const priorDoseDate = shiftDays(today, -3);
    const m = {
      $schema: 'klebb.datafile.v1',
      meta: {
        id: CARD_ID,
        label: 'Peptide check-off (e2e)',
        emoji: '💉',
        order: 9202,
        category: 'protocols',
        view: {
          enabled: true,
          component: 'schedule-card',
          checkOffForm: {
            currentDoseFields: ['site_side', 'site_region', 'site_position'],
            previousDoseFields: ['reactions'],
            previousDosePrompt: 'How does the last injection site look?',
            currentDosePrompt: 'This injection',
          },
        },
        writeable: {
          fromWebapp: true, todayAllowed: true, pastAllowed: true, futureAllowed: false,
          inputs: [
            { key: 'site_side',     label: 'Side',     type: 'chips',
              options: ['left', 'right', 'centre'] },
            { key: 'site_region',   label: 'Region',   type: 'chips',
              options: ['belly', 'flank', 'thigh'] },
            { key: 'site_position', label: 'Position', type: 'chips',
              options: ['upper', 'middle', 'lower'] },
            { key: 'reactions',     label: 'Reactions', type: 'chips-multi',
              options: ['bruised', 'red', 'itchy'] },
          ],
        },
      },
      description: 'currentDosePrompt visibility test (#361).',
      data: {
        items: [
          {
            name: 'TestPeptide-361',
            schedule: { type: 'daily', start_date: startDate, cycle_weeks: 4 },
            doses: [
              {
                scheduledDate: priorDoseDate,
                takenAt: `${priorDoseDate}T08:00:00Z`,
                site_side: 'right', site_region: 'belly', site_position: 'upper',
              },
            ],
          },
        ],
      },
    };
    await seed(page.request, sandboxState.baseUrl, m);

    await page.goto('/');
    const card = page.locator(`[data-card-id="${CARD_ID}"] eh-schedule-card`);
    await expect(card).toBeVisible({ timeout: 10_000 });

    await card.locator('.checkbox').first().click();
    const innerForm = card.locator('.checkoff-form eh-input-form');
    await expect(innerForm).toBeVisible();

    // Read the rendered heading text from inside the shadow root.
    const heading = await innerForm.evaluate(root => {
      const el = root.shadowRoot && root.shadowRoot.querySelector('.form-section-label');
      return el ? el.textContent.trim() : null;
    });
    expect(heading).toBe('This injection');

    await cleanup(page.request, sandboxState.baseUrl, CARD_ID);
  });
});
