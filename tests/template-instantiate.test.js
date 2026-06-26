// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/template-instantiate.test.js
// Unit tests for turning a shipped template into a real card manifest
// (#451): placeholder fill, id dedup, meta.template stripping, and — the
// load-bearing one — that every shipped template instantiates into a
// manifest the strict create-validator accepts (so "Add card" never 422s).

const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  listTemplates, instantiateTemplate, fillPlaceholders, uniqueId,
} = require('../server/content');
const { validateManifestShape } = require('../manifests/registry.js');

describe('uniqueId', () => {
  test('returns the base when free', () => {
    assert.equal(uniqueId('weight', []), 'weight');
    assert.equal(uniqueId('weight', ['mood', 'sleep']), 'weight');
  });
  test('suffixes -2, -3 … past collisions', () => {
    assert.equal(uniqueId('weight', ['weight']), 'weight-2');
    assert.equal(uniqueId('weight', ['weight', 'weight-2']), 'weight-3');
    assert.equal(uniqueId('weight', ['weight', 'weight-2', 'weight-3']), 'weight-4');
  });
});

describe('fillPlaceholders', () => {
  test('replaces {{string:KEY}} string leaves from values', () => {
    const out = fillPlaceholders({ a: '{{string:id}}', b: { c: '{{string:label}}' } }, { id: 'x', label: 'L' });
    assert.deepEqual(out, { a: 'x', b: { c: 'L' } });
  });
  test('an unsupplied placeholder collapses to empty string (never leaks {{}})', () => {
    assert.equal(fillPlaceholders('{{string:unit}}', {}), '');
  });
  test('leaves non-placeholder strings, numbers, booleans untouched', () => {
    const out = fillPlaceholders({ s: 'plain', n: 5, b: true, arr: [1, '{{string:id}}'] }, { id: 'z' });
    assert.deepEqual(out, { s: 'plain', n: 5, b: true, arr: [1, 'z'] });
  });
});

describe('instantiateTemplate', () => {
  const tmpl = () => ({
    $schema: 'klebb.datafile.v1',
    meta: {
      template: { id: 'weight', title: 'Weight', summary: 's', category: 'tracking', tags: ['t'], defaults: { unit: 'kg' } },
      id: '{{string:id}}',
      label: '{{string:label}}',
      emoji: '⚖️',
      view: { enabled: true, component: 'generic-card', display: { template: '{kg}', unit: '{{string:unit}}' } },
    },
    data: [],
  });

  test('fills id/label/unit and strips meta.template', () => {
    const { id, manifest } = instantiateTemplate(tmpl(), []);
    assert.equal(id, 'weight');
    assert.equal(manifest.meta.id, 'weight');
    assert.equal(manifest.meta.label, 'Weight');           // from title
    assert.equal(manifest.meta.view.display.unit, 'kg');   // from defaults
    assert.equal(manifest.meta.template, undefined);       // authoring block stripped
  });

  test('dedupes the id against taken ids', () => {
    const { id, manifest } = instantiateTemplate(tmpl(), ['weight', 'weight-2']);
    assert.equal(id, 'weight-3');
    assert.equal(manifest.meta.id, 'weight-3');
  });

  test('label default overrides the title when present', () => {
    const t = tmpl();
    t.meta.template.defaults.label = 'Body weight';
    assert.equal(instantiateTemplate(t, []).manifest.meta.label, 'Body weight');
  });

  test('throws on a non-template manifest', () => {
    assert.throws(() => instantiateTemplate({ meta: { id: 'x' } }, []), /not a template/);
  });

  test('never leaves a literal placeholder in the output', () => {
    const { manifest } = instantiateTemplate(tmpl(), []);
    assert.ok(!JSON.stringify(manifest).includes('{{'), 'no {{…}} leaked through');
  });
});

describe('every shipped template instantiates into a valid card', () => {
  test('all templates pass strict create-validation after instantiation', () => {
    const templates = listTemplates();
    assert.ok(templates.length >= 20, `expected >= 20 templates, got ${templates.length}`);
    for (const t of templates) {
      const { manifest } = instantiateTemplate(t.manifest, []);
      // Same gate createManifest runs; must not throw.
      assert.doesNotThrow(
        () => validateManifestShape(manifest, { strictId: true, strictNotifications: true }),
        `template ${t.id} produced an invalid manifest`,
      );
      assert.equal(manifest.meta.template, undefined, `template ${t.id} kept its meta.template block`);
      assert.ok(!JSON.stringify(manifest).includes('{{'), `template ${t.id} leaked a placeholder`);
    }
  });

  test('a second instantiation of the same template gets a distinct id', () => {
    const weight = listTemplates().find(t => t.id === 'weight');
    const first = instantiateTemplate(weight.manifest, []);
    const second = instantiateTemplate(weight.manifest, [first.id]);
    assert.notEqual(first.id, second.id);
  });
});
