// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/api/issue-394.test.js
//
// Regression seed for #394: when set_notification mutates a notification's
// trigger, the runtime state file's lastFired (computed under the OLD
// trigger config) must be cleared, so the scheduler doesn't silently
// treat a fresh slot under the NEW trigger as already-fired.
//
// The sharp bite: a schedule_due trigger that suppressed today (lastFired
// stamped with status:suppressed because no dose was due) gets mutated
// into a plain daily wall-clock trigger at the same time. Without the
// fix, the next tick sees lastFired === slots.prev under the new trigger
// and silently skips. With the fix, set_notification clears lastFired at
// the patch boundary, the slot fires, and the user gets their reminder.
//
// Also covers:
//   - benign updates (label/title/body unchanged trigger): lastFired preserved
//   - notification_id-less re-dispatch on unrelated items: their lastFired
//     untouched
//   - remove_notification: runtime state entry pruned

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSandbox, cleanupSandbox } = require('../helpers/sandbox');

function freshEnv(seed) {
  const root = createSandbox({ seed });
  process.env.HEALTH_HOME = root;
  process.env.HEALTH_NOTIFICATIONS_STATE_FILE = path.join(root, 'notifications.state.json');
  process.env.HEALTH_USER_FILE = path.join(root, 'user.json');
  process.env.TZ = 'Australia/Melbourne';
  for (const k of Object.keys(require.cache)) {
    if (k.endsWith('config' + path.sep + 'paths.js')
      || k.includes('manifests' + path.sep + 'registry.js')
      || k.includes('chat' + path.sep + 'tools.js')
      || k.includes('notifications-state')
      || k.includes('notification-trigger')
      || k.includes('notifications-scheduler')
      || k.includes('user-tz')) {
      delete require.cache[k];
    }
  }
  const registry = require('../../manifests/registry');
  registry.init();
  const tools = require('../../chat/tools');
  const stateMod = require('../../lib/notifications-state');
  const scheduler = require('../../lib/notifications-scheduler');
  scheduler._setRegistryForTests(registry);
  return { root, registry, tools, stateMod, scheduler };
}

function call(tools, name, args) {
  const json = tools.dispatchToolCall(
    { function: { name, arguments: JSON.stringify(args) } },
    { touches: [] },
  );
  return JSON.parse(json);
}

const SEED = {
  'mood.json': {
    $schema: 'klebb.datafile.v1',
    meta: {
      id: 'mood', label: 'Mood',
      view: { enabled: true, component: 'generic-card' },
      notifications: {
        enabled: true,
        items: [{
          id: 'morning-log',
          label: 'Morning log',
          title: 'Mood',
          body: 'How are you feeling?',
          trigger: { type: 'daily', time: '08:00' },
        }],
      },
    },
    data: [],
  },
};

test.describe('issue-394: set_notification clears lastFired on trigger mutation', () => {
  let env;
  test.beforeEach(() => { env = freshEnv(SEED); });
  test.afterEach(() => { cleanupSandbox(env.root); });

  test('trigger mutation clears lastFired so the new slot fires', async () => {
    // Seed the state as if the scheduler had already dispatched today's
    // 08:00 slot under the OLD trigger. Equivalent to: the scheduler
    // ticked at 08:00, recorded lastFired, and we're now at 08:05.
    env.stateMod.writeItem('mood#morning-log', {
      enabled: true,
      lastFired: '2026-06-12T08:00:00+10:00',
      lastFireStatus: 'pending',
    });

    // The user asks Klebbius to change the trigger shape (here: from daily
    // to a weekly with all 7 days, same time). The next prevFire under
    // the new trigger is byte-identical to the OLD prevFire that's still
    // in lastFired. Without the fix, the next tick treats the slot as
    // already-fired and silently skips.
    const result = call(env.tools, 'set_notification', {
      card_id: 'mood',
      notification_id: 'morning-log',
      label: 'Morning log',
      title: 'Mood',
      body: 'How are you feeling?',
      trigger: { type: 'weekly', time: '08:00', days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] },
    });
    assert.equal(result.ok, true);
    assert.equal(result.created, false);

    const after = env.stateMod.read();
    assert.equal(after.items['mood#morning-log'].lastFired, null,
      'lastFired must be cleared at the trigger-mutation boundary');

    // Belt-and-braces: drive the scheduler tick under the new trigger and
    // confirm the slot actually fires (i.e. the silent-skip is gone).
    const events = [];
    env.scheduler.setDispatch(async (evs) => events.push(...evs));
    await env.scheduler._tick(new Date('2026-06-11T22:05:00Z')); // 08:05 +10
    assert.equal(events.length, 1, 'the new trigger\'s slot must fire');
    assert.equal(events[0].items[0].id, 'mood#morning-log');
  });

  test('benign update (same trigger) preserves lastFired', async () => {
    env.stateMod.writeItem('mood#morning-log', {
      enabled: true,
      lastFired: '2026-06-12T08:00:00+10:00',
      lastFireStatus: 'pending',
    });

    // Identical trigger; only body text changes. Cached lastFired is
    // still valid for this trigger config: don't clear it.
    const result = call(env.tools, 'set_notification', {
      card_id: 'mood',
      notification_id: 'morning-log',
      label: 'Morning log',
      title: 'Mood',
      body: 'Feeling alright?', // changed
      trigger: { type: 'daily', time: '08:00' }, // unchanged
    });
    assert.equal(result.ok, true);

    const after = env.stateMod.read();
    assert.equal(after.items['mood#morning-log'].lastFired,
      '2026-06-12T08:00:00+10:00',
      'lastFired must survive when only label/body change');
  });

  test('mutation only touches the targeted item\'s runtime state', async () => {
    env.stateMod.writeItem('mood#morning-log', {
      enabled: true,
      lastFired: '2026-06-12T08:00:00+10:00',
    });
    env.stateMod.writeItem('weight#daily', {
      enabled: true,
      lastFired: '2026-06-12T07:30:00+10:00',
    });

    call(env.tools, 'set_notification', {
      card_id: 'mood',
      notification_id: 'morning-log',
      label: 'Morning log',
      title: 'Mood',
      body: 'How are you feeling?',
      trigger: { type: 'daily', time: '09:00' }, // mutated
    });

    const after = env.stateMod.read();
    assert.equal(after.items['mood#morning-log'].lastFired, null);
    assert.equal(after.items['weight#daily'].lastFired,
      '2026-06-12T07:30:00+10:00',
      'unrelated items must keep their lastFired');
  });

  test('add (no prior item) is a no-op on runtime state', async () => {
    // No state file exists yet; add a notification and confirm the tool
    // still succeeds without creating a stray runtime entry.
    const result = call(env.tools, 'set_notification', {
      card_id: 'mood',
      label: 'Evening log',
      title: 'Mood',
      body: 'How was your day?',
      trigger: { type: 'daily', time: '20:00' },
    });
    assert.equal(result.ok, true);
    assert.equal(result.created, true);

    const stateFile = path.join(env.root, 'notifications.state.json');
    if (fs.existsSync(stateFile)) {
      const after = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      assert.equal(after.items['mood#evening-log']?.lastFired ?? null, null);
    }
  });
});

test.describe('issue-394: remove_notification prunes runtime state', () => {
  let env;
  test.beforeEach(() => { env = freshEnv(SEED); });
  test.afterEach(() => { cleanupSandbox(env.root); });

  test('removed item\'s runtime entry is dropped from notifications.state.json', () => {
    env.stateMod.writeItem('mood#morning-log', {
      enabled: true,
      lastFired: '2026-06-12T08:00:00+10:00',
    });

    const result = call(env.tools, 'remove_notification', {
      card_id: 'mood',
      notification_id: 'morning-log',
    });
    assert.equal(result.ok, true);

    const after = env.stateMod.read();
    assert.equal(after.items['mood#morning-log'], undefined,
      'remove_notification must prune the runtime sidecar entry');
  });
});
