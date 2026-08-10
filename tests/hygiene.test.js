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

// Staleness only applies to cards the user can actually write to (#564), so a
// fixture that means to exercise it has to say so. Read-only cards get their own
// tests in the writeability suite below.
const WRITEABLE = {
  fromWebapp: true, todayAllowed: true, pastAllowed: true,
  inputs: [{ key: 'v', label: 'Value', type: 'number' }],
};

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
    const reg = makeRegistry([{ id: 'weight', meta: { label: 'Weight', writeable: WRITEABLE }, data: rowsEnding(30, 5) }]);
    const { findings } = scanHygiene(reg, TODAY);
    const stale = findings.find(f => f.cardId === 'weight' && f.kind === 'stale');
    assert.ok(stale, 'expected a stale finding');
    assert.match(stale.detail, /No entry in 30 days/);
  });

  test('does NOT flag a fresh card', () => {
    const reg = makeRegistry([{ id: 'weight', meta: { writeable: WRITEABLE }, data: rowsEnding(1, 5) }]);
    assert.deepStrictEqual(scanHygiene(reg, TODAY).findings.filter(f => f.kind === 'stale'), []);
  });

  test('does NOT flag a near-empty card (too little signal)', () => {
    const reg = makeRegistry([{ id: 'weight', meta: { writeable: WRITEABLE }, data: rowsEnding(60, 2) }]);
    assert.deepStrictEqual(scanHygiene(reg, TODAY).findings.filter(f => f.kind === 'stale'), []);
  });

  test('uses the tighter window for schedule-bearing cards', () => {
    // A card 10 days quiet: under the 21-day default it would NOT be stale,
    // but a recurring schedule tightens the window to 7 days so it trips.
    const reg = makeRegistry([{ id: 'p', meta: { writeable: WRITEABLE }, data: rowsEnding(10, 5).map(r => ({ ...r, schedule: { type: 'daily' } })) }]);
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
      { id: 'stalecard', meta: { writeable: WRITEABLE }, data: rowsEnding(40, 5) },
      { id: 'bigcard', meta: { writeable: WRITEABLE }, data: rowsEnding(0, 800) },
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

describe('hygiene: hidden cards are left alone (#560)', () => {
  // A hidden card is not one the user is neglecting; it is one they chose to put
  // away. hide_card is offered as the non-destructive alternative to deleting,
  // so nagging about staleness afterwards punishes exactly the tidy-up the
  // nudge asks for. Reported from a real instance: a card hidden months earlier
  // produced "ad-hoc-notes hasn't been updated in 84 days".
  test('a hidden stale card produces no finding', () => {
    const reg = makeRegistry([
      { id: 'put-away', meta: { label: 'Put away', enabled: false }, data: rowsEnding(84, 10) },
    ]);
    const { findings } = scanHygiene(reg, TODAY);
    assert.deepEqual(findings, [],
      'a card with meta.enabled:false was still flagged');
  });

  test('the same card DOES flag once it is visible again', () => {
    // Guards the fix from over-reaching: unhiding must restore the finding, so
    // this is not just a blanket suppression.
    const data = rowsEnding(84, 10);
    const hidden = makeRegistry([{ id: 'c', meta: { enabled: false, writeable: WRITEABLE }, data }]);
    const shown = makeRegistry([{ id: 'c', meta: { enabled: true, writeable: WRITEABLE }, data }]);
    assert.equal(scanHygiene(hidden, TODAY).findings.length, 0);
    assert.ok(scanHygiene(shown, TODAY).findings.some(f => f.kind === 'stale'),
      'an enabled card stopped being flagged');
  });

  test('a card with no enabled key is treated as visible', () => {
    // meta.enabled is optional and absent means shown, exactly as
    // registry.js viewEnabled reads it. Only an explicit false hides.
    const reg = makeRegistry([{ id: 'c', meta: { writeable: WRITEABLE }, data: rowsEnding(84, 10) }]);
    assert.ok(scanHygiene(reg, TODAY).findings.some(f => f.kind === 'stale'),
      'a card with no enabled key was treated as hidden');
  });

  test('growth and orphaned-input are suppressed on a hidden card too', () => {
    // Not just staleness: nothing about a put-away card is worth a mention.
    const reg = makeRegistry([{
      id: 'big-hidden',
      meta: {
        enabled: false,
        writeable: { fromWebapp: true, inputs: [{ key: 'never-used', label: 'Unused', type: 'text' }] },
      },
      data: rowsEnding(0, 800),
    }]);
    assert.deepEqual(scanHygiene(reg, TODAY).findings, [],
      'a hidden card still produced growth or orphaned-input findings');
  });

  test('the ambient nudge surface skips hidden cards', () => {
    // This is the path the peek bar reads, and where the report came from.
    const reg = makeRegistry([
      { id: 'hidden-one', meta: { enabled: false, writeable: WRITEABLE }, data: rowsEnding(84, 10) },
      { id: 'visible-one', meta: { writeable: WRITEABLE }, data: rowsEnding(40, 10) },
    ]);
    const ambient = ambientStaleness(reg, TODAY);
    assert.deepEqual(ambient.map(f => f.cardId), ['visible-one'],
      'the nudge surface offered a hidden card');
  });

  test('a hidden card does not mask a visible one behind it', () => {
    // The peek bar shows findings[0], so a hidden card at the front of the list
    // would have silently taken the slot from a real one.
    const reg = makeRegistry([
      { id: 'aaa-hidden', meta: { enabled: false, writeable: WRITEABLE }, data: rowsEnding(90, 10) },
      { id: 'zzz-visible', meta: { writeable: WRITEABLE }, data: rowsEnding(50, 10) },
    ]);
    const ambient = ambientStaleness(reg, TODAY);
    assert.ok(ambient.length >= 1, 'the visible stale card was lost entirely');
    assert.equal(ambient[0].cardId, 'zzz-visible');
  });
});

describe('hygiene: staleness only for cards the user can write to (#564)', () => {
  // Surfaced on a real instance the moment the hidden-card fix stopped masking
  // it: a greeting-banner was flagged "hasn't been updated in 32 days". That
  // card has no inputs and no writeable.fromWebapp, so there is nothing the user
  // could do about it; the nudge was asking for the impossible.
  const writeable = WRITEABLE;

  test('a read-only card is not flagged stale', () => {
    const reg = makeRegistry([
      { id: 'greeting', meta: { view: { component: 'greeting-banner' } }, data: rowsEnding(40, 5) },
    ]);
    const stale = scanHygiene(reg, TODAY).findings.filter(f => f.kind === 'stale');
    assert.deepEqual(stale, [],
      'a card with no writeable.fromWebapp was flagged stale');
  });

  test('an explicitly non-writeable card is not flagged stale', () => {
    const reg = makeRegistry([
      { id: 'ro', meta: { writeable: { fromWebapp: false } }, data: rowsEnding(40, 5) },
    ]);
    assert.deepEqual(scanHygiene(reg, TODAY).findings.filter(f => f.kind === 'stale'), []);
  });

  test('a writeable card IS still flagged', () => {
    // Guards against the fix over-reaching into suppressing everything.
    const reg = makeRegistry([{ id: 'weight', meta: { writeable }, data: rowsEnding(40, 5) }]);
    assert.ok(scanHygiene(reg, TODAY).findings.some(f => f.kind === 'stale'),
      'a writeable stale card stopped being flagged');
  });

  test('an HAE-fed card that is also writeable is still flagged', () => {
    // A phone that has stopped pushing is worth mentioning, so long as the user
    // could also log by hand. Deliberately NOT excluded by this rule.
    const reg = makeRegistry([{
      id: 'steps',
      meta: { ingest: { source: 'hae', metric: 'step_count' }, writeable },
      data: rowsEnding(40, 5),
    }]);
    assert.ok(scanHygiene(reg, TODAY).findings.some(f => f.kind === 'stale'),
      'a writeable HAE card should still be flagged when the pushes stop');
  });

  test('growth and orphaned-input are unaffected by writeability', () => {
    // These are author-facing tidy-ups rather than "go log something", so a
    // read-only card can legitimately carry them.
    const reg = makeRegistry([{
      id: 'big-ro',
      meta: {
        view: { component: 'greeting-banner' },
        writeable: { inputs: [{ key: 'never', label: 'Never', type: 'text' }] },
      },
      data: rowsEnding(0, 800),
    }]);
    const kinds = scanHygiene(reg, TODAY).findings.map(f => f.kind).sort();
    assert.deepEqual(kinds, ['growth', 'orphaned-input'],
      `expected growth + orphaned-input on a read-only card, got ${kinds.join(', ') || 'none'}`);
  });

  test('the ambient nudge surface only offers actionable cards', () => {
    // The exact live shape: a read-only banner and a writeable card both stale.
    const reg = makeRegistry([
      { id: 'greeting', meta: { view: { component: 'greeting-banner' } }, data: rowsEnding(32, 5) },
      { id: 'energy-levels', meta: { writeable }, data: rowsEnding(55, 5) },
    ]);
    assert.deepEqual(ambientStaleness(reg, TODAY).map(f => f.cardId), ['energy-levels'],
      'the nudge offered a card the user cannot write to');
  });
});
