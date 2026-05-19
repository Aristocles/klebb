// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/combines-resolver.test.js
// Pure unit tests for the combines resolver.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  resolveCombines,
  resolveEntry,
  getByPath,
  firstScalarKey,
  stringifyValue,
  canEditDonor,
  donorIdsInOrder,
  mondayOfWeekISO,
  sundayOfWeekISO,
} = require('../public/js/lib/combines-resolver.js');

describe('getByPath', () => {
  test('returns shallow value', () => {
    assert.equal(getByPath({ a: 1 }, 'a'), 1);
  });
  test('returns dotted value', () => {
    assert.equal(getByPath({ a: { b: { c: 7 } } }, 'a.b.c'), 7);
  });
  test('undefined on missing hop', () => {
    assert.equal(getByPath({ a: null }, 'a.b'), undefined);
  });
  test('undefined on empty path', () => {
    assert.equal(getByPath({ a: 1 }, ''), undefined);
  });
});

describe('firstScalarKey', () => {
  test('skips date, returns first scalar', () => {
    assert.equal(firstScalarKey({ date: '2026-05-04', hours: 7.5, note: 'x' }), 'hours');
  });
  test('skips null fields', () => {
    assert.equal(firstScalarKey({ date: '2026-05-04', hours: null, count: 42 }), 'count');
  });
  test('skips object/array fields', () => {
    assert.equal(firstScalarKey({ date: '2026-05-04', stages: {}, total: 8 }), 'total');
  });
  test('null on empty-scalar row', () => {
    assert.equal(firstScalarKey({ date: '2026-05-04' }), null);
  });
});

describe('stringifyValue', () => {
  test('null → null', () => {
    assert.equal(stringifyValue(null), null);
  });
  test('integer stays integer', () => {
    assert.equal(stringifyValue(42), '42');
  });
  test('float rounded to 2dp', () => {
    assert.equal(stringifyValue(7.3456), '7.35');
  });
  test('emojiMap override', () => {
    assert.equal(stringifyValue(4, { '1':'😩','4':'🙂' }), '🙂');
  });
  test('emojiMap miss → fallback to stringified value', () => {
    assert.equal(stringifyValue(99, { '1':'😩' }), '99');
  });
  test('boolean', () => {
    assert.equal(stringifyValue(true), 'yes');
    assert.equal(stringifyValue(false), 'no');
  });
});

describe('resolveEntry', () => {
  const sources = {
    'sleep-hours': {
      loaded: true,
      meta: { label: 'Sleep' },
      data: [
        { date: '2026-05-03', hours: 7.2 },
        { date: '2026-05-04', hours: 8.1 },
      ],
    },
    'mood': {
      loaded: true,
      meta: { label: 'Mood' },
      data: [
        { date: '2026-05-04', mood: 4, wakeUps: 1 },
      ],
    },
    'empty': {
      loaded: true,
      meta: { label: 'Empty' },
      data: [],
    },
  };

  test('ok path with explicit accessor', () => {
    const r = resolveEntry(
      { sourceId: 'sleep-hours', role: 'primary', accessor: 'hours', unit: 'h' },
      sources, '2026-05-04',
    );
    assert.equal(r.state, 'ok');
    assert.equal(r.value, 8.1);
    assert.equal(r.displayValue, '8.1');
    assert.equal(r.unit, 'h');
    assert.equal(r.role, 'primary');
  });

  test('label falls back to source meta.label', () => {
    const r = resolveEntry(
      { sourceId: 'sleep-hours', role: 'primary', accessor: 'hours' },
      sources, '2026-05-04',
    );
    assert.equal(r.label, 'Sleep');
  });

  test('label override wins over source meta', () => {
    const r = resolveEntry(
      { sourceId: 'sleep-hours', role: 'primary', accessor: 'hours', label: 'Asleep' },
      sources, '2026-05-04',
    );
    assert.equal(r.label, 'Asleep');
  });

  test('default accessor picks first non-date scalar', () => {
    const r = resolveEntry(
      { sourceId: 'sleep-hours', role: 'primary' },
      sources, '2026-05-04',
    );
    assert.equal(r.state, 'ok');
    assert.equal(r.value, 8.1);
  });

  test('no-source when sourceId missing from sources map', () => {
    const r = resolveEntry(
      { sourceId: 'not-a-card', role: 'primary' },
      sources, '2026-05-04',
    );
    assert.equal(r.state, 'no-source');
    assert.equal(r.value, null);
  });

  test('no-source when entry has no sourceId', () => {
    const r = resolveEntry({ role: 'primary' }, sources, '2026-05-04');
    assert.equal(r.state, 'no-source');
  });

  test('no-source when source not loaded', () => {
    const r = resolveEntry(
      { sourceId: 'sleep-hours', role: 'primary' },
      { 'sleep-hours': { loaded: false, data: null, meta: null } },
      '2026-05-04',
    );
    assert.equal(r.state, 'no-source');
  });

  test('no-entry when date not present', () => {
    const r = resolveEntry(
      { sourceId: 'sleep-hours', role: 'primary', accessor: 'hours' },
      sources, '2026-05-01',
    );
    assert.equal(r.state, 'no-entry');
    assert.equal(r.value, null);
  });

  test('no-entry when source has empty data', () => {
    const r = resolveEntry(
      { sourceId: 'empty', role: 'primary' },
      sources, '2026-05-04',
    );
    assert.equal(r.state, 'no-entry');
  });

  test('no-accessor-match when accessor yields undefined', () => {
    const r = resolveEntry(
      { sourceId: 'sleep-hours', role: 'primary', accessor: 'nonexistent' },
      sources, '2026-05-04',
    );
    assert.equal(r.state, 'no-accessor-match');
    assert.ok(r.row);
  });

  test('emojiMap applied to displayValue', () => {
    const r = resolveEntry(
      {
        sourceId: 'mood',
        role: 'secondary',
        accessor: 'mood',
        emojiMap: { '1':'😩','2':'😴','3':'😐','4':'🙂','5':'😄' },
      },
      sources, '2026-05-04',
    );
    assert.equal(r.state, 'ok');
    assert.equal(r.value, 4);
    assert.equal(r.displayValue, '🙂');
  });

  test('dotted accessor resolves', () => {
    const deep = {
      'nested': {
        loaded: true,
        meta: { label: 'Nested' },
        data: [{ date: '2026-05-04', stats: { avg: 3.14 } }],
      },
    };
    const r = resolveEntry(
      { sourceId: 'nested', role: 'primary', accessor: 'stats.avg' },
      deep, '2026-05-04',
    );
    assert.equal(r.state, 'ok');
    assert.equal(r.value, 3.14);
  });

  test('role defaults to annotation', () => {
    const r = resolveEntry(
      { sourceId: 'sleep-hours', accessor: 'hours' },
      sources, '2026-05-04',
    );
    assert.equal(r.role, 'annotation');
  });
});

describe('resolveCombines', () => {
  const sources = {
    'sleep-hours': {
      loaded: true, meta: { label: 'Sleep' },
      data: [{ date: '2026-05-04', hours: 8.1 }],
    },
    'mood': {
      loaded: true, meta: { label: 'Mood' },
      data: [{ date: '2026-05-04', mood: 4, wakeUps: 1 }],
    },
  };

  test('preserves order', () => {
    const combines = [
      { sourceId: 'mood', role: 'secondary', accessor: 'mood' },
      { sourceId: 'sleep-hours', role: 'primary', accessor: 'hours' },
    ];
    const out = resolveCombines(combines, sources, '2026-05-04');
    assert.equal(out.length, 2);
    assert.equal(out[0].sourceId, 'mood');
    assert.equal(out[1].sourceId, 'sleep-hours');
  });

  test('empty/missing combines returns []', () => {
    assert.deepEqual(resolveCombines(null, sources, '2026-05-04'), []);
    assert.deepEqual(resolveCombines(undefined, sources, '2026-05-04'), []);
    assert.deepEqual(resolveCombines([], sources, '2026-05-04'), []);
  });

  test('mix of ok and missing states', () => {
    const combines = [
      { sourceId: 'sleep-hours', role: 'primary', accessor: 'hours' },
      { sourceId: 'missing-card', role: 'secondary' },
      { sourceId: 'mood', role: 'annotation', accessor: 'missingField' },
    ];
    const out = resolveCombines(combines, sources, '2026-05-04');
    assert.equal(out[0].state, 'ok');
    assert.equal(out[1].state, 'no-source');
    assert.equal(out[2].state, 'no-accessor-match');
  });
});

describe('canEditDonor', () => {
  const writeable = {
    fromWebapp: true,
    todayAllowed: true,
    pastAllowed: true,
    futureAllowed: false,
    inputs: [{ key: 'mood', type: 'rating' }],
  };

  test('returns false for null/undefined meta', () => {
    assert.equal(canEditDonor(null, 'today'), false);
    assert.equal(canEditDonor(undefined, 'today'), false);
  });

  test('returns false when writeable block missing', () => {
    assert.equal(canEditDonor({}, 'today'), false);
    assert.equal(canEditDonor({ label: 'x' }, 'today'), false);
  });

  test('returns false when fromWebapp is false (ingest-only donor)', () => {
    assert.equal(canEditDonor({ writeable: { fromWebapp: false, inputs: [{ key: 'x', type: 'number' }] } }, 'today'), false);
  });

  test('returns false when inputs array is empty or missing', () => {
    assert.equal(canEditDonor({ writeable: { fromWebapp: true } }, 'today'), false);
    assert.equal(canEditDonor({ writeable: { fromWebapp: true, inputs: [] } }, 'today'), false);
  });

  test('today allowed by default when todayAllowed absent', () => {
    const m = { writeable: { fromWebapp: true, inputs: [{ key: 'x', type: 'number' }] } };
    assert.equal(canEditDonor(m, 'today'), true);
  });

  test('today disallowed when todayAllowed: false', () => {
    const m = { writeable: { fromWebapp: true, todayAllowed: false, inputs: [{ key: 'x', type: 'number' }] } };
    assert.equal(canEditDonor(m, 'today'), false);
  });

  test('past allowed only when explicitly true', () => {
    const yes = { writeable: { ...writeable, pastAllowed: true } };
    const no  = { writeable: { ...writeable, pastAllowed: false } };
    const absent = { writeable: { fromWebapp: true, inputs: [{ key: 'x', type: 'number' }] } };
    assert.equal(canEditDonor(yes, 'past'), true);
    assert.equal(canEditDonor(no, 'past'), false);
    assert.equal(canEditDonor(absent, 'past'), false);
  });

  test('future allowed only when explicitly true', () => {
    const yes = { writeable: { fromWebapp: true, futureAllowed: true, inputs: [{ key: 'x', type: 'number' }] } };
    const no  = { writeable: { fromWebapp: true, futureAllowed: false, inputs: [{ key: 'x', type: 'number' }] } };
    assert.equal(canEditDonor(yes, 'future'), true);
    assert.equal(canEditDonor(no, 'future'), false);
  });

  test('unknown dateMode returns false', () => {
    assert.equal(canEditDonor({ writeable }, 'weird'), false);
    assert.equal(canEditDonor({ writeable }, undefined), false);
  });
});

describe('donorIdsInOrder', () => {
  test('preserves first-appearance order', () => {
    const combines = [
      { sourceId: 'sleep-hours' },
      { sourceId: 'mood', accessor: 'mood' },
      { sourceId: 'mood', accessor: 'wakeUps' },
      { sourceId: 'sleep-hours', accessor: 'note' },
      { sourceId: 'hydration' },
    ];
    assert.deepEqual(donorIdsInOrder(combines), ['sleep-hours', 'mood', 'hydration']);
  });

  test('empty/missing input returns []', () => {
    assert.deepEqual(donorIdsInOrder(null), []);
    assert.deepEqual(donorIdsInOrder(undefined), []);
    assert.deepEqual(donorIdsInOrder([]), []);
  });

  test('skips entries with no sourceId', () => {
    const combines = [
      { sourceId: 'mood' },
      { role: 'annotation' },
      { sourceId: null },
      { sourceId: 'hydration' },
    ];
    assert.deepEqual(donorIdsInOrder(combines), ['mood', 'hydration']);
  });
});

describe('resolveEntry: ring-segment role', () => {
  const sources = {
    'steps': {
      loaded: true, meta: { label: 'Steps' },
      data: [{ date: '2026-05-05', count: 7200 }],
    },
    'active-minutes': {
      loaded: true, meta: { label: 'Active Minutes' },
      data: [{ date: '2026-05-05', minutes: 45 }],
    },
    'mood': {
      loaded: true, meta: { label: 'Mood' },
      data: [{ date: '2026-05-05', mood: 'okay' }],
    },
  };

  test('valid ring-segment: state=ok, ratio + complete computed', () => {
    const r = resolveEntry(
      { sourceId: 'steps', role: 'ring-segment', accessor: 'count', goalDaily: 10000 },
      sources, '2026-05-05',
    );
    assert.equal(r.state, 'ok');
    assert.equal(r.value, 7200);
    assert.equal(r.goalDaily, 10000);
    assert.equal(r.ratio, 0.72);
    assert.equal(r.complete, false);
  });

  test('overshoot: ratio > 1, complete = true', () => {
    const r = resolveEntry(
      { sourceId: 'active-minutes', role: 'ring-segment', accessor: 'minutes', goalDaily: 30 },
      sources, '2026-05-05',
    );
    assert.equal(r.state, 'ok');
    assert.equal(r.ratio, 1.5);
    assert.equal(r.complete, true);
  });

  test('exactly-at-goal: ratio = 1, complete = true', () => {
    const exact = { 'x': { loaded: true, meta: {}, data: [{ date: '2026-05-05', v: 30 }] } };
    const r = resolveEntry(
      { sourceId: 'x', role: 'ring-segment', accessor: 'v', goalDaily: 30 },
      exact, '2026-05-05',
    );
    assert.equal(r.ratio, 1);
    assert.equal(r.complete, true);
  });

  test('missing goalDaily → no-goal state', () => {
    const r = resolveEntry(
      { sourceId: 'steps', role: 'ring-segment', accessor: 'count' },
      sources, '2026-05-05',
    );
    assert.equal(r.state, 'no-goal');
    assert.equal(r.value, null);
  });

  test('zero goalDaily → no-goal state (defensive; avoids divide-by-zero)', () => {
    const r = resolveEntry(
      { sourceId: 'steps', role: 'ring-segment', accessor: 'count', goalDaily: 0 },
      sources, '2026-05-05',
    );
    assert.equal(r.state, 'no-goal');
  });

  test('negative goalDaily → no-goal state', () => {
    const r = resolveEntry(
      { sourceId: 'steps', role: 'ring-segment', accessor: 'count', goalDaily: -100 },
      sources, '2026-05-05',
    );
    assert.equal(r.state, 'no-goal');
  });

  test('non-numeric goalDaily → no-goal state', () => {
    const r = resolveEntry(
      { sourceId: 'steps', role: 'ring-segment', accessor: 'count', goalDaily: 'a lot' },
      sources, '2026-05-05',
    );
    assert.equal(r.state, 'no-goal');
  });

  test('non-numeric value on ring-segment → no-accessor-match', () => {
    const r = resolveEntry(
      { sourceId: 'mood', role: 'ring-segment', accessor: 'mood', goalDaily: 5 },
      sources, '2026-05-05',
    );
    assert.equal(r.state, 'no-accessor-match');
  });

  test('no-goal check runs BEFORE source lookup (goal is malformed regardless of source)', () => {
    // Even if the source is missing, a missing goal is still the primary
    // problem. Test documents that goal validation is first.
    const r = resolveEntry(
      { sourceId: 'nonexistent', role: 'ring-segment', accessor: 'x' },
      sources, '2026-05-05',
    );
    assert.equal(r.state, 'no-goal');
  });

  test('no ring fields on non-ring-segment entries', () => {
    const r = resolveEntry(
      { sourceId: 'steps', role: 'primary', accessor: 'count', goalDaily: 10000 },
      sources, '2026-05-05',
    );
    assert.equal(r.state, 'ok');
    assert.equal('ratio' in r, false);
    assert.equal('complete' in r, false);
    assert.equal('goalDaily' in r, false);
  });

  test('no-entry still propagates for ring-segment with valid goal', () => {
    const r = resolveEntry(
      { sourceId: 'steps', role: 'ring-segment', accessor: 'count', goalDaily: 10000 },
      sources, '2099-01-01',
    );
    assert.equal(r.state, 'no-entry');
  });

  test('ring-segment preserves colour field', () => {
    const r = resolveEntry(
      { sourceId: 'steps', role: 'ring-segment', accessor: 'count', goalDaily: 10000, colour: '#0ea5e9' },
      sources, '2026-05-05',
    );
    assert.equal(r.colour, '#0ea5e9');
  });

  test('daily ring-segment carries period: daily', () => {
    const r = resolveEntry(
      { sourceId: 'steps', role: 'ring-segment', accessor: 'count', goalDaily: 10000 },
      sources, '2026-05-05',
    );
    assert.equal(r.period, 'daily');
  });
});

describe('mondayOfWeekISO / sundayOfWeekISO', () => {
  // 2026-05-04 is a Monday; the week is Mon 2026-05-04 to Sun 2026-05-10.
  test('Monday returns itself', () => {
    assert.equal(mondayOfWeekISO('2026-05-04'), '2026-05-04');
    assert.equal(sundayOfWeekISO('2026-05-04'), '2026-05-10');
  });
  test('mid-week resolves back to that Monday', () => {
    assert.equal(mondayOfWeekISO('2026-05-06'), '2026-05-04');
    assert.equal(sundayOfWeekISO('2026-05-06'), '2026-05-10');
  });
  test('Sunday belongs to the week starting the previous Monday', () => {
    assert.equal(mondayOfWeekISO('2026-05-10'), '2026-05-04');
    assert.equal(sundayOfWeekISO('2026-05-10'), '2026-05-10');
  });
  test('crosses year boundary correctly', () => {
    // 2026-01-01 is a Thursday; ISO Monday is 2025-12-29.
    assert.equal(mondayOfWeekISO('2026-01-01'), '2025-12-29');
    assert.equal(sundayOfWeekISO('2026-01-01'), '2026-01-04');
  });
  test('invalid input returns null', () => {
    assert.equal(mondayOfWeekISO(null), null);
    assert.equal(mondayOfWeekISO('not a date'), null);
    assert.equal(sundayOfWeekISO('not a date'), null);
  });
});

describe('resolveEntry: ring-segment with goalWeekly', () => {
  // Mon-Sun: 2026-05-04 to 2026-05-10. One workout row per training day.
  const sources = {
    'workouts': {
      loaded: true, meta: { label: 'Workouts' },
      data: [
        { date: '2026-04-29', count: 1 },  // previous week
        { date: '2026-05-04', count: 1 },  // Mon of target week
        { date: '2026-05-06', count: 1 },  // Wed
        { date: '2026-05-08', count: 1 },  // Fri
        { date: '2026-05-12', count: 1 },  // next week
      ],
    },
    'workouts-empty': {
      loaded: true, meta: { label: 'Workouts' },
      data: [
        { date: '2026-04-29', count: 1 },  // only previous-week rows
      ],
    },
    'steps': {
      loaded: true, meta: { label: 'Steps' },
      data: [
        { date: '2026-05-04', count: 6000 },
        { date: '2026-05-05', count: 4000 },
      ],
    },
  };

  test('sums rows across Mon-Sun when viewed mid-week', () => {
    const r = resolveEntry(
      { sourceId: 'workouts', role: 'ring-segment', accessor: 'count', goalWeekly: 5 },
      sources, '2026-05-06',
    );
    assert.equal(r.state, 'ok');
    assert.equal(r.value, 3);
    assert.equal(r.period, 'week');
    assert.equal(r.goalWeekly, 5);
    assert.equal(r.ratio, 0.6);
    assert.equal(r.complete, false);
  });

  test('Monday boundary: counts that Monday in', () => {
    const r = resolveEntry(
      { sourceId: 'workouts', role: 'ring-segment', accessor: 'count', goalWeekly: 5 },
      sources, '2026-05-04',
    );
    assert.equal(r.value, 3);
  });

  test('Sunday boundary: counts the same week, not the next', () => {
    const r = resolveEntry(
      { sourceId: 'workouts', role: 'ring-segment', accessor: 'count', goalWeekly: 5 },
      sources, '2026-05-10',
    );
    assert.equal(r.value, 3);
  });

  test('past-week scrub shows that week, not the current one', () => {
    const r = resolveEntry(
      { sourceId: 'workouts', role: 'ring-segment', accessor: 'count', goalWeekly: 5 },
      sources, '2026-04-29',
    );
    assert.equal(r.state, 'ok');
    assert.equal(r.value, 1);
  });

  test('completes at goal (sum >= goalWeekly)', () => {
    const src = {
      'w': { loaded: true, meta: {}, data: [
        { date: '2026-05-04', count: 2 },
        { date: '2026-05-06', count: 3 },
      ]},
    };
    const r = resolveEntry(
      { sourceId: 'w', role: 'ring-segment', accessor: 'count', goalWeekly: 5 },
      src, '2026-05-06',
    );
    assert.equal(r.value, 5);
    assert.equal(r.complete, true);
  });

  test('overshoot: sum > goal, ratio > 1, complete = true', () => {
    const r = resolveEntry(
      { sourceId: 'steps', role: 'ring-segment', accessor: 'count', goalWeekly: 7000 },
      sources, '2026-05-05',
    );
    assert.equal(r.value, 10000);
    assert.ok(r.ratio > 1);
    assert.equal(r.complete, true);
  });

  test('empty week → no-entry', () => {
    const r = resolveEntry(
      { sourceId: 'workouts-empty', role: 'ring-segment', accessor: 'count', goalWeekly: 5 },
      sources, '2026-05-06',
    );
    assert.equal(r.state, 'no-entry');
  });

  test('both goalDaily and goalWeekly: weekly wins', () => {
    const r = resolveEntry(
      { sourceId: 'workouts', role: 'ring-segment', accessor: 'count', goalDaily: 1, goalWeekly: 5 },
      sources, '2026-05-06',
    );
    assert.equal(r.period, 'week');
    assert.equal(r.goalWeekly, 5);
    assert.equal('goalDaily' in r, false);
    assert.equal(r.value, 3);
  });

  test('neither goal → no-goal (unchanged)', () => {
    const r = resolveEntry(
      { sourceId: 'workouts', role: 'ring-segment', accessor: 'count' },
      sources, '2026-05-06',
    );
    assert.equal(r.state, 'no-goal');
  });

  test('zero goalWeekly falls back to goalDaily if present', () => {
    const r = resolveEntry(
      { sourceId: 'workouts', role: 'ring-segment', accessor: 'count', goalWeekly: 0, goalDaily: 1 },
      sources, '2026-05-06',
    );
    assert.equal(r.period, 'daily');
    assert.equal(r.goalDaily, 1);
  });

  test('non-numeric accessor across the week → no-accessor-match', () => {
    const text = {
      't': { loaded: true, meta: {}, data: [
        { date: '2026-05-04', note: 'hi' },
        { date: '2026-05-06', note: 'there' },
      ]},
    };
    const r = resolveEntry(
      { sourceId: 't', role: 'ring-segment', accessor: 'note', goalWeekly: 5 },
      text, '2026-05-06',
    );
    assert.equal(r.state, 'no-accessor-match');
  });

  test('mixed daily + weekly rings on the same card resolve independently', () => {
    const combines = [
      // Daily ring: viewed date is Mon 2026-05-04 so the steps row at that date drives it.
      { sourceId: 'steps', role: 'ring-segment', accessor: 'count', goalDaily: 10000 },
      { sourceId: 'workouts', role: 'ring-segment', accessor: 'count', goalWeekly: 5 },
    ];
    const out = resolveCombines(combines, sources, '2026-05-04');
    assert.equal(out[0].state, 'ok');
    assert.equal(out[0].period, 'daily');
    assert.equal(out[0].value, 6000);
    assert.equal(out[1].state, 'ok');
    assert.equal(out[1].period, 'week');
    assert.equal(out[1].value, 3);
  });
});
