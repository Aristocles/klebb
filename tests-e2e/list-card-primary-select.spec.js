// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests-e2e/list-card-primary-select.spec.js
// Regression for #332: list-card hardcoded the primary field to a
// text input, so a manifest declaring type:"select" on the primary
// rendered as an empty text box instead of a dropdown.

const { test, expect } = require('./helpers/auth-fixture');

const STOOL_LOG_ID = 'stool-log-e2e';

function stoolLogManifest() {
  return {
    $schema: 'klebb.datafile.v1',
    meta: {
      id: STOOL_LOG_ID,
      label: 'Stool Log (e2e)',
      emoji: '🚽',
      order: 9100,
      category: 'lifestyle',
      view: {
        enabled: true,
        component: 'list-card',
        display: {
          primaryField: 'bristolType',
          emptyMessage: 'No entries today.',
        },
      },
      writeable: {
        fromWebapp: true,
        todayAllowed: true,
        pastAllowed: true,
        futureAllowed: false,
        maxReadingsPerDay: 20,
        inputs: [
          { key: 'time', label: 'Time', type: 'time' },
          {
            key: 'bristolType',
            label: 'Bristol Type',
            type: 'select',
            options: [
              '1 - Hard lumps',
              '2 - Lumpy sausage',
              '3 - Cracked sausage',
              '4 - Smooth sausage',
              '5 - Soft blobs',
              '6 - Mushy',
              '7 - Watery',
            ],
            required: true,
          },
          { key: 'notes', label: 'Notes', type: 'textarea' },
        ],
      },
    },
    description: 'List-card with a select primary, for the #332 regression.',
    data: [
      { added: '2026-04-01T08:00:00Z', time: '08:00', bristolType: '4 - Smooth sausage', notes: '' },
    ],
  };
}

async function seed(request, baseUrl, manifest) {
  await request.delete(`${baseUrl}/api/manifests/${manifest.meta.id}`).catch(() => {});
  const r = await request.post(`${baseUrl}/api/manifests`, { data: manifest });
  expect([201, 409]).toContain(r.status());
}

async function cleanup(request, baseUrl, id) {
  await request.delete(`${baseUrl}/api/manifests/${id}`).catch(() => {});
}

test.describe('#332: list-card primary field honours its declared type', () => {
  test('a select primary renders a <select> in edit mode, not a text input', async ({ page, sandboxState }) => {
    await seed(page.request, sandboxState.baseUrl, stoolLogManifest());

    await page.goto('/');
    await expect(page.locator('eh-date-view')).toBeVisible({ timeout: 10_000 });

    const card = page.locator(`[data-card-id="${STOOL_LOG_ID}"] eh-list-card`);
    await expect(card).toBeVisible({ timeout: 10_000 });

    await card.locator('button[aria-label="Edit list"]').click();

    const primarySelect = card.locator('.row select.primary-input').first();
    await expect(primarySelect).toBeVisible();

    const optionCount = await primarySelect.locator('option').count();
    expect(optionCount).toBeGreaterThanOrEqual(7);

    await expect(card.locator('.row input.primary-input[type="text"]')).toHaveCount(0);

    await cleanup(page.request, sandboxState.baseUrl, STOOL_LOG_ID);
  });
});
