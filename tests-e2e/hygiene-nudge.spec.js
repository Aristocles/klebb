// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests-e2e/hygiene-nudge.spec.js
// #452: the chat peek bar surfaces a dismissible stale-card nudge when
// GET /api/hygiene has findings. Tapping it seeds the chat; dismissing
// reverts the bar and persists server-side. Seeds its own stale card via
// API and removes it afterwards so other specs see a clean sandbox.

const { test, expect } = require('./helpers/auth-fixture');
const { todayISO, shiftDays } = require('./helpers/seed-manifests');

const ID = 'e2e_stale_452';

function staleCard(today) {
  // Rows ending ~40 days ago: past the declared 21-day window, and enough rows
  // to clear the near-empty suppression in chat/hygiene.js. meta.cadence is
  // required for staleness at all since #570 (no declaration, no nudge).
  return {
    $schema: 'klebb.datafile.v1',
    meta: {
      id: ID, label: 'Stale 452', emoji: '🧪', order: 940,
      cadence: { expectDays: 21 },
      view: { enabled: true, component: 'generic-card', display: { template: '{n}' } },
      writeable: { fromWebapp: true, todayAllowed: true, inputs: [{ key: 'n', type: 'number' }] },
    },
    data: [
      { date: shiftDays(today, -44), n: 1 },
      { date: shiftDays(today, -42), n: 2 },
      { date: shiftDays(today, -40), n: 3 },
    ],
  };
}

async function dismissMoodPromptIfUp(page) {
  const promptModal = page.locator('eh-prompt-modal dialog');
  await promptModal.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
  if (await promptModal.isVisible().catch(() => false)) {
    await promptModal.locator('button[aria-label="Dismiss"]').click();
    await expect(promptModal).not.toBeVisible();
  }
}

test.describe('#452: stale-card nudge in the chat peek bar', () => {
  let baseUrl;

  test.beforeEach(async ({ page, sandboxState }) => {
    baseUrl = sandboxState.baseUrl;
    const create = await page.request.post(`${baseUrl}/api/manifests`, {
      data: staleCard(todayISO()),
    });
    expect(create.status()).toBe(201);
  });

  test.afterEach(async ({ page }) => {
    await page.request.delete(`${baseUrl}/api/manifests/${ID}`);
  });

  test('nudge shows for a stale card and tapping it seeds the chat', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('eh-date-view')).toBeVisible();
    await dismissMoodPromptIfUp(page);

    const chat = page.locator('health-chat');
    const nudge = chat.locator('.peek-bar.nudge');
    await expect(nudge).toBeVisible();
    await expect(nudge).toContainText(ID);
    await expect(nudge).toContainText(/days/);

    await nudge.click();
    const input = chat.locator('.chat-input');
    await expect(input).toBeVisible();
    await expect(input).toHaveValue(new RegExp(`${ID}.*stale`, 's'));
  });

  test('dismiss reverts the bar without opening chat, and persists', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('eh-date-view')).toBeVisible();
    await dismissMoodPromptIfUp(page);

    const chat = page.locator('health-chat');
    await expect(chat.locator('.peek-bar.nudge')).toBeVisible();

    await chat.locator('.nudge-dismiss').click();

    // Bar reverts in place to the normal ask bar; the panel did not open.
    await expect(chat.locator('.peek-bar.nudge')).not.toBeVisible();
    await expect(chat.locator('.peek-bar')).toBeVisible();
    await expect(chat.locator('.chat-panel')).not.toBeVisible();

    // Persisted server-side: the finding stays filtered from the ambient
    // surface, so a reload shows the normal bar too.
    const r = await (await page.request.get(`${baseUrl}/api/hygiene`)).json();
    expect(r.findings.find(f => f.cardId === ID)).toBeUndefined();

    await page.reload();
    await expect(page.locator('eh-date-view')).toBeVisible();
    await expect(chat.locator('.peek-bar.nudge')).not.toBeVisible();
    await expect(chat.locator('.peek-bar')).toBeVisible();
  });
});
