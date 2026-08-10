// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/api/hygiene-cadence-opt-in.test.js
// Regression seed for #570: staleness is opt-in per card via meta.cadence.
//
// The bug this pins is the third in one family (after #560 hidden cards and
// #564 read-only cards): a writeable card whose rows carry no dates was
// flagged "No entry in 40 days ... Last: unknown", because recent-activity
// falls back to the last data write when no per-row date exists. Dated
// entries were never that card's point.
//
// The fix inverts the rule set: no meta.cadence, no stale finding, whatever
// the card's shape. These tests are the allowlist contract.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { scanHygiene, ambientStaleness } = require('../../chat/hygiene');

const TODAY = '2026-06-24';

const WRITEABLE = {
  fromWebapp: true, todayAllowed: true, pastAllowed: true,
  inputs: [{ key: 'v', label: 'Value', type: 'number' }],
};

function makeRegistry(cards, updatedAt = {}) {
  const byId = new Map(cards.map(c => [c.id, c]));
  return {
    list: () => cards.map(c => ({ id: c.id, meta: c.meta || {} })),
    get: id => (byId.has(id) ? { meta: byId.get(id).meta || {}, data: byId.get(id).data } : null),
    dataUpdatedAt: id => updatedAt[id] || null,
    sourceMtime: () => null,
  };
}

function rowsEnding(daysAgo, count, field = 'v') {
  const out = [];
  const end = Date.parse(`${TODAY}T00:00:00Z`) - daysAgo * 86400000;
  for (let i = count - 1; i >= 0; i--) {
    out.push({ date: new Date(end - i * 86400000).toISOString().slice(0, 10), [field]: i });
  }
  return out;
}

describe('#570: undated rows are never flagged stale', () => {
  test('a writeable card of undated string rows produces no stale finding', () => {
    // The live shape: a list-card of strings (reading list, supplement list).
    // No per-row date, so the old code fell through to the last data write and
    // reported an age with "Last: unknown" attached.
    const reg = makeRegistry(
      [{ id: 'reading-list', meta: { label: 'Reading list', writeable: WRITEABLE }, data: ['A', 'B', 'C', 'D'] }],
      { 'reading-list': '2026-05-15T00:00:00Z' },
    );
    const stale = scanHygiene(reg, TODAY).findings.filter(f => f.kind === 'stale');
    assert.deepEqual(stale, [], 'an undated card was flagged stale');
  });

  test('an undated card that DOES opt in is still not flagged stale', () => {
    // The opt-in alone is not enough: the age has to mean "no entry since",
    // which needs a real per-row date. Without one the only age available is
    // "when did anything last write this card", which is not the same claim and
    // is what produced the "Last: unknown" detail line.
    const reg = makeRegistry(
      [{ id: 'undated', meta: { cadence: { expectDays: 7 }, writeable: WRITEABLE }, data: ['x', 'y', 'z', 'w'] }],
      { undated: '2026-05-15T00:00:00Z' },
    );
    assert.deepEqual(scanHygiene(reg, TODAY).findings.filter(f => f.kind === 'stale'), [],
      'an undated card was flagged stale despite having no entry dates to be stale against');
  });

  test('every stale finding names a real last-entry date', () => {
    // Structural guard on the detail line: it must never report a null or an
    // "unknown" last entry, because such a finding cannot be acted on.
    const reg = makeRegistry([
      { id: 'dated', meta: { cadence: { expectDays: 7 }, writeable: WRITEABLE }, data: rowsEnding(40, 5) },
      { id: 'undated', meta: { cadence: { expectDays: 7 }, writeable: WRITEABLE }, data: ['x', 'y', 'z', 'w'] },
    ], { undated: '2026-05-15T00:00:00Z' });
    const stale = scanHygiene(reg, TODAY).findings.filter(f => f.kind === 'stale');
    assert.equal(stale.length, 1, 'expected exactly the dated card to be flagged');
    assert.match(stale[0].detail, /Last: \d{4}-\d{2}-\d{2}\./,
      `detail must name a real date, got: ${stale[0].detail}`);
  });
});

describe('#570: staleness requires meta.cadence', () => {
  test('a stale, writeable, dated card with NO cadence is silent', () => {
    // This is the behaviour change: pre-#570 this card was the canonical
    // legitimate finding. Opting in is now mandatory.
    const reg = makeRegistry([{ id: 'weight', meta: { label: 'Weight', writeable: WRITEABLE }, data: rowsEnding(40, 5) }]);
    assert.deepEqual(scanHygiene(reg, TODAY).findings.filter(f => f.kind === 'stale'), [],
      'a card with no meta.cadence was flagged stale');
  });

  test('the same card IS flagged once it opts in', () => {
    // Guards the fix from being a blanket suppression.
    const reg = makeRegistry([{
      id: 'weight',
      meta: { label: 'Weight', cadence: { expectDays: 7 }, writeable: WRITEABLE },
      data: rowsEnding(40, 5),
    }]);
    const stale = scanHygiene(reg, TODAY).findings.find(f => f.kind === 'stale');
    assert.ok(stale, 'an opted-in stale card was not flagged');
    assert.match(stale.detail, /No entry in 40 days/);
    assert.match(stale.detail, /expected within ~7/);
  });

  test('an opted-in card inside its window is not flagged', () => {
    const reg = makeRegistry([{
      id: 'weight',
      meta: { cadence: { expectDays: 30 }, writeable: WRITEABLE },
      data: rowsEnding(10, 5),
    }]);
    assert.deepEqual(scanHygiene(reg, TODAY).findings.filter(f => f.kind === 'stale'), []);
  });

  test('the ambient nudge surface only offers opted-in cards', () => {
    // The peek bar reads this, and it renders findings[0] only, so a card that
    // should be silent must not merely sort late: it must be absent.
    const reg = makeRegistry([
      { id: 'greeting', meta: { view: { component: 'greeting-banner' } }, data: rowsEnding(32, 5) },
      { id: 'no-cadence', meta: { writeable: WRITEABLE }, data: rowsEnding(55, 5) },
      { id: 'opted-in', meta: { cadence: { expectDays: 14 }, writeable: WRITEABLE }, data: rowsEnding(40, 5) },
    ]);
    assert.deepEqual(ambientStaleness(reg, TODAY).map(f => f.cardId), ['opted-in']);
  });
});

describe('#570: the existing floor still applies on top of the opt-in', () => {
  // Opting in must not resurrect the cases #560 and #564 established as wrong.
  test('a hidden card that opts in is still silent (#560)', () => {
    const reg = makeRegistry([{
      id: 'put-away',
      meta: { enabled: false, cadence: { expectDays: 7 }, writeable: WRITEABLE },
      data: rowsEnding(84, 10),
    }]);
    assert.deepEqual(scanHygiene(reg, TODAY).findings, [],
      'a hidden card opted back into nagging');
  });

  test('a read-only card that opts in is still silent (#564)', () => {
    const reg = makeRegistry([{
      id: 'greeting',
      meta: { cadence: { expectDays: 7 }, view: { component: 'greeting-banner' } },
      data: rowsEnding(40, 5),
    }]);
    assert.deepEqual(scanHygiene(reg, TODAY).findings.filter(f => f.kind === 'stale'), [],
      'a read-only card opted back into nagging');
  });

  test('a near-empty card that opts in is still silent', () => {
    const reg = makeRegistry([{
      id: 'barely',
      meta: { cadence: { expectDays: 7 }, writeable: WRITEABLE },
      data: rowsEnding(60, 2),
    }]);
    assert.deepEqual(scanHygiene(reg, TODAY).findings.filter(f => f.kind === 'stale'), []);
  });
});

describe('#570: cadence is declared, never inferred', () => {
  test('a schedule-bearing card with no cadence gets no implicit window', () => {
    // Pre-#570 a data.items[].schedule tightened the window to 7 days on its
    // own. Inference is exactly what produced this bug family.
    const reg = makeRegistry([{
      id: 'peptides',
      meta: { writeable: WRITEABLE },
      data: rowsEnding(10, 5).map(r => ({ ...r, schedule: { type: 'daily' } })),
    }]);
    assert.deepEqual(scanHygiene(reg, TODAY).findings.filter(f => f.kind === 'stale'), [],
      'a schedule block still implied a cadence');
  });

  test('a schedule-bearing card honours its DECLARED window', () => {
    const reg = makeRegistry([{
      id: 'peptides',
      meta: { cadence: { expectDays: 7 }, writeable: WRITEABLE },
      data: rowsEnding(10, 5).map(r => ({ ...r, schedule: { type: 'daily' } })),
    }]);
    const stale = scanHygiene(reg, TODAY).findings.find(f => f.kind === 'stale');
    assert.ok(stale, 'a declared 7-day cadence did not trip at 10 days quiet');
    assert.match(stale.detail, /expected within ~7/);
  });
});

describe('#570: growth and orphaned-input are unaffected', () => {
  test('a card with no cadence still reports growth and orphaned inputs', () => {
    // These are author-facing tidy-ups that do not depend on cadence, so the
    // opt-in must not silence them too.
    const reg = makeRegistry([{
      id: 'big',
      meta: { writeable: { fromWebapp: true, inputs: [{ key: 'never-used', label: 'Unused', type: 'text' }] } },
      data: rowsEnding(0, 800),
    }]);
    const kinds = scanHygiene(reg, TODAY).findings.map(f => f.kind).sort();
    assert.deepEqual(kinds, ['growth', 'orphaned-input'],
      `expected growth + orphaned-input without a cadence, got ${kinds.join(', ') || 'none'}`);
  });
});

describe('#570: severity escalates on the declared window', () => {
  test('past double the declared window escalates to warn', () => {
    const reg = makeRegistry([{
      id: 'weight',
      meta: { cadence: { expectDays: 7 }, writeable: WRITEABLE },
      data: rowsEnding(20, 5),
    }]);
    const stale = scanHygiene(reg, TODAY).findings.find(f => f.kind === 'stale');
    assert.equal(stale.severity, 'warn');
  });

  test('just past the declared window stays info', () => {
    const reg = makeRegistry([{
      id: 'weight',
      meta: { cadence: { expectDays: 7 }, writeable: WRITEABLE },
      data: rowsEnding(9, 5),
    }]);
    const stale = scanHygiene(reg, TODAY).findings.find(f => f.kind === 'stale');
    assert.equal(stale.severity, 'info');
  });
});
