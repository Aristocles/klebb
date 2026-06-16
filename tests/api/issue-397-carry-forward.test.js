// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/api/issue-397-carry-forward.test.js
//
// Per-bug regression seed for #397: same-day morning miss must surface
// in the evening schedule_due fire as `missed_earlier`. Removing the
// earlier-slot pull from notifications-scheduler.js makes this fail.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function freshState() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klebb-issue-397-'));
  process.env.HEALTH_NOTIFICATIONS_STATE_FILE = path.join(root, 'notifications.state.json');
  process.env.HEALTH_USER_FILE = path.join(root, 'user.json');
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
}

const TODAY = '2026-06-12';

test('issue-397: morning-miss surfaces in evening fire', async () => {
  freshState();
  const scheduler = require('../../lib/notifications-scheduler');
  const events = [];
  scheduler.setDispatch(async (evs) => events.push(...evs));

  const cards = [
    {
      meta: {
        id: 'reminders',
        label: 'Reminders',
        notifications: {
          enabled: true,
          items: [{
            id: 'evening-jab',
            label: 'Evening',
            title: 'Injection',
            body: 'Take {schedule_due}{missed_earlier}',
            trigger: { type: 'schedule_due', card: 'peptide-cycle', time_of_day: 'evening', time: '20:00' },
            privacy: 'public',
            default: 'on',
          }],
        },
      },
    },
    {
      meta: { id: 'peptide-cycle', label: 'Injections' },
      data: {
        items: [
          { name: 'BPC-157', short_name: 'BPC-157', schedule: { type: 'daily', time_of_day: 'morning' }, doses: [] },
          { name: 'Ozempic', short_name: 'Ozempic', schedule: { type: 'daily', time_of_day: 'evening' }, doses: [] },
        ],
      },
    },
  ];
  scheduler._setRegistryForTests({
    list: () => cards,
    get: (id) => cards.find(c => c.meta.id === id) || null,
  });

  // 20:00 +10 on 2026-06-12 = 10:00 UTC.
  await scheduler._tick(new Date('2026-06-12T10:00:00Z'));

  assert.equal(events.length, 1);
  const it = events[0].items[0];
  assert.equal(it.surviving.length, 1);
  assert.equal(it.surviving[0].short_name, 'Ozempic');
  // The carry-forward assertion: this is the bit that breaks if the
  // earlier-slot pull is removed.
  assert.equal(it.missed_earlier.length, 1);
  assert.equal(it.missed_earlier[0].short_name, 'BPC-157');

  const webPush = require('../../lib/web-push-send');
  const payload = webPush.buildPayload(events[0]);
  assert.equal(
    payload.items[0].body,
    'Take Ozempic. Also missed earlier: BPC-157',
    `body should reflect ${TODAY} morning miss carried into evening fire`,
  );
});
