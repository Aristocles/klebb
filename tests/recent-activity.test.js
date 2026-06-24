// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/recent-activity.test.js
// Unit tests for the get_recent_activity summary: per-card recency/staleness
// derivation (per-row date with dateField override and mtime fallback) and
// TOOL_DEFS membership.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { buildRecentActivity, dateFieldFor, ageInDays } = require('../chat/recent-activity');
const { TOOL_DEFS } = require('../chat/tools');

// Minimal registry stub: list() yields {id, meta}, get(id) yields {data},
// sourceMtime(id) yields an epoch-ms or null. Mirrors the real registry's
// shape for these three accessors only.
function makeRegistry(cards, mtimes = {}) {
  const byId = new Map(cards.map(c => [c.id, c]));
  return {
    list: () => cards.map(c => ({ id: c.id, meta: c.meta || {} })),
    get: id => (byId.has(id) ? { data: byId.get(id).data } : null),
    sourceMtime: id => (id in mtimes ? mtimes[id] : null),
  };
}

const TODAY = '2026-06-24';

describe('recent-activity: date field resolution', () => {
  test('defaults to "date"', () => {
    assert.strictEqual(dateFieldFor({}), 'date');
    assert.strictEqual(dateFieldFor({ view: {} }), 'date');
  });
  test('honours meta.view.dateField override', () => {
    assert.strictEqual(dateFieldFor({ view: { dateField: 'loggedOn' } }), 'loggedOn');
  });
});

describe('recent-activity: ageInDays', () => {
  test('whole-day difference, today - then', () => {
    assert.strictEqual(ageInDays('2026-06-24', '2026-06-12'), 12);
    assert.strictEqual(ageInDays('2026-06-24', '2026-06-24'), 0);
  });
  test('returns null on unparseable input', () => {
    assert.strictEqual(ageInDays('2026-06-24', 'nope'), null);
  });
});

describe('recent-activity: buildRecentActivity', () => {
  test('derives lastEntryDate/ageDays/rowCount from per-row date (staleSource rows)', () => {
    const reg = makeRegistry([
      {
        id: 'weight', meta: { label: 'Weight', view: { component: 'generic-card' } },
        data: [{ date: '2026-06-10', kg: 84 }, { date: '2026-06-22', kg: 83 }],
      },
    ]);
    const [w] = buildRecentActivity(reg, TODAY);
    assert.strictEqual(w.id, 'weight');
    assert.strictEqual(w.label, 'Weight');
    assert.strictEqual(w.renderer, 'generic-card');
    assert.strictEqual(w.rowCount, 2);
    assert.strictEqual(w.lastEntryDate, '2026-06-22');
    assert.strictEqual(w.ageDays, 2);
    assert.strictEqual(w.staleSource, 'rows');
  });

  test('lastNDelta is last-minus-previous for a single numeric field', () => {
    const reg = makeRegistry([
      { id: 'weight', meta: {}, data: [{ date: '2026-06-10', kg: 84 }, { date: '2026-06-22', kg: 83 }] },
    ]);
    const [w] = buildRecentActivity(reg, TODAY);
    assert.strictEqual(w.lastNDelta, -1);
  });

  test('lastNDelta is null when rows carry more than one numeric field', () => {
    const reg = makeRegistry([
      { id: 'bp', meta: {}, data: [{ date: '2026-06-10', sys: 120, dia: 80 }, { date: '2026-06-22', sys: 118, dia: 78 }] },
    ]);
    const [bp] = buildRecentActivity(reg, TODAY);
    assert.strictEqual(bp.lastNDelta, null);
  });

  test('honours meta.view.dateField override for staleness', () => {
    const reg = makeRegistry([
      { id: 'odd', meta: { view: { dateField: 'loggedOn' } }, data: [{ loggedOn: '2026-06-20', v: 1 }] },
    ]);
    const [o] = buildRecentActivity(reg, TODAY);
    assert.strictEqual(o.lastEntryDate, '2026-06-20');
    assert.strictEqual(o.ageDays, 4);
  });

  test('falls back to file mtime when no row date exists (staleSource mtime)', () => {
    const mtimeMs = Date.parse('2026-06-19T08:00:00Z');
    const reg = makeRegistry(
      [{ id: 'notes', meta: { view: { component: 'markdown-doc' } }, data: { markdown: 'hi' } }],
      { notes: mtimeMs },
    );
    const [n] = buildRecentActivity(reg, TODAY);
    assert.strictEqual(n.lastEntryDate, null);
    assert.strictEqual(n.staleSource, 'mtime');
    assert.strictEqual(n.ageDays, 5);
    assert.strictEqual(n.rowCount, 1);
  });

  test('null data yields rowCount 0 and no age when no mtime', () => {
    const reg = makeRegistry([{ id: 'empty', meta: {}, data: null }]);
    const [e] = buildRecentActivity(reg, TODAY);
    assert.strictEqual(e.rowCount, 0);
    assert.strictEqual(e.lastEntryDate, null);
    assert.strictEqual(e.ageDays, null);
    assert.strictEqual(e.staleSource, null);
  });
});

describe('recent-activity: tool registration', () => {
  test('get_recent_activity is in TOOL_DEFS with no required params', () => {
    const def = TOOL_DEFS.find(t => t.function?.name === 'get_recent_activity');
    assert.ok(def, 'get_recent_activity missing from TOOL_DEFS');
    assert.deepStrictEqual(def.function.parameters.properties, {});
  });
});
