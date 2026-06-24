// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/hygiene.test.js
// Unit tests for the hygiene scan: stale/growth/orphaned-input detection,
// the conservative suppression rules, the ambient staleness-only filter,
// and TOOL_DEFS membership.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { scanHygiene, ambientStaleness, orphanedInputKeys, hasScheduleCadence } = require('../chat/hygiene');
const { TOOL_DEFS } = require('../chat/tools');

const TODAY = '2026-06-24';

function makeRegistry(cards, mtimes = {}) {
  const byId = new Map(cards.map(c => [c.id, c]));
  return {
    list: () => cards.map(c => ({ id: c.id, meta: c.meta || {} })),
    get: id => (byId.has(id) ? { meta: byId.get(id).meta || {}, data: byId.get(id).data } : null),
    sourceMtime: id => (id in mtimes ? mtimes[id] : null),
  };
}

// rows ending N days before TODAY, daily
function rowsEnding(daysAgo, count, field = 'v') {
  const out = [];
  const end = Date.parse(`${TODAY}T00:00:00Z`) - daysAgo * 86400000;
  for (let i = count - 1; i >= 0; i--) {
    out.push({ date: new Date(end - i * 86400000).toISOString().slice(0, 10), [field]: i });
  }
  return out;
}

describe('hygiene: stale detection', () => {
  test('flags an atomic card untouched well past the default window', () => {
    const reg = makeRegistry([{ id: 'weight', meta: { label: 'Weight' }, data: rowsEnding(30, 5) }]);
    const { findings } = scanHygiene(reg, TODAY);
    const stale = findings.find(f => f.cardId === 'weight' && f.kind === 'stale');
    assert.ok(stale, 'expected a stale finding');
    assert.match(stale.detail, /No entry in 30 days/);
  });

  test('does NOT flag a fresh card', () => {
    const reg = makeRegistry([{ id: 'weight', meta: {}, data: rowsEnding(1, 5) }]);
    assert.deepStrictEqual(scanHygiene(reg, TODAY).findings.filter(f => f.kind === 'stale'), []);
  });

  test('does NOT flag a near-empty card (too little signal)', () => {
    const reg = makeRegistry([{ id: 'weight', meta: {}, data: rowsEnding(60, 2) }]);
    assert.deepStrictEqual(scanHygiene(reg, TODAY).findings.filter(f => f.kind === 'stale'), []);
  });

  test('uses the tighter window for schedule-bearing cards', () => {
    // A card 10 days quiet: under the 21-day default it would NOT be stale,
    // but a recurring schedule tightens the window to 7 days so it trips.
    const reg = makeRegistry([{ id: 'p', meta: {}, data: rowsEnding(10, 5).map(r => ({ ...r, schedule: { type: 'daily' } })) }]);
    const stale = scanHygiene(reg, TODAY).findings.find(f => f.kind === 'stale');
    assert.ok(stale, 'a 10-day-old scheduled card should be stale under the 7-day window');
  });
});

describe('hygiene: growth + orphaned inputs', () => {
  test('flags a very large data block', () => {
    const reg = makeRegistry([{ id: 'big', meta: {}, data: rowsEnding(0, 800) }]);
    const growth = scanHygiene(reg, TODAY).findings.find(f => f.kind === 'growth');
    assert.ok(growth);
    assert.match(growth.detail, /800 rows/);
  });

  test('orphanedInputKeys finds a declared input no row uses', () => {
    const meta = { writeable: { inputs: [{ key: 'kg' }, { key: 'bodyFat' }] } };
    const data = [{ date: '2026-06-20', kg: 84 }];
    assert.deepStrictEqual(orphanedInputKeys(meta, data), ['bodyFat']);
  });

  test('orphanedInputKeys is empty when every input is used', () => {
    const meta = { writeable: { inputs: [{ key: 'kg' }] } };
    assert.deepStrictEqual(orphanedInputKeys(meta, [{ date: 'x', kg: 1 }]), []);
  });

  test('hasScheduleCadence detects items[] with a schedule', () => {
    assert.strictEqual(hasScheduleCadence({ items: [{ schedule: {} }] }), true);
    assert.strictEqual(hasScheduleCadence([{ date: 'x', v: 1 }]), false);
  });
});

describe('hygiene: ambient filter', () => {
  test('ambientStaleness returns only stale findings', () => {
    const reg = makeRegistry([
      { id: 'stalecard', meta: {}, data: rowsEnding(40, 5) },
      { id: 'bigcard', meta: {}, data: rowsEnding(0, 800) },
    ]);
    const ambient = ambientStaleness(reg, TODAY);
    assert.ok(ambient.length >= 1);
    assert.ok(ambient.every(f => f.kind === 'stale'));
  });
});

describe('hygiene: tool registration', () => {
  test('hygiene_scan is in TOOL_DEFS with no required params', () => {
    const def = TOOL_DEFS.find(t => t.function?.name === 'hygiene_scan');
    assert.ok(def, 'hygiene_scan missing from TOOL_DEFS');
    assert.deepStrictEqual(def.function.parameters.properties, {});
  });
});
