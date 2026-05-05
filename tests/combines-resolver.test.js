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
