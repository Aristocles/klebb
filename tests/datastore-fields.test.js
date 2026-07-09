// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/datastore-fields.test.js
// The orphan report + rename machinery in lib/datastore/fields.js.
//
// The trust-destroying failure mode is NOISE: a pristine card reporting
// orphans because referencedFields missed a reference surface. The
// zero-noise sweep below runs the report over every shipped template and
// demo fixture and requires an empty orphan list on all of them.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {
  referencedFields, combinesReferences, aliasMap, storedDatedKeys,
  orphanReport, renameDataField, STRUCTURAL_KEYS,
} = require('../lib/datastore/fields');

const REPO_ROOT = path.resolve(__dirname, '..');

// Registry stub: get(id) -> {meta, data}, list() -> [{id, meta}],
// writeData captures the staged value.
function makeRegistry(cards) {
  const byId = new Map(cards.map(c => [c.id, c]));
  return {
    get: id => (byId.has(id) ? { meta: byId.get(id).meta || {}, data: byId.get(id).data ?? null } : null),
    list: () => cards.map(c => ({ id: c.id, meta: c.meta || {} })),
    writeData(id, value) { byId.get(id).data = value; return true; },
    _snapshot: id => byId.get(id)?.data,
  };
}

describe('referencedFields', () => {
  test('collects inputs, template tokens, trends, thresholds, calendar, reports', () => {
    const refs = referencedFields({
      writeable: { inputs: [{ key: 'kg' }, { key: 'notes' }] },
      view: {
        display: {
          template: '{kg:round(1)} / {bmi|n/a}',
          secondary: '{mood?good:bad}',
          trendArrow: { field: 'kg' },
          thresholds: [{ ifField: 'systolic', max: 120 }],
          emojiMap: { mood: { 1: 'a' } },
        },
        dateField: 'loggedOn',
      },
      trends: { field: 'kg', fields: ['systolic', 'diastolic'], series: [{ field: 'hrv' }], xAxis: 'when' },
      calendar: { marker: { type: 'field-emoji', field: 'mood' } },
      reports: { columns: [{ field: 'result' }], sort: { field: 'date' } },
    });
    for (const k of ['kg', 'notes', 'bmi', 'mood', 'systolic', 'diastolic', 'hrv', 'when', 'result', 'loggedOn']) {
      assert.ok(refs.has(k), `expected ${k} in referenced set`);
    }
  });

  test('each trends surface is a reference source on its own', () => {
    assert.ok(referencedFields({ trends: { field: 'solo_a' } }).has('solo_a'));
    assert.ok(referencedFields({ trends: { fields: ['solo_b'] } }).has('solo_b'));
    assert.ok(referencedFields({ trends: { series: [{ field: 'solo_c' }] } }).has('solo_c'));
    assert.ok(referencedFields({ trends: { xAxis: 'solo_d' } }).has('solo_d'));
  });

  test('dotted paths reference their leading segment', () => {
    const refs = referencedFields({
      view: { display: { template: '{results.ldl} mg' } },
    });
    assert.ok(refs.has('results'));
  });

  test('checkOffForm dose fields are references', () => {
    const refs = referencedFields({
      view: { checkOffForm: { currentDoseFields: ['site_side'], previousDoseFields: ['reactions'] } },
    });
    assert.ok(refs.has('site_side'));
    assert.ok(refs.has('reactions'));
  });

  test('flat emojiMap values are not treated as field names', () => {
    const refs = referencedFields({
      view: { display: { emojiMap: { 1: '😩', 2: '😴' } } },
    });
    assert.ok(!refs.has('1'));
    assert.ok(!refs.has('2'));
  });

  test('HAE-backed card references the catalogue row shape', () => {
    const refs = referencedFields({ ingest: { source: 'hae', metric: 'sleep_analysis' } });
    for (const k of ['hours', 'deep', 'rem', 'source']) {
      assert.ok(refs.has(k), `expected catalogue field ${k}`);
    }
  });
});

describe('combinesReferences', () => {
  test('collects donor-side accessors pointing at the id', () => {
    const donors = combinesReferences('sleep-hours', [
      { id: 'rings', meta: { view: { combines: [
        { sourceId: 'sleep-hours', accessor: 'deep' },
        { sourceId: 'mood', accessor: 'mood' },
      ] } } },
    ]);
    assert.ok(donors.has('deep'));
    assert.ok(!donors.has('mood'));
  });
});

describe('orphanReport', () => {
  test('flags a stored key nothing references; rows stay intact', () => {
    const reg = makeRegistry([{
      id: 'weight',
      meta: {
        writeable: { inputs: [{ key: 'kg' }] },
        view: { display: { template: '{kg}' } },
      },
      data: [{ date: '2026-06-01', kg: 84, waist_cm: 90 }],
    }]);
    const report = orphanReport(reg, 'weight');
    assert.deepStrictEqual(report.orphans, ['waist_cm']);
    assert.strictEqual(reg._snapshot('weight')[0].waist_cm, 90, 'report never mutates rows');
  });

  test('structural keys and the date field are never orphans', () => {
    const reg = makeRegistry([{
      id: 'x',
      meta: { view: { display: { template: '{v}' } } },
      data: [{ date: '2026-06-01', v: 1, added: 'ts', takenAt: 'ts', id: 'r1' }],
    }]);
    assert.deepStrictEqual(orphanReport(reg, 'x').orphans, []);
  });

  test('a donor field referenced only by a combo card is not an orphan', () => {
    const reg = makeRegistry([
      {
        id: 'sleep',
        meta: { view: { display: { template: '{hours}' } } },
        data: [{ date: '2026-06-01', hours: 7.2, deep: 1.4 }],
      },
      {
        id: 'rings',
        meta: { view: { component: 'combination-card', combines: [{ sourceId: 'sleep', accessor: 'deep' }] } },
        data: [],
      },
    ]);
    assert.deepStrictEqual(orphanReport(reg, 'sleep').orphans, []);
  });

  test('alias projects an old key onto a referenced new key', () => {
    const reg = makeRegistry([{
      id: 'weight',
      meta: {
        data: { aliases: { kg: 'weight_kg' } },
        view: { display: { template: '{weight_kg}' } },
      },
      data: [{ date: '2026-06-01', kg: 84 }],
    }]);
    assert.deepStrictEqual(orphanReport(reg, 'weight').orphans, []);
    assert.deepStrictEqual(orphanReport(reg, 'weight').aliases, { kg: 'weight_kg' });
  });

  test('removing an input orphans its logged key (the M13 payoff)', () => {
    const meta = {
      writeable: { inputs: [{ key: 'mood' }, { key: 'notes' }] },
      view: { display: { template: '{mood}' } },
    };
    const data = [{ date: '2026-06-01', mood: 4, notes: 'fine' }];
    const before = makeRegistry([{ id: 'mood', meta, data }]);
    assert.deepStrictEqual(orphanReport(before, 'mood').orphans, []);

    const metaAfter = JSON.parse(JSON.stringify(meta));
    metaAfter.writeable.inputs = [{ key: 'mood' }];
    const after = makeRegistry([{ id: 'mood', meta: metaAfter, data }]);
    assert.deepStrictEqual(orphanReport(after, 'mood').orphans, ['notes']);
  });

  test('roster items and rest keys are content, not orphan candidates', () => {
    const reg = makeRegistry([{
      id: 'peptides',
      meta: { view: { component: 'schedule-card' } },
      data: {
        items: [{ name: 'BPC-157', doses: [{ scheduledDate: '2026-06-01' }], custom_note: 'x' }],
        groups: [],
      },
    }]);
    assert.deepStrictEqual(orphanReport(reg, 'peptides').orphans, []);
  });

  test('unknown id returns an error object', () => {
    const reg = makeRegistry([]);
    assert.ok(orphanReport(reg, 'ghost').error);
  });
});

describe('orphanReport: zero noise on every shipped template and fixture', () => {
  const load = file => JSON.parse(fs.readFileSync(file, 'utf8'));

  test('templates/*.klebb.json report no orphans', () => {
    const dir = path.join(REPO_ROOT, 'templates');
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.klebb.json'));
    assert.ok(files.length >= 20, `expected 20+ templates, got ${files.length}`);
    const cards = files.map(f => {
      const doc = load(path.join(dir, f));
      return { id: doc.meta.id, meta: doc.meta, data: doc.data ?? null };
    });
    const reg = makeRegistry(cards);
    for (const c of cards) {
      const report = orphanReport(reg, c.id);
      assert.deepStrictEqual(report.orphans, [],
        `${c.id}: pristine template reported orphans: ${report.orphans}`);
    }
  });

  test('demo/fixtures/*.json report no orphans', () => {
    const dir = path.join(REPO_ROOT, 'demo', 'fixtures');
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    assert.ok(files.length >= 8);
    const cards = files.map(f => {
      const doc = load(path.join(dir, f));
      return { id: doc.meta.id, meta: doc.meta, data: doc.data ?? null };
    });
    const reg = makeRegistry(cards);
    for (const c of cards) {
      const report = orphanReport(reg, c.id);
      assert.deepStrictEqual(report.orphans, [],
        `${c.id}: pristine fixture reported orphans: ${report.orphans}`);
    }
  });
});

describe('renameDataField', () => {
  test('renames across all rows, preserving key order and values', () => {
    const reg = makeRegistry([{
      id: 'weight',
      meta: { writeable: { inputs: [{ key: 'kg' }] } },
      data: [
        { date: '2026-06-01', kg: 84, note: 'a' },
        { date: '2026-06-02', kg: 83.5 },
        { date: '2026-06-03', other: 1 },
      ],
    }]);
    const r = renameDataField(reg, 'weight', 'kg', 'weight_kg');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.rowsRenamed, 2);
    const rows = reg._snapshot('weight');
    assert.deepStrictEqual(Object.keys(rows[0]), ['date', 'weight_kg', 'note'], 'key position preserved');
    assert.strictEqual(rows[0].weight_kg, 84);
    assert.ok(!('kg' in rows[1]));
    assert.deepStrictEqual(rows[2], { date: '2026-06-03', other: 1 }, 'rows without the key untouched');
  });

  test('renames rows inside object containers, leaves rest keys alone', () => {
    const reg = makeRegistry([{
      id: 'supps',
      meta: {},
      data: {
        current: [{ name: 'D3', dose_iu: 5000 }],
        past: [{ name: 'Zn', dose_iu: 25 }],
        note: 'rest-key content',
      },
    }]);
    const r = renameDataField(reg, 'supps', 'dose_iu', 'daily_iu');
    assert.strictEqual(r.rowsRenamed, 2);
    const d = reg._snapshot('supps');
    assert.strictEqual(d.current[0].daily_iu, 5000);
    assert.strictEqual(d.past[0].daily_iu, 25);
    assert.strictEqual(d.note, 'rest-key content');
  });

  test('refuses to clobber an existing target key and writes nothing', () => {
    const data = [{ date: '2026-06-01', kg: 84, weight_kg: 85 }];
    const reg = makeRegistry([{ id: 'w', meta: {}, data }]);
    const r = renameDataField(reg, 'w', 'kg', 'weight_kg');
    assert.match(r.error, /refusing to clobber/);
    assert.strictEqual(reg._snapshot('w'), data, 'no write happened');
  });

  test('refuses structural keys, identical keys, missing keys, unknown ids', () => {
    const reg = makeRegistry([{ id: 'w', meta: {}, data: [{ date: 'd', kg: 1 }] }]);
    assert.match(renameDataField(reg, 'w', 'date', 'when').error, /structural/);
    assert.match(renameDataField(reg, 'w', 'kg', 'kg').error, /identical/);
    assert.match(renameDataField(reg, 'w', 'ghost', 'x').error, /no row carries/);
    assert.match(renameDataField(reg, 'nope', 'a', 'b').error, /unknown manifest/);
    assert.match(renameDataField(reg, 'w', '', 'x').error, /non-empty/);
  });

  test('doc-shaped data is rejected', () => {
    const reg = makeRegistry([{ id: 'doc', meta: {}, data: null }]);
    assert.match(renameDataField(reg, 'doc', 'a', 'b').error, /no row-shaped data/);
  });
});

describe('exported constants', () => {
  test('STRUCTURAL_KEYS covers the renderer write-path stamps', () => {
    for (const k of ['date', 'added', 'takenAt', 'scheduledDate', 'offSchedule', 'takenDates']) {
      assert.ok(STRUCTURAL_KEYS.has(k), `missing structural key ${k}`);
    }
  });

  test('aliasMap drops non-string targets', () => {
    assert.deepStrictEqual(
      aliasMap({ data: { aliases: { a: 'b', c: 3, d: '' } } }),
      { a: 'b' },
    );
  });

  test('storedDatedKeys ignores undated containers and doc shapes', () => {
    assert.deepStrictEqual([...storedDatedKeys({ items: [{ name: 'x' }] })], []);
    assert.deepStrictEqual([...storedDatedKeys({ markdown: 'hi' })], []);
    assert.deepStrictEqual(
      [...storedDatedKeys([{ date: 'd', kg: 1 }])].sort(),
      ['date', 'kg'],
    );
  });
});
