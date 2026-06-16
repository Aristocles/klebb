// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests-e2e/schedule-due-time-of-day-chips.spec.js
// Coverage for #397 Phase 2a + 2c: time-of-day chips on schedule-card and
// checklist-card items, plus a happy-path round-trip authoring a manifest
// with a schedule_due notification trigger.
//
// Negative validation cases (bad time_of_day tokens, missing card field,
// malformed schedule_due trigger) are deliberately NOT covered here:
// they're exhaustively unit-tested in tests/notifications-schedule-due.test.js
// and tests/schedule-time-of-day-validation.test.js, and the HTTP layer
// just surfaces the validator's throws. e2e is the wrong layer for that.

const { test, expect } = require('./helpers/auth-fixture');

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

const SCHEDULE_CARD_ID = 'tod-chips-schedule-e2e';
const CHECKLIST_CARD_ID = 'tod-chips-checklist-e2e';
const NOTIFY_CARD_ID = 'tod-schedule-due-notify-e2e';

function activeCycle(today) {
  return [{
    type: 'on',
    status: 'active',
    cycle_number: 1,
    start: shiftDays(today, -5),
    end: shiftDays(today, 25),
    start_date: shiftDays(today, -5),
    end_date: shiftDays(today, 25),
  }];
}

function scheduleCardManifest(today) {
  return {
    $schema: 'klebb.datafile.v1',
    meta: {
      id: SCHEDULE_CARD_ID,
      label: 'Time-of-day schedule chips (e2e)',
      emoji: '💉',
      order: 9700,
      category: 'protocols',
      view: { enabled: true, component: 'schedule-card' },
      writeable: { fromWebapp: true, todayAllowed: true, pastAllowed: true, futureAllowed: false },
    },
    description: 'Time-of-day chip rendering on schedule-card items (#397 Phase 2a).',
    data: {
      items: [
        {
          name: 'Morning-only',
          short_name: 'Morning-only',
          schedule: { type: 'daily', time_of_day: 'morning' },
          cycles: activeCycle(today),
        },
        {
          // Manifest order is intentionally [evening, morning] so the
          // renderer's slot-order sort is exercised: morning chip must
          // appear FIRST despite its position in the array.
          name: 'Twice-daily',
          short_name: 'Twice-daily',
          schedule: { type: 'daily', time_of_day: ['evening', 'morning'] },
          cycles: activeCycle(today),
        },
        {
          name: 'No-tod',
          short_name: 'No-tod',
          schedule: { type: 'daily' },
          cycles: activeCycle(today),
        },
      ],
    },
  };
}

function checklistCardManifest(today) {
  return {
    $schema: 'klebb.datafile.v1',
    meta: {
      id: CHECKLIST_CARD_ID,
      label: 'Time-of-day checklist chips (e2e)',
      emoji: '💊',
      order: 9701,
      category: 'supplements',
      view: { enabled: true, component: 'checklist-card' },
      writeable: { fromWebapp: true, todayAllowed: true, pastAllowed: true, futureAllowed: false },
    },
    description: 'Time-of-day chip rendering on checklist-card items (#397 Phase 2a).',
    data: {
      items: [
        {
          name: 'Lunchtime supplement',
          short_name: 'Lunch',
          schedule: { type: 'daily', time_of_day: 'midday' },
          cycles: activeCycle(today),
        },
      ],
    },
  };
}

async function seed(request, baseUrl, m) {
  await request.delete(`${baseUrl}/api/manifests/${m.meta.id}`).catch(() => {});
  const r = await request.post(`${baseUrl}/api/manifests`, { data: m });
  expect([201, 409]).toContain(r.status());
}

async function cleanup(request, baseUrl, id) {
  await request.delete(`${baseUrl}/api/manifests/${id}`).catch(() => {});
}

test.describe('#397 Phase 2a: time-of-day chips on schedule-card', () => {
  test('chips render per item per token, ordered by slot, none when absent', async ({ page, sandboxState }) => {
    const today = todayISO();
    const m = scheduleCardManifest(today);
    await seed(page.request, sandboxState.baseUrl, m);

    await page.goto('/');
    await expect(page.locator('eh-date-view')).toBeVisible({ timeout: 10_000 });

    const card = page.locator(`[data-card-id="${SCHEDULE_CARD_ID}"] eh-schedule-card`);
    await expect(card).toBeVisible({ timeout: 10_000 });

    // The renderer iterates the manifest items in declared order. Walk
    // .item-row entries in DOM order and capture their tod-chip emojis +
    // labels for assertion.
    const chipsByRow = await card.evaluate((root) => {
      const sr = root.shadowRoot;
      if (!sr) return null;
      const rows = Array.from(sr.querySelectorAll('.item-row'));
      return rows.map((row) => {
        const name = (row.querySelector('.name') || {}).textContent || '';
        const chips = Array.from(row.querySelectorAll('.tod-chip')).map((c) => ({
          emoji: c.textContent.trim(),
          label: c.getAttribute('aria-label'),
          title: c.getAttribute('title'),
        }));
        return { name: name.trim(), chips };
      });
    });

    expect(chipsByRow).not.toBeNull();
    expect(chipsByRow.length).toBe(3);

    const morningOnly = chipsByRow.find((r) => r.name === 'Morning-only');
    const twiceDaily = chipsByRow.find((r) => r.name === 'Twice-daily');
    const noTod = chipsByRow.find((r) => r.name === 'No-tod');

    expect(morningOnly).toBeTruthy();
    expect(morningOnly.chips).toEqual([
      { emoji: '☀️', label: 'Morning', title: 'Morning' },
    ]);

    expect(twiceDaily).toBeTruthy();
    // Morning before evening despite the manifest array being
    // ['evening', 'morning']: chipsFor sorts by slot.
    expect(twiceDaily.chips.length).toBe(2);
    expect(twiceDaily.chips[0]).toEqual({ emoji: '☀️', label: 'Morning', title: 'Morning' });
    expect(twiceDaily.chips[1]).toEqual({ emoji: '🌙', label: 'Evening', title: 'Evening' });

    expect(noTod).toBeTruthy();
    expect(noTod.chips).toEqual([]);

    await cleanup(page.request, sandboxState.baseUrl, SCHEDULE_CARD_ID);
  });
});

test.describe('#397 Phase 2a: time-of-day chips on checklist-card', () => {
  test('midday chip renders the partly-sunny emoji next to the item name', async ({ page, sandboxState }) => {
    const today = todayISO();
    const m = checklistCardManifest(today);
    await seed(page.request, sandboxState.baseUrl, m);

    await page.goto('/');
    await expect(page.locator('eh-date-view')).toBeVisible({ timeout: 10_000 });

    const card = page.locator(`[data-card-id="${CHECKLIST_CARD_ID}"] eh-checklist-card`);
    await expect(card).toBeVisible({ timeout: 10_000 });

    const chips = await card.evaluate((root) => {
      const sr = root.shadowRoot;
      if (!sr) return null;
      return Array.from(sr.querySelectorAll('.tod-chip')).map((c) => ({
        emoji: c.textContent.trim(),
        label: c.getAttribute('aria-label'),
        title: c.getAttribute('title'),
      }));
    });

    expect(chips).not.toBeNull();
    expect(chips).toEqual([
      { emoji: '🌤️', label: 'Midday', title: 'Midday' },
    ]);

    await cleanup(page.request, sandboxState.baseUrl, CHECKLIST_CARD_ID);
  });
});

test.describe('#397 Phase 2c: schedule_due notification round-trips through POST /api/manifests', () => {
  test('manifest with a schedule_due trigger is accepted and persists the normalised trigger', async ({ page, sandboxState }) => {
    const baseUrl = sandboxState.baseUrl;
    // First create the target schedule-card the trigger points at — the
    // notifications validator only checks that trigger.card matches the
    // CARD_ID_PATTERN; it doesn't require the card to exist. Seeding it
    // anyway so the manifest mirrors a realistic authoring sequence.
    const today = todayISO();
    await seed(page.request, baseUrl, {
      $schema: 'klebb.datafile.v1',
      meta: {
        id: NOTIFY_CARD_ID,
        label: 'Notify target (e2e)',
        emoji: '💉',
        order: 9702,
        view: { enabled: true, component: 'schedule-card' },
        writeable: { fromWebapp: true, todayAllowed: true, pastAllowed: true, futureAllowed: false },
        notifications: {
          enabled: true,
          items: [
            {
              id: 'morning-jab',
              label: 'Morning injection',
              title: 'Injection',
              body: 'Time for {schedule_due}',
              trigger: {
                type: 'schedule_due',
                card: NOTIFY_CARD_ID,
                time_of_day: 'morning',
                time: '08:00',
              },
              privacy: 'public',
              default: 'on',
            },
          ],
        },
      },
      description: 'schedule_due happy-path round-trip (#397 Phase 2c).',
      data: {
        items: [
          {
            name: 'BPC-157',
            short_name: 'BPC-157',
            schedule: { type: 'daily', time_of_day: 'morning' },
            cycles: activeCycle(today),
          },
        ],
      },
    });

    const fetched = await page.request.get(`${baseUrl}/api/manifests/${NOTIFY_CARD_ID}`);
    expect(fetched.status()).toBe(200);
    const body = await fetched.json();

    const items = body.meta && body.meta.notifications && body.meta.notifications.items;
    expect(Array.isArray(items)).toBe(true);
    expect(items.length).toBe(1);
    const trig = items[0].trigger;
    expect(trig.type).toBe('schedule_due');
    expect(trig.card).toBe(NOTIFY_CARD_ID);
    expect(trig.time_of_day).toBe('morning');
    expect(trig.time).toBe('08:00');

    // The schedule item's time_of_day passes through validation intact.
    expect(body.data.items[0].schedule.time_of_day).toBe('morning');

    await cleanup(page.request, baseUrl, NOTIFY_CARD_ID);
  });
});
