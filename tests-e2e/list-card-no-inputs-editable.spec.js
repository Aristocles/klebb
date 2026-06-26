// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests-e2e/list-card-no-inputs-editable.spec.js
// Regression for #457: a list-card whose manifest sets
// writeable.fromWebapp:true but declares NO writeable.inputs (e.g. the
// Appointments card) rendered an Add button that appended a blank,
// read-only row — nothing to type into. _primaryInput() returned null,
// so _renderEditMode fell back to a <span> instead of an <input>.
//
// A minimal manifest must still be fillable: Add should yield a typeable
// row keyed on the primary field (default `name`), and Done should
// persist it.

const { test, expect } = require('./helpers/auth-fixture');

const APPTS_ID = 'appointments-noinputs-e2e';

function noInputsManifest() {
  return {
    $schema: 'klebb.datafile.v1',
    meta: {
      id: APPTS_ID,
      label: 'Appointments (e2e)',
      emoji: '🗓️',
      order: 9100,
      view: {
        enabled: true,
        component: 'list-card',
      },
      writeable: {
        fromWebapp: true,
        pastAllowed: true,
        todayAllowed: true,
        futureAllowed: true,
      },
      enabled: true,
    },
    description: 'List-card with no writeable.inputs, for the #457 regression.',
    data: [],
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

test.describe('#457: inputs-less list-card is still editable', () => {
  test('Add yields a typeable row that persists on Done', async ({ page, sandboxState }) => {
    await seed(page.request, sandboxState.baseUrl, noInputsManifest());

    await page.goto('/');
    await expect(page.locator('eh-date-view')).toBeVisible({ timeout: 10_000 });

    const card = page.locator(`[data-card-id="${APPTS_ID}"] eh-list-card`);
    await expect(card).toBeVisible({ timeout: 10_000 });

    await card.locator('button[aria-label="Edit list"]').click();
    await card.locator('.add-btn').click();

    // The new row must carry an editable primary input, NOT a read-only
    // <span>. Before the fix this locator found nothing.
    const input = card.locator('.row .primary-input').first();
    await expect(input).toBeVisible();

    await input.fill('Dentist 9am Tuesday');
    await card.locator('button[aria-label="Done — save changes"]').click();

    // Back in view mode the row is persisted and shown.
    await expect(card.locator('.rows .primary')).toContainText('Dentist 9am Tuesday');

    // And it survives a reload (server-side write, not just local state).
    const after = await page.request.get(`${sandboxState.baseUrl}/api/manifests/${APPTS_ID}`);
    expect(after.status()).toBe(200);
    const body = await after.json();
    const rows = Array.isArray(body.data) ? body.data : (body.data?.items || []);
    expect(rows.some(r => r.name === 'Dentist 9am Tuesday')).toBe(true);

    await cleanup(page.request, sandboxState.baseUrl, APPTS_ID);
  });
});
