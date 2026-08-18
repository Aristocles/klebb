// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/import-selection.test.js
// Per-artefact import selection (lib/import/selection.js): the selectable
// universe built from a validation plan, what a wire selection normalises to,
// what it refuses, and the copy predicate the filtered plan produces.
//
// Pure unit tests over a hand-built plan and a scratch reports tree: no
// HEALTH_HOME, no require-cache games, so this file mixes with anything.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildItems, normaliseSelection, filterPlan, copySets, accepts, SAMPLES_FILE,
} = require('../lib/import/selection');

const ARCHIVED_PDF = 'reports/_archive/2026-08-01-bloods.pdf';

function header(fields) {
  const lines = ['---', 'klebb_ingest: v2'];
  for (const [k, v] of Object.entries(fields)) lines.push(`${k}: ${v}`);
  lines.push('---', '');
  return lines.join('\n');
}

const tmpDirs = [];

// A tree holding only what buildItems reads off disk: report bodies (for their
// frontmatter) and file sizes. Cards are described by the plan alone.
function makeTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eh-sel-'));
  tmpDirs.push(root);
  fs.mkdirSync(path.join(root, 'reports', '_archive'), { recursive: true });
  const w = (rel, body) => fs.writeFileSync(path.join(root, ...rel.split('/')), body);

  w('reports/bloods.md', header({
    ingested_at: '2026-08-01T00:00:00.000Z',
    source_file: '2026-08-01-bloods.pdf',
    source_format: 'pdf',
    archive_path: ARCHIVED_PDF,
    title: 'Blood panel',
  }) + '# Bloods\n');
  w('reports/notes.md', '# Hand-written notes\n');
  w('reports/orphan.md', header({
    ingested_at: '2026-07-01T00:00:00.000Z',
    source_file: 'gone.pdf',
    source_format: 'pdf',
    archive_path: 'reports/_archive/gone.pdf',
  }) + '# Orphan\n');
  w('reports/hostile.md', header({
    ingested_at: '2026-07-02T00:00:00.000Z',
    source_file: 'x.pdf',
    source_format: 'pdf',
    archive_path: '../../../../etc/passwd',
  }) + '# Hostile\n');
  w(ARCHIVED_PDF, 'PDF BYTES');
  w('reports/_archive/loose.pdf', 'LOOSE BYTES');
  return root;
}

function makePlan() {
  return {
    cards: [
      { id: 'weight', file: 'data/weight.json', data: 'embedded', label: 'Weight', rows: 12, hae: false },
      { id: 'steps', file: 'data/steps.json', data: 'none', label: 'Steps', rows: 0, hae: true },
    ],
    samplesPushes: 3,
    reports: [
      'reports/bloods.md',
      'reports/notes.md',
      'reports/orphan.md',
      'reports/hostile.md',
      ARCHIVED_PDF,
      'reports/_archive/loose.pdf',
    ],
    config: 'write',
  };
}

describe('import selection', () => {
  let root;
  let plan;
  let items;

  before(() => {
    root = makeTree();
    plan = makePlan();
    items = buildItems(root, plan);
  });

  after(() => {
    while (tmpDirs.length) {
      try { fs.rmSync(tmpDirs.pop(), { recursive: true, force: true }); } catch {}
    }
  });

  describe('buildItems', () => {
    test('cards carry the plan fields the preview needs', () => {
      assert.deepStrictEqual(items.cards, [
        { id: 'weight', file: 'data/weight.json', label: 'Weight', rows: 12, hae: false, data: 'embedded' },
        { id: 'steps', file: 'data/steps.json', label: 'Steps', rows: 0, hae: true, data: 'none' },
      ]);
      assert.deepStrictEqual(items.history, { pushes: 3 });
    });

    test('an ingested report and its archived original are ONE item', () => {
      const bloods = items.reports.find(r => r.key === 'reports/bloods.md');
      assert.strictEqual(bloods.label, 'Blood panel', 'the frontmatter title is the label');
      assert.deepStrictEqual(bloods.files, ['reports/bloods.md', ARCHIVED_PDF]);
      assert.strictEqual(bloods.original, ARCHIVED_PDF);
      assert.strictEqual(bloods.bytes, 'PDF BYTES'.length + fs.statSync(path.join(root, 'reports', 'bloods.md')).size);
    });

    test('a claimed original that is not in the archive is not invented', () => {
      const orphan = items.reports.find(r => r.key === 'reports/orphan.md');
      assert.strictEqual(orphan.original, null);
      assert.deepStrictEqual(orphan.files, ['reports/orphan.md']);
    });

    test('a traversal archive_path cannot escape: basename, then archive membership', () => {
      const hostile = items.reports.find(r => r.key === 'reports/hostile.md');
      assert.strictEqual(hostile.original, null,
        'a claimed path outside the archive must resolve to nothing');
      assert.deepStrictEqual(hostile.files, ['reports/hostile.md']);
    });

    test('a header-less report is still selectable, labelled by filename', () => {
      const notes = items.reports.find(r => r.key === 'reports/notes.md');
      assert.strictEqual(notes.label, 'notes');
      assert.deepStrictEqual(notes.files, ['reports/notes.md']);
    });

    test('an archived original no report claims becomes its own item', () => {
      const loose = items.reports.find(r => r.key === 'reports/_archive/loose.pdf');
      assert.strictEqual(loose.unlinked, true);
      assert.deepStrictEqual(loose.files, ['reports/_archive/loose.pdf']);
      // Every file under reports/ belongs to exactly one item, so a filtered
      // import can reach all of them.
      const covered = items.reports.flatMap(r => r.files).sort();
      assert.deepStrictEqual(covered, plan.reports.slice().sort());
    });
  });

  describe('normaliseSelection', () => {
    test('absent selection is the compatibility path: null, no errors', () => {
      for (const wire of [undefined, null]) {
        assert.deepStrictEqual(normaliseSelection(items, wire), { selection: null, errors: [] });
      }
    });

    test('an empty object means everything: an omitted family is not a deselection', () => {
      const { selection, errors } = normaliseSelection(items, {});
      assert.deepStrictEqual(errors, []);
      assert.deepStrictEqual(selection, {
        cards: ['weight', 'steps'],
        reports: items.reports.map(r => r.key),
        history: true,
      });
    });

    test('explicit lists are kept in request order, deduped', () => {
      const { selection } = normaliseSelection(items,
        { cards: ['steps', 'weight', 'steps'], reports: [], history: false });
      assert.deepStrictEqual(selection, { cards: ['steps', 'weight'], reports: [], history: false });
    });

    test('history alone is a real restore', () => {
      const { selection, errors } = normaliseSelection(items,
        { cards: [], reports: [], history: true });
      assert.deepStrictEqual(errors, []);
      assert.deepStrictEqual(selection, { cards: [], reports: [], history: true });
    });

    test('nothing selected is REFUSED: an import replaces everything first', () => {
      const { selection, errors } = normaliseSelection(items,
        { cards: [], reports: [], history: false });
      assert.strictEqual(selection, null);
      assert.strictEqual(errors.length, 1);
      assert.strictEqual(errors[0].code, 'SELECTION_EMPTY');
      assert.strictEqual(errors[0].severity, 'refusal');
      assert.strictEqual(errors[0].phase, 'select');
      assert.match(errors[0].message, /would leave it empty/);
    });

    test('history on an archive with no pushes does not count as a restore', () => {
      const empty = buildItems(root, { ...plan, samplesPushes: 0 });
      const { errors } = normaliseSelection(empty, { cards: [], reports: [], history: true });
      assert.strictEqual(errors[0].code, 'SELECTION_EMPTY');
    });

    test('an unknown card id is refused by set membership, and named', () => {
      const { selection, errors } = normaliseSelection(items, { cards: ['weight', 'nope'] });
      assert.strictEqual(selection, null);
      assert.strictEqual(errors.length, 1);
      assert.strictEqual(errors[0].code, 'SELECTION_INVALID');
      assert.strictEqual(errors[0].scope, 'cards');
      assert.strictEqual(errors[0].ref, 'nope');
      assert.match(errors[0].message, /"nope" is not in this archive/);
    });

    test('a traversal path is just another unknown key', () => {
      const { selection, errors } = normaliseSelection(items, {
        cards: ['../../../../etc/passwd'],
        reports: ['../../etc/shadow', 'reports/../../data/weight.json'],
      });
      assert.strictEqual(selection, null);
      assert.deepStrictEqual(errors.map(e => e.code), ['SELECTION_INVALID', 'SELECTION_INVALID', 'SELECTION_INVALID']);
      assert.deepStrictEqual(errors.map(e => e.ref),
        ['../../../../etc/passwd', '../../etc/shadow', 'reports/../../data/weight.json']);
    });

    test('a long hostile ref is clipped in the finding', () => {
      const { errors } = normaliseSelection(items, { cards: ['x'.repeat(200)] });
      assert.strictEqual(errors[0].ref.length, 80);
      assert.ok(errors[0].ref.endsWith('...'));
    });

    test('wrong types are refused, not coerced', () => {
      assert.strictEqual(normaliseSelection(items, 'everything').errors[0].code, 'SELECTION_INVALID');
      assert.strictEqual(normaliseSelection(items, ['weight']).errors[0].code, 'SELECTION_INVALID');
      assert.match(normaliseSelection(items, { cards: 'weight' }).errors[0].message,
        /selection\.cards must be an array/);
      assert.match(normaliseSelection(items, { cards: [{ id: 'weight' }] }).errors[0].message,
        /non-string entry/);
      assert.match(normaliseSelection(items, { history: 'yes' }).errors[0].message,
        /selection\.history must be true or false/);
    });
  });

  describe('filterPlan', () => {
    test('a null selection returns the plan itself, untouched', () => {
      assert.strictEqual(filterPlan(plan, items, null), plan);
    });

    test('cards, reports and pushes all narrow; config rides along', () => {
      const sel = normaliseSelection(items,
        { cards: ['steps'], reports: ['reports/notes.md'], history: false }).selection;
      const filtered = filterPlan(plan, items, sel);
      assert.deepStrictEqual(filtered.cards.map(c => c.id), ['steps']);
      assert.deepStrictEqual(filtered.reports, ['reports/notes.md']);
      assert.strictEqual(filtered.samplesPushes, 0);
      assert.strictEqual(filtered.config, 'write');
      assert.deepStrictEqual(plan, makePlan(), 'the source plan must not be mutated');
    });

    test('selecting an ingested report pulls its original in with it', () => {
      const sel = normaliseSelection(items,
        { cards: [], reports: ['reports/bloods.md'], history: true }).selection;
      assert.deepStrictEqual(filterPlan(plan, items, sel).reports,
        ['reports/bloods.md', ARCHIVED_PDF]);
    });

    test('everything selected filters to the same plan content', () => {
      const sel = normaliseSelection(items, {}).selection;
      const filtered = filterPlan(plan, items, sel);
      assert.deepStrictEqual(filtered.cards, plan.cards);
      assert.deepStrictEqual(filtered.reports, plan.reports);
      assert.strictEqual(filtered.samplesPushes, plan.samplesPushes);
    });
  });

  describe('copySets + accepts', () => {
    function predicate(wire) {
      const sel = normaliseSelection(items, wire).selection;
      const sets = copySets(plan, filterPlan(plan, items, sel), sel);
      return rel => accepts(sets, rel);
    }

    test('an unticked card file is not copied; a ticked one is', () => {
      const ok = predicate({ cards: ['steps'], reports: [], history: false });
      assert.strictEqual(ok('data/steps.json'), true);
      assert.strictEqual(ok('data/weight.json'), false);
    });

    test('history gates exactly the samples inbox file', () => {
      const off = predicate({ cards: ['steps'], reports: [], history: false });
      assert.strictEqual(off(SAMPLES_FILE), false);
      const on = predicate({ cards: ['steps'], reports: [], history: true });
      assert.strictEqual(on(SAMPLES_FILE), true);
      assert.strictEqual(off('data/auto-export/discovered.json'), true,
        'discovered metrics are ingest shape, not history rows');
    });

    test('reports are copied only when their item was ticked, original included', () => {
      const ok = predicate({ cards: [], reports: ['reports/bloods.md'], history: true });
      assert.strictEqual(ok('reports/bloods.md'), true);
      assert.strictEqual(ok(ARCHIVED_PDF), true);
      assert.strictEqual(ok('reports/notes.md'), false);
      assert.strictEqual(ok('reports/_archive/loose.pdf'), false);
    });

    test('instance shape rides along whatever is ticked', () => {
      const ok = predicate({ cards: [], reports: [], history: true });
      for (const rel of ['klebb-export.json', 'config.json', 'data/info/PROFILE.md',
        'data/auto-export/last-push.json', 'data/legacy-not-a-card.json']) {
        assert.strictEqual(ok(rel), true, rel);
      }
    });

    test('a card-named file the plan never listed is other data, not a deselected card', () => {
      // A legacy or unsupported card file: the loader skips it, so nothing can
      // tick it, and dropping it would lose bytes no selection ever refused.
      const ok = predicate({ cards: ['steps'], reports: [], history: false });
      assert.strictEqual(ok('data/legacy.json'), true);
    });

    test('with no selection there is no predicate to run', () => {
      const sel = normaliseSelection(items, null).selection;
      const sets = copySets(plan, filterPlan(plan, items, sel), sel);
      assert.strictEqual(sets.samples, true);
      assert.strictEqual(accepts(sets, 'data/weight.json'), true,
        'a null selection must accept every card in the universe');
    });
  });
});
