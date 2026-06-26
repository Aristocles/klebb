// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests-e2e/card-settings-gear.spec.js
// Live coverage for the per-card settings gear (#456): the gear opens a
// modal of behaviour toggles that APPLY IMMEDIATELY (no Save button), the
// sparkline toggle is data-gated (disabled until >=2 points), reminders
// can be turned on/off, advanced features park-and-restore, and every
// "Ask Klebbius" is an inline link that seeds the chat. Mutates sandbox
// state, so runs serial + restores.

const { test, expect } = require('./helpers/auth-fixture');
const { todayISO, shiftDays } = require('./helpers/seed-manifests');

test.describe.configure({ mode: 'serial' });

// Poll a manifest's meta until `pick` returns the expected value, proving
// an apply-immediately toggle persisted without a Save step.
async function expectMeta(page, baseUrl, id, pick, expected) {
  await expect.poll(async () => {
    const j = await (await page.request.get(`${baseUrl}/api/manifests/${id}`)).json();
    return pick(j.meta);
  }).toEqual(expected);
}

test.describe('#456: per-card settings gear', () => {
  // Keep the mood daily prompt from firing mid-spec and stealing clicks.
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      const d = new Date();
      const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      try { localStorage.setItem(`klebb-prompt-shown-mood-${today}`, '1'); } catch {}
    });
  });

  test('gear opens the modal and a toggle applies immediately (no Save)', async ({ page, sandboxState }) => {
    const baseUrl = sandboxState.baseUrl;
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
    await expect(modal.locator('.title')).toHaveText('Weight');
    // No Save button exists.
    await expect(modal.locator('.save-btn')).toHaveCount(0);

    // Flip "Prompt me to log this daily" — applies on click, no Save.
    const promptToggle = modal.locator('.row', { hasText: 'Prompt me to log this daily' }).locator('.toggle');
    const wasChecked = (await promptToggle.getAttribute('aria-checked')) === 'true';
    await promptToggle.click();
    await expectMeta(page, baseUrl, 'weight', m => !!m.prompt?.enabled, !wasChecked);
    // The modal stays open; the toggle reflects the new state.
    await expect(modal.locator('dialog')).toBeVisible();
    await expect(promptToggle).toHaveAttribute('aria-checked', String(!wasChecked));

    await page.request.fetch(`${baseUrl}/api/manifests/weight`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      data: { meta: { prompt: { enabled: promptWasEnabled } } },
    });
  });

  test('there is no whole-card / view-visibility toggle in the gear', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('eh-date-view')).toBeVisible();
    const weightCard = page.locator('eh-generic-card', { hasText: 'Weight' }).first();
    await weightCard.locator('.settings-gear').click();
    const modal = page.locator('eh-card-settings-modal');
    await expect(modal.locator('dialog')).toBeVisible();
    // Visibility lives in Settings > Cards, not here.
    await expect(modal.locator('.row', { hasText: 'Show on Today' })).toHaveCount(0);
    await expect(modal.locator('.row', { hasText: 'Show in Trends' })).toHaveCount(0);
  });

  test('sparkline toggle applies immediately and the card reflects it', async ({ page, sandboxState }) => {
    const baseUrl = sandboxState.baseUrl;
    const before = await (await page.request.get(`${baseUrl}/api/manifests/weight`)).json();
    const sparkWas = !!before.meta?.view?.showSparkline;

    await page.goto('/');
    await expect(page.locator('eh-date-view')).toBeVisible();

    const weightCard = page.locator('eh-generic-card', { hasText: 'Weight' }).first();
    await weightCard.locator('.settings-gear').click();
    const modal = page.locator('eh-card-settings-modal');
    await expect(modal.locator('dialog')).toBeVisible();

    const sparkToggle = modal.locator('.row', { hasText: 'Show trend sparkline' }).locator('.toggle');
    await expect(sparkToggle).toBeEnabled();
    if ((await sparkToggle.getAttribute('aria-checked')) !== 'true') await sparkToggle.click();
    await expectMeta(page, baseUrl, 'weight', m => !!m.view?.showSparkline, true);

    // Close the modal; the sparkline now renders on the card.
    await modal.locator('.close-btn').click();
    await expect(modal).toHaveCount(0);
    await expect(weightCard.locator('eh-sparkline')).toBeVisible();

    await page.request.fetch(`${baseUrl}/api/manifests/weight`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      data: { meta: { view: { showSparkline: sparkWas } } },
    });
  });

  test('sparkline toggle is disabled with a hint on a card with too few points', async ({ page, sandboxState }) => {
    const baseUrl = sandboxState.baseUrl;
    const today = todayISO();
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

  test('footer Ask-Klebbius link seeds the chat with this card context', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('eh-date-view')).toBeVisible();
    await page.evaluate(() => {
      window.__seeded = null;
      window.addEventListener('klebb-paste-into-chat', (e) => { window.__seeded = e.detail?.text || ''; });
    });

    const weightCard = page.locator('eh-generic-card', { hasText: 'Weight' }).first();
    await weightCard.locator('.settings-gear').click();
    const modal = page.locator('eh-card-settings-modal');
    await expect(modal.locator('dialog')).toBeVisible();
    // The footer is a sentence with an inline "Ask Klebbius" link.
    await modal.locator('.footer-note .klebbius-link').click();

    await expect(modal).toHaveCount(0);
    const seeded = await page.evaluate(() => window.__seeded);
    expect(seeded).toContain('weight');
  });

  test('schedule-card gear adherence sparkline toggle applies immediately', async ({ page, sandboxState }) => {
    const baseUrl = sandboxState.baseUrl;
    const before = await (await page.request.get(`${baseUrl}/api/manifests/peptides`)).json();
    const sparkWas = !!before.meta?.view?.showSparkline;

    await page.goto('/');
    await expect(page.locator('eh-date-view')).toBeVisible();

    const scheduleCard = page.locator('eh-schedule-card').first();
    await scheduleCard.locator('.settings-gear').click();
    const modal = page.locator('eh-card-settings-modal');
    await expect(modal.locator('dialog')).toBeVisible();

    const toggle = modal.locator('.row', { hasText: 'Show adherence sparkline' }).locator('.toggle');
    await expect(toggle).toBeEnabled();
    if ((await toggle.getAttribute('aria-checked')) !== 'true') await toggle.click();
    await expectMeta(page, baseUrl, 'peptides', m => !!m.view?.showSparkline, true);

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
    const before = await (await page.request.get(`${baseUrl}/api/manifests/weight`)).json();
    const hadNotifs = before.meta?.notifications !== undefined;

    await page.goto('/');
    await expect(page.locator('eh-date-view')).toBeVisible();
    const weightCard = page.locator('eh-generic-card', { hasText: 'Weight' }).first();
    await weightCard.locator('.settings-gear').click();
    const modal = page.locator('eh-card-settings-modal');
    await expect(modal.locator('dialog')).toBeVisible();

    const toggle = modal.locator('.row', { hasText: 'Reminders' }).locator('.toggle');
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await toggle.click();

    // Applied immediately: one private daily reminder now exists.
    await expect.poll(async () => {
      const m = (await (await page.request.get(`${baseUrl}/api/manifests/weight`)).json()).meta;
      const n = m.notifications;
      if (!n || !Array.isArray(n.items) || n.items.length !== 1) return null;
      return { enabled: n.enabled, type: n.items[0].trigger.type, time: n.items[0].trigger.time, privacy: n.items[0].privacy };
    }).toEqual({ enabled: true, type: 'daily', time: '09:00', privacy: 'private' });

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
      await toggle.click(); // master off, applies immediately

      await expect.poll(async () => {
        const n = (await (await page.request.get(`${baseUrl}/api/manifests/${id}`)).json()).meta.notifications;
        return { enabled: n.enabled, items: n.items.length, id0: n.items[0]?.id };
      }).toEqual({ enabled: false, items: 1, id0: 'morning' });
    } finally {
      await page.request.delete(`${baseUrl}/api/manifests/${id}`);
    }
  });

  test('notifications: a read-only card shows a clickable hint, no toggle', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('eh-date-view')).toBeVisible();
    // workouts is fromWebapp:false with no notifications -> 'none' state.
    const card = page.locator('eh-generic-card', { hasText: 'Workouts' }).first();
    await card.locator('.settings-gear').click();
    const modal = page.locator('eh-card-settings-modal');
    await expect(modal.locator('dialog')).toBeVisible();
    const notifRow = modal.locator('.row', { hasText: 'Reminders' });
    await expect(notifRow.locator('.toggle')).toHaveCount(0);
    await expect(notifRow.locator('.klebbius-link')).toBeVisible();
  });

  test('advanced feature: disabling parks the block, re-enabling restores it', async ({ page, sandboxState }) => {
    const baseUrl = sandboxState.baseUrl;
    const id = 'e2e_adv_456';
    const checkOffForm = { currentDoseFields: ['site'], previousDoseFields: ['reactions'] };
    const create = await page.request.post(`${baseUrl}/api/manifests`, {
      data: {
        $schema: 'klebb.datafile.v1',
        meta: {
          id, label: 'Adv 456', emoji: '🧬', order: 953,
          view: { enabled: true, component: 'schedule-card', checkOffForm },
          writeable: {
            fromWebapp: true, todayAllowed: true,
            inputs: [{ key: 'site', type: 'text' }, { key: 'reactions', type: 'text' }],
          },
        },
        data: { items: [{ id: 'a', name: 'Item A', schedule: { type: 'daily_straight', days: ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'] } }] },
      },
    });
    expect(create.status()).toBe(201);
    try {
      await page.goto('/');
      await expect(page.locator('eh-date-view')).toBeVisible();
      const card = page.locator('eh-schedule-card', { hasText: 'Adv 456' }).first();
      await card.locator('.settings-gear').click();
      const modal = page.locator('eh-card-settings-modal');
      await expect(modal.locator('dialog')).toBeVisible();

      const toggle = modal.locator('.row', { hasText: 'Per-dose check-off form' }).locator('.toggle');
      await expect(toggle).toHaveAttribute('aria-checked', 'true');
      await toggle.click(); // off, applies immediately -> parks the block

      await expect.poll(async () => {
        const m = (await (await page.request.get(`${baseUrl}/api/manifests/${id}`)).json()).meta;
        return { live: m.view.checkOffForm, parked: m.view._disabled?.checkOffForm };
      }).toEqual({ live: undefined, parked: checkOffForm });

      // The same modal now shows it OFF; toggle back on -> restored exactly.
      await expect(toggle).toHaveAttribute('aria-checked', 'false');
      await toggle.click();
      await expectMeta(page, baseUrl, id, m => m.view.checkOffForm, checkOffForm);
    } finally {
      await page.request.delete(`${baseUrl}/api/manifests/${id}`);
    }
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
