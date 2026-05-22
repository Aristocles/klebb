// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests-e2e/table-list-lab-shape.spec.js
// Regression for #290: eh-table-list must adapt to lab-shaped findings
// (label / value / unit / refLow / refHigh / flag), not just SNP-shaped
// findings (gene / rsid / genotype). Until #290 lands, the blood panel
// renders every row's left column as `?` and tops the card with a
// nonsense `APOE: ? · ?/? SNPs found` summary.
//
// The spec POSTs a minimal blood-panel manifest into the live sandbox,
// navigates to Reports, and asserts the rendered card uses the labels
// (not `?`) and shows `value unit` on the right. The sibling SNP shape
// is also re-asserted so the auto-detect doesn't regress the existing
// genome card.

const { test, expect } = require('./helpers/auth-fixture');

const BLOOD_ID = 'blood-panel-e2e';
const SNPS_ID = 'genome-snps-e2e';

function bloodPanelManifest() {
  return {
    $schema: 'klebb.datafile.v1',
    meta: {
      id: BLOOD_ID,
      label: 'Blood panel',
      emoji: '🩸',
      order: 800,
      view: {
        enabled: true,
        component: 'list-card',
        display: { primaryField: 'label', emptyMessage: 'No blood panels recorded yet.' },
      },
      reports: { enabled: true, component: 'table-list' },
      writeable: { fromWebapp: false },
    },
    description: 'Lab-shaped fixture for the table-list regression.',
    data: {
      collected: '2026-04-21',
      lab: 'DemoLabs Pty Ltd',
      categories: [
        {
          name: 'Lipids',
          findings: [
            { label: 'Total cholesterol', value: '4.6', unit: 'mmol/L',
              refLow: '<5.5', refHigh: '', flag: '' },
            { label: 'HDL', value: '1.5', unit: 'mmol/L',
              refLow: '>1.0', refHigh: '', flag: '' },
          ],
        },
      ],
    },
  };
}

function snpsManifest() {
  return {
    $schema: 'klebb.datafile.v1',
    meta: {
      id: SNPS_ID,
      label: 'Genome (SNPs)',
      emoji: '🧬',
      order: 850,
      view: {
        enabled: true,
        component: 'list-card',
        display: { primaryField: 'gene', emptyMessage: 'No SNPs loaded yet.' },
      },
      reports: { enabled: true, component: 'table-list' },
      writeable: { fromWebapp: false },
    },
    description: 'SNP-shaped sibling fixture — must keep rendering correctly.',
    data: {
      apoe: '3/3',
      found_count: 78,
      searched_count: 120,
      categories: [
        {
          name: 'Lipid metabolism',
          findings: [
            { gene: 'APOE', rsid: 'rs429358', genotype: 'T/T' },
            { gene: 'PCSK9', rsid: 'rs11591147', genotype: 'G/G' },
          ],
        },
      ],
    },
  };
}

async function seedManifest(request, baseUrl, manifest) {
  // Best-effort delete first in case a prior run left the card behind.
  await request.delete(`${baseUrl}/api/manifests/${manifest.meta.id}`).catch(() => {});
  const r = await request.post(`${baseUrl}/api/manifests`, { data: manifest });
  expect([201, 409]).toContain(r.status());
}

async function deleteManifest(request, baseUrl, id) {
  await request.delete(`${baseUrl}/api/manifests/${id}`).catch(() => {});
}

test.describe('#290: table-list adapts to lab-shape findings', () => {
  test('blood-panel rows show labels + value with unit (not "?")', async ({ page, sandboxState }) => {
    await seedManifest(page.request, sandboxState.baseUrl, bloodPanelManifest());

    await page.goto('/reports');
    await expect(page.locator('eh-reports-view')).toBeVisible({ timeout: 10_000 });

    // Scope to the blood-panel card via the wrap's data-card-id, then
    // dive into its eh-table-list. This avoids matching the SNP card
    // when both happen to be loaded.
    const card = page.locator(
      `eh-view-renderer [data-card-id="${BLOOD_ID}"] eh-table-list`,
    );
    await expect(card).toBeVisible({ timeout: 10_000 });

    // The actual lab labels should appear, not the SNP-fallback `?`.
    await expect(card).toContainText('Total cholesterol');
    await expect(card).toContainText('HDL');

    // Value with unit on the right column.
    await expect(card).toContainText('4.6 mmol/L');
    await expect(card).toContainText('1.5 mmol/L');

    // The SNP-style summary line must NOT appear on a lab card.
    await expect(card).not.toContainText('SNPs found');

    await deleteManifest(page.request, sandboxState.baseUrl, BLOOD_ID);
  });

  test('SNP card still renders genes + APOE summary', async ({ page, sandboxState }) => {
    await seedManifest(page.request, sandboxState.baseUrl, snpsManifest());

    await page.goto('/reports');
    await expect(page.locator('eh-reports-view')).toBeVisible({ timeout: 10_000 });

    const card = page.locator(
      `eh-view-renderer [data-card-id="${SNPS_ID}"] eh-table-list`,
    );
    await expect(card).toBeVisible({ timeout: 10_000 });

    await expect(card).toContainText('APOE');
    await expect(card).toContainText('PCSK9');
    await expect(card).toContainText('SNPs found');

    await deleteManifest(page.request, sandboxState.baseUrl, SNPS_ID);
  });
});
