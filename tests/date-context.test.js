// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/date-context.test.js
//
// Unit tests for chat/date-context.js. The bug these lock in: the chat
// agent used to compute weekdays from an ISO date itself and got them
// confidently wrong (said Friday for 2026-05-11, which is a Monday).
// We now pre-compute a weekday lookup table and inject it into the
// system prompt.

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildDateContextBlock } = require('../chat/date-context');

test('today line names the correct weekday', () => {
  // 2026-05-06 is a Wednesday.
  const now = new Date('2026-05-06T06:00:00Z');
  const block = buildDateContextBlock({ now, tz: 'UTC', pastDays: 1, futureDays: 1 });
  assert.match(block, /Today is Wednesday, 2026-05-06\./);
});

test('lookup table names the correct weekday for +5 days (the regression case)', () => {
  // Regression: agent said "Friday, 2026-05-11" when asked "5 days from
  // now" on Wed 2026-05-06. 2026-05-11 is a Monday.
  const now = new Date('2026-05-06T06:00:00Z');
  const block = buildDateContextBlock({ now, tz: 'UTC', pastDays: 0, futureDays: 7 });
  assert.match(block, /\+05 {2}Mon {2}2026-05-11/);
  assert.doesNotMatch(block, /Fri {2}2026-05-11/);
});

test('tomorrow and yesterday are labelled', () => {
  const now = new Date('2026-05-06T06:00:00Z');
  const block = buildDateContextBlock({ now, tz: 'UTC', pastDays: 1, futureDays: 1 });
  assert.match(block, /\+01 {2}Thu {2}2026-05-07 {2}\(tomorrow\)/);
  assert.match(block, /-01 {2}Tue {2}2026-05-05 {2}\(yesterday\)/);
  assert.match(block, /0 {2}Wed {2}2026-05-06 {2}\(today\)/);
});

test('spans month and year boundaries correctly', () => {
  // Dec 31 2026 is a Thursday. +1 is Jan 1 2027 (Friday).
  const now = new Date('2026-12-31T12:00:00Z');
  const block = buildDateContextBlock({ now, tz: 'UTC', pastDays: 0, futureDays: 2 });
  assert.match(block, /Today is Thursday, 2026-12-31\./);
  assert.match(block, /\+01 {2}Fri {2}2027-01-01/);
  assert.match(block, /\+02 {2}Sat {2}2027-01-02/);
});

test('respects TZ when computing "today"', () => {
  // 2026-05-06T14:00:00Z is Thursday 07 May 2026 at 00:00 in Sydney
  // (UTC+10), but still Wednesday 06 May in UTC.
  const now = new Date('2026-05-06T14:00:00Z');
  const utc = buildDateContextBlock({ now, tz: 'UTC', pastDays: 0, futureDays: 0 });
  const syd = buildDateContextBlock({ now, tz: 'Australia/Sydney', pastDays: 0, futureDays: 0 });
  assert.match(utc, /Today is Wednesday, 2026-05-06\./);
  assert.match(syd, /Today is Thursday, 2026-05-07\./);
});

test('tells the model not to compute weekdays itself', () => {
  const now = new Date('2026-05-06T06:00:00Z');
  const block = buildDateContextBlock({ now, tz: 'UTC' });
  assert.match(block, /Do NOT compute weekdays yourself/);
  assert.match(block, /do not state a weekday you have not been told/);
});

test('default window is -14..+60 days', () => {
  const now = new Date('2026-05-06T06:00:00Z');
  const block = buildDateContextBlock({ now, tz: 'UTC' });
  // 75 total offset lines: -14..+60 inclusive.
  const lines = block.split('\n').filter(l => /^ {2}[-+ ]\d/.test(l));
  assert.equal(lines.length, 75);
  assert.match(block, /-14 {2}[A-Z][a-z]{2} {2}\d{4}-\d{2}-\d{2}/);
  assert.match(block, /\+60 {2}[A-Z][a-z]{2} {2}\d{4}-\d{2}-\d{2}/);
});

test('every listed weekday matches the ISO date it is paired with', () => {
  const now = new Date('2026-05-06T06:00:00Z');
  const block = buildDateContextBlock({ now, tz: 'UTC', pastDays: 30, futureDays: 90 });
  const shortNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const re = /^ {2}[-+ ]\d\d {2}([A-Z][a-z]{2}) {2}(\d{4})-(\d{2})-(\d{2})/gm;
  let m;
  let checked = 0;
  while ((m = re.exec(block)) !== null) {
    const [, name, y, mo, d] = m;
    const expected = shortNames[new Date(Date.UTC(+y, +mo - 1, +d)).getUTCDay()];
    assert.equal(name, expected, `weekday mismatch for ${y}-${mo}-${d}`);
    checked++;
  }
  assert.ok(checked > 100, `expected to check many rows, got ${checked}`);
});
