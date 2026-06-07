// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests-e2e/generic-card-multi-entry.spec.js
// Regression for #336: a generic-card manifest with
// `meta.writeable.maxReadingsPerDay > 1` could only show one entry per
// day. The save path correctly appended (capped at the max), but the
// display path returned the first matching row only and the UI had no
// per-row edit/delete affordances. This spec drives the multi-entry
// flow end-to-end.

const { test, expect } = require('./helpers/auth-fixture');

const STOOL_LOG_ID = 'stool-log-multi-e2e';

function stoolLogManifest(today) {
  return {
    $schema: 'klebb.datafile.v1',
    meta: {
      id: STOOL_LOG_ID,
      label: 'Stool Log (multi e2e)',
      emoji: '🚽',
      order: 9200,
      category: 'lifestyle',
      view: {
        enabled: true,
        component: 'generic-card',
        display: {
          template: '{bristolType} at {time}',
          emptyHeadline: 'No entries yet',
        },
      },
      writeable: {
        fromWebapp: true,
        todayAllowed: true,
        pastAllowed: true,
        futureAllowed: false,
        maxReadingsPerDay: 99,
        inputs: [
          { key: 'time', label: 'Time', type: 'time' },
          {
            key: 'bristolType',
            label: 'Bristol Type',
            type: 'select',
            options: [
              '1 - Hard lumps',
              '4 - Smooth sausage',
              '7 - Watery',
            ],
            required: true,
          },
          { key: 'notes', label: 'Notes', type: 'textarea' },
        ],
      },
    },
    description: 'Generic-card with maxReadingsPerDay > 1, for the #336 regression.',
    data: [
      { date: today, time: '07:30', bristolType: '4 - Smooth sausage', notes: '' },
      { date: today, time: '14:15', bristolType: '1 - Hard lumps', notes: 'busy day' },
    ],
  };
}

function todayISO() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

async function seed(request, baseUrl, manifest) {
  await request.delete(`${baseUrl}/api/manifests/${manifest.meta.id}`).catch(() => {});
  const r = await request.post(`${baseUrl}/api/manifests`, { data: manifest });
  expect([201, 409]).toContain(r.status());
}

async function cleanup(request, baseUrl, id) {
  await request.delete(`${baseUrl}/api/manifests/${id}`).catch(() => {});
}

test.describe('#336: generic-card with maxReadingsPerDay > 1 renders every row for the day', () => {
  test('shows both seeded rows, with edit + delete + add affordances', async ({ page, sandboxState }) => {
    const today = todayISO();
    await seed(page.request, sandboxState.baseUrl, stoolLogManifest(today));

    await page.goto('/');
    await expect(page.locator('eh-date-view')).toBeVisible({ timeout: 10_000 });

    const card = page.locator(`[data-card-id="${STOOL_LOG_ID}"] eh-generic-card`);
    await expect(card).toBeVisible({ timeout: 10_000 });

    // Both seeded rows render; before the fix only one would appear.
    const rows = card.locator('.gen-list-row');
    await expect(rows).toHaveCount(2);
    await expect(card).toContainText('07:30');
    await expect(card).toContainText('14:15');
    await expect(card).toContainText('4 - Smooth sausage');
    await expect(card).toContainText('1 - Hard lumps');

    // Per-row edit + delete buttons exist.
    await expect(card.locator('button[aria-label="Edit entry"]')).toHaveCount(2);
    await expect(card.locator('button[aria-label="Delete entry"]')).toHaveCount(2);

    // Add control is always visible alongside the list.
    await expect(card.locator('button[aria-label="Add entry"]')).toBeVisible();

    await cleanup(page.request, sandboxState.baseUrl, STOOL_LOG_ID);
  });

  test('Add appends a third row without overwriting the existing two', async ({ page, sandboxState }) => {
    const today = todayISO();
    await seed(page.request, sandboxState.baseUrl, stoolLogManifest(today));

    await page.goto('/');
    await expect(page.locator('eh-date-view')).toBeVisible({ timeout: 10_000 });

    const card = page.locator(`[data-card-id="${STOOL_LOG_ID}"] eh-generic-card`);
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card.locator('.gen-list-row')).toHaveCount(2);

    await card.locator('button[aria-label="Add entry"]').click();
    const form = card.locator('eh-input-form');
    await expect(form).toBeVisible();

    await form.locator('input[type="time"]').fill('20:00');
    await form.locator('select').selectOption('7 - Watery');
    await form.locator('button[type="submit"]').click();

    await expect(card.locator('.gen-list-row')).toHaveCount(3);
    await expect(card).toContainText('20:00');
    await expect(card).toContainText('7 - Watery');
    // Earlier entries still there.
    await expect(card).toContainText('07:30');
    await expect(card).toContainText('14:15');

    await cleanup(page.request, sandboxState.baseUrl, STOOL_LOG_ID);
  });

  test('Delete removes a row in place', async ({ page, sandboxState }) => {
    const today = todayISO();
    await seed(page.request, sandboxState.baseUrl, stoolLogManifest(today));

    await page.goto('/');
    await expect(page.locator('eh-date-view')).toBeVisible({ timeout: 10_000 });

    const card = page.locator(`[data-card-id="${STOOL_LOG_ID}"] eh-generic-card`);
    await expect(card.locator('.gen-list-row')).toHaveCount(2);

    await card.locator('button[aria-label="Delete entry"]').first().click();

    await expect(card.locator('.gen-list-row')).toHaveCount(1);
    await expect(card).not.toContainText('07:30');
    await expect(card).toContainText('14:15');

    await cleanup(page.request, sandboxState.baseUrl, STOOL_LOG_ID);
  });
});
