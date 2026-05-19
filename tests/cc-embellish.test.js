// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/cc-embellish.test.js
// CC-specific branch of the post-create embellishment chip generator.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { pickEmbellishments, pickCcEmbellishments, MAX_CC_OFFERS } = require('../chat/embellish');

function cc(meta = {}, combines = [], layout = null) {
  const view = {
    enabled: true,
    component: 'combination-card',
    combines,
  };
  if (layout) view.layout = layout;
  return {
    $schema: 'klebb.datafile.v1',
    meta: { id: 'recovery-ring', label: 'Recovery', view, ...meta },
    data: [],
  };
}

describe('pickCcEmbellishments: combination-card branch', () => {
  test('no donors: returns null', () => {
    assert.equal(pickCcEmbellishments(cc({}, [])), null);
  });

  test('stack layout: offers rings-switch as first chip', () => {
    const out = pickCcEmbellishments(cc({}, [
      { sourceId: 'a' }, { sourceId: 'b' }, { sourceId: 'c' },
    ], 'stack'));
    assert.ok(out);
    assert.equal(out.embellishments[0].id, 'cc-switch-to-rings');
  });

  test('rings layout: offers stack-switch and ungoaled-rings goal chip', () => {
    const out = pickCcEmbellishments(cc({}, [
      { sourceId: 'a', role: 'ring-segment' },
      { sourceId: 'b', role: 'ring-segment' },
      { sourceId: 'c', role: 'ring-segment' },
    ], 'rings'));
    assert.ok(out);
    const ids = out.embellishments.map(e => e.id);
    assert.ok(ids.includes('cc-switch-to-stack'));
    assert.ok(ids.includes('cc-add-goals'));
  });

  test('primary promotion offered when no donor is primary', () => {
    const out = pickCcEmbellishments(cc({}, [
      { sourceId: 'hrv', label: 'HRV' },
      { sourceId: 'rhr' },
    ]));
    const ids = out.embellishments.map(e => e.id);
    assert.ok(ids.includes('cc-set-primary'));
    const primary = out.embellishments.find(e => e.id === 'cc-set-primary');
    assert.match(primary.label, /HRV/);
    assert.match(primary.prompt, /"hrv"/);
  });

  test('primary NOT offered when one donor is already primary', () => {
    const out = pickCcEmbellishments(cc({}, [
      { sourceId: 'a', role: 'primary' },
      { sourceId: 'b' },
    ]));
    const ids = out.embellishments.map(e => e.id);
    assert.ok(!ids.includes('cc-set-primary'));
  });

  test('goal chip NOT offered when every ring segment has goalDaily', () => {
    const out = pickCcEmbellishments(cc({}, [
      { sourceId: 'a', role: 'ring-segment', goalDaily: 10000 },
      { sourceId: 'b', role: 'ring-segment', goalDaily: 30 },
    ], 'rings'));
    const ids = out ? out.embellishments.map(e => e.id) : [];
    assert.ok(!ids.includes('cc-add-goals'));
  });

  test('goal chip NOT offered when ring segments use goalWeekly', () => {
    const out = pickCcEmbellishments(cc({}, [
      { sourceId: 'workouts', role: 'ring-segment', goalWeekly: 5 },
      { sourceId: 'exercise', role: 'ring-segment', goalWeekly: 4 },
    ], 'rings'));
    const ids = out ? out.embellishments.map(e => e.id) : [];
    assert.ok(!ids.includes('cc-add-goals'));
  });

  test('colour chip NOT offered when every ring segment has a colour', () => {
    const out = pickCcEmbellishments(cc({}, [
      { sourceId: 'a', role: 'ring-segment', goalDaily: 10, colour: '#f00' },
      { sourceId: 'b', role: 'ring-segment', goalDaily: 5, colour: '#0f0' },
    ], 'rings'));
    const ids = out ? out.embellishments.map(e => e.id) : [];
    assert.ok(!ids.includes('cc-set-colours'));
  });

  test('single-donor ungoaled ring: label names that donor specifically', () => {
    const out = pickCcEmbellishments(cc({}, [
      { sourceId: 'steps', label: 'Steps', role: 'ring-segment', colour: '#f00' },
      { sourceId: 'sleep', role: 'ring-segment', goalDaily: 8, colour: '#0f0' },
    ], 'rings'));
    const goalChip = out.embellishments.find(e => e.id === 'cc-add-goals');
    assert.ok(goalChip);
    assert.match(goalChip.label, /Steps/);
  });

  test('capped at MAX_CC_OFFERS', () => {
    // Build a scenario that emits 5 chips and assert cap.
    // Stack layout (rings switch), no primary (set-primary), and two
    // ungoaled ring segments + two uncoloured ones — but ring chips are
    // offered once per category (goals and colours), so realistically
    // the max is 4 anyway. Cap is defensive.
    const out = pickCcEmbellishments(cc({}, [
      { sourceId: 'a', role: 'ring-segment' },
      { sourceId: 'b', role: 'ring-segment' },
    ], 'stack'));  // will offer switch-to-rings; ring-segment goals/colours
                   // don't apply while layout is stack
    assert.ok(out.embellishments.length <= MAX_CC_OFFERS);
  });

  test('intro text differs for CCs vs atomic cards', () => {
    const out = pickCcEmbellishments(cc({}, [
      { sourceId: 'a' },
    ]));
    assert.match(out.text, /CC|combination|embellish/i);
  });
});

describe('pickEmbellishments dispatches CC branch when component === combination-card', () => {
  test('a CC manifest goes through the CC branch, not the atomic catalogue', () => {
    const manifest = cc({ emoji: undefined }, [
      { sourceId: 'a' }, { sourceId: 'b' }, { sourceId: 'c' },
    ], 'stack');
    const out = pickEmbellishments(manifest, { flow: 'create' });
    assert.ok(out);
    // Atomic-catalogue chips (add-emoji, add-trend-arrow, ...) should
    // NOT appear. CC-specific chips should.
    const ids = out.embellishments.map(e => e.id);
    for (const id of ids) assert.ok(id.startsWith('cc-'),
      `atomic chip leaked into CC branch: ${id}`);
  });

  test('an atomic (generic-card) manifest still goes through the atomic branch', () => {
    const manifest = {
      $schema: 'klebb.datafile.v1',
      meta: {
        id: 'weight',
        label: 'Weight',
        view: { enabled: true, component: 'generic-card',
                display: { template: '{kg}' } },
      },
      data: [],
    };
    const out = pickEmbellishments(manifest, { flow: 'create' });
    assert.ok(out);
    const ids = out.embellishments.map(e => e.id);
    // At least one non-cc chip should appear.
    assert.ok(ids.some(id => !id.startsWith('cc-')));
  });
});
