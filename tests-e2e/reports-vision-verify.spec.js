// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests-e2e/reports-vision-verify.spec.js
// The verify screen for vision-read reports (#681): uncorroborated numbers
// are highlighted with a legend, the witness tri-state drives the copy, the
// reader-aware retry is back, and verification still clears the gate.
//
// Reports are seeded on disk with the exact headers the pipeline writes,
// because this run's sandbox has no reachable gateway to produce a real
// vision read; the header contract itself is proven in
// tests/reports-vision-e2e.test.js.

const fs = require('fs');
const path = require('path');
const { test, expect } = require('./helpers/auth-fixture');

const DESKTOP = { width: 1280, height: 900 };

const BODY = [
  'Glucose 7.2 mmol/L (3.9 - 5.5)',
  'HbA1c 41 mmol/mol',
  'Cholesterol 5.5 mmol/L',
].join('\n');

// unwitnessed: array -> the line is written ('none' when empty); null -> no
// witness line at all, the "could not cross-check" state.
function seedVisionReport(sandbox, name, unwitnessed) {
  const lines = [
    '---',
    'klebb_ingest: v2',
    `source_file: ${name}.png`,
    'source_format: image',
    'ingested_at: 2026-09-06T01:02:03Z',
    `archive_path: reports/_archive/${name}.png`,
    'status: ready',
    'verify: required',
    `title: Vision check ${name}`,
    'document_date: 2026-09-01',
    'relevance: health',
    'read_by: vision',
    'ocr_attempts: vision',
    ...(unwitnessed !== null
      ? [`unwitnessed: ${unwitnessed.length ? unwitnessed.join(' ') : 'none'}`]
      : []),
    'bullets:',
    '  - Glucose 7.2 mmol/L, above range',
    '---',
    '',
    `# Vision check ${name}`,
    '',
    BODY,
  ];
  fs.writeFileSync(path.join(sandbox, 'reports', `${name}.md`), lines.join('\n'));
  fs.writeFileSync(path.join(sandbox, 'reports', '_archive', `${name}.png`), 'PNGDATA');
}

async function waitForReportsLoaded(page) {
  const view = page.locator('eh-reports-view');
  await expect(view).toBeVisible({ timeout: 10_000 });
  await expect(view.locator('.md-list, .empty').first()).toBeVisible({ timeout: 10_000 });
  await expect(view).not.toContainText('Loading…', { timeout: 10_000 });
  return view;
}

async function openCompare(page, view, name) {
  const card = view.locator('.md-item', { hasText: name }).first();
  await expect(card).toBeVisible();
  await card.click();
  const sheet = page.locator('eh-report-detail');
  await expect(sheet.locator('.panel')).toBeVisible();
  await sheet.getByRole('button', { name: 'Check the text' }).click();
  await expect(sheet.locator('pre.ocr')).toBeVisible();
  return sheet;
}

test.describe('Reports: vision verify screen (#681)', () => {
  test('uncorroborated numbers are highlighted, corroborated ones are not', async ({ page, sandboxState }) => {
    seedVisionReport(sandboxState.sandbox, 'e2e-vis-marked', ['7.2', '41']);
    await page.setViewportSize(DESKTOP);
    await page.goto('/reports');
    const view = await waitForReportsLoaded(page);

    const sheet = await openCompare(page, view, 'e2e-vis-marked');
    const marks = sheet.locator('pre.ocr mark');
    await expect(marks).toHaveCount(2);
    await expect(marks.nth(0)).toHaveText('7.2');
    await expect(marks.nth(1)).toHaveText('41');
    // The corroborated values stay plain text.
    await expect(sheet.locator('pre.ocr')).toContainText('Cholesterol 5.5 mmol/L');

    const legend = sheet.locator('.note.warn', { hasText: 'highlighted' });
    await expect(legend).toBeVisible();
    await expect(legend).toContainText('not seen by the local OCR cross-check');

    // The retry names its reader: vision already produced this text, so the
    // next rung is a local OCR setting.
    await expect(sheet.getByRole('button', { name: 'Retry with local OCR' })).toBeVisible();
  });

  test('the detail sheet says who read the document', async ({ page, sandboxState }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto('/reports');
    const view = await waitForReportsLoaded(page);
    const card = view.locator('.md-item', { hasText: 'e2e-vis-marked' }).first();
    await card.click();
    const sheet = page.locator('eh-report-detail');
    await expect(sheet.locator('.chip', { hasText: 'read by vision' })).toBeVisible();
  });

  test('a fully corroborated read says so and shows no marks', async ({ page, sandboxState }) => {
    seedVisionReport(sandboxState.sandbox, 'e2e-vis-clean', []);
    await page.setViewportSize(DESKTOP);
    await page.goto('/reports');
    const view = await waitForReportsLoaded(page);

    const sheet = await openCompare(page, view, 'e2e-vis-clean');
    await expect(sheet.locator('pre.ocr mark')).toHaveCount(0);
    await expect(sheet.locator('.note', { hasText: 'also appears in a local OCR cross-check' }))
      .toBeVisible();
  });

  test('no witness means every value is on the human', async ({ page, sandboxState }) => {
    seedVisionReport(sandboxState.sandbox, 'e2e-vis-blind', null);
    await page.setViewportSize(DESKTOP);
    await page.goto('/reports');
    const view = await waitForReportsLoaded(page);

    const sheet = await openCompare(page, view, 'e2e-vis-blind');
    await expect(sheet.locator('pre.ocr mark')).toHaveCount(0);
    await expect(sheet.locator('.note.warn', { hasText: 'could not cross-check' })).toBeVisible();
    await expect(sheet.locator('.note.warn')).toContainText('check every value');
  });

  test('retry posts the reprocess and closes the sheet', async ({ page, sandboxState }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto('/reports');
    const view = await waitForReportsLoaded(page);

    const sheet = await openCompare(page, view, 'e2e-vis-blind');
    const responsePromise = page.waitForResponse(r =>
      r.url().includes('/reprocess') && r.request().method() === 'POST');
    await sheet.getByRole('button', { name: 'Retry with local OCR' }).click();
    const response = await responsePromise;
    expect(response.status()).toBe(202);
    const body = await response.json();
    expect(body.reader).toBe('tesseract');
    expect(body.psm).toBe(3);
    await expect(page.locator('eh-report-detail')).toHaveCount(0, { timeout: 10_000 });
  });

  test('verifying still clears the gate for a vision-read report', async ({ page, sandboxState }) => {
    seedVisionReport(sandboxState.sandbox, 'e2e-vis-verify', ['7.2']);
    await page.setViewportSize(DESKTOP);
    await page.goto('/reports');
    const view = await waitForReportsLoaded(page);

    const card = view.locator('.md-item', { hasText: 'e2e-vis-verify' }).first();
    await expect(card.locator('.badge.warn', { hasText: 'Needs checking' })).toBeVisible();

    const sheet = await openCompare(page, view, 'e2e-vis-verify');
    await sheet.getByRole('button', { name: 'Looks right' }).click();
    await expect(page.locator('eh-report-detail')).toHaveCount(0, { timeout: 10_000 });

    const after = view.locator('.md-item', { hasText: 'e2e-vis-verify' }).first();
    await expect(after).toBeVisible();
    await expect(after.locator('.badge.warn')).toHaveCount(0);
  });
});
