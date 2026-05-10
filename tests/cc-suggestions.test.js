// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/cc-suggestions.test.js
// Unit tests for the CC-suggestion cluster heuristic + dismissal state.

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let tmp;
let ccs;

function reloadModule() {
  delete require.cache[require.resolve('../config/paths')];
  delete require.cache[require.resolve('../meta/cc-suggestions')];
  ccs = require('../meta/cc-suggestions');
}

function makeRegistry(cards) {
  return {
    list() {
      return cards.map(c => ({ id: c.id, meta: c.meta || {} }));
    },
  };
}

function card(id, category, extraMeta = {}) {
  return {
    id,
    meta: {
      id,
      label: id,
      category,
      view: { enabled: true, component: 'generic-card' },
      ...extraMeta,
    },
  };
}

function cc(id, combines) {
  return {
    id,
    meta: {
      id,
      label: id,
      view: {
        enabled: true,
        component: 'combination-card',
        combines: combines.map(sourceId => ({ sourceId })),
      },
    },
  };
}

describe('cc-suggestions', () => {
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eh-ccs-'));
    process.env.HEALTH_HOME = tmp;
    process.env.HEALTH_HOME_WARNED = '1';
    fs.mkdirSync(path.join(tmp, 'data'), { recursive: true });
    reloadModule();
  });
  afterEach(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    delete process.env.HEALTH_HOME;
  });

  describe('list()', () => {
    test('returns empty when fewer than 3 cards in any category', () => {
      const reg = makeRegistry([card('a', 'recovery'), card('b', 'recovery')]);
      assert.deepEqual(ccs.list(reg), { suggestions: [] });
    });

    test('emits a suggestion when 3+ cards share a category', () => {
      const reg = makeRegistry([
        card('sleep', 'sleep'),
        card('hrv', 'recovery'),
        card('rhr', 'recovery'),
        card('sleep2', 'recovery'),
      ]);
      const out = ccs.list(reg);
      assert.equal(out.suggestions.length, 1);
      assert.equal(out.suggestions[0].category, 'recovery');
      assert.deepEqual(out.suggestions[0].cardIds.sort(),
        ['hrv', 'rhr', 'sleep2']);
    });

    test('cards without meta.category are invisible to the heuristic', () => {
      const reg = makeRegistry([
        card('a', 'recovery'),
        card('b', 'recovery'),
        { id: 'c', meta: { id: 'c', label: 'C' } }, // no category
      ]);
      assert.deepEqual(ccs.list(reg), { suggestions: [] });
    });

    test('disabled cards are excluded', () => {
      const reg = makeRegistry([
        card('a', 'recovery'),
        card('b', 'recovery'),
        card('c', 'recovery', { enabled: false }),
      ]);
      assert.deepEqual(ccs.list(reg), { suggestions: [] });
    });

    test('cards already used in an existing CC are excluded', () => {
      const reg = makeRegistry([
        card('a', 'recovery'),
        card('b', 'recovery'),
        card('c', 'recovery'),
        card('d', 'recovery'),
        cc('recovery-ring', ['a', 'b', 'c']),
      ]);
      // a/b/c already combined; only d is left → no cluster.
      assert.deepEqual(ccs.list(reg), { suggestions: [] });
    });

    test('combination cards themselves are not part of clusters', () => {
      const reg = makeRegistry([
        card('a', 'recovery'),
        card('b', 'recovery'),
        // CC with meta.category shouldn't slip through into its own cluster.
        { id: 'rc', meta: {
            id: 'rc', label: 'Recovery', category: 'recovery',
            view: { enabled: true, component: 'combination-card' } } },
      ]);
      assert.deepEqual(ccs.list(reg), { suggestions: [] });
    });

    test('multiple categories produce multiple suggestions, sorted', () => {
      const reg = makeRegistry([
        card('s1', 'sleep'), card('s2', 'sleep'), card('s3', 'sleep'),
        card('r1', 'recovery'), card('r2', 'recovery'), card('r3', 'recovery'),
      ]);
      const out = ccs.list(reg);
      assert.equal(out.suggestions.length, 2);
      assert.deepEqual(out.suggestions.map(s => s.category),
        ['recovery', 'sleep']);
    });

    test('dismissed cluster is suppressed', () => {
      const reg = makeRegistry([
        card('a', 'recovery'), card('b', 'recovery'), card('c', 'recovery'),
      ]);
      ccs.dismiss('recovery', ['a', 'b', 'c']);
      assert.deepEqual(ccs.list(reg), { suggestions: [] });
    });

    test('adding a 4th card to a dismissed cluster re-fires with new key', () => {
      const reg3 = makeRegistry([
        card('a', 'recovery'), card('b', 'recovery'), card('c', 'recovery'),
      ]);
      ccs.dismiss('recovery', ['a', 'b', 'c']);
      assert.deepEqual(ccs.list(reg3), { suggestions: [] });

      // Add a fourth card; the old dismissal key no longer matches.
      const reg4 = makeRegistry([
        card('a', 'recovery'), card('b', 'recovery'),
        card('c', 'recovery'), card('d', 'recovery'),
      ]);
      const out = ccs.list(reg4);
      assert.equal(out.suggestions.length, 1);
      assert.deepEqual(out.suggestions[0].cardIds.sort(),
        ['a', 'b', 'c', 'd']);
    });
  });

  describe('dismiss()', () => {
    test('persists the key to disk', () => {
      ccs.dismiss('recovery', ['a', 'b', 'c']);
      const state = ccs.loadDismissed();
      const key = ccs.clusterKey('recovery', ['a', 'b', 'c']);
      assert.ok(state[key]);
      assert.equal(state[key].category, 'recovery');
      assert.deepEqual(state[key].cardIds.sort(), ['a', 'b', 'c']);
    });

    test('rejects empty cardIds', () => {
      assert.equal(ccs.dismiss('recovery', []), false);
      assert.equal(ccs.dismiss('recovery', null), false);
      assert.equal(ccs.dismiss('', ['a']), false);
    });

    test('cardIds order doesn\'t affect key (sorted in key)', () => {
      ccs.dismiss('recovery', ['c', 'a', 'b']);
      const state = ccs.loadDismissed();
      const key = ccs.clusterKey('recovery', ['a', 'b', 'c']);
      assert.ok(state[key]);
    });
  });

  describe('lazy file creation', () => {
    test('list() doesn\'t create the file', () => {
      const reg = makeRegistry([card('a', 'recovery'), card('b', 'recovery')]);
      ccs.list(reg);
      assert.equal(fs.existsSync(ccs.FILE), false);
    });
    test('dismiss() creates the file on first call', () => {
      assert.equal(fs.existsSync(ccs.FILE), false);
      ccs.dismiss('recovery', ['a', 'b', 'c']);
      assert.equal(fs.existsSync(ccs.FILE), true);
    });
  });
});
