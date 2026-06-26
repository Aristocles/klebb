// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/card-notifications.test.js
// Logic for the settings gear's Notifications section (#456): card-state
// classification, the enable/disable patch, and — the load-bearing one —
// that the auto-built default reminder passes the SAME strict validator
// the PATCH endpoint runs, so enabling never 422s.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  notificationsState,
  notificationsEnabled,
  buildDefaultReminder,
  buildNotificationsPatch,
} from '../public/js/lib/card-notifications.js';

const require = createRequire(import.meta.url);
const { validateNotifications } = require('../manifests/notifications-schema.js');

const loggable = { writeable: { fromWebapp: true }, label: 'Vitamin D' };
const readonly = { writeable: { fromWebapp: false }, label: 'Allergies' };
const withItems = {
  label: 'Peptides',
  notifications: { enabled: true, items: [{ id: 'x', label: 'l', title: 't', body: 'b', trigger: { type: 'daily', time: '08:00' } }] },
};

describe('notificationsState', () => {
  test('has-items when the block carries items', () => {
    assert.equal(notificationsState(withItems), 'has-items');
  });
  test('can-create when loggable but no items', () => {
    assert.equal(notificationsState(loggable), 'can-create');
    assert.equal(notificationsState({ writeable: { fromWebapp: true }, notifications: { enabled: true, items: [] } }), 'can-create');
  });
  test('none when not loggable and no items', () => {
    assert.equal(notificationsState(readonly), 'none');
    assert.equal(notificationsState({}), 'none');
  });
});

describe('notificationsEnabled', () => {
  test('false with no block', () => assert.equal(notificationsEnabled(loggable), false));
  test('true when block present and not explicitly disabled', () => {
    assert.equal(notificationsEnabled(withItems), true);
    assert.equal(notificationsEnabled({ notifications: { items: [] } }), true);
  });
  test('false when explicitly disabled', () => {
    assert.equal(notificationsEnabled({ notifications: { enabled: false, items: [] } }), false);
  });
});

describe('buildDefaultReminder passes the strict validator', () => {
  test('a freshly built reminder validates with strict:true and no throw', () => {
    const item = buildDefaultReminder(loggable);
    const block = { enabled: true, items: [item] };
    // strict mode throws on the first invalid field; this must not throw.
    const cleaned = validateNotifications(block, { strict: true });
    assert.equal(cleaned.enabled, true);
    assert.equal(cleaned.items.length, 1);
    // Privacy defaults to private (the gear never publicises).
    assert.equal(cleaned.items[0].privacy, 'private');
    assert.equal(cleaned.items[0].default, 'on');
    assert.equal(cleaned.items[0].trigger.type, 'daily');
    assert.equal(cleaned.items[0].trigger.time, '09:00');
  });
  test('a very long card label is clamped so title (<=30) and label (<=80) stay valid', () => {
    const longName = 'X'.repeat(120);
    const item = buildDefaultReminder({ label: longName, writeable: { fromWebapp: true } });
    assert.ok(item.title.length <= 30);
    assert.ok(item.label.length <= 80);
    // Still validates.
    assert.doesNotThrow(() => validateNotifications({ enabled: true, items: [item] }, { strict: true }));
  });
  test('honours a custom time', () => {
    assert.equal(buildDefaultReminder(loggable, { time: '21:30' }).trigger.time, '21:30');
  });
});

describe('buildNotificationsPatch', () => {
  test('none state never patches', () => {
    assert.equal(buildNotificationsPatch(readonly, true), null);
    assert.equal(buildNotificationsPatch(readonly, false), null);
  });

  test('has-items: master toggle flips enabled WITHOUT sending items[]', () => {
    // Currently on -> turn off.
    const off = buildNotificationsPatch(withItems, false);
    assert.deepEqual(off, { meta: { notifications: { enabled: false } } });
    assert.ok(!('items' in off.meta.notifications), 'never sends items[] (array-replace would wipe them)');
    // Already on -> no-op.
    assert.equal(buildNotificationsPatch(withItems, true), null);
  });

  test('can-create: enabling seeds exactly one default reminder', () => {
    const patch = buildNotificationsPatch(loggable, true);
    assert.equal(patch.meta.notifications.enabled, true);
    assert.equal(patch.meta.notifications.items.length, 1);
    assert.equal(patch.meta.notifications.items[0].id, 'reminder');
  });

  test('can-create: disabling (nothing to turn off yet) is a no-op', () => {
    assert.equal(buildNotificationsPatch(loggable, false), null);
  });
});
