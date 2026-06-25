// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/hero-tier.test.js
// Unit tests for public/js/lib/hero-tier.js. Contract: priority FLAGS a card
// as pinned (styling only) but never re-sorts the list, so a manual reorder
// (which rewrites meta.order, the server's sort key) always wins.

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
  test('preserves the incoming order even when priorities differ', () => {
    // Incoming order is the server meta.order sequence. priority must NOT
    // re-sort it: this is what lets a manual drag stick.
    const cards = [card('a', { priority: 30 }), card('b', { priority: 10 }), card('c', { priority: 20 })];
    const out = orderCardsForView(cards, 'view');
    assert.deepEqual(ids(out), ['a', 'b', 'c']);
    assert.ok(out.every(r => r.pinned === true));
  });

  test('REGRESSION: a reordered priority card is NOT snapped back to the top', () => {
    // Simulate the user dragging the high-priority "weight" card to the
    // bottom: the server returns it last (its meta.order was rewritten).
    // orderCardsForView must leave it last.
    const reordered = [
      card('steps', { priority: 20 }),
      card('notes'),
      card('weight', { priority: 10 }), // dragged to the end despite low priority
    ];
    const out = orderCardsForView(reordered, 'view');
    assert.deepEqual(ids(out), ['steps', 'notes', 'weight']);
    assert.equal(out[out.length - 1].card.id, 'weight');
  });

  test('pinned flag is set by priority presence, order untouched', () => {
    const cards = [card('plain1'), card('pinned', { priority: 5 }), card('plain2')];
    const out = orderCardsForView(cards, 'view');
    assert.deepEqual(ids(out), ['plain1', 'pinned', 'plain2']);
    assert.deepEqual(out.map(r => r.pinned), [false, true, false]);
  });

  test('no priority anywhere yields the same order, nothing pinned', () => {
    const cards = [card('a'), card('b'), card('c'), card('d')];
    const out = orderCardsForView(cards, 'view');
    assert.deepEqual(ids(out), ['a', 'b', 'c', 'd']);
    assert.ok(out.every(r => r.pinned === false));
  });

  test('hero treatment (the pinned flag) applies only to the today view', () => {
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
    assert.deepEqual(ids(out), ['a', 'b', 'c']); // order always preserved
    assert.deepEqual(out.map(r => r.pinned), [false, false, true]); // only finite 0 is pinned
  });

  test('empty / non-array input is safe', () => {
    assert.deepEqual(orderCardsForView([], 'view'), []);
    assert.deepEqual(orderCardsForView(undefined, 'view'), []);
    assert.deepEqual(orderCardsForView(null, 'trends'), []);
  });
});
