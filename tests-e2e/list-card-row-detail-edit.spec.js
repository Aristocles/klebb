// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests-e2e/list-card-row-detail-edit.spec.js
// Regression for #317: opening a list-card row's inline detail form in
// edit mode crashed the renderer with "Render failed: Can't find
// variable: display". The bug was a bare `display` reference in
// _renderEditMode (the variable was only computed in renderCard /
// _renderViewMode). It fired any time a list-card had secondary
// fields and the user tapped the per-row `…` (more) button.

const { test, expect } = require('./helpers/auth-fixture');

const FOOD_LOG_ID = 'food-log-e2e';

function foodLogManifest() {
  return {
    $schema: 'klebb.datafile.v1',
    meta: {
      id: FOOD_LOG_ID,
      label: 'Food Log (e2e)',
      emoji: '📝',
      order: 9000,
      category: 'lifestyle',
      view: {
        enabled: true,
        component: 'list-card',
        display: {
          primaryField: 'notes',
          emptyMessage: 'No food entries today.',
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
            key: 'meal',
            label: 'Meal',
            type: 'select',
            options: ['Breakfast', 'Lunch', 'Dinner', 'Snack'],
            required: true,
          },
          {
            key: 'notes',
            label: 'What did you eat?',
            type: 'textarea',
            required: true,
          },
        ],
      },
    },
    description: 'List-card with secondary fields, for the #317 regression.',
    data: [
      { added: '2026-04-01T08:00:00Z', time: '08:00', meal: 'Breakfast', notes: 'Oats with banana' },
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

test.describe('#317: list-card row detail form does not crash on open', () => {
  test('tapping the per-row `…` button in edit mode does not throw', async ({ page, sandboxState }) => {
    await seed(page.request, sandboxState.baseUrl, foodLogManifest());

    await page.goto('/');
    await expect(page.locator('eh-date-view')).toBeVisible({ timeout: 10_000 });

    const card = page.locator(`[data-card-id="${FOOD_LOG_ID}"] eh-list-card`);
    await expect(card).toBeVisible({ timeout: 10_000 });

    // Enter edit mode via the pencil tool-btn.
    await card.locator('button[aria-label="Edit list"]').click();

    // The seed row should now show a per-row `…` button (it's only
    // rendered when there are secondary fields).
    const detailBtn = card.locator('button[aria-label*="Edit extra fields"]').first();
    await expect(detailBtn).toBeVisible();

    await detailBtn.click();

    // Before the fix, _renderEditMode crashed with
    // "Render failed: Can't find variable: display" and the card body
    // was replaced with that string. Assert no such placeholder.
    await expect(card.locator('.error-placeholder')).toHaveCount(0);
    await expect(card).not.toContainText("Can't find variable");
    await expect(card).not.toContainText('Render failed');

    // The inline form should have rendered.
    await expect(card.locator('eh-input-form')).toBeVisible();

    await cleanup(page.request, sandboxState.baseUrl, FOOD_LOG_ID);
  });
});
