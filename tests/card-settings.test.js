// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/card-settings.test.js
// Pure-logic tests for the per-card settings model: value resolution,
// availability predicates, minimal-diff patch building, schema merge.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMMON_SETTINGS,
  mergeSchema,
  getAtPath,
  resolveSettingValue,
  isSettingAvailable,
  buildMetaPatch,
} from '../public/js/lib/card-settings.js';

const tog = (path, opts = {}) => ({ path, label: path, kind: 'toggle', default: false, ...opts });

describe('getAtPath', () => {
  test('reads nested values', () => {
    assert.equal(getAtPath({ view: { enabled: true } }, 'view.enabled'), true);
  });
  test('returns undefined for missing paths without throwing', () => {
    assert.equal(getAtPath({}, 'a.b.c'), undefined);
    assert.equal(getAtPath(null, 'a'), undefined);
    assert.equal(getAtPath({ a: 1 }, 'a.b'), undefined);
  });
});

describe('resolveSettingValue', () => {
  test('returns the live boolean when present', () => {
    assert.equal(resolveSettingValue({ view: { enabled: true } }, tog('view.enabled')), true);
    assert.equal(resolveSettingValue({ view: { enabled: false } }, tog('view.enabled')), false);
  });
  test('falls back to the descriptor default when absent', () => {
    assert.equal(resolveSettingValue({}, tog('view.enabled', { default: false })), false);
    assert.equal(resolveSettingValue({}, tog('writeable.todayAllowed', { default: true })), true);
  });
  test('ignores non-boolean live values and uses the default', () => {
    assert.equal(resolveSettingValue({ view: { enabled: 'yes' } }, tog('view.enabled', { default: false })), false);
  });
});

describe('isSettingAvailable', () => {
  test('true when no predicate', () => {
    assert.equal(isSettingAvailable(tog('x'), { meta: {}, data: null }), true);
  });
  test('evaluates the predicate against ctx', () => {
    const d = tog('writeable.todayAllowed', {
      availableWhen: ({ meta }) => !!meta?.writeable?.fromWebapp,
    });
    assert.equal(isSettingAvailable(d, { meta: { writeable: { fromWebapp: true } } }), true);
    assert.equal(isSettingAvailable(d, { meta: { writeable: {} } }), false);
  });
  test('a throwing predicate resolves to unavailable, not a crash', () => {
    const d = tog('x', { availableWhen: () => { throw new Error('boom'); } });
    assert.equal(isSettingAvailable(d, { meta: {} }), false);
  });
});

describe('buildMetaPatch', () => {
  const schema = [tog('view.enabled'), tog('writeable.fromWebapp'), tog('writeable.todayAllowed', { default: true })];

  test('emits only changed paths, nested under meta', () => {
    const patch = buildMetaPatch(schema, { view: { enabled: false } }, { 'view.enabled': true });
    assert.deepEqual(patch, { meta: { view: { enabled: true } } });
  });

  test('no-op (null) when edited value equals current', () => {
    const patch = buildMetaPatch(schema, { view: { enabled: true } }, { 'view.enabled': true });
    assert.equal(patch, null);
  });

  test('no-op (null) when nothing was edited', () => {
    assert.equal(buildMetaPatch(schema, { view: { enabled: true } }, {}), null);
  });

  test('respects per-field defaults when computing the diff', () => {
    // todayAllowed defaults true; setting it true on an absent manifest is a no-op.
    assert.equal(buildMetaPatch(schema, {}, { 'writeable.todayAllowed': true }), null);
    // ...but flipping it false IS a change.
    assert.deepEqual(
      buildMetaPatch(schema, {}, { 'writeable.todayAllowed': false }),
      { meta: { writeable: { todayAllowed: false } } },
    );
  });

  test('merges multiple changed paths into one nested patch', () => {
    const patch = buildMetaPatch(
      schema,
      { view: { enabled: false }, writeable: { fromWebapp: false } },
      { 'view.enabled': true, 'writeable.fromWebapp': true },
    );
    assert.deepEqual(patch, { meta: { view: { enabled: true }, writeable: { fromWebapp: true } } });
  });

  test('ignores edited keys not declared in the schema', () => {
    assert.equal(buildMetaPatch(schema, {}, { 'bogus.path': true }), null);
  });
});

describe('mergeSchema', () => {
  test('common settings come first, renderer schema appended', () => {
    const extra = [tog('view.showSparkline')];
    const merged = mergeSchema(extra);
    assert.equal(merged.length, COMMON_SETTINGS.length + 1);
    assert.equal(merged[merged.length - 1].path, 'view.showSparkline');
  });
  test('tolerates a missing/undefined renderer schema', () => {
    assert.equal(mergeSchema(undefined).length, COMMON_SETTINGS.length);
    assert.equal(mergeSchema(null).length, COMMON_SETTINGS.length);
  });
});

describe('COMMON_SETTINGS shape', () => {
  test('every descriptor has a path, label, toggle kind and boolean default', () => {
    for (const d of COMMON_SETTINGS) {
      assert.equal(typeof d.path, 'string');
      assert.equal(typeof d.label, 'string');
      assert.equal(d.kind, 'toggle');
      assert.equal(typeof d.default, 'boolean');
    }
  });
  test('todayAllowed defaults on; the rest default off', () => {
    const today = COMMON_SETTINGS.find(d => d.path === 'writeable.todayAllowed');
    assert.equal(today.default, true);
    const past = COMMON_SETTINGS.find(d => d.path === 'writeable.pastAllowed');
    assert.equal(past.default, false);
  });
});
