// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/hero-tier.test.js
// Unit tests for public/js/lib/hero-tier.js: the pinned/hero tier sort
// that lifts meta.view.priority cards to the top of the Today view.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { orderCardsForView } from '../public/js/lib/hero-tier.js';

// Cards arrive already sorted by the server's order convention, so these
// fixtures are written in that incoming order.
function card(id, { priority, order } = {}) {
  const view = { enabled: true, component: 'generic-card' };
  if (priority !== undefined) view.priority = priority;
  return { id, meta: { id, label: id, order, view }, viewConfig: view };
}

const ids = (rows) => rows.map(r => r.card.id);

describe('orderCardsForView', () => {
  test('lower priority sorts ahead among pinned cards', () => {
    const cards = [card('a', { priority: 30 }), card('b', { priority: 10 }), card('c', { priority: 20 })];
    const out = orderCardsForView(cards, 'view');
    assert.deepEqual(ids(out), ['b', 'c', 'a']);
    assert.ok(out.every(r => r.pinned === true));
  });

  test('pinned cards precede unpinned cards', () => {
    const cards = [
      card('plain1'),
      card('pinned', { priority: 5 }),
      card('plain2'),
    ];
    const out = orderCardsForView(cards, 'view');
    assert.deepEqual(ids(out), ['pinned', 'plain1', 'plain2']);
    assert.deepEqual(out.map(r => r.pinned), [true, false, false]);
  });

  test('among unpinned cards the incoming order is preserved', () => {
    // Incoming is already order-sorted; ties must stay stable.
    const cards = [card('first'), card('second'), card('third')];
    const out = orderCardsForView(cards, 'view');
    assert.deepEqual(ids(out), ['first', 'second', 'third']);
  });

  test('no priority anywhere yields the same order as input', () => {
    const cards = [card('a'), card('b'), card('c'), card('d')];
    const out = orderCardsForView(cards, 'view');
    assert.deepEqual(ids(out), ['a', 'b', 'c', 'd']);
    assert.ok(out.every(r => r.pinned === false));
  });

  test('equal priorities keep their incoming relative order (stable)', () => {
    const cards = [
      card('p1', { priority: 10 }),
      card('p2', { priority: 10 }),
      card('p3', { priority: 5 }),
    ];
    const out = orderCardsForView(cards, 'view');
    assert.deepEqual(ids(out), ['p3', 'p1', 'p2']);
  });

  test('hero treatment applies only to the today/default view', () => {
    const cards = [card('plain'), card('pinned', { priority: 1 })];
    for (const view of ['trends', 'calendar', 'reports', 'dayDetail']) {
      const out = orderCardsForView(cards, view);
      assert.deepEqual(ids(out), ['plain', 'pinned'], `order untouched for ${view}`);
      assert.ok(out.every(r => r.pinned === false), `nothing pinned for ${view}`);
    }
  });

  test('non-numeric / non-finite priority is treated as unpinned', () => {
    const weird = [
      card('a', { priority: 'high' }),
      card('b', { priority: NaN }),
      card('c', { priority: 0 }),
    ];
    const out = orderCardsForView(weird, 'view');
    // Only c (priority 0, finite) is pinned; the rest keep input order.
    assert.deepEqual(ids(out), ['c', 'a', 'b']);
    assert.deepEqual(out.map(r => r.pinned), [true, false, false]);
  });

  test('empty / non-array input is safe', () => {
    assert.deepEqual(orderCardsForView([], 'view'), []);
    assert.deepEqual(orderCardsForView(undefined, 'view'), []);
    assert.deepEqual(orderCardsForView(null, 'trends'), []);
  });
});
