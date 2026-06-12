// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/notifications-scheduler.test.js
//
// In-process tests for the scheduler tick. We never call start() here
// because that runs an implicit tick against real time which would
// race the controlled tick the test wants to exercise. Instead we
// stash the registry via _setRegistryForTests and call _tick directly.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function freshState() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klebb-sched-'));
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
      || k.endsWith('config' + path.sep + 'paths.js')) {
      delete require.cache[k];
    }
  }
  return { root, stateFile, userFile };
}

const VALID_DAILY = {
  id: 'evening-log',
  label: 'Evening',
  title: 'Mood',
  body: 'How are you feeling?',
  trigger: { type: 'daily', time: '08:00' },
  privacy: 'private',
  default: 'on',
};

function setupCard(scheduler, items) {
  scheduler._setRegistryForTests({
    list: () => [{
      meta: {
        id: 'mood', label: 'Mood',
        notifications: { enabled: true, items },
      },
    }],
  });
}

test.describe('notifications-scheduler tick', () => {
  test('fires due notification, advances lastFired, second tick is idempotent', async () => {
    const { stateFile } = freshState();
    const scheduler = require('../lib/notifications-scheduler');
    const events = [];
    scheduler.setDispatch(async (evs) => events.push(...evs));
    setupCard(scheduler, [VALID_DAILY]);

    // 08:00 +10:00 on 2026-06-12 = 22:00 UTC on 2026-06-11
    const now = new Date('2026-06-11T22:00:00Z');
    await scheduler._tick(now);

    assert.equal(events.length, 1);
    assert.equal(events[0].items.length, 1);
    assert.equal(events[0].items[0].id, 'mood#evening-log');

    const persisted = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.match(persisted.items['mood#evening-log'].lastFired, /T08:00:00\+10:00$/);
    assert.equal(persisted.items['mood#evening-log'].lastFireStatus, 'pending');

    // Second tick at the same instant: no new dispatch.
    events.length = 0;
    await scheduler._tick(now);
    assert.equal(events.length, 0);
  });

  test('paused_until short-circuits the tick (does not advance lastFired)', async () => {
    const { stateFile } = freshState();
    const scheduler = require('../lib/notifications-scheduler');
    const stateMod = require('../lib/notifications-state');
    const events = [];
    scheduler.setDispatch(async (evs) => events.push(...evs));
    stateMod.writeGlobal({ paused_until: '2026-06-12T00:00:00Z' });
    setupCard(scheduler, [VALID_DAILY]);

    const now = new Date('2026-06-11T22:00:00Z');
    await scheduler._tick(now);
    assert.equal(events.length, 0);

    // Critical: lastFired must NOT have advanced - so when paused
    // expires the next tick can still fire the missed slot.
    const after = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(after.items['mood#evening-log']?.lastFired, undefined);
  });

  test('quiet_hours: tick records lastFired but skips dispatch', async () => {
    const { stateFile } = freshState();
    const scheduler = require('../lib/notifications-scheduler');
    const stateMod = require('../lib/notifications-state');
    const events = [];
    scheduler.setDispatch(async (evs) => events.push(...evs));
    // Quiet 07:00..09:00 - the 08:00 slot lands inside the window.
    stateMod.writeGlobal({ quiet_hours: { start: '07:00', end: '09:00' } });
    setupCard(scheduler, [VALID_DAILY]);

    const now = new Date('2026-06-11T22:00:00Z'); // 08:00 +10:00
    await scheduler._tick(now);

    assert.equal(events.length, 0);
    const after = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.match(after.items['mood#evening-log'].lastFired, /T08:00:00\+10:00$/);
    assert.equal(after.items['mood#evening-log'].lastFireStatus, 'quiet');
  });

  test('item-state.enabled=false skips dispatch', async () => {
    freshState();
    const scheduler = require('../lib/notifications-scheduler');
    const stateMod = require('../lib/notifications-state');
    const events = [];
    scheduler.setDispatch(async (evs) => events.push(...evs));
    stateMod.writeItem('mood#evening-log', { enabled: false });
    setupCard(scheduler, [VALID_DAILY]);

    await scheduler._tick(new Date('2026-06-11T22:00:00Z'));
    assert.equal(events.length, 0);
  });

  test('manifest-level enabled=false skips every item', async () => {
    freshState();
    const scheduler = require('../lib/notifications-scheduler');
    const events = [];
    scheduler.setDispatch(async (evs) => events.push(...evs));
    scheduler._setRegistryForTests({
      list: () => [{
        meta: { id: 'mood', label: 'Mood', notifications: { enabled: false, items: [VALID_DAILY] } },
      }],
    });

    await scheduler._tick(new Date('2026-06-11T22:00:00Z'));
    assert.equal(events.length, 0);
  });

  test('privacy override from state file wins over manifest default', async () => {
    // Regression for the "Show full text toggle silently ignored at
    // send time" bug: the manifest declared privacy:"private" but the
    // user flipped it to "public" via /api/notifications/state. The
    // dispatch event must reflect the runtime override so the wire
    // payload carries the real title/body to the device.
    freshState();
    const scheduler = require('../lib/notifications-scheduler');
    const stateMod = require('../lib/notifications-state');
    const events = [];
    scheduler.setDispatch(async (evs) => events.push(...evs));

    stateMod.writeItem('mood#evening-log', { privacy: 'public' });
    setupCard(scheduler, [VALID_DAILY]); // manifest privacy: 'private'

    await scheduler._tick(new Date('2026-06-11T22:00:00Z'));
    assert.equal(events.length, 1);
    assert.equal(events[0].items[0].item.privacy, 'public',
      'scheduler must resolve privacy from state file, not manifest');
  });

  test('manifest privacy is the default when state has no override', async () => {
    freshState();
    const scheduler = require('../lib/notifications-scheduler');
    const events = [];
    scheduler.setDispatch(async (evs) => events.push(...evs));

    setupCard(scheduler, [{ ...VALID_DAILY, privacy: 'public' }]);

    await scheduler._tick(new Date('2026-06-11T22:00:00Z'));
    assert.equal(events.length, 1);
    assert.equal(events[0].items[0].item.privacy, 'public');
  });
});
