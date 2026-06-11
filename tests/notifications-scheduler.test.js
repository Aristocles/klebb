// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/notifications-scheduler.test.js
//
// In-process tests for the scheduler tick. Drives _tick() with a mock
// "now" and a fake registry so we don't depend on real card files.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function freshState() {
  // Each test gets its own HEALTH_HOME so notifications.state.json,
  // user.json, etc. don't leak. The path module is loaded ONCE per
  // process so we shim HEALTH_HOME via the override env var.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klebb-sched-'));
  const stateFile = path.join(root, 'notifications.state.json');
  const userFile = path.join(root, 'user.json');
  process.env.HEALTH_NOTIFICATIONS_STATE_FILE = stateFile;
  process.env.HEALTH_USER_FILE = userFile;
  process.env.TZ = 'Australia/Melbourne';
  // Bust the require cache so the modules reload PATHS with the new env.
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

function fakeRegistry(cards) {
  return {
    list: () => cards,
  };
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

test.describe('notifications-scheduler tick', () => {
  test('fires due notification, advances lastFired, second tick is idempotent', async () => {
    const { stateFile } = freshState();
    const scheduler = require('../lib/notifications-scheduler');
    const events = [];
    scheduler.setDispatch(async (evs) => events.push(...evs));

    const card = {
      meta: {
        id: 'mood', label: 'Mood',
        notifications: { enabled: true, items: [VALID_DAILY] },
      },
    };

    // 09:00 +10:00 on 2026-06-12 = 23:00 UTC on 2026-06-11
    const now = new Date('2026-06-11T23:00:00Z');
    scheduler._tick.bind(null);
    await scheduler._tick.call({ _registry: { list: () => [card] } }, now);
    // The first tick happens via the public tick path - our shim above
    // doesn't bind a registry. Use the wrapped form instead:
    scheduler.start({ list: () => [card] });
    // Stop the timer immediately; we'll drive _tick manually below.
    scheduler.stop();
    events.length = 0;

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

    // Pre-pause for an hour past "now".
    stateMod.writeGlobal({ paused_until: '2026-06-12T00:00:00Z' });

    scheduler.start({ list: () => [{
      meta: { id: 'mood', label: 'Mood', notifications: { enabled: true, items: [VALID_DAILY] } },
    }] });
    scheduler.stop();
    events.length = 0;

    const now = new Date('2026-06-11T23:00:00Z');
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

    scheduler.start({ list: () => [{
      meta: { id: 'mood', label: 'Mood', notifications: { enabled: true, items: [VALID_DAILY] } },
    }] });
    scheduler.stop();
    events.length = 0;

    const now = new Date('2026-06-11T23:00:00Z'); // 09:00 +10:00
    // Reset hour to 08:00 so we land inside quiet window
    const qNow = new Date('2026-06-11T22:00:00Z'); // 08:00 +10:00
    await scheduler._tick(qNow);

    assert.equal(events.length, 0);
    const after = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    // Slot recorded, status flagged so a debug surface can show "quiet".
    assert.match(after.items['mood#evening-log'].lastFired, /T08:00:00\+10:00$/);
    assert.equal(after.items['mood#evening-log'].lastFireStatus, 'quiet');
  });

  test('item-state.enabled=false skips dispatch', async () => {
    const { stateFile } = freshState();
    const scheduler = require('../lib/notifications-scheduler');
    const stateMod = require('../lib/notifications-state');
    const events = [];
    scheduler.setDispatch(async (evs) => events.push(...evs));

    stateMod.writeItem('mood#evening-log', { enabled: false });

    scheduler.start({ list: () => [{
      meta: { id: 'mood', label: 'Mood', notifications: { enabled: true, items: [VALID_DAILY] } },
    }] });
    scheduler.stop();
    events.length = 0;

    await scheduler._tick(new Date('2026-06-11T23:00:00Z'));
    assert.equal(events.length, 0);
  });

  test('manifest-level enabled=false skips every item', async () => {
    freshState();
    const scheduler = require('../lib/notifications-scheduler');
    const events = [];
    scheduler.setDispatch(async (evs) => events.push(...evs));

    scheduler.start({ list: () => [{
      meta: { id: 'mood', label: 'Mood', notifications: { enabled: false, items: [VALID_DAILY] } },
    }] });
    scheduler.stop();
    events.length = 0;

    await scheduler._tick(new Date('2026-06-11T23:00:00Z'));
    assert.equal(events.length, 0);
  });
});
