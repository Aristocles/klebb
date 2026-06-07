// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests-e2e/chips-input-types.spec.js
// Coverage for #344: chips (single-select) and chips-multi (multi-select)
// input types in eh-input-form. Seeds a list-card whose secondary fields
// include one of each chip type, opens the per-row detail form, taps
// chips, applies, saves, and asserts the on-disk shape.

const { test, expect } = require('./helpers/auth-fixture');

const CARD_ID = 'chips-e2e';

function chipsManifest() {
  return {
    $schema: 'klebb.datafile.v1',
    meta: {
      id: CARD_ID,
      label: 'Chips e2e',
      emoji: '🏷️',
      order: 9100,
      category: 'lifestyle',
      view: {
        enabled: true,
        component: 'list-card',
        display: {
          primaryField: 'note',
          emptyMessage: 'No entries yet.',
        },
      },
      writeable: {
        fromWebapp: true,
        todayAllowed: true,
        pastAllowed: true,
        futureAllowed: false,
        maxReadingsPerDay: 20,
        inputs: [
          { key: 'note', label: 'Note', type: 'text', required: true },
          {
            key: 'category',
            label: 'Category',
            type: 'chips',
            options: ['breakfast', 'lunch', 'dinner', 'snack'],
          },
          {
            key: 'tags',
            label: 'Tags',
            type: 'chips-multi',
            options: ['home-cooked', 'takeaway', 'vegetarian', 'protein'],
          },
        ],
      },
    },
    description: 'List-card exercising chips and chips-multi inputs (#344).',
    data: [
      // Seed one row so we can target an existing per-row detail
      // button rather than going through the add-row flow.
      { added: '2026-04-01T08:00:00Z', note: 'Eggs and toast', category: '', tags: [] },
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

test.describe('#344: chips and chips-multi input types', () => {
  test('selecting chips and chips-multi values round-trips to disk', async ({ page, sandboxState }) => {
    await seed(page.request, sandboxState.baseUrl, chipsManifest());

    await page.goto('/');
    await expect(page.locator('eh-date-view')).toBeVisible({ timeout: 10_000 });

    const card = page.locator(`[data-card-id="${CARD_ID}"] eh-list-card`);
    await expect(card).toBeVisible({ timeout: 10_000 });

    // Enter edit mode, then open the seeded row's detail form.
    await card.locator('button[aria-label="Edit list"]').click();
    await card.locator('button[aria-label*="Edit extra fields"]').first().click();

    const form = card.locator('eh-input-form');
    await expect(form).toBeVisible();

    // chips: pick "breakfast".
    const categoryGroup = form.locator('.chip-row').nth(0);
    await categoryGroup.locator('.chip', { hasText: 'breakfast' }).click();
    await expect(categoryGroup.locator('.chip.selected', { hasText: 'breakfast' })).toBeVisible();

    // chips-multi: pick "home-cooked" and "protein".
    const tagsGroup = form.locator('.chip-row').nth(1);
    await tagsGroup.locator('.chip', { hasText: 'home-cooked' }).click();
    await tagsGroup.locator('.chip', { hasText: 'protein' }).click();
    await expect(tagsGroup.locator('.chip.selected')).toHaveCount(2);

    // Apply to merge into the draft row, then Done to persist.
    await form.getByRole('button', { name: /^apply$/i }).click();
    await card.locator('button[aria-label="Done — save changes"]').click();

    // Round-trip: read the data file back and assert the shape.
    const res = await page.request.get(`${sandboxState.baseUrl}/api/manifests/${CARD_ID}/data`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBe(1);
    const row = body.data[0];
    expect(row.note).toBe('Eggs and toast');
    expect(row.category).toBe('breakfast');
    expect(Array.isArray(row.tags)).toBe(true);
    expect(row.tags.sort()).toEqual(['home-cooked', 'protein']);

    await cleanup(page.request, sandboxState.baseUrl, CARD_ID);
  });

  test('tapping the selected chip clears the chips value', async ({ page, sandboxState }) => {
    await seed(page.request, sandboxState.baseUrl, chipsManifest());

    await page.goto('/');
    const card = page.locator(`[data-card-id="${CARD_ID}"] eh-list-card`);
    await expect(card).toBeVisible({ timeout: 10_000 });
    await card.locator('button[aria-label="Edit list"]').click();
    await card.locator('button[aria-label*="Edit extra fields"]').first().click();
    const form = card.locator('eh-input-form');

    const categoryGroup = form.locator('.chip-row').nth(0);
    await categoryGroup.locator('.chip', { hasText: 'lunch' }).click();
    await expect(categoryGroup.locator('.chip.selected', { hasText: 'lunch' })).toBeVisible();

    // Tap the same chip again — should clear.
    await categoryGroup.locator('.chip.selected', { hasText: 'lunch' }).click();
    await expect(categoryGroup.locator('.chip.selected')).toHaveCount(0);

    await cleanup(page.request, sandboxState.baseUrl, CARD_ID);
  });
});
