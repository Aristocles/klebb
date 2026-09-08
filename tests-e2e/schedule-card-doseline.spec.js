// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests-e2e/schedule-card-doseline.spec.js
// #706: meta.view.doseLine controls when the per-item dose text renders.
// 'scheduled' (default) keeps the pre-#706 behaviour: dose text on
// scheduled days only; 'always' surfaces it on rest-day rows too;
// 'never' suppresses it; an unrecognised value behaves as the default.

const { test, expect } = require('./helpers/auth-fixture');

const ID = 'e2e_doseline_706';
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function isoDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function manifest() {
  const notToday = DAY_NAMES[(new Date().getDay() + 3) % 7];
  return {
    $schema: 'klebb.datafile.v1',
    meta: {
      id: ID,
      label: 'Dose Line 706',
      view: { enabled: true, component: 'schedule-card' },
      writeable: { fromWebapp: true, todayAllowed: true },
    },
    description: 'Fixture for the doseLine view option (#706).',
    data: {
      items: [
        {
          name: 'DailyItem-706',
          dose_mg: 5,
          schedule: { type: 'daily', times_per_day: 1, start_date: isoDaysAgo(7), cycle_weeks: 4 },
          doses: [],
        },
        {
          name: 'RestItem-706',
          dose_mg: 9,
          schedule: { type: 'weekly', on_days: [notToday], start_date: isoDaysAgo(7) },
          doses: [],
        },
      ],
    },
  };
}

async function setDoseLine(request, baseUrl, value) {
  const r = await request.fetch(`${baseUrl}/api/manifests/${ID}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    data: { meta: { view: { enabled: true, component: 'schedule-card', doseLine: value } } },
  });
  expect(r.status()).toBe(200);
}

function rows(page) {
  const card = page.locator('eh-schedule-card', { hasText: 'Dose Line 706' });
  return {
    card,
    daily: card.locator('.item-row', { hasText: 'DailyItem-706' }),
    rest: card.locator('.item-row', { hasText: 'RestItem-706' }),
  };
}

test.describe('#706: meta.view.doseLine', () => {
  test('scheduled default, always, never, and typo fallback', async ({ page, sandboxState }) => {
    const baseUrl = sandboxState.baseUrl;
    await page.request.delete(`${baseUrl}/api/manifests/${ID}`).catch(() => {});
    const mk = await page.request.post(`${baseUrl}/api/manifests`, { data: manifest() });
    expect(mk.status()).toBe(201);

    try {
      // Default (no doseLine): dose on the scheduled row only.
      await page.goto('/');
      let r = rows(page);
      await expect(r.card).toBeVisible();
      await expect(r.rest).toContainText('Rest day');
      await expect(r.daily.locator('.dose')).toHaveText(/5mg/);
      await expect(r.rest.locator('.dose')).toHaveCount(0);

      // always: the rest-day row shows its dose too.
      await setDoseLine(page.request, baseUrl, 'always');
      await page.goto('/');
      r = rows(page);
      await expect(r.rest.locator('.dose')).toHaveText(/9mg/);
      await expect(r.daily.locator('.dose')).toHaveText(/5mg/);

      // never: no dose text even on the scheduled row.
      await setDoseLine(page.request, baseUrl, 'never');
      await page.goto('/');
      r = rows(page);
      await expect(r.card).toBeVisible();
      await expect(r.daily.locator('.dose')).toHaveCount(0);
      await expect(r.rest.locator('.dose')).toHaveCount(0);

      // Unrecognised value: behaves exactly like the default.
      await setDoseLine(page.request, baseUrl, 'sometimes');
      await page.goto('/');
      r = rows(page);
      await expect(r.daily.locator('.dose')).toHaveText(/5mg/);
      await expect(r.rest.locator('.dose')).toHaveCount(0);
    } finally {
      await page.request.delete(`${baseUrl}/api/manifests/${ID}`);
    }
  });
});
