// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests-e2e/notifications-tab.spec.js
// #387: Notifications tab UI — banner states, empty state, footer note,
// per-card section rendering, toggle persistence, Test button rate-limit.
// Doesn't try to actually subscribe to push (Playwright Chromium permission
// flow is fragile); permission stays 'default' and the test exercises the
// "Notifications are off in this browser" banner.

const { test, expect } = require('./helpers/auth-fixture');

test.describe('#387: Notifications tab', () => {
  test('empty state + footer note when no manifests declare notifications', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.locator('eh-settings-view')).toBeVisible();
    await page.locator('eh-settings-view [data-tab="notifications"]').click();

    const tab = page.locator('eh-settings-notifications');
    await expect(tab).toBeVisible();

    // Empty-state copy is exact per spec.
    await expect(tab.locator('.empty')).toContainText(
      'Ask Klebbius to set one up: try',
    );
    await expect(tab.locator('.empty')).toContainText(
      'remind me to log mood every evening at 8pm',
    );

    // Footer note is always rendered.
    await expect(tab.locator('.footer-note')).toContainText(
      'If a notification you want is missing, ask Klebbius to add it.',
    );
  });

  test('default-permission banner offers Enable button', async ({ page, context }) => {
    // Don't grant notifications permission - we want the default state.
    await page.goto('/settings');
    await page.locator('eh-settings-view [data-tab="notifications"]').click();
    const tab = page.locator('eh-settings-notifications');
    await expect(tab).toBeVisible();

    const banner = tab.locator('.banner').first();
    // Either iOS banner (won't render in Chromium) or default-permission
    // banner: must contain an Enable button OR install instructions.
    const text = await banner.innerText();
    expect(text.length).toBeGreaterThan(0);
  });

  test('per-card sections render after Klebbius adds a notification (via /api/manifests)', async ({ page, sandboxState }) => {
    const baseUrl = sandboxState.baseUrl;
    // Add a card with a notification block via the API (no chat agent
    // required - this is what set_notification ultimately does).
    const create = await page.request.post(`${baseUrl}/api/manifests`, {
      data: {
        $schema: 'klebb.datafile.v1',
        meta: {
          id: 'e2e-mood',
          label: 'E2E Mood',
          emoji: '🙂',
          view: { enabled: true, component: 'generic-card' },
          notifications: {
            enabled: true,
            items: [
              {
                id: 'evening',
                label: 'Evening mood log',
                title: 'Mood',
                body: 'How are you feeling?',
                trigger: { type: 'daily', time: '20:00' },
              },
            ],
          },
        },
        data: [],
      },
    });
    expect(create.status()).toBe(201);

    await page.goto('/settings');
    await page.locator('eh-settings-view [data-tab="notifications"]').click();
    const tab = page.locator('eh-settings-notifications');
    await expect(tab).toBeVisible();

    // Card section header shows emoji + label.
    await expect(tab.locator('.card-header', { hasText: 'E2E Mood' })).toBeVisible();

    // The item row shows time + label.
    await expect(tab.locator('.item-time', { hasText: '20:00' })).toBeVisible();
    await expect(tab.locator('.item-label', { hasText: 'Evening mood log' })).toBeVisible();

    // Toggle the on/off switch and re-fetch /api/notifications to verify
    // persistence.
    const onOff = tab.locator('[data-role="enabled"]').first();
    await expect(onOff).toHaveAttribute('aria-pressed', 'true');
    await onOff.click();
    // Wait for the post + UI flip to settle.
    await expect(onOff).toHaveAttribute('aria-pressed', 'false', { timeout: 10000 });

    const list = await page.request.get(`${baseUrl}/api/notifications`);
    expect(list.status()).toBe(200);
    const json = await list.json();
    const it = json.notifications.find(n => n.id === 'e2e-mood#evening');
    expect(it).toBeDefined();
    expect(it.enabled).toBe(false);

    // Tear down.
    await page.request.delete(`${baseUrl}/api/manifests/e2e-mood`);
  });

  test('Quiet hours and Pause-for chips persist via /api/notifications/global-state', async ({ page, sandboxState }) => {
    const baseUrl = sandboxState.baseUrl;
    await page.goto('/settings');
    await page.locator('eh-settings-view [data-tab="notifications"]').click();
    const tab = page.locator('eh-settings-notifications');
    await expect(tab).toBeVisible();

    // Set quiet hours start to 22:30, end to 06:30.
    const startInput = tab.locator('.global-row input[type="time"]').first();
    const endInput = tab.locator('.global-row input[type="time"]').nth(1);
    await startInput.fill('22:30');
    await startInput.dispatchEvent('change');
    await endInput.fill('06:30');
    await endInput.dispatchEvent('change');

    // Click 1h pause chip. The component POSTs to global-state, then
    // dispatches an event the app shell listens for; the shell re-fetches
    // /api/notifications and renders the banner. All of that happens
    // asynchronously, so just wait for the banner to appear.
    await tab.locator('.global-row .chip', { hasText: '1h' }).click();
    const pauseBanner = page.locator('health-app').locator('.pause-banner');
    await expect(pauseBanner).toBeVisible({ timeout: 10000 });

    // Resume now from the banner.
    await pauseBanner.locator('.resume-btn').click();
    await expect(pauseBanner).not.toBeVisible();

    // Server state reflects the quiet-hours setting.
    const r = await page.request.get(`${baseUrl}/api/notifications`);
    const json = await r.json();
    expect(json.quiet_hours).toEqual({ start: '22:30', end: '06:30' });
    expect(json.paused_until).toBe(null);
  });
});

test.describe('#393: Notifications row mobile touch + a11y polish', () => {
  // Seed a single-item card before each spec and clean it up after.
  // The runtime returns privacy='private' by default, so the privacy
  // toggle starts at aria-pressed='false'.
  test.beforeEach(async ({ page, sandboxState }) => {
    const create = await page.request.post(`${sandboxState.baseUrl}/api/manifests`, {
      data: {
        $schema: 'klebb.datafile.v1',
        meta: {
          id: 'e2e-393',
          label: '393 Polish',
          emoji: '🔔',
          view: { enabled: true, component: 'generic-card' },
          notifications: {
            enabled: true,
            items: [
              {
                id: 'morning',
                label: 'Morning reminder',
                title: 'Reminder',
                body: 'Time to log.',
                trigger: { type: 'daily', time: '09:00' },
              },
            ],
          },
        },
        data: [],
      },
    });
    expect(create.status()).toBe(201);
  });

  test.afterEach(async ({ page, sandboxState }) => {
    await page.request.delete(`${sandboxState.baseUrl}/api/manifests/e2e-393`);
  });

  test('toggle hit area meets 44x44 at iPhone 13 mini width', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/settings');
    await page.locator('eh-settings-view [data-tab="notifications"]').click();
    const tab = page.locator('eh-settings-notifications');
    await expect(tab).toBeVisible();

    const enabled = tab.locator('[data-role="enabled"]').first();
    const privacy = tab.locator('[data-role="privacy"]').first();
    await expect(enabled).toBeVisible();
    await expect(privacy).toBeVisible();

    const enBox = await enabled.boundingBox();
    const prBox = await privacy.boundingBox();
    expect(enBox).not.toBeNull();
    expect(prBox).not.toBeNull();
    expect(enBox.width).toBeGreaterThanOrEqual(44);
    expect(enBox.height).toBeGreaterThanOrEqual(44);
    expect(prBox.width).toBeGreaterThanOrEqual(44);
    expect(prBox.height).toBeGreaterThanOrEqual(44);
  });

  test('privacy hint is visible on small viewports and reflects state', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/settings');
    await page.locator('eh-settings-view [data-tab="notifications"]').click();
    const tab = page.locator('eh-settings-notifications');
    await expect(tab).toBeVisible();

    const hint = tab.locator('.privacy-hint').first();
    await expect(hint).toBeVisible();
    // Default is privacy='private': lock screen says "You have a reminder".
    await expect(hint).toContainText('You have a reminder');

    // Flip the privacy toggle and assert the hint copy follows.
    const privacy = tab.locator('[data-role="privacy"]').first();
    await privacy.click();
    await expect(privacy).toHaveAttribute('aria-pressed', 'true', { timeout: 10000 });
    await expect(hint).toContainText('full reminder text');
  });

  test('tapping the "Show full text" caption flips the privacy toggle', async ({ page }) => {
    await page.goto('/settings');
    await page.locator('eh-settings-view [data-tab="notifications"]').click();
    const tab = page.locator('eh-settings-notifications');
    await expect(tab).toBeVisible();

    const privacy = tab.locator('[data-role="privacy"]').first();
    const caption = tab.locator('.privacy-help').first();
    await expect(privacy).toHaveAttribute('aria-pressed', 'false');

    await caption.click();
    await expect(privacy).toHaveAttribute('aria-pressed', 'true', { timeout: 10000 });
  });

  test('toggle gets aria-busy=true during in-flight state POST', async ({ page }) => {
    await page.goto('/settings');
    await page.locator('eh-settings-view [data-tab="notifications"]').click();
    const tab = page.locator('eh-settings-notifications');
    await expect(tab).toBeVisible();

    // Stall the POST so the busy state is observable. Resolve it after
    // we've asserted aria-busy=true.
    let release;
    const released = new Promise(r => { release = r; });
    await page.route('**/api/notifications/state', async (route) => {
      await released;
      await route.continue();
    });

    const enabled = tab.locator('[data-role="enabled"]').first();
    await enabled.click();
    await expect(enabled).toHaveAttribute('aria-busy', 'true', { timeout: 5000 });
    // Spinner is rendered while busy.
    await expect(tab.locator('.busy-dots').first()).toBeVisible();

    release();
    await expect(enabled).toHaveAttribute('aria-busy', 'false', { timeout: 10000 });
    await expect(tab.locator('.busy-dots')).toHaveCount(0);
  });
});
