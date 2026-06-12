// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/chat-tools-notifications.test.js
//
// In-process tests for the new set_notification + remove_notification
// tools in chat/tools.js. Drives dispatchToolCall directly against a
// real registry seeded with a sandbox card.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createSandbox, cleanupSandbox } = require('./helpers/sandbox');

function freshRegistry(seed = {}) {
  const root = createSandbox({ seed });
  process.env.HEALTH_HOME = root;
  // Reset the require cache so config/paths resolves the new HEALTH_HOME.
  for (const k of Object.keys(require.cache)) {
    if (k.endsWith('config' + path.sep + 'paths.js')
      || k.includes('manifests' + path.sep + 'registry.js')
      || k.includes('chat' + path.sep + 'tools.js')) {
      delete require.cache[k];
    }
  }
  const registry = require('../manifests/registry');
  registry.init();
  const tools = require('../chat/tools');
  return { root, registry, tools };
}

function call(tools, name, args, ctx = { touches: [] }) {
  const json = tools.dispatchToolCall(
    { function: { name, arguments: JSON.stringify(args) } },
    ctx,
  );
  return JSON.parse(json);
}

const SEED_MOOD = {
  'mood.json': {
    $schema: 'klebb.datafile.v1',
    meta: {
      id: 'mood', label: 'Mood', emoji: '🙂',
      view: { enabled: true, component: 'generic-card' },
    },
    data: [],
  },
};

test.describe('chat/tools set_notification', () => {
  let env;
  test.before(() => { env = freshRegistry(SEED_MOOD); });
  test.after(() => cleanupSandbox(env.root));

  test('add: creates the notification block, returns notification_id + created:true', () => {
    const result = call(env.tools, 'set_notification', {
      card_id: 'mood',
      label: 'Evening mood log',
      title: 'Mood',
      body: 'How are you feeling?',
      trigger: { type: 'daily', time: '20:00' },
    });
    assert.equal(result.ok, true);
    assert.equal(result.created, true);
    assert.equal(result.notification_id, 'evening-mood-log');

    const reread = env.registry.get('mood');
    const items = reread.meta.notifications.items;
    assert.equal(items.length, 1);
    assert.equal(items[0].id, 'evening-mood-log');
    assert.equal(items[0].privacy, 'private'); // default applied by validator
  });

  test('add: respects explicit notification_id when provided', () => {
    const result = call(env.tools, 'set_notification', {
      card_id: 'mood',
      notification_id: 'morning',
      label: 'Morning log',
      title: 'Mood',
      body: 'Quick check-in?',
      trigger: { type: 'daily', time: '08:00' },
    });
    assert.equal(result.created, true);
    assert.equal(result.notification_id, 'morning');
  });

  test('update: same notification_id replaces in place, created:false', () => {
    const result = call(env.tools, 'set_notification', {
      card_id: 'mood',
      notification_id: 'morning',
      label: 'Morning log',
      title: 'Mood',
      body: 'How are you feeling today?',
      trigger: { type: 'daily', time: '09:00' }, // changed
    });
    assert.equal(result.created, false);
    const items = env.registry.get('mood').meta.notifications.items;
    const morning = items.find(i => i.id === 'morning');
    assert.equal(morning.trigger.time, '09:00');
  });

  test('weekly trigger persists with days[] preserved', () => {
    const result = call(env.tools, 'set_notification', {
      card_id: 'mood',
      label: 'Mid-week pulse',
      title: 'Mood',
      body: 'Mid-week check-in?',
      trigger: { type: 'weekly', time: '14:00', days: ['mon', 'wed', 'fri'] },
    });
    assert.equal(result.ok, true);
    const items = env.registry.get('mood').meta.notifications.items;
    const item = items.find(i => i.id === 'mid-week-pulse');
    assert.deepEqual(item.trigger.days, ['mon', 'wed', 'fri']);
  });

  test('rejects unknown card_id', () => {
    const result = call(env.tools, 'set_notification', {
      card_id: 'does-not-exist',
      label: 'X', title: 'X', body: 'X',
      trigger: { type: 'daily', time: '08:00' },
    });
    assert.match(result.error, /unknown card/);
  });

  test('rejects malformed trigger via the registry validator', () => {
    const result = call(env.tools, 'set_notification', {
      card_id: 'mood',
      label: 'Bad',
      title: 'Bad',
      body: 'Bad',
      trigger: { type: 'interval', every_days: 7, time: '08:00' },
    });
    assert.match(result.error, /trigger.type/);
  });

  test('records a touch for the embellishment picker', () => {
    const ctx = { touches: [] };
    const result = call(env.tools, 'set_notification', {
      card_id: 'mood',
      notification_id: 'late-night',
      label: 'Late check-in',
      title: 'Mood',
      body: 'Still up?',
      trigger: { type: 'daily', time: '23:00' },
    }, ctx);
    assert.equal(result.ok, true);
    assert.equal(ctx.touches.length, 1);
    assert.equal(ctx.touches[0].id, 'mood');
    assert.equal(ctx.touches[0].flow, 'edit');
  });
});

test.describe('chat/tools remove_notification', () => {
  let env;
  test.before(() => {
    env = freshRegistry({
      'mood.json': {
        $schema: 'klebb.datafile.v1',
        meta: {
          id: 'mood', label: 'Mood',
          view: { enabled: true, component: 'generic-card' },
          notifications: {
            enabled: true,
            items: [
              { id: 'morning', label: 'Morning', title: 'Mood', body: 'Hi', trigger: { type: 'daily', time: '08:00' } },
              { id: 'evening', label: 'Evening', title: 'Mood', body: 'Hi', trigger: { type: 'daily', time: '20:00' } },
            ],
          },
        },
        data: [],
      },
    });
  });
  test.after(() => cleanupSandbox(env.root));

  test('removes the named item, leaves siblings intact', () => {
    const result = call(env.tools, 'remove_notification', {
      card_id: 'mood',
      notification_id: 'morning',
    });
    assert.equal(result.ok, true);
    assert.equal(result.remaining, 1);
    const items = env.registry.get('mood').meta.notifications.items;
    assert.equal(items.length, 1);
    assert.equal(items[0].id, 'evening');
  });

  test('rejects unknown notification_id with descriptive error', () => {
    const result = call(env.tools, 'remove_notification', {
      card_id: 'mood',
      notification_id: 'never-existed',
    });
    assert.match(result.error, /unknown notification/);
  });

  test('rejects unknown card_id', () => {
    const result = call(env.tools, 'remove_notification', {
      card_id: 'does-not-exist',
      notification_id: 'morning',
    });
    assert.match(result.error, /unknown card/);
  });
});
