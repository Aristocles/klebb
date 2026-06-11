// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/notifications-trigger.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const trigger = require('../lib/notification-trigger');

const TZ = 'Australia/Melbourne';

test.describe('notification-trigger: daily', () => {
  test('mid-afternoon: prev = today 08:00, next = tomorrow 08:00', () => {
    // 2026-06-12T15:00:00+10:00 (winter in AEST, UTC+10)
    const now = new Date('2026-06-12T05:00:00Z');
    const out = trigger.evaluate({ type: 'daily', time: '08:00' }, now, TZ);
    assert.match(out.prev, /^2026-06-12T08:00:00\+10:00$/);
    assert.match(out.next, /^2026-06-13T08:00:00\+10:00$/);
  });

  test('before today\'s slot: prev = yesterday, next = today', () => {
    // 2026-06-12T05:00:00+10:00 = 2026-06-11T19:00:00Z
    const now = new Date('2026-06-11T19:00:00Z');
    const out = trigger.evaluate({ type: 'daily', time: '08:00' }, now, TZ);
    assert.match(out.prev, /^2026-06-11T08:00:00\+10:00$/);
    assert.match(out.next, /^2026-06-12T08:00:00\+10:00$/);
  });

  test('exactly at the slot: counts as fired (prev=today, next=tomorrow)', () => {
    // 2026-06-12T08:00:00+10:00 = 2026-06-11T22:00:00Z
    const now = new Date('2026-06-11T22:00:00Z');
    const out = trigger.evaluate({ type: 'daily', time: '08:00' }, now, TZ);
    assert.match(out.prev, /^2026-06-12T08:00:00\+10:00$/);
    assert.match(out.next, /^2026-06-13T08:00:00\+10:00$/);
  });
});

test.describe('notification-trigger: daily across DST', () => {
  // Australia/Melbourne ends AEDT on 2026-04-05 03:00 (clocks roll
  // back from +11 to +10) and starts AEDT on 2026-10-04 02:00 (clocks
  // jump from +10 to +11). A correct evaluator yields HH:MM in local
  // wall-clock terms even across these boundaries.

  test('autumn DST boundary (AEDT ends 2026-04-05): 08:00 stays 08:00', () => {
    // 09:00 AEDT/+11 on 2026-04-05 = 22:00 UTC the day before
    const now = new Date('2026-04-04T22:00:00Z');
    const out = trigger.evaluate({ type: 'daily', time: '08:00' }, now, TZ);
    // After the rollback the offset is +10
    assert.match(out.next, /T08:00:00\+10:00$/);
  });

  test('spring DST boundary (AEDT starts 2026-10-04): 08:00 stays 08:00', () => {
    // 06:00 AEST/+10 on 2026-10-04 = 20:00 UTC the day before
    const now = new Date('2026-10-03T20:00:00Z');
    const out = trigger.evaluate({ type: 'daily', time: '08:00' }, now, TZ);
    // After the jump-forward the offset is +11
    assert.match(out.next, /T08:00:00\+11:00$/);
  });
});

test.describe('notification-trigger: weekly', () => {
  test('Mon/Wed/Fri 08:00 from a Wed afternoon: prev = today, next = Friday', () => {
    // 2026-06-10 is a Wednesday. 15:00 local = 05:00 UTC.
    const now = new Date('2026-06-10T05:00:00Z');
    const out = trigger.evaluate(
      { type: 'weekly', time: '08:00', days: ['mon', 'wed', 'fri'] },
      now, TZ,
    );
    assert.match(out.prev, /^2026-06-10T08:00:00\+10:00$/);
    assert.match(out.next, /^2026-06-12T08:00:00\+10:00$/);
  });

  test('Sun-only trigger from a Wed: prev = last Sunday, next = next Sunday', () => {
    const now = new Date('2026-06-10T05:00:00Z'); // Wed 15:00 +10
    const out = trigger.evaluate(
      { type: 'weekly', time: '09:00', days: ['sun'] },
      now, TZ,
    );
    assert.match(out.prev, /^2026-06-07T09:00:00\+10:00$/);
    assert.match(out.next, /^2026-06-14T09:00:00\+10:00$/);
  });

  test('returns null when days[] is empty', () => {
    const now = new Date('2026-06-10T05:00:00Z');
    const out = trigger.evaluate(
      { type: 'weekly', time: '08:00', days: [] },
      now, TZ,
    );
    assert.equal(out, null);
  });
});

test.describe('notification-trigger: malformed input', () => {
  test('returns null for unknown trigger type', () => {
    const out = trigger.evaluate({ type: 'interval', time: '08:00' }, new Date(), TZ);
    assert.equal(out, null);
  });

  test('returns null for malformed time', () => {
    const out = trigger.evaluate({ type: 'daily', time: '8am' }, new Date(), TZ);
    assert.equal(out, null);
  });

  test('returns null when tz is missing', () => {
    const out = trigger.evaluate({ type: 'daily', time: '08:00' }, new Date(), null);
    assert.equal(out, null);
  });
});
