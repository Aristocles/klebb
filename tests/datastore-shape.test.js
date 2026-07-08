// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/datastore-shape.test.js
// Property tests for the decompose/reconstruct kernel: every shipped data
// block plus adversarial shapes must round-trip deep-equal, both directly
// and after each stored piece passes through JSON text (the storage path).
// Equality is assert.deepStrictEqual: value-exact, key-order-insensitive —
// JSON key order is not semantically significant in a manifest data block.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { decompose, reconstruct, rowDate } = require('../lib/datastore/shape');

const REPO_ROOT = path.resolve(__dirname, '..');

// Mirrors the datastore's persistence: shape and every row/rest document are
// stored as JSON text columns, then parsed back on load.
function throughStorage(value) {
  const { shape, containers, rest } = decompose(value);
  const storedShape = JSON.parse(JSON.stringify(shape));
  const storedContainers = {};
  for (const name of Object.keys(containers)) {
    const rows = containers[name].map(row => JSON.parse(JSON.stringify(row === undefined ? null : row)));
    Object.defineProperty(storedContainers, name, {
      value: rows, writable: true, enumerable: true, configurable: true,
    });
  }
  const storedRest = rest === null ? null : JSON.parse(JSON.stringify(rest));
  return reconstruct({ shape: storedShape, containers: storedContainers, rest: storedRest });
}

function assertRoundTrip(value, label) {
  const direct = reconstruct(decompose(value));
  assert.deepStrictEqual(direct, value === undefined ? null : value, `${label}: direct round trip`);
  const jsonEquivalent = value === undefined || value === null
    ? null
    : JSON.parse(JSON.stringify(value));
  assert.deepStrictEqual(throughStorage(value), jsonEquivalent, `${label}: storage round trip`);
}

describe('kernel round trip: shipped fixtures', () => {
  const sources = [];
  for (const f of fs.readdirSync(path.join(REPO_ROOT, 'templates'))) {
    if (f.endsWith('.json')) sources.push(path.join('templates', f));
  }
  for (const f of fs.readdirSync(path.join(REPO_ROOT, 'demo', 'fixtures'))) {
    if (f.endsWith('.json')) sources.push(path.join('demo', 'fixtures', f));
  }

  test('fixture sweep covers both source dirs', () => {
    assert.ok(sources.length >= 30, `expected 30+ fixture files, found ${sources.length}`);
  });

  for (const rel of sources) {
    test(rel.replace(/\\/g, '/'), () => {
      const parsed = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'));
      assertRoundTrip(parsed.data === undefined ? null : parsed.data, rel);
    });
  }
});

describe('kernel round trip: adversarial shapes', () => {
  const cases = {
    'array of bare strings (greeting)': ['Good morning', 'Up and at em', 'G’day ☀️'],
    'items + groups roster (peptides)': {
      items: [
        {
          name: 'BPC-157', vial_mg: 10, dose_mg: 0.5, doses_per_vial: 20,
          schedule: { type: 'on_off', on_days: ['Mon', 'Tue'], off_days: ['Sat', 'Sun'] },
          cycles: [{ cycle_number: 1, status: 'active', start_date: '2026-03-01' }],
          doses: [
            { scheduledDate: '2026-04-29', takenAt: '2026-05-04T22:20:00.000Z' },
            { scheduledDate: '2026-07-03', takenAt: '2026-07-03T08:00:00.000Z', site_side: '', site_region: '', site_position: '', reactions: [] },
          ],
        },
        { name: 'Blend', doses_per_vial: '20', concentration_mg_ml: null },
      ],
      groups: [{ id: 'am-stack', label: 'Morning', items: ['BPC-157'], draw_order: 1 }],
    },
    'current + past roster (supplements)': {
      current: [{ name: 'Creatine', dose: '5g', takenDates: ['2026-07-01', '2026-07-02'], doses: [] }],
      past: [{ name: 'Zinc', endDate: '2026-05-01' }],
    },
    'document object (genome-snps)': {
      apoe: 'e3/e3', total_snps: 640000, found_count: 412,
      categories: [{ name: 'Methylation', findings: [{ label: 'MTHFR C677T', value: 'CT' }] }],
      not_found: ['rs123'],
    },
    'markdown doc': { markdown: '# Notes\n\nSome *prose*.' },
    'empty array': [],
    'null data': null,
    'entry with empty-string date': [{ date: '', note: 'strike', added: '2026-06-01T10:00:00.000Z' }],
    'duplicate dates': [
      { date: '2026-05-24', mood: 3, wakeUps: 0, notes: '' },
      { date: '2026-05-24', mood: 3, wakeUps: 1, notes: '' },
      { date: '2026-05-24', mood: 4, wakeUps: 1, notes: '' },
    ],
    'nested results objects (bloods)': [
      {
        date: '2026-02-10', status: 'complete', tests: ['FBC', 'LFT'],
        results: { FBC: { value: 4.5, range: '4.0-11.0', flag: null }, LFT: { value: 32, range: '<40', flag: 'ok' } },
      },
      { date: '2026-06-15', status: 'pending', pendingTests: ['HbA1c'], resultsExpected: '2026-06-22' },
    ],
    'unicode keys': { 'café': [{ date: '2026-01-01', '日本語': 1 }], '💊': 'emoji-keyed value' },
    'empty containers survive (items+groups both empty)': { items: [], groups: [] },
    'mixed object: arrays, scalars, nested, null': {
      items: [{ name: 'a' }], config: { nested: { deep: true } }, count: 3, note: null, tags: [],
    },
    'rows that are not objects': [1, 'two', null, [3, 4], { date: '2026-01-01' }, true],
    'date-keyed legacy object': {
      '2026-04-20': { 'NAD+': { taken: true, time: '08:00' } },
      '2026-04-21': { 'NAD+': { taken: false } },
    },
    'object with __proto__ and constructor keys': JSON.parse('{"__proto__": [{"date": "2026-01-01"}], "constructor": "value", "items": [1]}'),
    'bare string data': 'just a string',
    'bare number data': 42,
    'boolean false data': false,
    'deeply nested arrays in rest': { summary: 'x', matrix: [[1, 2], [3, 4]], meta2: { list: [{ a: [{ b: 1 }] }] } },
  };

  for (const [label, value] of Object.entries(cases)) {
    test(label, () => {
      assertRoundTrip(value, label);
    });
  }

  test('empty-container object reconstructs with zero rows stored', () => {
    const { shape } = decompose({ items: [], groups: [] });
    // Simulate a DB load where no rows exist for either container: the
    // shape record alone must rebuild the exact structure.
    const rebuilt = reconstruct({ shape, containers: {}, rest: null });
    assert.deepStrictEqual(rebuilt, { items: [], groups: [] });
  });

  test('object key order is preserved through the shape record', () => {
    const value = { zebra: [1], apple: 'x', mango: [2], banana: 3 };
    const rebuilt = throughStorage(value);
    assert.deepStrictEqual(Object.keys(rebuilt), ['zebra', 'apple', 'mango', 'banana']);
  });

  test('undefined data behaves as null (absent data key)', () => {
    assert.strictEqual(reconstruct(decompose(undefined)), null);
  });
});

describe('reconstruct corruption guards', () => {
  test('doc shape with no __doc__ row throws', () => {
    assert.throws(() => reconstruct({ shape: { kind: 'doc' }, containers: {}, rest: null }), /__doc__/);
  });

  test('object shape with missing rest key throws', () => {
    const { shape } = decompose({ items: [1], note: 'x' });
    assert.throws(
      () => reconstruct({ shape, containers: { items: [1] }, rest: {} }),
      /missing key "note"/,
    );
  });

  test('unknown shape kind throws', () => {
    assert.throws(() => reconstruct({ shape: { kind: 'wat' } }), /unknown shape kind/);
  });
});

describe('rowDate extraction', () => {
  test('plain YYYY-MM-DD', () => {
    assert.strictEqual(rowDate({ date: '2026-05-24' }), '2026-05-24');
  });
  test('longer date string keeps prefix only', () => {
    assert.strictEqual(rowDate({ date: '2026-07-08 10:28:00 +1000' }), '2026-07-08');
  });
  test('empty-string date is null', () => {
    assert.strictEqual(rowDate({ date: '' }), null);
  });
  test('non-string, absent, and non-object rows are null', () => {
    assert.strictEqual(rowDate({ date: 20260524 }), null);
    assert.strictEqual(rowDate({ note: 'no date' }), null);
    assert.strictEqual(rowDate('2026-05-24'), null);
    assert.strictEqual(rowDate(null), null);
    assert.strictEqual(rowDate(['2026-05-24']), null);
  });
  test('no timezone or parsing games: invalid-but-matching prefix kept verbatim', () => {
    assert.strictEqual(rowDate({ date: '2026-99-99T00:00' }), '2026-99-99');
  });
});
