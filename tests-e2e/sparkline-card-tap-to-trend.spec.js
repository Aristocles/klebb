// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests-e2e/sparkline-card-tap-to-trend.spec.js
//
// The mini trend sparkline inside a generic-card on Today, and the tap
// gesture that expands it to the full trend chart for that card. Live
// regression coverage for the sparkline feature (#445 + #448); the
// behaviour shipped in v3.3.0.
//
// Key contracts, from the UI/UX lens only:
//   - The sparkline is OPT-IN and default-off. It renders only when a
//     manifest sets meta.view.showSparkline: true, so no existing card
//     changes behaviour and the baseline suite stays untouched.
//   - It is a dumb <eh-sparkline> SVG mounted by composition inside the
//     generic-card headline row. It is decorative: aria-hidden, with an
//     aria-label summary for assistive tech.
//   - It only surfaces on the Today masonry (eh-date-view _dateMode ===
//     'today'); on a past/future date the card shows no sparkline.
//   - Expanding reveals the full trend chart for that card: the lazy
//     ECharts line-chart opens inline below the headline. Two targets do
//     it, the chevron beside the sparkline and the card header itself
//     (#572). That is the bridge to the dedicated Trends view, which must
//     plot the identical series.
//   - Visual language tracks the theme via CSS custom properties so the
//     sparkline flips with dark/light mode and never hardcodes colour.

const { test, expect } = require('./helpers/auth-fixture');

const CARD_ID = 'sparkline-weight-e2e';

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

// A generic-card manifest that opts in via meta.view.showSparkline and
// carries enough dated rows (>= the 2-point minimum, with a clear
// downward trend) for the sparkline to draw a real polyline. trendArrow
// nominates the numeric field so the sparkline and the arrow resolve the
// same series (no two-trend-signal mismatch).
function sparklineManifest(today) {
  const rows = [];
  for (let i = 13; i >= 0; i -= 1) {
    rows.push({ date: shiftDays(today, -i), kg: 84.0 - (13 - i) * 0.2 });
  }
  return {
    $schema: 'klebb.datafile.v1',
    meta: {
      id: CARD_ID,
      label: 'Weight (sparkline e2e)',
      emoji: '⚖️',
      order: 9720,
      category: 'body',
      view: {
        enabled: true,
        component: 'generic-card',
        // The opt-in flag this whole storyboard hangs on.
        showSparkline: true,
        display: {
          template: '{kg:round(1)} kg',
          trendArrow: { field: 'kg', direction: 'lower-better' },
        },
      },
      trends: { enabled: true, component: 'line-chart' },
      // inputs are what make the edit pencil render. It matters here: the
      // pencil is absolutely positioned into the header row, and the old
      // header chevron sat underneath it (#572).
      writeable: {
        fromWebapp: true, todayAllowed: true, pastAllowed: true, futureAllowed: false,
        inputs: [{ key: 'kg', type: 'number', label: 'Weight', step: 0.1 }],
      },
    },
    description: 'Generic value card opting into a mini trend sparkline (storyboard).',
    data: rows,
  };
}

// A second manifest identical in shape but WITHOUT the opt-in flag, to
// prove default-off: the same data must render no sparkline.
function noSparklineManifest(today) {
  const m = sparklineManifest(today);
  m.meta.id = 'no-sparkline-weight-e2e';
  m.meta.label = 'Weight (no sparkline e2e)';
  m.meta.order = 9721;
  delete m.meta.view.showSparkline;
  return m;
}

async function seed(request, baseUrl, m) {
  await request.delete(`${baseUrl}/api/manifests/${m.meta.id}`).catch(() => {});
  const r = await request.post(`${baseUrl}/api/manifests`, { data: m });
  expect([201, 409]).toContain(r.status());
}

async function cleanup(request, baseUrl, id) {
  await request.delete(`${baseUrl}/api/manifests/${id}`).catch(() => {});
}

test.describe('Storyboard: mini sparkline in a card, tap to full trend', () => {
  let today;

  test.beforeEach(async ({ page, sandboxState }) => {
    today = todayISO();
    await seed(page.request, sandboxState.baseUrl, sparklineManifest(today));
    await seed(page.request, sandboxState.baseUrl, noSparklineManifest(today));
  });

  test.afterEach(async ({ page, sandboxState }) => {
    await cleanup(page.request, sandboxState.baseUrl, CARD_ID);
    await cleanup(page.request, sandboxState.baseUrl, 'no-sparkline-weight-e2e');
  });

  // The opt-in card draws a sparkline on Today; the non-opted card with
  // identical data does not.
  test('renders an inline sparkline only when meta.view.showSparkline is set', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('eh-date-view')).toBeVisible({ timeout: 10_000 });

    const card = page.locator('eh-generic-card', { hasText: 'Weight (sparkline e2e)' }).first();
    await expect(card).toBeVisible({ timeout: 10_000 });

    // The sparkline is a standalone Lit element mounted by composition
    // inside the card headline row, not part of the ECharts layer.
    const spark = card.locator('eh-sparkline');
    await expect(spark).toBeVisible();

    // It is an inline SVG polyline over the resolved numeric series; with
    // 14 dated rows it draws a real line (>= the 2-point minimum).
    const polyline = spark.locator('svg polyline.line');
    await expect(polyline).toBeVisible();
    const pointCount = await polyline.evaluate((el) => {
      const raw = (el.getAttribute('points') || '').trim();
      return raw ? raw.split(/\s+/).length : 0;
    });
    expect(pointCount).toBeGreaterThanOrEqual(2);

    // Default-off: the identical-data card without the opt-in flag must
    // render no sparkline at all.
    const plainCard = page.locator('eh-generic-card', { hasText: 'Weight (no sparkline e2e)' }).first();
    await expect(plainCard).toBeVisible();
    await expect(plainCard.locator('eh-sparkline')).toHaveCount(0);
  });

  // The sparkline is decorative and accessible: the numeric headline
  // carries the value to assistive tech;
  // the SVG is aria-hidden but exposes an aria-label trend summary so it
  // is not silent where the headline is templated.
  test('sparkline is decorative: aria-hidden with a trend-summary label', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('eh-date-view')).toBeVisible({ timeout: 10_000 });

    const card = page.locator('eh-generic-card', { hasText: 'Weight (sparkline e2e)' }).first();
    const spark = card.locator('eh-sparkline');
    // The inner svg is decorative; the accessible name lives on the host
    // element (role=img + aria-label), so screen readers announce one summary
    // rather than walking the svg geometry.
    await expect(spark.locator('svg')).toHaveAttribute('aria-hidden', 'true');
    await expect(spark).toHaveAttribute('role', 'img');

    // The label summarises direction + latest value (e.g. "trend down,
    // latest 81.4"); the seeded series trends down, so the word "down"
    // must appear. The headline still owns the literal value for AT.
    const label = await spark.getAttribute('aria-label');
    expect(label).toBeTruthy();
    expect(label.toLowerCase()).toContain('down');
  });

  // The sparkline lives on Today only. On a past date the same card is
  // in the tree but shows no sparkline,
  // because the trend glyph is a "today, at-a-glance" affordance.
  test('sparkline appears on Today but not on a past-date view', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('eh-date-view')).toBeVisible({ timeout: 10_000 });
    await expect(
      page.locator('eh-generic-card', { hasText: 'Weight (sparkline e2e)' }).first().locator('eh-sparkline'),
    ).toBeVisible();

    // Navigate to a past date via the canonical /day/<iso> route.
    await page.goto(`/day/${shiftDays(today, -3)}`);
    await expect(page.locator('eh-date-view')).toBeVisible({ timeout: 10_000 });

    const pastCard = page.locator('eh-generic-card', { hasText: 'Weight (sparkline e2e)' }).first();
    await expect(pastCard).toBeVisible({ timeout: 10_000 });
    await expect(pastCard.locator('eh-sparkline')).toHaveCount(0);
  });

  // Tapping the card expands the full trend inline. The sparkline itself
  // is non-interactive; the gesture is the existing ~44px header expand
  // target, which lazy-loads the full ECharts line-chart below the
  // headline. Expanding in place was chosen over scrolling the user to
  // the Trends view: it keeps them where they were.
  test('tapping the card expands the full trend chart inline', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('eh-date-view')).toBeVisible({ timeout: 10_000 });

    const card = page.locator('eh-generic-card', { hasText: 'Weight (sparkline e2e)' }).first();
    await expect(card.locator('eh-sparkline')).toBeVisible({ timeout: 10_000 });

    // Full chart is NOT mounted until expand (the ~1MB ECharts cost is
    // paid once, on demand, never per Today card).
    await expect(card.locator('eh-line-chart')).toHaveCount(0);

    // Tap the existing clickable header to expand. The header is the
    // accessible expand target, not the decorative SVG.
    const header = card.locator('.card-header.clickable').first();
    await expect(header).toHaveAttribute('aria-expanded', 'false');
    await header.click();

    await expect(header).toHaveAttribute('aria-expanded', 'true');
    await expect(card.locator('eh-line-chart')).toBeVisible({ timeout: 10_000 });
  });

  // #572: the expand chevron sits beside the sparkline, not in the header
  // chrome. Previously it rendered between the edit pencil and the settings
  // gear, where it read as unrelated to the trend line it opens and
  // overlapped the absolutely-positioned .edit-btn.
  test('the expand chevron sits to the left of the sparkline, not in the header', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('eh-date-view')).toBeVisible({ timeout: 10_000 });

    const card = page.locator('eh-generic-card', { hasText: 'Weight (sparkline e2e)' }).first();
    const spark = card.locator('eh-sparkline');
    await expect(spark).toBeVisible({ timeout: 10_000 });

    // Exactly one chevron on the card, and it is the one beside the glyph.
    const chevron = card.locator('button.spark-expand');
    await expect(chevron).toBeVisible();
    await expect(card.locator('.expand-indicator')).toHaveCount(0);

    // Left of the sparkline and vertically aligned with it, so the two
    // read as one control-plus-glyph unit.
    const cBox = await chevron.boundingBox();
    const sBox = await spark.boundingBox();
    expect(cBox).not.toBeNull();
    expect(sBox).not.toBeNull();
    expect(cBox.x + cBox.width).toBeLessThanOrEqual(sBox.x + 1);
    const cMid = cBox.y + cBox.height / 2;
    const sMid = sBox.y + sBox.height / 2;
    expect(Math.abs(cMid - sMid)).toBeLessThanOrEqual(4);

    // It no longer collides with the edit button, which is what made the
    // old placement read as hidden.
    const edit = card.locator('.edit-btn');
    await expect(edit).toBeVisible();
    const eBox = await edit.boundingBox();
    const overlaps = cBox.x < eBox.x + eBox.width && eBox.x < cBox.x + cBox.width
      && cBox.y < eBox.y + eBox.height && eBox.y < cBox.y + cBox.height;
    expect(overlaps).toBe(false);
  });

  // The chevron is a real button: it expands on click, flips aria-expanded,
  // and is reachable by keyboard alone (a span with a click handler would
  // pass the first two and fail the third).
  test('the chevron expands the chart and is operable by keyboard', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('eh-date-view')).toBeVisible({ timeout: 10_000 });

    const card = page.locator('eh-generic-card', { hasText: 'Weight (sparkline e2e)' }).first();
    const chevron = card.locator('button.spark-expand');
    await expect(chevron).toBeVisible({ timeout: 10_000 });
    await expect(card.locator('eh-line-chart')).toHaveCount(0);
    await expect(chevron).toHaveAttribute('aria-expanded', 'false');

    await chevron.click();
    await expect(chevron).toHaveAttribute('aria-expanded', 'true');
    await expect(card.locator('eh-line-chart')).toBeVisible({ timeout: 10_000 });

    // Collapse from the keyboard: focus the control and press Enter.
    await chevron.focus();
    await expect(chevron).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(chevron).toHaveAttribute('aria-expanded', 'false');
    await expect(card.locator('eh-line-chart')).toHaveCount(0);
  });

  // A card that expands but draws no sparkline keeps the header indicator:
  // the chevron only moves for the case it belongs to. Here the same card
  // on a past date has no sparkline row, so no chevron rides it.
  test('a card with no sparkline row has no chevron beside the value', async ({ page }) => {
    await page.goto(`/day/${shiftDays(today, -3)}`);
    await expect(page.locator('eh-date-view')).toBeVisible({ timeout: 10_000 });

    const pastCard = page.locator('eh-generic-card', { hasText: 'Weight (sparkline e2e)' }).first();
    await expect(pastCard).toBeVisible({ timeout: 10_000 });
    await expect(pastCard.locator('eh-sparkline')).toHaveCount(0);
    await expect(pastCard.locator('button.spark-expand')).toHaveCount(0);
  });

  // The Today sparkline and the dedicated Trends view plot the same
  // card's series. Tapping is the
  // bridge between the at-a-glance glyph and the full chart; the Trends
  // view must render the same card so the two never diverge.
  test('the same card surfaces its full trend on the Trends view', async ({ page }) => {
    await page.goto('/trends');
    await expect(page.locator('eh-trends-view')).toBeVisible({ timeout: 10_000 });

    const trendCard = page.locator(`[data-card-id="${CARD_ID}"] eh-line-chart`);
    await expect(trendCard).toBeVisible({ timeout: 10_000 });
  });
});

test.describe('Storyboard: sparkline dark-mode and mobile-first execution', () => {
  let today;

  test.beforeEach(async ({ page, sandboxState }) => {
    today = todayISO();
    await seed(page.request, sandboxState.baseUrl, sparklineManifest(today));
  });

  test.afterEach(async ({ page, sandboxState }) => {
    await cleanup(page.request, sandboxState.baseUrl, CARD_ID);
  });

  // The sparkline tracks the theme via CSS custom properties and never
  // hardcodes colour. Its stroke resolves
  // to the same --accent token the rest of the UI uses, so a dark/light
  // flip needs zero JS in the component.
  test('sparkline stroke resolves to the themed --accent token', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('eh-date-view')).toBeVisible({ timeout: 10_000 });

    const card = page.locator('eh-generic-card', { hasText: 'Weight (sparkline e2e)' }).first();
    const polyline = card.locator('eh-sparkline svg polyline.line');
    await expect(polyline).toBeVisible({ timeout: 10_000 });

    // Read the computed stroke in the current (default) theme.
    const lightStroke = await polyline.evaluate((el) => getComputedStyle(el).stroke);
    expect(lightStroke).toBeTruthy();

    // Flip the document theme the way Settings > General does
    // (data-theme on <html> + the persisted preference key) and assert
    // the stroke recomputes, proving it rides a CSS var rather than a
    // baked-in colour.
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'dark');
      localStorage.setItem('klebb-theme', 'dark');
    });

    await expect
      .poll(async () => polyline.evaluate((el) => getComputedStyle(el).stroke))
      .not.toBe(lightStroke);
  });

  // On a narrow mobile viewport the sparkline is width-pinned in hard
  // pixels (never %), so it cannot push
  // the card past the viewport or break the masonry. It sits in a fixed
  // headline grid track beside the value; the card stays within the
  // iPhone-13-mini width.
  test('sparkline is width-pinned and does not overflow on a narrow viewport', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 }); // iPhone 13 mini
    await page.goto('/');
    await expect(page.locator('eh-date-view')).toBeVisible({ timeout: 10_000 });

    const card = page.locator('eh-generic-card', { hasText: 'Weight (sparkline e2e)' }).first();
    const spark = card.locator('eh-sparkline');
    await expect(spark).toBeVisible({ timeout: 10_000 });

    // Hard pixel width (eh-sparkline defaults to 64); never a
    // percentage that fights the minmax(0, 1fr) Today grid tracks.
    const box = await spark.boundingBox();
    expect(box).not.toBeNull();
    expect(box.width).toBeLessThanOrEqual(96);

    // The card itself stays inside the viewport: no horizontal overflow.
    const cardBox = await card.boundingBox();
    expect(cardBox).not.toBeNull();
    expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(375 + 1);
  });
});
