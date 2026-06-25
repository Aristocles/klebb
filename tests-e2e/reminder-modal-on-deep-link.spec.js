// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests-e2e/reminder-modal-on-deep-link.spec.js
// #454: tapping a schedule_due notification re-shows the items the
// notification was reminding about. Playwright can't trigger real OS
// notifications, so the spec seeds the SW IndexedDB stash that
// handlePush would have written, then reloads — the cold-start path
// reads the stash on boot and surfaces the modal.

const { test, expect } = require('./helpers/auth-fixture');

const STASH_DB = 'klebb-sw';
const STASH_STORE = 'deep-links';

async function seedDeepLinkStash(page, value) {
  await page.evaluate(
    ({ name, store, payload }) => new Promise((resolve, reject) => {
      const req = indexedDB.open(name, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(store)) db.createObjectStore(store);
      };
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(store, 'readwrite');
        tx.objectStore(store).put(payload, 'pending');
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    }),
    { name: STASH_DB, store: STASH_STORE, payload: value },
  );
}

test.describe('#454: reminder modal on notification tap', () => {
  test('cold-start with reminders in IDB renders the modal grouped by source card', async ({ page }) => {
    // Land on the app once so the SW registers and the IDB exists.
    await page.goto('/');
    await expect(page.locator('eh-date-view')).toBeVisible();

    await seedDeepLinkStash(page, {
      ts: Date.now(),
      url: '/?card=peptide-cycle',
      cardId: 'peptide-cycle',
      reminders: [
        {
          cardId: 'peptide-cycle',
          cardLabel: 'Injections',
          cardEmoji: '💉',
          due_now: [{ name: 'Ozempic', short_name: 'Ozempic', dose: '0.5mg · subQ', timing: 'morning' }],
          missed_earlier: [{ name: 'BPC-157', short_name: 'BPC-157', dose: '0.5mg' }],
        },
      ],
    });

    // Reload triggers _consumePendingDeepLink() in the constructor.
    await page.goto('/');

    const modal = page.locator('eh-reminder-modal');
    const dlg = modal.locator('dialog');
    await expect(dlg).toBeVisible();
    await expect(modal).toContainText('Reminders');
    await expect(modal).toContainText('Due now');
    await expect(modal).toContainText('Ozempic');
    await expect(modal).toContainText('Missed earlier');
    await expect(modal).toContainText('BPC-157');
    // Group header shows the card label + emoji once per group.
    await expect(modal.locator('.group-label')).toContainText('Injections');
    // Dose meta is rendered next to the row name.
    await expect(modal).toContainText('0.5mg · subQ');
    // One Open card button per group, not per row.
    await expect(modal.locator('.open-btn')).toHaveCount(1);

    // Top-right ✕ clears the modal.
    await modal.locator('button.close-btn').click();
    await expect(modal).toHaveCount(0);
  });

  test('Open card button: routes to /?card=<id> and closes modal', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('eh-date-view')).toBeVisible();

    await seedDeepLinkStash(page, {
      ts: Date.now(),
      url: '/?card=peptide-cycle',
      cardId: 'peptide-cycle',
      reminders: [
        {
          cardId: 'peptide-cycle',
          cardLabel: 'Injections',
          cardEmoji: '💉',
          due_now: [{ name: 'Ozempic', short_name: 'Ozempic' }],
          missed_earlier: [],
        },
      ],
    });
    await page.goto('/');

    const modal = page.locator('eh-reminder-modal');
    await expect(modal.locator('dialog')).toBeVisible();
    await modal.locator('.open-btn').click();
    await expect(modal).toHaveCount(0);
    expect(new URL(page.url()).search).toContain('card=peptide-cycle');
  });

  test('only "due now" rows present: missed-earlier section is omitted', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('eh-date-view')).toBeVisible();

    await seedDeepLinkStash(page, {
      ts: Date.now(),
      url: '/?card=mood',
      cardId: 'mood',
      reminders: [
        {
          cardId: 'mood',
          cardLabel: 'Mood',
          cardEmoji: '🙂',
          due_now: [{ name: 'Evening check-in', short_name: 'Evening' }],
          missed_earlier: [],
        },
      ],
    });
    await page.goto('/');

    const modal = page.locator('eh-reminder-modal');
    const dlg = modal.locator('dialog');
    await expect(dlg).toBeVisible();
    await expect(modal).toContainText('Due now');
    await expect(modal).not.toContainText('Missed earlier');
  });

  test('IDB stash with no reminders block: no modal appears', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('eh-date-view')).toBeVisible();

    // Daily/weekly notification path - SW omits the reminders field.
    await seedDeepLinkStash(page, {
      ts: Date.now(),
      url: '/?card=mood',
      cardId: 'mood',
    });
    await page.goto('/');

    // Wait long enough for any constructor-time consume to settle.
    await page.waitForTimeout(200);
    await expect(page.locator('eh-reminder-modal')).toHaveCount(0);
  });

  test('empty reminders array: no modal (defensive)', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('eh-date-view')).toBeVisible();

    await seedDeepLinkStash(page, {
      ts: Date.now(),
      url: '/?card=mood',
      cardId: 'mood',
      reminders: [],
    });
    await page.goto('/');

    await page.waitForTimeout(200);
    await expect(page.locator('eh-reminder-modal')).toHaveCount(0);
  });
});
