// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/merge-patch.test.js
// Unit tests for the RFC 7396 JSON Merge Patch helper.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { mergePatch, isPlainObject } = require('../manifests/merge-patch');

describe('isPlainObject', () => {
  test('objects', () => { assert.equal(isPlainObject({}), true); assert.equal(isPlainObject({a:1}), true); });
  test('not arrays', () => { assert.equal(isPlainObject([]), false); });
  test('not null', () => { assert.equal(isPlainObject(null), false); });
  test('not primitives', () => {
    assert.equal(isPlainObject(1), false);
    assert.equal(isPlainObject('x'), false);
    assert.equal(isPlainObject(true), false);
    assert.equal(isPlainObject(undefined), false);
  });
});

describe('mergePatch', () => {
  test('shallow key set', () => {
    assert.deepEqual(mergePatch({a:1}, {b:2}), {a:1, b:2});
  });

  test('shallow key replace', () => {
    assert.deepEqual(mergePatch({a:1}, {a:2}), {a:2});
  });

  test('null removes key', () => {
    assert.deepEqual(mergePatch({a:1, b:2}, {a:null}), {b:2});
  });

  test('null removes deep key', () => {
    assert.deepEqual(
      mergePatch({a: {b:1, c:2}}, {a: {b: null}}),
      {a: {c:2}},
    );
  });

  test('deep merge nested object', () => {
    assert.deepEqual(
      mergePatch({a: {b:1, c:2}}, {a: {c: 99, d: 100}}),
      {a: {b:1, c:99, d:100}},
    );
  });

  test('arrays replace wholesale (RFC 7396)', () => {
    assert.deepEqual(
      mergePatch({a: [1,2,3]}, {a: [9]}),
      {a: [9]},
    );
  });

  test('array inside nested object still replaces', () => {
    assert.deepEqual(
      mergePatch({meta: {inputs: [{k:'a'},{k:'b'}]}}, {meta: {inputs: [{k:'a'}]}}),
      {meta: {inputs: [{k:'a'}]}},
    );
  });

  test('non-object patch replaces target entirely', () => {
    assert.equal(mergePatch({a:1}, 42), 42);
    assert.equal(mergePatch({a:1}, 'hello'), 'hello');
    assert.deepEqual(mergePatch({a:1}, [1,2]), [1,2]);
    assert.equal(mergePatch({a:1}, null), null);
  });

  test('target missing key gets nested structure created', () => {
    assert.deepEqual(
      mergePatch({}, {a: {b: {c: 1}}}),
      {a: {b: {c: 1}}},
    );
  });

  test('target key that is not an object gets replaced by nested patch', () => {
    // Target a=5 (number); patch a={b:1} — target isn't mergeable so it's replaced.
    assert.deepEqual(mergePatch({a:5}, {a:{b:1}}), {a:{b:1}});
  });

  test('original target not mutated', () => {
    const target = {a: {b: 1}};
    const patched = mergePatch(target, {a: {c: 2}});
    assert.deepEqual(target, {a: {b: 1}});
    assert.deepEqual(patched, {a: {b:1, c:2}});
  });

  test('empty patch returns equal copy', () => {
    assert.deepEqual(mergePatch({a:1}, {}), {a:1});
  });

  test('klebb-flavoured: flipping a single input flag', () => {
    const before = {
      meta: {
        writeable: {
          fromWebapp: true,
          inputs: [
            { key: 'mood', type: 'emoji-picker', autoSubmit: true },
            { key: 'notes', type: 'textarea' },
          ],
        },
      },
    };
    // The patch must include the full inputs array (arrays replace).
    const patch = {
      meta: {
        writeable: {
          inputs: [
            { key: 'mood', type: 'emoji-picker', autoSubmit: false },
            { key: 'notes', type: 'textarea' },
          ],
        },
      },
    };
    const after = mergePatch(before, patch);
    assert.equal(after.meta.writeable.fromWebapp, true, 'fromWebapp preserved');
    assert.equal(after.meta.writeable.inputs[0].autoSubmit, false);
    assert.equal(after.meta.writeable.inputs[1].type, 'textarea');
  });
});
