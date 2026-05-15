// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/prompt-queue.test.js
// Unit tests for public/js/lib/prompt-queue.js — the modal prompt
// queueing logic for meta.prompt.enabled cards.
//
// Tests the pure buildPromptQueue() function against synthetic manifest
// lists + an in-memory localStorage stand-in. The network-fetching
// checkPromptsForToday() wrapper is not tested here (integration level).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPromptQueue,
  entryExistsForDate,
  allScheduledTakenForDate,
  wasShownToday,
  markShownToday,
  shownTodayKey,
} from '../public/js/lib/prompt-queue.js';

function makeStorage() {
  const data = new Map();
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
    _dump: () => Object.fromEntries(data),
  };
}

test('entryExistsForDate: flat array of dated entries', () => {
  const data = [{ date: '2026-04-23', mood: 3 }];
  assert.equal(entryExistsForDate(data, '2026-04-23'), true);
  assert.equal(entryExistsForDate(data, '2026-04-22'), false);
});

test('entryExistsForDate: items[].doses (peptides-style)', () => {
  const data = {
    items: [
      { name: 'reta', doses: [{ scheduledDate: '2026-04-23', takenAt: '2026-04-23T08:00' }] },
    ],
  };
  assert.equal(entryExistsForDate(data, '2026-04-23'), true);
  assert.equal(entryExistsForDate(data, '2026-04-22'), false);
});

test('entryExistsForDate: items[].doses with takenAt null does not count', () => {
  const data = {
    items: [
      { name: 'reta', doses: [{ scheduledDate: '2026-04-23', takenAt: null }] },
    ],
  };
  assert.equal(entryExistsForDate(data, '2026-04-23'), false);
});

test('entryExistsForDate: supplements-style { current: [{ takenDates }] }', () => {
  const data = { current: [{ name: 'B12', takenDates: ['2026-04-23'] }] };
  assert.equal(entryExistsForDate(data, '2026-04-23'), true);
  assert.equal(entryExistsForDate(data, '2026-04-22'), false);
});

test('entryExistsForDate: null / empty shapes', () => {
  assert.equal(entryExistsForDate(null, '2026-04-23'), false);
  assert.equal(entryExistsForDate({}, '2026-04-23'), false);
  assert.equal(entryExistsForDate({ items: [] }, '2026-04-23'), false);
});

test('shownTodayKey format', () => {
  assert.equal(shownTodayKey('mood', '2026-04-23'), 'klebb-prompt-shown-mood-2026-04-23');
});

test('wasShownToday + markShownToday round-trip', () => {
  const s = makeStorage();
  assert.equal(wasShownToday('mood', '2026-04-23', s), false);
  markShownToday('mood', '2026-04-23', s);
  assert.equal(wasShownToday('mood', '2026-04-23', s), true);
  // Different date → still false
  assert.equal(wasShownToday('mood', '2026-04-24', s), false);
});

test('buildPromptQueue: skips cards without prompt.enabled', () => {
  const storage = makeStorage();
  const manifests = [
    { meta: { id: 'weight', order: 0 }, data: [] },
    { meta: { id: 'mood', order: 1, prompt: { enabled: false } }, data: [] },
  ];
  const q = buildPromptQueue(manifests, { date: '2026-04-23', storage });
  assert.deepEqual(q, []);
});

test('buildPromptQueue: skips disabled cards even with prompt.enabled', () => {
  const storage = makeStorage();
  const manifests = [
    { meta: { id: 'mood', enabled: false, prompt: { enabled: true } }, data: [] },
  ];
  const q = buildPromptQueue(manifests, { date: '2026-04-23', storage });
  assert.deepEqual(q, []);
});

test('buildPromptQueue: skips cards already shown today', () => {
  const storage = makeStorage();
  markShownToday('mood', '2026-04-23', storage);
  const manifests = [
    { meta: { id: 'mood', prompt: { enabled: true } }, data: [] },
  ];
  const q = buildPromptQueue(manifests, { date: '2026-04-23', storage });
  assert.deepEqual(q, []);
});

test('buildPromptQueue: skips cards with today entry (whenMissing default)', () => {
  const storage = makeStorage();
  const manifests = [
    { meta: { id: 'mood', prompt: { enabled: true } }, data: [{ date: '2026-04-23', mood: 4 }] },
  ];
  const q = buildPromptQueue(manifests, { date: '2026-04-23', storage });
  assert.deepEqual(q, []);
});

test('buildPromptQueue: whenMissing false → always prompts (if not shown)', () => {
  const storage = makeStorage();
  const manifests = [
    {
      meta: { id: 'mood', prompt: { enabled: true, whenMissing: false } },
      data: [{ date: '2026-04-23', mood: 4 }],
    },
  ];
  const q = buildPromptQueue(manifests, { date: '2026-04-23', storage });
  assert.equal(q.length, 1);
  assert.equal(q[0].meta.id, 'mood');
});

test('buildPromptQueue: includes eligible card', () => {
  const storage = makeStorage();
  const manifests = [
    { meta: { id: 'mood', prompt: { enabled: true } }, data: [] },
  ];
  const q = buildPromptQueue(manifests, { date: '2026-04-23', storage });
  assert.equal(q.length, 1);
  assert.equal(q[0].meta.id, 'mood');
});

test('buildPromptQueue: sorts by meta.order ascending, stable on id', () => {
  const storage = makeStorage();
  const manifests = [
    { meta: { id: 'bp', order: 5, prompt: { enabled: true } }, data: [] },
    { meta: { id: 'weight', order: 1, prompt: { enabled: true } }, data: [] },
    { meta: { id: 'mood', order: 5, prompt: { enabled: true } }, data: [] },
  ];
  const q = buildPromptQueue(manifests, { date: '2026-04-23', storage });
  assert.deepEqual(q.map(c => c.meta.id), ['weight', 'bp', 'mood']);
});

test('buildPromptQueue: missing meta.order treated as 999', () => {
  const storage = makeStorage();
  const manifests = [
    { meta: { id: 'a', order: 10, prompt: { enabled: true } }, data: [] },
    { meta: { id: 'b', prompt: { enabled: true } }, data: [] },
  ];
  const q = buildPromptQueue(manifests, { date: '2026-04-23', storage });
  assert.deepEqual(q.map(c => c.meta.id), ['a', 'b']);
});

test('buildPromptQueue: handles empty and null manifests', () => {
  const storage = makeStorage();
  assert.deepEqual(buildPromptQueue([], { storage }), []);
  assert.deepEqual(buildPromptQueue(null, { storage }), []);
  assert.deepEqual(buildPromptQueue(undefined, { storage }), []);
});

// --- checklist-mode (#185) ---

const SCHEDULE_DATA = (taken) => ({
  items: [
    {
      id: 'a',
      name: 'A',
      schedule: { type: 'daily' },
      doses: taken.a ? [{ scheduledDate: '2026-04-23', takenAt: '2026-04-23T08:00' }] : [],
    },
    {
      id: 'b',
      name: 'B',
      schedule: { type: 'daily' },
      doses: taken.b ? [{ scheduledDate: '2026-04-23', takenAt: '2026-04-23T08:01' }] : [],
    },
    {
      id: 'c',
      name: 'C',
      schedule: { type: 'daily' },
      doses: taken.c ? [{ scheduledDate: '2026-04-23', takenAt: '2026-04-23T08:02' }] : [],
    },
  ],
});

test('allScheduledTakenForDate: NONE taken → false', () => {
  assert.equal(allScheduledTakenForDate(SCHEDULE_DATA({}), '2026-04-23'), false);
});

test('allScheduledTakenForDate: SOME taken → false', () => {
  assert.equal(allScheduledTakenForDate(SCHEDULE_DATA({ a: true }), '2026-04-23'), false);
  assert.equal(allScheduledTakenForDate(SCHEDULE_DATA({ a: true, b: true }), '2026-04-23'), false);
});

test('allScheduledTakenForDate: ALL taken → true', () => {
  assert.equal(
    allScheduledTakenForDate(SCHEDULE_DATA({ a: true, b: true, c: true }), '2026-04-23'),
    true,
  );
});

test('allScheduledTakenForDate: nothing scheduled today → false (no prompt to suppress)', () => {
  // schedule.type omitted is the same as no schedule → not 'scheduled'
  // for items with explicit schedule blocks, so use a weekly Mon-only
  // schedule and a Tuesday date.
  const data = {
    items: [
      { id: 'a', name: 'A', schedule: { type: 'weekly', on_days: ['Mon'] } },
    ],
  };
  // 2026-04-23 is a Thursday — item A is not scheduled, so the
  // checklist would render empty. Treat that as "no prompt warranted"
  // (false), matching the same falsy answer entryExistsForDate returns
  // when the data is empty.
  assert.equal(allScheduledTakenForDate(data, '2026-04-23'), false);
});

test('allScheduledTakenForDate: takenDates shape (supplement-stack) ALL taken', () => {
  const data = {
    items: [
      { id: 'a', name: 'B12', takenDates: ['2026-04-23'] },
      { id: 'b', name: 'D3',  takenDates: ['2026-04-23'] },
    ],
  };
  assert.equal(allScheduledTakenForDate(data, '2026-04-23'), true);
});

test('allScheduledTakenForDate: takenDates shape SOME taken → false', () => {
  const data = {
    items: [
      { id: 'a', name: 'B12', takenDates: ['2026-04-23'] },
      { id: 'b', name: 'D3',  takenDates: [] },
    ],
  };
  assert.equal(allScheduledTakenForDate(data, '2026-04-23'), false);
});

test('buildPromptQueue: checklist mode skips when ALL items taken', () => {
  const storage = makeStorage();
  const manifests = [
    {
      meta: { id: 'peptides', prompt: { enabled: true, mode: 'checklist' } },
      data: SCHEDULE_DATA({ a: true, b: true, c: true }),
    },
  ];
  const q = buildPromptQueue(manifests, { date: '2026-04-23', storage });
  assert.deepEqual(q, []);
});

test('buildPromptQueue: checklist mode includes card when SOME items unmarked', () => {
  const storage = makeStorage();
  const manifests = [
    {
      meta: { id: 'peptides', prompt: { enabled: true, mode: 'checklist' } },
      data: SCHEDULE_DATA({ a: true }),
    },
  ];
  const q = buildPromptQueue(manifests, { date: '2026-04-23', storage });
  assert.equal(q.length, 1);
  assert.equal(q[0].meta.id, 'peptides');
});

test('buildPromptQueue: checklist mode includes card when NONE taken', () => {
  const storage = makeStorage();
  const manifests = [
    {
      meta: { id: 'peptides', prompt: { enabled: true, mode: 'checklist' } },
      data: SCHEDULE_DATA({}),
    },
  ];
  const q = buildPromptQueue(manifests, { date: '2026-04-23', storage });
  assert.equal(q.length, 1);
});

test('buildPromptQueue: defends against malformed manifest entries', () => {
  const storage = makeStorage();
  const manifests = [
    null,
    {},
    { meta: null },
    { meta: { id: 'good', prompt: { enabled: true } }, data: [] },
  ];
  const q = buildPromptQueue(manifests, { date: '2026-04-23', storage });
  assert.equal(q.length, 1);
  assert.equal(q[0].meta.id, 'good');
});
