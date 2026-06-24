// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/validate-manifest.test.js
// The validate_manifest dry-run tool: structural parity with the write-path
// validator, renderer-shape checks, and that the dry-run never mutates input.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { validateManifest, rendererShapeErrors } = require('../chat/validate-manifest');
const registry = require('../manifests/registry');
const { TOOL_DEFS, dispatchToolCall } = require('../chat/tools');

function makeToolCall(name, args) {
  return { function: { name, arguments: JSON.stringify(args) } };
}

const goodGeneric = {
  $schema: 'klebb.datafile.v1',
  meta: { id: 'weight', label: 'Weight', view: { component: 'generic-card', display: { template: '{kg}', unit: 'kg' } } },
  data: [],
};

describe('validate_manifest: structural validation', () => {
  test('accepts a well-formed generic-card manifest', () => {
    assert.deepStrictEqual(validateManifest(goodGeneric), { ok: true });
  });

  test('rejects a missing meta.label, pointing at the path', () => {
    const r = validateManifest({ $schema: 'klebb.datafile.v1', meta: { id: 'x' } });
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors.some(e => e.path === 'meta.label'));
  });

  test('rejects a bad id format', () => {
    const r = validateManifest({ $schema: 'klebb.datafile.v1', meta: { id: 'Bad Id!', label: 'x' } });
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors.some(e => e.path === 'meta.id' && /invalid id/.test(e.message)));
  });

  test('rejects unsupported $schema', () => {
    const r = validateManifest({ $schema: 'nope.v9', meta: { id: 'x', label: 'X' } });
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors.some(e => e.path === '$schema'));
  });

  test('rejects a non-object manifest', () => {
    assert.strictEqual(validateManifest(null).ok, false);
    assert.strictEqual(validateManifest([]).ok, false);
    assert.strictEqual(validateManifest('x').ok, false);
  });
});

describe('validate_manifest: parity with the write path', () => {
  // The dry-run must agree with what createManifest would reject for the same
  // input. We can't call createManifest without a sandbox here, but we can
  // assert the dry-run uses the SAME validator throw by checking a case the
  // validator rejects (reserved id) surfaces as an error.
  test('reserved id is rejected (same gate as create)', () => {
    const r = validateManifest({ $schema: 'klebb.datafile.v1', meta: { id: '_meta', label: 'X' } });
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors.some(e => e.path === 'meta.id'));
  });

  test('a manifest validate_manifest accepts also passes validateManifestShape directly', () => {
    // belt-and-braces: the dry-run accepting implies the raw validator accepts
    assert.doesNotThrow(() => registry.validateManifestShape(JSON.parse(JSON.stringify(goodGeneric)), { strictId: true }));
  });
});

describe('validate_manifest: renderer-shape checks', () => {
  test('combination-card without combines[] is rejected', () => {
    const r = validateManifest({
      $schema: 'klebb.datafile.v1',
      meta: { id: 'combo', label: 'Combo', view: { component: 'combination-card' } },
      data: [],
    });
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors.some(e => e.path === 'meta.view.combines'));
  });

  test('combination-card combines entry without sourceId is rejected', () => {
    const errs = rendererShapeErrors({ meta: { view: { component: 'combination-card', combines: [{ role: 'ring' }] } } });
    assert.ok(errs.some(e => /sourceId/.test(e.path)));
  });

  test('line-chart WITHOUT series is accepted (renderer auto-detects)', () => {
    const errs = rendererShapeErrors({ meta: { view: { component: 'line-chart' } } });
    assert.deepStrictEqual(errs, []);
  });

  test('line-chart WITH a malformed series entry is rejected', () => {
    const errs = rendererShapeErrors({ meta: { view: { component: 'line-chart', series: [{ label: 'x' }] } } });
    assert.ok(errs.some(e => /series\[0\]\.field/.test(e.path)));
  });

  test('display as a string is rejected', () => {
    const errs = rendererShapeErrors({ meta: { view: { component: 'generic-card', display: 'oops' } } });
    assert.ok(errs.some(e => e.path === 'meta.view.display'));
  });
});

describe('validate_manifest: purity + tool wiring', () => {
  test('dry-run does not mutate the input manifest', () => {
    const input = { $schema: 'klebb.datafile.v1', meta: { id: 'x', label: 'X', category: 'not-a-real-category' } };
    const snapshot = JSON.stringify(input);
    validateManifest(input);
    assert.strictEqual(JSON.stringify(input), snapshot, 'validate_manifest must not mutate its input (category should not be stripped)');
  });

  test('is registered in TOOL_DEFS and dispatches', () => {
    const def = TOOL_DEFS.find(t => t.function?.name === 'validate_manifest');
    assert.ok(def, 'validate_manifest missing from TOOL_DEFS');
    const out = JSON.parse(dispatchToolCall(makeToolCall('validate_manifest', { manifest: goodGeneric })));
    assert.strictEqual(out.ok, true);
  });
});
