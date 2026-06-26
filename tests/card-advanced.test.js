// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/card-advanced.test.js
// Discover-and-park logic for advanced feature blocks (#456). The patches
// are exercised through the REAL RFC 7396 mergePatch the server applies,
// so the byte-exact park, the round-trip restore, and the live-wins purge
// are proven against production semantics, not a stand-in.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { discoverAdvanced, buildAdvancedPatch } from '../public/js/lib/card-advanced.js';

const require = createRequire(import.meta.url);
const { mergePatch } = require('../manifests/merge-patch.js');

// Apply a { meta } patch the way the PATCH endpoint does: deep-merge over
// the existing meta. Returns the new meta.
function applyPatch(meta, patch) {
  return patch ? mergePatch(meta, patch.meta) : meta;
}

const checkOff = { currentDoseFields: ['site', 'reactions'], previousDoseFields: ['reactions'], currentDosePrompt: 'This dose' };

function scheduleMeta() {
  return { id: 'pep', label: 'Peptides', view: { enabled: true, component: 'schedule-card', checkOffForm: structuredClone(checkOff) } };
}

describe('discoverAdvanced', () => {
  test('finds a present live block as on', () => {
    const found = discoverAdvanced(scheduleMeta(), 'schedule-card');
    assert.equal(found.length, 1);
    assert.equal(found[0].key, 'checkOffForm');
    assert.equal(found[0].on, true);
    assert.equal(found[0]._stale, false);
  });
  test('omits features that are neither live nor parked', () => {
    const bare = { view: { component: 'schedule-card' } };
    assert.deepEqual(discoverAdvanced(bare, 'schedule-card'), []);
  });
  test('finds a parked-only block as off', () => {
    const meta = { view: { component: 'schedule-card', _disabled: { checkOffForm: structuredClone(checkOff) } } };
    const found = discoverAdvanced(meta, 'schedule-card');
    assert.equal(found.length, 1);
    assert.equal(found[0].on, false);
    assert.equal(found[0]._stale, false);
  });
  test('flags a stale parked copy when a live block also exists', () => {
    const meta = scheduleMeta();
    meta.view._disabled = { checkOffForm: { currentDoseFields: ['OLD'] } };
    const found = discoverAdvanced(meta, 'schedule-card');
    assert.equal(found[0].on, true);
    assert.equal(found[0]._stale, true);
  });
  test('scopes features to the renderer (generic features absent on schedule)', () => {
    const keys = discoverAdvanced(
      { view: { component: 'generic-card', display: { thresholds: [{ ifField: 'x', min: 1 }] } } },
      'generic-card',
    ).map(f => f.key);
    assert.deepEqual(keys, ['thresholds']);
  });
});

describe('park (turn off) preserves the block byte-for-byte', () => {
  test('off moves checkOffForm to _disabled and clears the live path', () => {
    const meta = scheduleMeta();
    const disc = discoverAdvanced(meta, 'schedule-card');
    const patch = buildAdvancedPatch(meta, disc, { checkOffForm: false });
    const next = applyPatch(meta, patch);
    assert.equal(next.view.checkOffForm, undefined, 'live block removed');
    assert.deepEqual(next.view._disabled.checkOffForm, checkOff, 'parked copy is byte-identical');
  });
});

describe('restore (turn on) round-trips', () => {
  test('parked -> on yields the original live block again', () => {
    // Start parked.
    const meta = { view: { component: 'schedule-card', _disabled: { checkOffForm: structuredClone(checkOff) } } };
    const disc = discoverAdvanced(meta, 'schedule-card');
    assert.equal(disc[0].on, false);
    const patch = buildAdvancedPatch(meta, disc, { checkOffForm: true });
    const next = applyPatch(meta, patch);
    assert.deepEqual(next.view.checkOffForm, checkOff, 'live block restored exactly');
    // _disabled.checkOffForm cleared (left as {} is acceptable; key must be gone/empty).
    assert.ok(!next.view._disabled || !next.view._disabled.checkOffForm, 'parked slot cleared');
  });

  test('full off-then-on cycle returns to the starting manifest shape', () => {
    const start = scheduleMeta();
    const off = applyPatch(start, buildAdvancedPatch(start, discoverAdvanced(start, 'schedule-card'), { checkOffForm: false }));
    const on = applyPatch(off, buildAdvancedPatch(off, discoverAdvanced(off, 'schedule-card'), { checkOffForm: true }));
    assert.deepEqual(on.view.checkOffForm, checkOff, 'feature is back, intact');
  });
});

describe('live wins, parked evaporates', () => {
  test('on save, a stale parked copy is purged without touching the live block', () => {
    // Klebbius rebuilt the feature while a stale copy sat parked.
    const meta = scheduleMeta();           // live = current checkOff
    meta.view._disabled = { checkOffForm: { currentDoseFields: ['OLD'] } };
    const disc = discoverAdvanced(meta, 'schedule-card');
    // No user edits — a plain Save.
    const patch = buildAdvancedPatch(meta, disc, {});
    assert.ok(patch, 'a purge patch is produced even with no edits');
    const next = applyPatch(meta, patch);
    assert.deepEqual(next.view.checkOffForm, checkOff, 'live block untouched');
    assert.ok(!next.view._disabled.checkOffForm, 'stale parked copy purged');
  });

  test('no change + no stale => null patch (no needless write)', () => {
    const meta = scheduleMeta();
    const disc = discoverAdvanced(meta, 'schedule-card');
    assert.equal(buildAdvancedPatch(meta, disc, {}), null);
  });
});
