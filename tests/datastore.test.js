// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/datastore.test.js
// Unit tests for lib/datastore: memory-first reads with reference aliasing,
// transactional SQLite persistence, rollback-on-throw, and reload fidelity.

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { open } = require('../lib/datastore');

// node:sqlite is unflagged from Node 22.13; the CI matrix still carries a
// Node 20 leg until the engines floor bumps. Skip (loudly) where the module
// is unavailable rather than failing a runtime the datastore never targets.
let sqliteAvailable = true;
try { require('node:sqlite'); } catch { sqliteAvailable = false; }
const skip = sqliteAvailable ? false : 'node:sqlite unavailable on this Node';

let dir;
let store;

beforeEach(() => {
  if (!sqliteAvailable) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eh-ds-'));
  store = open(path.join(dir, 'db', 'klebb.db'));
});

afterEach(() => {
  if (!sqliteAvailable) return;
  try { store.close(); } catch {}
  fs.rmSync(dir, { recursive: true, force: true });
});

function reopen() {
  store.close();
  store = open(path.join(dir, 'db', 'klebb.db'));
  store.load();
}

describe('datastore basics', { skip }, () => {
  test('creates the db directory and WAL sidecar', () => {
    assert.ok(fs.existsSync(path.join(dir, 'db', 'klebb.db')));
    store.setData('weight', [{ date: '2026-01-01', kg: 80 }]);
    assert.ok(fs.existsSync(path.join(dir, 'db', 'klebb.db-wal')), 'WAL file appears beside the db');
  });

  test('getData returns the same reference setData stored (aliasing)', () => {
    const value = [{ date: '2026-01-01', kg: 80 }];
    store.setData('weight', value);
    assert.strictEqual(store.getData('weight'), value);
    value.push({ date: '2026-01-02', kg: 79.5 });
    assert.strictEqual(store.getData('weight').length, 2);
  });

  test('unknown card reads as null / hasData false / updatedAt null', () => {
    assert.strictEqual(store.getData('nope'), null);
    assert.strictEqual(store.hasData('nope'), false);
    assert.strictEqual(store.dataUpdatedAt('nope'), null);
  });

  test('null data is recorded: known card, hasData false', () => {
    store.setData('combo', null);
    assert.strictEqual(store.getData('combo'), null);
    assert.strictEqual(store.hasData('combo'), false);
    assert.ok(store.dataUpdatedAt('combo'), 'null-data card still has a bookkeeping timestamp');
    reopen();
    assert.strictEqual(store.getData('combo'), null);
    assert.strictEqual(store.hasData('combo'), false);
    assert.ok(store.dataUpdatedAt('combo'));
  });

  test('setData full-replaces prior rows', () => {
    store.setData('mood', [{ date: '2026-05-01', mood: 3 }, { date: '2026-05-02', mood: 4 }]);
    store.setData('mood', [{ date: '2026-05-03', mood: 5 }]);
    reopen();
    assert.deepStrictEqual(store.getData('mood'), [{ date: '2026-05-03', mood: 5 }]);
  });

  test('deleteCard removes value, bookkeeping, and rows durably', () => {
    store.setData('mood', [{ date: '2026-05-01', mood: 3 }]);
    assert.strictEqual(store.deleteCard('mood'), true);
    assert.strictEqual(store.getData('mood'), null);
    assert.strictEqual(store.hasData('mood'), false);
    assert.strictEqual(store.dataUpdatedAt('mood'), null);
    reopen();
    assert.strictEqual(store.getData('mood'), null);
    assert.strictEqual(store.deleteCard('mood'), false, 'second delete reports unknown');
  });

  test('setData rejects a bad id', () => {
    assert.throws(() => store.setData('', []), /non-empty string/);
    assert.throws(() => store.setData(42, []), /non-empty string/);
  });
});

describe('datastore persistence fidelity', { skip }, () => {
  const shapes = {
    'dated array': [{ date: '2026-01-01', kg: 80 }, { date: '2026-01-02', kg: 79.5, note: 'fasted' }],
    'bare-string array': ['Good morning', 'Up and at em'],
    'items+groups roster': {
      items: [{ name: 'BPC-157', doses: [{ scheduledDate: '2026-04-29', takenAt: null }] }],
      groups: [{ id: 'am', items: ['BPC-157'] }],
    },
    'current+past roster': { current: [{ name: 'Creatine' }], past: [] },
    'document object': { apoe: 'e3/e3', categories: [{ name: 'Methylation' }], found_count: 412 },
    'markdown doc': { markdown: '# Notes' },
    'empty array': [],
    'empty containers': { items: [], groups: [] },
    'bare string': 'just a string',
    'duplicate + empty dates': [{ date: '2026-05-24', mood: 3 }, { date: '2026-05-24', mood: 4 }, { date: '', note: 'x' }],
    '__proto__ key': JSON.parse('{"__proto__": [1], "items": [{"a": 1}]}'),
  };

  for (const [label, value] of Object.entries(shapes)) {
    test(`round-trips through reload: ${label}`, () => {
      store.setData('card', value);
      reopen();
      assert.deepStrictEqual(store.getData('card'), JSON.parse(JSON.stringify(value)));
    });
  }

  test('load rebuilds multiple cards and their timestamps', () => {
    store.setData('a', [{ date: '2026-01-01', v: 1 }]);
    store.setData('b', { items: [{ name: 'x' }] });
    const atA = store.dataUpdatedAt('a');
    const atB = store.dataUpdatedAt('b');
    reopen();
    const { count } = store.load();
    assert.strictEqual(count, 2);
    assert.strictEqual(store.dataUpdatedAt('a'), atA);
    assert.strictEqual(store.dataUpdatedAt('b'), atB);
  });

  test('a user container key named __rest__ cannot collide with the rest channel', () => {
    const value = { __rest__: [{ a: 1 }], note: 'scalar stays in rest doc' };
    store.setData('tricky', value);
    reopen();
    assert.deepStrictEqual(store.getData('tricky'), value);
  });

  test('a user container key named __doc__ cannot collide with the doc channel', () => {
    const value = { __doc__: [{ a: 1 }, { b: 2 }], note: 'x' };
    store.setData('tricky', value);
    reopen();
    assert.deepStrictEqual(store.getData('tricky'), value);
  });
});

describe('datastore transactionality', { skip }, () => {
  test('a throw mid-transaction leaves DB and memory at prior state', () => {
    const before = [{ date: '2026-01-01', kg: 80 }];
    store.setData('weight', before);

    // Row 0 serialises fine; row 1 contains a BigInt, which JSON.stringify
    // rejects AFTER row 0's INSERT already ran inside the transaction.
    const poisoned = [{ date: '2026-01-02', kg: 79 }, { date: '2026-01-03', kg: 1n }];
    assert.throws(() => store.setData('weight', poisoned), TypeError);

    assert.strictEqual(store.getData('weight'), before, 'memory untouched');
    reopen();
    assert.deepStrictEqual(store.getData('weight'), before, 'DB rolled back to prior rows');
  });

  test('a failed write does not poison later writes', () => {
    store.setData('weight', [{ date: '2026-01-01', kg: 80 }]);
    assert.throws(() => store.setData('weight', [{ bad: 1n }]));
    store.setData('weight', [{ date: '2026-01-05', kg: 78 }]);
    reopen();
    assert.deepStrictEqual(store.getData('weight'), [{ date: '2026-01-05', kg: 78 }]);
  });
});

describe('datastore perf smoke', { skip }, () => {
  test('steps-sized card (1,300 rows) set+get round trip', () => {
    const rows = [];
    for (let i = 0; i < 1300; i++) {
      const d = new Date(2022, 9, 1 + i);
      const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      rows.push({ date, count: 4000 + (i % 9000) });
    }
    const t0 = process.hrtime.bigint();
    store.setData('steps', rows);
    const got = store.getData('steps');
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.strictEqual(got.length, 1300);
    // Soft threshold: CI boxes vary, so log rather than fail below the
    // pathological line. >500ms means insert-per-row went unprepared.
    if (ms > 50) console.log(`[perf] steps-sized setData+getData took ${ms.toFixed(1)}ms (soft target 50ms)`);
    assert.ok(ms < 500, `pathological write: ${ms.toFixed(1)}ms`);

    const t1 = process.hrtime.bigint();
    reopen();
    const loadMs = Number(process.hrtime.bigint() - t1) / 1e6;
    assert.strictEqual(store.getData('steps').length, 1300);
    if (loadMs > 100) console.log(`[perf] reload of 1,300 rows took ${loadMs.toFixed(1)}ms`);
  });
});
