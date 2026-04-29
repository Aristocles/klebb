// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/date-util.test.js
// Unit tests for public/js/lib/date-util.js — local-timezone date
// helpers. The bug these fix: new Date().toISOString() returns UTC,
// so in UTC+ timezones "today" rolled back to yesterday in the morning,
// breaking the meta.prompt modal queue.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { localDateStr, localToday } from '../public/js/lib/date-util.js';

test('localDateStr: formats a local Date as YYYY-MM-DD', () => {
  const d = new Date(2026, 3, 25, 7, 0, 0); // 25 April 2026, local
  assert.equal(localDateStr(d), '2026-04-25');
});

test('localDateStr: pads month and day', () => {
  const d = new Date(2026, 0, 3, 0, 0, 0); // 3 January 2026, local
  assert.equal(localDateStr(d), '2026-01-03');
});

test('localDateStr: returns local date even when UTC date differs', () => {
  // 07:00 in Sydney (UTC+10) on 2026-04-25 is 21:00 on 2026-04-24 in UTC.
  // Build a Date that represents that exact instant, then assert that
  // localDateStr uses the runner's local zone (not UTC).
  const instant = new Date('2026-04-24T21:00:00Z');
  const expectedY = instant.getFullYear();
  const expectedM = String(instant.getMonth() + 1).padStart(2, '0');
  const expectedD = String(instant.getDate()).padStart(2, '0');
  assert.equal(localDateStr(instant), `${expectedY}-${expectedM}-${expectedD}`);
  // And explicitly verify it doesn't fall back to the UTC slice which
  // would be '2026-04-24' regardless of runner timezone.
  if (instant.getTimezoneOffset() < 0) {
    // Runner is in a UTC+ zone — local date should be 2026-04-25, not UTC's 2026-04-24.
    assert.equal(localDateStr(instant), '2026-04-25');
    assert.notEqual(localDateStr(instant), instant.toISOString().slice(0, 10));
  }
});

test('localToday: returns today in local timezone, YYYY-MM-DD format', () => {
  const result = localToday();
  assert.match(result, /^\d{4}-\d{2}-\d{2}$/);
  const now = new Date();
  assert.equal(result, localDateStr(now));
});
