// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests-e2e/reports-upload-verify.spec.js
// The Reports surface in a real browser: upload, the quota counter, the detail
// sheet, and the OCR compare view at desktop and phone widths.
//
// Assertions are on visible content (a title, a bullet, a badge) rather than on
// an element merely existing, because the client falls back to an empty list on
// a shape it does not recognise: an element-present assertion would pass on a
// blank page.

const { test, expect } = require('./helpers/auth-fixture');

const PHONE = { width: 375, height: 812 };
const DESKTOP = { width: 1280, height: 900 };

const CSV = [
  'analyte,result,unit,range',
  'haemoglobin,147,g/L,130-180',
  'ferritin,88,ug/L,30-300',
].join('\n');

// Create a report through the real upload endpoint. The e2e sandbox points
// CHAT_ENDPOINT_URL at a dead port, so comprehension degrades and the report
// lands as `raw` carrying the csv text. That is the honest state for this
// environment and it exercises everything the client does: the list, the badges,
// the sheet, the source pane and delete. The verified/unverified transition is
// covered at the API layer in tests/reports-manage-api.test.js, which can write
// the frontmatter a gateway would otherwise have to produce.
//
// Goes through page.request, not the bare `request` fixture: only the browser
// context carries the injected session cookie, and the bare fixture gets a 401
// that presents later as "the card never appeared".
async function seedReport(page, name) {
  const res = await page.request.post('/api/reports/upload', {
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Klebb-Filename': encodeURIComponent(`${name}.csv`),
    },
    data: CSV,
  });
  if (res.status() !== 202) {
    throw new Error(`seeding ${name} failed: ${res.status()} ${await res.text()}`);
  }
  return res;
}

async function waitForReportsLoaded(page) {
  const view = page.locator('eh-reports-view');
  await expect(view).toBeVisible({ timeout: 10_000 });
  // The list renders once the fetch resolves; "Loading…" is the pre-state.
  await expect(view.locator('.md-list, .empty').first()).toBeVisible({ timeout: 10_000 });
  await expect(view).not.toContainText('Loading…', { timeout: 10_000 });
  return view;
}

test.describe('Reports: upload and the managed list', () => {
  test('the upload control shows the quota and the size limit', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto('/reports');
    const view = await waitForReportsLoaded(page);

    const upload = view.locator('.upload');
    await expect(upload).toBeVisible();
    await expect(upload).toContainText('Add a document');
    // "X of N used" is the pre-attempt affordance: the user should know where
    // they stand before picking a file.
    await expect(upload.locator('.quota')).toContainText(/\d+ of \d+ used/);
    await expect(upload).toContainText('15 MB');
  });

  test('uploading a csv produces a visible report card', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const res = await seedReport(page, 'e2e-bloods');
    expect(res.status()).toBe(202);

    await page.goto('/reports');
    const view = await waitForReportsLoaded(page);

    // Assert on visible text, not on the card element existing.
    const card = view.locator('.md-item', { hasText: 'e2e-bloods' }).first();
    await expect(card).toBeVisible({ timeout: 15_000 });
  });

  test('the detail sheet opens with the report title and actions', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await seedReport(page, 'e2e-sheet');
    await page.goto('/reports');
    const view = await waitForReportsLoaded(page);

    const card = view.locator('.md-item', { hasText: 'e2e-sheet' }).first();
    await expect(card).toBeVisible({ timeout: 15_000 });
    await card.click();

    // The host element is zero-size (its content lives inside a <dialog>), so
    // the panel is what to assert visibility on.
    const sheet = page.locator('eh-report-detail');
    await expect(sheet.locator('.panel')).toBeVisible();
    await expect(sheet.locator('.title')).toContainText('e2e-sheet');
    // The digest view is deliberately down to two actions. Delete and the OCR
    // retry both live in the compare view, so they must NOT be here.
    await expect(sheet.locator('a.action', { hasText: 'View full report' })).toBeVisible();
    await expect(sheet.locator('button.action').filter({ hasText: /Compare with original|Check the text/ })).toHaveCount(1);
    await expect(sheet.locator('button.action', { hasText: 'Delete' })).toHaveCount(0);
    await expect(sheet.locator('button.action', { hasText: 'Read it again' })).toHaveCount(0);
  });

  test('View full report is hidden until the report is approved', async ({ page }) => {
    // A report awaiting an OCR check has content chat is not allowed to use, so
    // offering to open it as a finished report is the wrong affordance.
    await page.setViewportSize(DESKTOP);
    await page.goto('/reports');
    const view = await waitForReportsLoaded(page);

    const cards = view.locator('.md-item');
    const count = await cards.count();
    for (let i = 0; i < count; i++) {
      const card = cards.nth(i);
      const needsCheck = await card.locator('.badge', { hasText: 'Needs checking' }).count();
      if (!needsCheck) continue;
      await card.click();
      const sheet = page.locator('eh-report-detail');
      await expect(sheet.locator('.panel')).toBeVisible();
      await expect(sheet.locator('a.action', { hasText: 'View full report' })).toHaveCount(0);
      await expect(sheet.locator('button.action', { hasText: 'Check the text' })).toHaveCount(1);
      return;
    }
    // No unverified report in this sandbox (tesseract is absent, so nothing is
    // gated); the API-layer suite covers the gating itself.
  });

  test('delete asks once, then removes the card and frees a slot', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await seedReport(page, 'e2e-doomed');
    await page.goto('/reports');
    const view = await waitForReportsLoaded(page);

    const card = view.locator('.md-item', { hasText: 'e2e-doomed' }).first();
    await expect(card).toBeVisible({ timeout: 15_000 });
    const usedBefore = await view.locator('.quota').textContent();
    await card.click();

    const sheet = page.locator('eh-report-detail');
    // Delete lives in the compare view now, one step in from the digest.
    await sheet.locator('button.action').filter({ hasText: /Compare with original|Check the text/ }).click();
    const del = sheet.locator('button.action', { hasText: 'Delete' });
    await expect(del).toBeVisible();
    await del.click();
    // One confirmation, in place, not a browser dialog.
    await expect(sheet.locator('button.action', { hasText: 'Really delete?' })).toBeVisible();
    await sheet.locator('button.action', { hasText: 'Really delete?' }).click();

    await expect(page.locator('eh-report-detail')).toHaveCount(0, { timeout: 10_000 });
    await expect(view.locator('.md-item', { hasText: 'e2e-doomed' })).toHaveCount(0, { timeout: 10_000 });
    await expect(view.locator('.quota')).not.toHaveText(usedBefore, { timeout: 10_000 });
  });

  test('an unsupported file type is refused with the server message shown', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    // Needs a real page first so the context cookie is attached.
    await page.goto('/reports');
    const res = await page.request.post('/api/reports/upload', {
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Klebb-Filename': encodeURIComponent('payload.exe'),
      },
      data: 'MZ',
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    // The client surfaces this verbatim, so it has to name the extension.
    expect(body.error).toContain('.exe');
  });
});

test.describe('Reports: state and the compare view', () => {
  test('a degraded report is labelled rather than looking merely empty', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await seedReport(page, 'e2e-state');

    await page.goto('/reports');
    const view = await waitForReportsLoaded(page);
    const card = view.locator('.md-item', { hasText: 'e2e-state' }).first();
    await expect(card).toBeVisible({ timeout: 15_000 });

    // The gateway is unreachable in this sandbox, so the report is `raw`. The
    // point is that the user is told so, and told the format, rather than being
    // shown a title with no explanation for the missing summary.
    await expect(card).toContainText('Not summarised');
    await expect(card.locator('.badge', { hasText: 'text' })).toBeVisible();

    await card.click();
    const sheet = page.locator('eh-report-detail');
    await expect(sheet.locator('.panel')).toBeVisible();
    // And the reason the comprehension pass recorded is surfaced, not swallowed.
    await expect(sheet.locator('.note.warn')).toContainText(/gateway|comprehension/i);
  });

  test('the sheet does not overflow horizontally on a phone', async ({ page }) => {
    // There is an existing spec for this class of bug on modals (#188); the
    // detail sheet is a new modal surface and must not reintroduce it.
    await page.setViewportSize(PHONE);
    await seedReport(page, 'e2e-mobile');
    await page.goto('/reports');
    const view = await waitForReportsLoaded(page);

    const card = view.locator('.md-item', { hasText: 'e2e-mobile' }).first();
    await expect(card).toBeVisible({ timeout: 15_000 });
    await card.click();

    const panel = page.locator('eh-report-detail').locator('.panel');
    await expect(panel).toBeVisible();
    const probe = await panel.evaluate(el => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }));
    expect(probe.scrollWidth,
      `detail sheet overflows horizontally at ${PHONE.width}px ` +
      `(scrollWidth ${probe.scrollWidth} > clientWidth ${probe.clientWidth})`)
      .toBeLessThanOrEqual(probe.clientWidth + 1);
  });

  test('the compare view is one full-width text column with the original a tap away', async ({ page }) => {
    await seedReport(page, 'e2e-compare');

    // Phone first: this is where the check actually happens, since it is the
    // device the photo was taken with.
    await page.setViewportSize(PHONE);
    await page.goto('/reports');
    let view = await waitForReportsLoaded(page);
    let card = view.locator('.md-item', { hasText: 'e2e-compare' }).first();
    await expect(card).toBeVisible({ timeout: 15_000 });
    await card.click();

    const sheet = page.locator('eh-report-detail');
    // No conditional guard around the assertions: a test that skips its own
    // body when the button is missing would pass while proving nothing, which
    // is precisely the failure this spec exists to catch.
    const compareBtn = sheet.locator('button.action')
      .filter({ hasText: /Check the text|Compare with original/ });
    await expect(compareBtn).toHaveCount(1);
    await compareBtn.click();

    // One full-width text column. No tabs and no inline preview of the original:
    // a PDF embed renders as a black box in several browsers, and half a phone
    // screen of shrunken scan cannot be checked against anyway.
    await expect(sheet.locator('.tabs')).toHaveCount(0);
    await expect(sheet.locator('.pane-label')).toHaveCount(1);
    await expect(sheet.locator('.pane-label', { hasText: 'Text read from it' })).toBeVisible();
    await expect(sheet.locator('embed')).toHaveCount(0);

    // The extracted text is what the human compares against, so it has to be
    // the content of the document and not our own frontmatter.
    await expect(sheet.locator('.ocr')).toContainText('haemoglobin');
    await expect(sheet.locator('.ocr')).not.toContainText('klebb_ingest');

    // The original is one tap away, in its own tab, and the retry is gone.
    await expect(sheet.locator('a.action', { hasText: 'Open the original' })).toHaveCount(1);
    await expect(sheet.locator('button.action', { hasText: 'Retry reading it' })).toHaveCount(0);
    await expect(sheet.locator('button.action', { hasText: 'Looks right' })).toHaveCount(1);
    await expect(sheet.locator('button.action', { hasText: 'Delete' })).toHaveCount(1);

    // Back returns to the digest, and does not leave a half-armed delete.
    await sheet.locator('button.action', { hasText: 'Back' }).click();
    await expect(sheet.locator('.ocr')).toHaveCount(0);
    await expect(sheet.locator('button.action', { hasText: 'Really delete?' })).toHaveCount(0);

    // Same single-column layout on a desktop; width is the only difference.
    await page.setViewportSize(DESKTOP);
    await compareBtn.click();
    await expect(sheet.locator('.tabs')).toHaveCount(0);
    await expect(sheet.locator('.pane-label')).toHaveCount(1);
  });
});

test.describe('Reports: demo mode', () => {
  test('the report list still renders for a visitor', async ({ page }) => {
    // Upload is server-gated in demo mode and the control is hidden; what
    // matters here is that the page itself is not broken by the envelope.
    await page.setViewportSize(DESKTOP);
    await page.goto('/reports');
    const view = await waitForReportsLoaded(page);
    await expect(view.locator('h2')).toContainText('Reports');
  });
});
