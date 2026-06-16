// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests-e2e/time-of-day-chips-trends-reports.spec.js
// Coverage for #401: time-of-day chips on the historical views,
// eh-schedule-timeline (Trends) and eh-adherence-report (Reports).
// Items with schedule.time_of_day get the canonical .tod-chip; items
// without it render with no chip.

const { test, expect } = require('./helpers/auth-fixture');

const CARD_ID = 'tod-chips-trends-reports-e2e';

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

function activeCycle(today) {
  return [{
    type: 'on',
    status: 'active',
    cycle_number: 1,
    start: shiftDays(today, -5),
    end: shiftDays(today, 25),
    start_date: shiftDays(today, -5),
    end_date: shiftDays(today, 25),
  }];
}

function manifestForViews(today) {
  return {
    $schema: 'klebb.datafile.v1',
    meta: {
      id: CARD_ID,
      label: 'Time-of-day historical chips (e2e)',
      emoji: '💉',
      order: 9710,
      category: 'protocols',
      view: { enabled: true, component: 'schedule-card' },
      trends: { enabled: true, component: 'schedule-timeline', itemsPath: 'items' },
      reports: { enabled: true, component: 'adherence-report' },
      writeable: { fromWebapp: true, todayAllowed: true, pastAllowed: true, futureAllowed: false },
    },
    description: 'Time-of-day chip rendering on historical views (#401).',
    data: {
      items: [
        {
          name: 'Morning-only',
          short_name: 'Morning-only',
          schedule: { type: 'daily', time_of_day: 'morning' },
          cycles: activeCycle(today),
        },
        {
          // Manifest order [evening, morning] exercises the canonical
          // slot-order sort: morning chip must appear FIRST regardless.
          name: 'Twice-daily',
          short_name: 'Twice-daily',
          schedule: { type: 'daily', time_of_day: ['evening', 'morning'] },
          cycles: activeCycle(today),
        },
        {
          name: 'No-tod',
          short_name: 'No-tod',
          schedule: { type: 'daily' },
          cycles: activeCycle(today),
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

function harvestChipsByCycleName(rendererTag) {
  return async (root) => {
    const sr = root.shadowRoot;
    if (!sr) return null;
    const blocks = Array.from(sr.querySelectorAll('.cycle-block, .cycle-row'));
    return blocks.map((block) => {
      const nameEl = block.querySelector('.cycle-name');
      const name = nameEl ? (nameEl.textContent || '').trim() : '';
      const chips = Array.from(block.querySelectorAll('.tod-chip')).map((c) => ({
        emoji: c.textContent.trim(),
        label: c.getAttribute('aria-label'),
        title: c.getAttribute('title'),
      }));
      return { name, chips };
    });
  };
}

test.describe('#401: time-of-day chips on Trends (eh-schedule-timeline)', () => {
  test('renders chips for items with time_of_day, none for items without', async ({ page, sandboxState }) => {
    const today = todayISO();
    const m = manifestForViews(today);
    await seed(page.request, sandboxState.baseUrl, m);

    await page.goto('/trends');
    await expect(page.locator('eh-trends-view')).toBeVisible({ timeout: 10_000 });

    const card = page.locator(`[data-card-id="${CARD_ID}"] eh-schedule-timeline`);
    await expect(card).toBeVisible({ timeout: 10_000 });

    const rows = await card.evaluate(harvestChipsByCycleName('eh-schedule-timeline'));
    expect(rows).not.toBeNull();

    // One cycle per item, three items.
    expect(rows.length).toBe(3);

    const morningOnly = rows.find((r) => r.name.startsWith('Morning-only'));
    const twiceDaily = rows.find((r) => r.name.startsWith('Twice-daily'));
    const noTod = rows.find((r) => r.name.startsWith('No-tod'));

    expect(morningOnly).toBeTruthy();
    expect(morningOnly.chips).toEqual([
      { emoji: '☀️', label: 'Morning', title: 'Morning' },
    ]);

    expect(twiceDaily).toBeTruthy();
    // Manifest array is ['evening', 'morning']; chipsFor sorts to canonical
    // slot order so morning comes first.
    expect(twiceDaily.chips.length).toBe(2);
    expect(twiceDaily.chips[0]).toEqual({ emoji: '☀️', label: 'Morning', title: 'Morning' });
    expect(twiceDaily.chips[1]).toEqual({ emoji: '🌙', label: 'Evening', title: 'Evening' });

    expect(noTod).toBeTruthy();
    expect(noTod.chips).toEqual([]);

    await cleanup(page.request, sandboxState.baseUrl, CARD_ID);
  });
});

test.describe('#401: time-of-day chips on Reports (eh-adherence-report)', () => {
  test('renders chips for items with time_of_day, none for items without', async ({ page, sandboxState }) => {
    const today = todayISO();
    const m = manifestForViews(today);
    await seed(page.request, sandboxState.baseUrl, m);

    await page.goto('/reports');
    await expect(page.locator('eh-reports-view')).toBeVisible({ timeout: 10_000 });

    const card = page.locator(`[data-card-id="${CARD_ID}"] eh-adherence-report`);
    await expect(card).toBeVisible({ timeout: 10_000 });

    const rows = await card.evaluate(harvestChipsByCycleName('eh-adherence-report'));
    expect(rows).not.toBeNull();

    // One cycle per item, three items.
    expect(rows.length).toBe(3);

    const morningOnly = rows.find((r) => r.name.startsWith('Morning-only'));
    const twiceDaily = rows.find((r) => r.name.startsWith('Twice-daily'));
    const noTod = rows.find((r) => r.name.startsWith('No-tod'));

    expect(morningOnly).toBeTruthy();
    expect(morningOnly.chips).toEqual([
      { emoji: '☀️', label: 'Morning', title: 'Morning' },
    ]);

    expect(twiceDaily).toBeTruthy();
    expect(twiceDaily.chips.length).toBe(2);
    expect(twiceDaily.chips[0]).toEqual({ emoji: '☀️', label: 'Morning', title: 'Morning' });
    expect(twiceDaily.chips[1]).toEqual({ emoji: '🌙', label: 'Evening', title: 'Evening' });

    expect(noTod).toBeTruthy();
    expect(noTod.chips).toEqual([]);

    await cleanup(page.request, sandboxState.baseUrl, CARD_ID);
  });
});
