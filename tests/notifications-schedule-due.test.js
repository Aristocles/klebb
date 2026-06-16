// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/notifications-schedule-due.test.js
//
// Scheduler tick coverage for the schedule_due trigger: in-cycle vs
// off-cycle, rest day, already-taken, carry-forward across slots,
// time_of_day-as-array, multi-card, and the privacy templating
// interaction at fire time.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function freshState() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klebb-sched-due-'));
  const stateFile = path.join(root, 'notifications.state.json');
  const userFile = path.join(root, 'user.json');
  process.env.HEALTH_NOTIFICATIONS_STATE_FILE = stateFile;
  process.env.HEALTH_USER_FILE = userFile;
  process.env.TZ = 'Australia/Melbourne';
  for (const k of Object.keys(require.cache)) {
    if (k.includes('notifications-state')
      || k.includes('notification-trigger')
      || k.includes('notifications-scheduler')
      || k.includes('user-tz')
      || k.includes('web-push-send')
      || k.endsWith('config' + path.sep + 'paths.js')) {
      delete require.cache[k];
    }
  }
  return { root, stateFile };
}

function notifItem(overrides = {}) {
  return {
    id: 'morning-jab',
    label: 'Morning injection',
    title: 'Injection',
    body: 'Time for {schedule_due}{missed_earlier}',
    trigger: { type: 'schedule_due', card: 'peptide-cycle', time_of_day: 'morning', time: '08:00' },
    privacy: 'public',
    default: 'on',
    ...overrides,
  };
}

function buildRegistry({ items, notifications }) {
  const cards = [
    {
      meta: {
        id: 'reminders',
        label: 'Reminders',
        notifications: { enabled: true, items: notifications },
      },
      data: null,
    },
    {
      meta: { id: 'peptide-cycle', label: 'Injections' },
      data: { items },
    },
  ];
  return {
    list: () => cards,
    get: (id) => cards.find(c => c.meta.id === id) || null,
  };
}

function dailyItem({ name = 'BPC-157', short_name, time_of_day, takenToday = false, today, status }) {
  // Build a daily-scheduled item with a single dose for "today" in
  // various states. `status` overrides isScheduledOnDate in tests
  // where we want a non-scheduled day; we drive it via schedule shape.
  let schedule;
  if (status === 'rest') {
    // weekly with no on-days matching today
    schedule = { type: 'weekly', on_days: ['Sun'] };
  } else if (status === 'off') {
    // off cycle covers today
    return {
      name, short_name, schedule: { type: 'daily', time_of_day },
      cycles: [{ type: 'off', start: today, end: today }],
      doses: takenToday ? [{ scheduledDate: today, takenAt: today + 'T07:55:00' }] : [],
    };
  } else {
    schedule = { type: 'daily' };
  }
  if (time_of_day !== undefined) schedule.time_of_day = time_of_day;
  return {
    name, short_name, schedule,
    doses: takenToday ? [{ scheduledDate: today, takenAt: today + 'T07:55:00' }] : [],
  };
}

// 2026-06-12T08:00 +10:00 = 2026-06-11T22:00:00Z. The local day on
// that instant in Australia/Melbourne is 2026-06-12.
const NOW_AT_MORNING = new Date('2026-06-11T22:00:00Z');
const TODAY = '2026-06-12';

test.describe('schedule_due scheduler tick', () => {
  test('fires when a scheduled item exists at the matching slot', async () => {
    freshState();
    const scheduler = require('../lib/notifications-scheduler');
    const events = [];
    scheduler.setDispatch(async (evs) => events.push(...evs));
    scheduler._setRegistryForTests(buildRegistry({
      notifications: [notifItem()],
      items: [dailyItem({ time_of_day: 'morning', today: TODAY })],
    }));

    await scheduler._tick(NOW_AT_MORNING);

    assert.equal(events.length, 1);
    const ev = events[0];
    assert.equal(ev.items.length, 1);
    assert.equal(ev.items[0].surviving.length, 1);
    assert.equal(ev.items[0].surviving[0].name, 'BPC-157');
    assert.equal(ev.items[0].missed_earlier.length, 0);
  });

  test('off cycle: does not fire and lastFired advances (suppressed)', async () => {
    const { stateFile } = freshState();
    const scheduler = require('../lib/notifications-scheduler');
    const events = [];
    scheduler.setDispatch(async (evs) => events.push(...evs));
    scheduler._setRegistryForTests(buildRegistry({
      notifications: [notifItem()],
      items: [dailyItem({ time_of_day: 'morning', today: TODAY, status: 'off' })],
    }));

    await scheduler._tick(NOW_AT_MORNING);

    assert.equal(events.length, 0);
    const after = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(after.items['reminders#morning-jab'].lastFireStatus, 'suppressed');
  });

  test('rest day: does not fire (weekly on Sun, today is Fri)', async () => {
    freshState();
    const scheduler = require('../lib/notifications-scheduler');
    const events = [];
    scheduler.setDispatch(async (evs) => events.push(...evs));
    scheduler._setRegistryForTests(buildRegistry({
      notifications: [notifItem()],
      items: [dailyItem({ time_of_day: 'morning', today: TODAY, status: 'rest' })],
    }));

    await scheduler._tick(NOW_AT_MORNING);
    assert.equal(events.length, 0);
  });

  test('already-taken today: does not fire', async () => {
    freshState();
    const scheduler = require('../lib/notifications-scheduler');
    const events = [];
    scheduler.setDispatch(async (evs) => events.push(...evs));
    scheduler._setRegistryForTests(buildRegistry({
      notifications: [notifItem()],
      items: [dailyItem({ time_of_day: 'morning', today: TODAY, takenToday: true })],
    }));

    await scheduler._tick(NOW_AT_MORNING);
    assert.equal(events.length, 0);
  });

  test('item without time_of_day: excluded', async () => {
    freshState();
    const scheduler = require('../lib/notifications-scheduler');
    const events = [];
    scheduler.setDispatch(async (evs) => events.push(...evs));
    scheduler._setRegistryForTests(buildRegistry({
      notifications: [notifItem()],
      items: [dailyItem({ today: TODAY })], // no time_of_day at all
    }));

    await scheduler._tick(NOW_AT_MORNING);
    assert.equal(events.length, 0);
  });

  test('time_of_day as array: morning slot fires when array includes morning', async () => {
    freshState();
    const scheduler = require('../lib/notifications-scheduler');
    const events = [];
    scheduler.setDispatch(async (evs) => events.push(...evs));
    scheduler._setRegistryForTests(buildRegistry({
      notifications: [notifItem()],
      items: [dailyItem({ name: 'Twice-daily', time_of_day: ['morning', 'evening'], today: TODAY })],
    }));

    await scheduler._tick(NOW_AT_MORNING);
    assert.equal(events.length, 1);
    assert.equal(events[0].items[0].surviving[0].name, 'Twice-daily');
  });

  test('multiple items at the same slot all surface', async () => {
    freshState();
    const scheduler = require('../lib/notifications-scheduler');
    const events = [];
    scheduler.setDispatch(async (evs) => events.push(...evs));
    scheduler._setRegistryForTests(buildRegistry({
      notifications: [notifItem()],
      items: [
        dailyItem({ name: 'BPC-157', short_name: 'BPC-157', time_of_day: 'morning', today: TODAY }),
        dailyItem({ name: 'Insulin glargine', short_name: 'Insulin', time_of_day: 'morning', today: TODAY }),
      ],
    }));

    await scheduler._tick(NOW_AT_MORNING);
    assert.equal(events.length, 1);
    const surv = events[0].items[0].surviving;
    assert.equal(surv.length, 2);
    assert.deepEqual(surv.map(s => s.short_name).sort(), ['BPC-157', 'Insulin']);
  });

  test('missing target card: suppressed silently and lastFired advances', async () => {
    const { stateFile } = freshState();
    const scheduler = require('../lib/notifications-scheduler');
    const events = [];
    scheduler.setDispatch(async (evs) => events.push(...evs));
    // The notifications card declares peptide-cycle, but registry only
    // has the notifications card.
    scheduler._setRegistryForTests({
      list: () => [{
        meta: {
          id: 'reminders',
          label: 'Reminders',
          notifications: { enabled: true, items: [notifItem()] },
        },
      }],
      get: () => null,
    });

    await scheduler._tick(NOW_AT_MORNING);
    assert.equal(events.length, 0);
    const after = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(after.items['reminders#morning-jab'].lastFireStatus, 'suppressed');
  });
});

test.describe('schedule_due carry-forward', () => {
  test('evening fire pulls in unfired earlier-slot items as missed_earlier', async () => {
    freshState();
    const scheduler = require('../lib/notifications-scheduler');
    const events = [];
    scheduler.setDispatch(async (evs) => events.push(...evs));
    // Two items: one morning (not taken), one evening (now firing).
    scheduler._setRegistryForTests(buildRegistry({
      notifications: [
        // Evening trigger at 20:00 in Melbourne TZ.
        notifItem({
          id: 'evening-jab',
          trigger: { type: 'schedule_due', card: 'peptide-cycle', time_of_day: 'evening', time: '20:00' },
        }),
      ],
      items: [
        dailyItem({ name: 'BPC-157', short_name: 'BPC-157', time_of_day: 'morning', today: TODAY }),
        dailyItem({ name: 'Ozempic', short_name: 'Ozempic', time_of_day: 'evening', today: TODAY }),
      ],
    }));

    // Evening fire: 20:00 +10 on 2026-06-12 = 10:00 UTC same day.
    const eveningNow = new Date('2026-06-12T10:00:00Z');
    await scheduler._tick(eveningNow);

    assert.equal(events.length, 1);
    const it = events[0].items[0];
    assert.equal(it.surviving.length, 1);
    assert.equal(it.surviving[0].short_name, 'Ozempic');
    assert.equal(it.missed_earlier.length, 1);
    assert.equal(it.missed_earlier[0].short_name, 'BPC-157');
  });

  test('morning slot is the first; missed_earlier is always empty when morning fires', async () => {
    freshState();
    const scheduler = require('../lib/notifications-scheduler');
    const events = [];
    scheduler.setDispatch(async (evs) => events.push(...evs));
    scheduler._setRegistryForTests(buildRegistry({
      notifications: [notifItem()],
      items: [
        dailyItem({ name: 'BPC-157', short_name: 'BPC-157', time_of_day: 'morning', today: TODAY }),
      ],
    }));

    await scheduler._tick(NOW_AT_MORNING);
    assert.equal(events.length, 1);
    assert.equal(events[0].items[0].missed_earlier.length, 0);
  });

  test('earlier-slot item taken today: not carried into evening fire', async () => {
    freshState();
    const scheduler = require('../lib/notifications-scheduler');
    const events = [];
    scheduler.setDispatch(async (evs) => events.push(...evs));
    scheduler._setRegistryForTests(buildRegistry({
      notifications: [notifItem({
        id: 'evening-jab',
        trigger: { type: 'schedule_due', card: 'peptide-cycle', time_of_day: 'evening', time: '20:00' },
      })],
      items: [
        dailyItem({ name: 'BPC-157', short_name: 'BPC-157', time_of_day: 'morning', today: TODAY, takenToday: true }),
        dailyItem({ name: 'Ozempic', short_name: 'Ozempic', time_of_day: 'evening', today: TODAY }),
      ],
    }));

    await scheduler._tick(new Date('2026-06-12T10:00:00Z'));
    assert.equal(events.length, 1);
    assert.equal(events[0].items[0].missed_earlier.length, 0);
  });

  test('morning fires alone; if no later slot exists no follow-up fires', async () => {
    freshState();
    const scheduler = require('../lib/notifications-scheduler');
    const events = [];
    scheduler.setDispatch(async (evs) => events.push(...evs));
    scheduler._setRegistryForTests(buildRegistry({
      notifications: [notifItem()], // morning only
      items: [
        dailyItem({ name: 'BPC-157', short_name: 'BPC-157', time_of_day: 'morning', today: TODAY }),
      ],
    }));

    await scheduler._tick(NOW_AT_MORNING);
    assert.equal(events.length, 1);

    // Simulate the next minute: same slot already fired, no new event.
    events.length = 0;
    await scheduler._tick(NOW_AT_MORNING);
    assert.equal(events.length, 0);
  });
});

test.describe('schedule_due body templating', () => {
  test('public privacy: body and title get {schedule_due} substituted', async () => {
    freshState();
    const scheduler = require('../lib/notifications-scheduler');
    const webPush = require('../lib/web-push-send');
    const events = [];
    scheduler.setDispatch(async (evs) => events.push(...evs));
    scheduler._setRegistryForTests(buildRegistry({
      notifications: [notifItem({ privacy: 'public', title: '{schedule_due}', body: 'Time for {schedule_due}' })],
      items: [dailyItem({ name: 'BPC-157', short_name: 'BPC-157', time_of_day: 'morning', today: TODAY })],
    }));

    await scheduler._tick(NOW_AT_MORNING);
    const payload = webPush.buildPayload(events[0]);
    assert.equal(payload.items[0].title, 'BPC-157');
    assert.equal(payload.items[0].body, 'Time for BPC-157');
    assert.equal(payload.items[0].realTitle, null);
    assert.equal(payload.items[0].realBody, null);
  });

  test('private privacy: substitution lands in realBody/realTitle, wire body stays generic', async () => {
    freshState();
    const scheduler = require('../lib/notifications-scheduler');
    const webPush = require('../lib/web-push-send');
    const events = [];
    scheduler.setDispatch(async (evs) => events.push(...evs));
    scheduler._setRegistryForTests(buildRegistry({
      notifications: [notifItem({ privacy: 'private', body: 'Time for {schedule_due}{missed_earlier}' })],
      items: [dailyItem({ name: 'BPC-157', short_name: 'BPC-157', time_of_day: 'morning', today: TODAY })],
    }));

    await scheduler._tick(NOW_AT_MORNING);
    const payload = webPush.buildPayload(events[0]);
    assert.equal(payload.items[0].body, 'You have a reminder.');
    assert.equal(payload.items[0].realBody, 'Time for BPC-157');
  });

  test('{missed_earlier} substitutes empty when no carry-forward', async () => {
    freshState();
    const scheduler = require('../lib/notifications-scheduler');
    const webPush = require('../lib/web-push-send');
    const events = [];
    scheduler.setDispatch(async (evs) => events.push(...evs));
    scheduler._setRegistryForTests(buildRegistry({
      notifications: [notifItem({ privacy: 'public', body: 'Take {schedule_due}{missed_earlier}' })],
      items: [dailyItem({ name: 'BPC-157', short_name: 'BPC-157', time_of_day: 'morning', today: TODAY })],
    }));

    await scheduler._tick(NOW_AT_MORNING);
    const payload = webPush.buildPayload(events[0]);
    assert.equal(payload.items[0].body, 'Take BPC-157');
  });

  test('{missed_earlier} substitutes ". Also missed earlier: ..." when populated', async () => {
    freshState();
    const scheduler = require('../lib/notifications-scheduler');
    const webPush = require('../lib/web-push-send');
    const events = [];
    scheduler.setDispatch(async (evs) => events.push(...evs));
    scheduler._setRegistryForTests(buildRegistry({
      notifications: [notifItem({
        id: 'evening-jab',
        privacy: 'public',
        body: 'Take {schedule_due}{missed_earlier}',
        trigger: { type: 'schedule_due', card: 'peptide-cycle', time_of_day: 'evening', time: '20:00' },
      })],
      items: [
        dailyItem({ name: 'BPC-157', short_name: 'BPC-157', time_of_day: 'morning', today: TODAY }),
        dailyItem({ name: 'Ozempic', short_name: 'Ozempic', time_of_day: 'evening', today: TODAY }),
      ],
    }));

    await scheduler._tick(new Date('2026-06-12T10:00:00Z'));
    const payload = webPush.buildPayload(events[0]);
    assert.equal(payload.items[0].body, 'Take Ozempic. Also missed earlier: BPC-157');
  });

  test('regular daily trigger: placeholders substitute to empty strings (backwards compat)', async () => {
    freshState();
    const scheduler = require('../lib/notifications-scheduler');
    const webPush = require('../lib/web-push-send');
    const events = [];
    scheduler.setDispatch(async (evs) => events.push(...evs));
    scheduler._setRegistryForTests({
      list: () => [{
        meta: {
          id: 'mood', label: 'Mood',
          notifications: {
            enabled: true,
            items: [{
              id: 'evening-log', label: 'x', title: 'Mood', body: 'How are you{missed_earlier}',
              trigger: { type: 'daily', time: '08:00' }, privacy: 'public', default: 'on',
            }],
          },
        },
      }],
    });

    await scheduler._tick(NOW_AT_MORNING);
    const payload = webPush.buildPayload(events[0]);
    assert.equal(payload.items[0].body, 'How are you');
  });
});
