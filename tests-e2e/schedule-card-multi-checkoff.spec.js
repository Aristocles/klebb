// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests-e2e/schedule-card-multi-checkoff.spec.js
// #705: meta.writeable.maxReadingsPerDay > 1 lets one scheduled item be
// checked off several times in a day. Each tap stacks a fresh
// {scheduledDate, takenAt} entry up to the cap (no-op at the cap); the
// checkbox never unticks in this mode, a ×N badge expands the day's
// entry list, and entries are removed individually. Cards without the
// flag keep the exact single-toggle behaviour.

const { test, expect } = require('./helpers/auth-fixture');

const MULTI_ID = 'e2e_multi_705';
const SINGLE_ID = 'e2e_single_705';
const CHECK_ID = 'e2e_multi_checklist_705';

function isoDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function scheduleCard(id, label, maxReadingsPerDay) {
  const writeable = { fromWebapp: true, todayAllowed: true };
  if (maxReadingsPerDay) writeable.maxReadingsPerDay = maxReadingsPerDay;
  return {
    $schema: 'klebb.datafile.v1',
    meta: {
      id, label,
      view: { enabled: true, component: 'schedule-card' },
      writeable,
    },
    description: 'Multi check-off fixture (#705).',
    data: {
      items: [{
        name: `Item-${id}`,
        dose_mg: 5,
        schedule: { type: 'daily', times_per_day: 1, start_date: isoDaysAgo(7), cycle_weeks: 4 },
        doses: [],
      }],
    },
  };
}

function checklistCard(id, label) {
  return {
    $schema: 'klebb.datafile.v1',
    meta: {
      id, label,
      view: { enabled: true, component: 'checklist-card' },
      writeable: { fromWebapp: true, todayAllowed: true, maxReadingsPerDay: 2 },
    },
    description: 'Multi check-off checklist fixture (#705).',
    data: {
      items: [{
        name: `Tick-${id}`,
        schedule: { type: 'daily', start_date: isoDaysAgo(7) },
        doses: [],
      }],
    },
  };
}

async function readDoses(request, baseUrl, id) {
  const res = await request.get(`${baseUrl}/api/manifests/${id}/data`);
  const body = await res.json();
  return body.data.items[0].doses;
}

async function seed(request, baseUrl, manifest) {
  await request.delete(`${baseUrl}/api/manifests/${manifest.meta.id}`).catch(() => {});
  const r = await request.post(`${baseUrl}/api/manifests`, { data: manifest });
  expect(r.status()).toBe(201);
}

test.describe('#705: multiple check-offs per day', () => {
  test('schedule-card stacks entries up to the cap, lists and removes them', async ({ page, sandboxState }) => {
    const baseUrl = sandboxState.baseUrl;
    await seed(page.request, baseUrl, scheduleCard(MULTI_ID, 'Multi 705', 2));

    try {
      await page.goto('/');
      const card = page.locator('eh-schedule-card', { hasText: 'Multi 705' });
      await expect(card).toBeVisible();
      const checkbox = card.locator('.checkbox').first();

      // First tap: one entry, badge ×1.
      await checkbox.click();
      await expect(card.locator('.multi-count')).toHaveText('×1');
      let doses = await readDoses(page.request, baseUrl, MULTI_ID);
      expect(doses.length).toBe(1);
      expect(doses[0].takenAt).toBeTruthy();

      // Second tap stacks a second entry with its own timestamp.
      await checkbox.click();
      await expect(card.locator('.multi-count')).toHaveText('×2');
      doses = await readDoses(page.request, baseUrl, MULTI_ID);
      expect(doses.length).toBe(2);
      expect(doses[1].takenAt).toBeTruthy();
      expect(doses[1].takenAt).not.toBe(doses[0].takenAt);

      // Third tap is a no-op at the cap: never silently drops a record.
      await checkbox.click();
      await page.waitForTimeout(400);
      doses = await readDoses(page.request, baseUrl, MULTI_ID);
      expect(doses.length).toBe(2);

      // The badge expands the day's entries; removing the FIRST removes
      // exactly that one: the second entry's timestamp must survive.
      const secondTakenAt = doses[1].takenAt;
      await card.locator('.multi-count').click();
      await expect(card.locator('.day-entry')).toHaveCount(2);
      await card.locator('.day-entry .entry-remove').first().click();
      await expect(card.locator('.multi-count')).toHaveText('×1');
      doses = await readDoses(page.request, baseUrl, MULTI_ID);
      expect(doses.length).toBe(1);
      expect(doses[0].takenAt).toBe(secondTakenAt);
    } finally {
      await page.request.delete(`${baseUrl}/api/manifests/${MULTI_ID}`);
    }
  });

  test('a card without the flag keeps the single-toggle round trip', async ({ page, sandboxState }) => {
    const baseUrl = sandboxState.baseUrl;
    await seed(page.request, baseUrl, scheduleCard(SINGLE_ID, 'Single 705', null));

    try {
      await page.goto('/');
      const card = page.locator('eh-schedule-card', { hasText: 'Single 705' });
      await expect(card).toBeVisible();
      const checkbox = card.locator('.checkbox').first();

      await checkbox.click();
      await expect(checkbox).toHaveClass(/checked/);
      let doses = await readDoses(page.request, baseUrl, SINGLE_ID);
      expect(doses.length).toBe(1);
      await expect(card.locator('.multi-count')).toHaveCount(0);

      // Untick clears takenAt in place, exactly as before.
      await checkbox.click();
      await expect(checkbox).not.toHaveClass(/checked/);
      doses = await readDoses(page.request, baseUrl, SINGLE_ID);
      expect(doses.length).toBe(1);
      expect(doses[0].takenAt).toBe(null);
    } finally {
      await page.request.delete(`${baseUrl}/api/manifests/${SINGLE_ID}`);
    }
  });

  test('checklist-card doses shape stacks and removes entries too', async ({ page, sandboxState }) => {
    const baseUrl = sandboxState.baseUrl;
    await seed(page.request, baseUrl, checklistCard(CHECK_ID, 'Multi Checklist 705'));

    try {
      await page.goto('/');
      const card = page.locator('eh-checklist-card', { hasText: 'Multi Checklist 705' });
      await expect(card).toBeVisible();
      const checkbox = card.locator('.checkbox').first();

      await checkbox.click();
      await expect(card.locator('.multi-count')).toHaveText('×1');
      await checkbox.click();
      await expect(card.locator('.multi-count')).toHaveText('×2');
      let doses = await readDoses(page.request, baseUrl, CHECK_ID);
      expect(doses.length).toBe(2);

      const secondTakenAt = doses[1].takenAt;
      await card.locator('.multi-count').click();
      await expect(card.locator('.day-entry')).toHaveCount(2);
      await card.locator('.day-entry .entry-remove').first().click();
      await expect(card.locator('.multi-count')).toHaveText('×1');
      doses = await readDoses(page.request, baseUrl, CHECK_ID);
      expect(doses.length).toBe(1);
      expect(doses[0].takenAt).toBe(secondTakenAt);
    } finally {
      await page.request.delete(`${baseUrl}/api/manifests/${CHECK_ID}`);
    }
  });

  test('checkOffForm x multi: blank under cap, same-day review, in-place edit at cap', async ({ page, sandboxState }) => {
    const baseUrl = sandboxState.baseUrl;
    const FORM_ID = 'e2e_multi_form_705';
    await seed(page.request, baseUrl, {
      $schema: 'klebb.datafile.v1',
      meta: {
        id: FORM_ID,
        label: 'Form Multi 705',
        view: {
          enabled: true,
          component: 'schedule-card',
          checkOffForm: { currentDoseFields: ['site_side'], previousDoseFields: ['reactions'] },
        },
        writeable: {
          fromWebapp: true,
          todayAllowed: true,
          maxReadingsPerDay: 2,
          inputs: [
            { key: 'site_side', label: 'Side', type: 'chips', options: ['left', 'right', 'centre'] },
            { key: 'reactions', label: 'Reactions', type: 'chips-multi', options: ['bruised', 'red'] },
          ],
        },
      },
      description: 'checkOffForm x multi fixture (#705).',
      data: {
        items: [{
          name: 'FormItem-705',
          dose_mg: 1,
          schedule: { type: 'daily', times_per_day: 1, start_date: isoDaysAgo(7), cycle_weeks: 4 },
          doses: [],
        }],
      },
    });

    try {
      await page.goto('/');
      const card = page.locator('eh-schedule-card', { hasText: 'Form Multi 705' });
      await expect(card).toBeVisible();
      const checkbox = card.locator('.checkbox').first();
      const form = card.locator('.checkoff-form');

      // First tap: no previous dose exists, so only the current field
      // renders. Log the first entry.
      await checkbox.click();
      await expect(form).toBeVisible();
      await form.locator('.chip', { hasText: 'left' }).click();
      await form.locator('eh-input-form').getByRole('button', { name: /log dose/i }).first().click();
      await expect(form).toHaveCount(0);
      let doses = await readDoses(page.request, baseUrl, FORM_ID);
      expect(doses.length).toBe(1);
      expect(doses[0].site_side).toBe('left');
      const firstTakenAt = doses[0].takenAt;

      // Second tap, under the cap: the form opens BLANK (logging another
      // entry, not editing), and the previous-dose review targets the
      // SAME-DAY earlier entry.
      await checkbox.click();
      await expect(form).toBeVisible();
      await expect(form.locator('.chip.selected')).toHaveCount(0);
      await expect(form.locator('.prev-dose-summary')).toContainText('left');
      await form.locator('.chip', { hasText: 'right' }).click();
      // Typed input must survive unrelated state changes beside the open
      // form: toggling the entries badge used to reset it.
      await card.locator('.multi-count').click();
      await card.locator('.multi-count').click();
      await expect(form.locator('.chip.selected', { hasText: 'right' })).toBeVisible();
      await form.locator('.chip', { hasText: 'bruised' }).click();
      await form.locator('eh-input-form').getByRole('button', { name: /log dose/i }).first().click();
      await expect(form).toHaveCount(0);
      doses = await readDoses(page.request, baseUrl, FORM_ID);
      expect(doses.length).toBe(2);
      expect(doses[1].site_side).toBe('right');
      expect(doses[1].takenAt).not.toBe(firstTakenAt);
      expect(doses[0].reactions).toEqual(['bruised']);
      const secondTakenAt = doses[1].takenAt;

      // Third tap, at the cap: the form opens PREFILLED from the latest
      // entry and Submit edits it in place, keeping its original takenAt.
      await checkbox.click();
      await expect(form).toBeVisible();
      await expect(form.locator('.chip.selected', { hasText: 'right' })).toBeVisible();
      await form.locator('.chip.selected', { hasText: 'right' }).click();
      await form.locator('.chip', { hasText: 'centre' }).click();
      await form.locator('eh-input-form').getByRole('button', { name: /log dose/i }).first().click();
      await expect(form).toHaveCount(0);
      doses = await readDoses(page.request, baseUrl, FORM_ID);
      expect(doses.length).toBe(2);
      expect(doses[1].site_side).toBe('centre');
      expect(doses[1].takenAt).toBe(secondTakenAt);
    } finally {
      await page.request.delete(`${baseUrl}/api/manifests/${FORM_ID}`);
    }
  });

  test('single mode: duplicate taken entries read as done and untick clears them all', async ({ page, sandboxState }) => {
    const baseUrl = sandboxState.baseUrl;
    const DUP_ID = 'e2e_dup_705';
    const localToday = new Date().toLocaleDateString('en-CA');
    await seed(page.request, baseUrl, {
      $schema: 'klebb.datafile.v1',
      meta: {
        id: DUP_ID,
        label: 'Dup 705',
        view: { enabled: true, component: 'schedule-card' },
        writeable: { fromWebapp: true, todayAllowed: true },
      },
      description: 'Duplicate same-day entries fixture (#705).',
      data: {
        items: [{
          name: 'DupItem-705',
          dose_mg: 2,
          schedule: { type: 'daily', times_per_day: 1, start_date: isoDaysAgo(7), cycle_weeks: 4 },
          // An unticked placeholder FOLLOWED by a taken entry: find-first
          // readers used to call this not-taken; chat- or import-written
          // duplicates make it reachable in single mode.
          doses: [
            { scheduledDate: localToday, takenAt: null },
            { scheduledDate: localToday, takenAt: `${localToday}T08:00:00.000Z` },
          ],
        }],
      },
    });

    try {
      await page.goto('/');
      const card = page.locator('eh-schedule-card', { hasText: 'Dup 705' });
      await expect(card).toBeVisible();
      const checkbox = card.locator('.checkbox').first();
      await expect(checkbox).toHaveClass(/checked/);

      // One untick clears EVERY same-date taken entry, so the checkbox
      // actually unchecks instead of silently flipping the first entry.
      await checkbox.click();
      await expect(checkbox).not.toHaveClass(/checked/);
      const doses = await readDoses(page.request, baseUrl, DUP_ID);
      expect(doses.length).toBe(2);
      expect(doses.every(d => d.takenAt === null)).toBe(true);
    } finally {
      await page.request.delete(`${baseUrl}/api/manifests/${DUP_ID}`);
    }
  });
});
