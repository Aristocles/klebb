// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests-e2e/card-settings-gear.spec.js
// Live coverage for the per-card settings gear (#456): the gear opens a
// modal of safe toggles, flipping one persists via PATCH and the view
// reflects it, the sparkline toggle is data-gated (disabled until there
// are >=2 numeric points), and the Ask-Klebbius link seeds the chat with
// card context. Mutates sandbox state, so runs serial + restores.

const { test, expect } = require('./helpers/auth-fixture');
const { todayISO, shiftDays } = require('./helpers/seed-manifests');

test.describe.configure({ mode: 'serial' });

test.describe('#456: per-card settings gear', () => {
  // Keep the mood daily prompt from firing mid-spec and stealing clicks.
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      const d = new Date();
      const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      try { localStorage.setItem(`klebb-prompt-shown-mood-${today}`, '1'); } catch {}
    });
  });

  test('gear opens the modal and flipping a toggle persists + reflects', async ({ page, sandboxState }) => {
    const baseUrl = sandboxState.baseUrl;
    // Snapshot weight meta so we can restore prompt.enabled afterwards.
    const before = await (await page.request.get(`${baseUrl}/api/manifests/weight`)).json();
    const promptWasEnabled = !!before.meta?.prompt?.enabled;

    await page.goto('/');
    await expect(page.locator('eh-date-view')).toBeVisible();

    const weightCard = page.locator('eh-generic-card', { hasText: 'Weight' }).first();
    const gear = weightCard.locator('.settings-gear');
    await expect(gear).toBeVisible();
    await gear.click();

    const modal = page.locator('eh-card-settings-modal');
    await expect(modal.locator('dialog')).toBeVisible();
    // Title shows the card label; kicker shows the renderer display name.
    await expect(modal.locator('.title')).toHaveText('Weight');

    // Flip "Prompt me to log this daily" (available: weight has inputs).
    const promptRow = modal.locator('.row', { hasText: 'Prompt me to log this daily' });
    const promptToggle = promptRow.locator('.toggle');
    const wasChecked = (await promptToggle.getAttribute('aria-checked')) === 'true';
    await promptToggle.click();
    await expect(promptToggle).toHaveAttribute('aria-checked', String(!wasChecked));
    await modal.locator('.save-btn').click();

    // Modal closes; the manifest reflects the change.
    await expect(modal).toHaveCount(0);
    await expect.poll(async () => {
      const j = await (await page.request.get(`${baseUrl}/api/manifests/weight`)).json();
      return !!j.meta?.prompt?.enabled;
    }).toBe(!wasChecked);

    // Restore original prompt.enabled.
    await page.request.fetch(`${baseUrl}/api/manifests/weight`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      data: { meta: { prompt: { enabled: promptWasEnabled } } },
    });
  });

  test('sparkline toggle is available on a card with >=2 points and turns it on', async ({ page, sandboxState }) => {
    const baseUrl = sandboxState.baseUrl;
    const before = await (await page.request.get(`${baseUrl}/api/manifests/weight`)).json();
    const sparkWas = !!before.meta?.view?.showSparkline;

    await page.goto('/');
    await expect(page.locator('eh-date-view')).toBeVisible();

    const weightCard = page.locator('eh-generic-card', { hasText: 'Weight' }).first();
    await weightCard.locator('.settings-gear').click();
    const modal = page.locator('eh-card-settings-modal');
    await expect(modal.locator('dialog')).toBeVisible();

    const sparkRow = modal.locator('.row', { hasText: 'Show trend sparkline' });
    const sparkToggle = sparkRow.locator('.toggle');
    // Weight has 4 numeric rows, so the toggle is interactive (not disabled).
    await expect(sparkToggle).toBeEnabled();
    if ((await sparkToggle.getAttribute('aria-checked')) !== 'true') {
      await sparkToggle.click();
    }
    await modal.locator('.save-btn').click();
    await expect(modal).toHaveCount(0);

    // The sparkline now renders on the card (Today, >=2 points).
    await expect(weightCard.locator('eh-sparkline')).toBeVisible();

    // Restore.
    await page.request.fetch(`${baseUrl}/api/manifests/weight`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      data: { meta: { view: { showSparkline: sparkWas } } },
    });
  });

  test('sparkline toggle is disabled with a hint on a card with too few points', async ({ page, sandboxState }) => {
    const baseUrl = sandboxState.baseUrl;
    const today = todayISO();
    // Throwaway generic-card with a single numeric row — below the
    // >=2-points bar the sparkline needs.
    const id = 'e2e_sparse_456';
    const create = await page.request.post(`${baseUrl}/api/manifests`, {
      data: {
        $schema: 'klebb.datafile.v1',
        meta: {
          id, label: 'Sparse 456', emoji: '🧪', order: 950,
          view: { enabled: true, component: 'generic-card', display: { template: '{n}' } },
          writeable: { fromWebapp: true, todayAllowed: true, inputs: [{ key: 'n', type: 'number' }] },
        },
        data: [{ date: shiftDays(today, -1), n: 5 }],
      },
    });
    expect(create.status()).toBe(201);

    try {
      await page.goto('/');
      await expect(page.locator('eh-date-view')).toBeVisible();
      const card = page.locator('eh-generic-card', { hasText: 'Sparse 456' }).first();
      await card.locator('.settings-gear').click();
      const modal = page.locator('eh-card-settings-modal');
      await expect(modal.locator('dialog')).toBeVisible();

      const sparkRow = modal.locator('.row', { hasText: 'Show trend sparkline' });
      await expect(sparkRow.locator('.toggle')).toBeDisabled();
      await expect(sparkRow.locator('.row-hint')).toContainText(/data/i);
    } finally {
      await page.request.delete(`${baseUrl}/api/manifests/${id}`);
    }
  });

  test('Ask Klebbius seeds the chat with this card context', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('eh-date-view')).toBeVisible();

    // Capture the seed event payload.
    await page.evaluate(() => {
      window.__seeded = null;
      window.addEventListener('klebb-paste-into-chat', (e) => { window.__seeded = e.detail?.text || ''; });
    });

    const weightCard = page.locator('eh-generic-card', { hasText: 'Weight' }).first();
    await weightCard.locator('.settings-gear').click();
    const modal = page.locator('eh-card-settings-modal');
    await expect(modal.locator('dialog')).toBeVisible();
    await modal.getByRole('button', { name: 'Ask Klebbius →' }).click();

    await expect(modal).toHaveCount(0);
    const seeded = await page.evaluate(() => window.__seeded);
    expect(seeded).toContain('weight');
  });

  test('schedule-card gear offers the adherence sparkline toggle and persists it', async ({ page, sandboxState }) => {
    const baseUrl = sandboxState.baseUrl;
    const before = await (await page.request.get(`${baseUrl}/api/manifests/peptides`)).json();
    const sparkWas = !!before.meta?.view?.showSparkline;

    await page.goto('/');
    await expect(page.locator('eh-date-view')).toBeVisible();

    const scheduleCard = page.locator('eh-schedule-card').first();
    await scheduleCard.locator('.settings-gear').click();
    const modal = page.locator('eh-card-settings-modal');
    await expect(modal.locator('dialog')).toBeVisible();

    // The peptides seed has a scheduled item, so the adherence toggle is available.
    const row = modal.locator('.row', { hasText: 'Show adherence sparkline' });
    const toggle = row.locator('.toggle');
    await expect(toggle).toBeEnabled();
    if ((await toggle.getAttribute('aria-checked')) !== 'true') await toggle.click();
    await modal.locator('.save-btn').click();
    await expect(modal).toHaveCount(0);

    await expect.poll(async () => {
      const j = await (await page.request.get(`${baseUrl}/api/manifests/peptides`)).json();
      return !!j.meta?.view?.showSparkline;
    }).toBe(true);

    // Restore.
    await page.request.fetch(`${baseUrl}/api/manifests/peptides`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      data: { meta: { view: { showSparkline: sparkWas } } },
    });
  });

  test('combination-card (read-only composite) shows no gear', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('eh-date-view')).toBeVisible();
    const combo = page.locator('eh-combination-card').first();
    await expect(combo).toBeVisible();
    await expect(combo.locator('.settings-gear')).toHaveCount(0);
  });

  test('notifications: enabling on a loggable card with none creates a private daily reminder', async ({ page, sandboxState }) => {
    const baseUrl = sandboxState.baseUrl;
    // weight is loggable (fromWebapp) and has no notifications block.
    const before = await (await page.request.get(`${baseUrl}/api/manifests/weight`)).json();
    const hadNotifs = before.meta?.notifications !== undefined;

    await page.goto('/');
    await expect(page.locator('eh-date-view')).toBeVisible();
    const weightCard = page.locator('eh-generic-card', { hasText: 'Weight' }).first();
    await weightCard.locator('.settings-gear').click();
    const modal = page.locator('eh-card-settings-modal');
    await expect(modal.locator('dialog')).toBeVisible();

    const notifRow = modal.locator('.row', { hasText: 'Reminders' });
    const toggle = notifRow.locator('.toggle');
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await toggle.click();
    await modal.locator('.save-btn').click();
    await expect(modal).toHaveCount(0);

    // The manifest gained a single private daily reminder.
    const after = await (await page.request.get(`${baseUrl}/api/manifests/weight`)).json();
    const n = after.meta.notifications;
    expect(n.enabled).toBe(true);
    expect(n.items).toHaveLength(1);
    expect(n.items[0].trigger).toMatchObject({ type: 'daily', time: '09:00' });
    expect(n.items[0].privacy).toBe('private');

    // Restore: strip the notifications block we added (null removes it).
    await page.request.fetch(`${baseUrl}/api/manifests/weight`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      data: { meta: { notifications: hadNotifs ? before.meta.notifications : null } },
    });
  });

  test('notifications: master toggle on a card with items flips enabled without wiping items', async ({ page, sandboxState }) => {
    const baseUrl = sandboxState.baseUrl;
    const id = 'e2e_notif_456';
    const create = await page.request.post(`${baseUrl}/api/manifests`, {
      data: {
        $schema: 'klebb.datafile.v1',
        meta: {
          id, label: 'Notif 456', emoji: '🔔', order: 952,
          view: { enabled: true, component: 'generic-card', display: { template: '{n}' } },
          writeable: { fromWebapp: true, todayAllowed: true, inputs: [{ key: 'n', type: 'number' }] },
          notifications: {
            enabled: true,
            items: [{ id: 'morning', label: 'Morning ping', title: 'Notif 456', body: 'Log it.', trigger: { type: 'daily', time: '07:30' } }],
          },
        },
        data: [],
      },
    });
    expect(create.status()).toBe(201);
    try {
      await page.goto('/');
      await expect(page.locator('eh-date-view')).toBeVisible();
      const card = page.locator('eh-generic-card', { hasText: 'Notif 456' }).first();
      await card.locator('.settings-gear').click();
      const modal = page.locator('eh-card-settings-modal');
      await expect(modal.locator('dialog')).toBeVisible();

      const toggle = modal.locator('.row', { hasText: 'Reminders' }).locator('.toggle');
      await expect(toggle).toHaveAttribute('aria-checked', 'true');
      await toggle.click(); // turn master off
      await modal.locator('.save-btn').click();
      await expect(modal).toHaveCount(0);

      const after = await (await page.request.get(`${baseUrl}/api/manifests/${id}`)).json();
      expect(after.meta.notifications.enabled).toBe(false);
      // Items are preserved (merge-patch never sent items[]).
      expect(after.meta.notifications.items).toHaveLength(1);
      expect(after.meta.notifications.items[0].id).toBe('morning');
    } finally {
      await page.request.delete(`${baseUrl}/api/manifests/${id}`);
    }
  });

  test('notifications: a read-only card shows the hint, no toggle', async ({ page, sandboxState }) => {
    await page.goto('/');
    await expect(page.locator('eh-date-view')).toBeVisible();
    // workouts is fromWebapp:false with no notifications -> 'none' state.
    const card = page.locator('eh-generic-card', { hasText: 'Workouts' }).first();
    await card.locator('.settings-gear').click();
    const modal = page.locator('eh-card-settings-modal');
    await expect(modal.locator('dialog')).toBeVisible();
    const notifRow = modal.locator('.row', { hasText: 'Reminders' });
    await expect(notifRow.locator('.toggle')).toHaveCount(0);
    await expect(notifRow.locator('.row-hint')).toContainText(/Klebbius/i);
  });

  test('synthetic cards (e.g. unknown renderer) do not show a gear', async ({ page, sandboxState }) => {
    const baseUrl = sandboxState.baseUrl;
    const id = 'e2e_unknown_456';
    const create = await page.request.post(`${baseUrl}/api/manifests`, {
      data: {
        $schema: 'klebb.datafile.v1',
        meta: {
          id, label: 'Unknown 456', order: 951,
          view: { enabled: true, component: 'totally-not-a-renderer' },
        },
        data: [],
      },
    });
    expect(create.status()).toBe(201);
    try {
      await page.goto('/');
      await expect(page.locator('eh-date-view')).toBeVisible();
      const card = page.locator('eh-unknown-card', { hasText: 'Unknown 456' }).first();
      await expect(card).toBeVisible();
      await expect(card.locator('.settings-gear')).toHaveCount(0);
    } finally {
      await page.request.delete(`${baseUrl}/api/manifests/${id}`);
    }
  });
});
