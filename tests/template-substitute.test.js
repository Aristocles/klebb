// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/template-substitute.test.js
// Unit tests for public/js/lib/template-substitute.js. Pure-function
// module; testable under Node with no browser glue.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('path');

// The lib is ES-module. Load it via dynamic import.
let lib;
test.before(async () => {
  lib = await import(
    'file://' + path.resolve(__dirname, '..', 'public', 'js', 'lib', 'template-substitute.js')
      .replace(/\\/g, '/'),
  );
});

describe('extractPlaceholders', () => {
  test('extracts typed placeholders', () => {
    const raw = '{"a":"{{string:name}}","b":"{{number:dose_mg}}","c":"{{date:start}}"}';
    const out = lib.extractPlaceholders(raw);
    assert.deepEqual(out, [
      { name: 'name', type: 'string' },
      { name: 'dose_mg', type: 'number' },
      { name: 'start', type: 'date' },
    ]);
  });

  test('defaults to string when no type prefix', () => {
    const raw = '{"a":"{{name}}"}';
    const out = lib.extractPlaceholders(raw);
    assert.deepEqual(out, [{ name: 'name', type: 'string' }]);
  });

  test('deduplicates repeated placeholder names', () => {
    const raw = '{"a":"{{string:id}}","b":"{{string:id}}"}';
    const out = lib.extractPlaceholders(raw);
    assert.deepEqual(out, [{ name: 'id', type: 'string' }]);
  });

  test('throws on conflicting types for the same name', () => {
    const raw = '{"a":"{{string:x}}","b":"{{number:x}}"}';
    assert.throws(() => lib.extractPlaceholders(raw),
      /conflicting types/);
  });

  test('throws on unknown type', () => {
    const raw = '{"a":"{{banana:x}}"}';
    assert.throws(() => lib.extractPlaceholders(raw),
      /unknown placeholder type/);
  });
});

describe('substitutePlaceholders', () => {
  test('substitutes string values quoted', () => {
    const raw = '{"id":"{{string:id}}"}';
    const out = lib.substitutePlaceholders(raw, { id: 'weight' });
    assert.equal(out, '{"id":"weight"}');
  });

  test('substitutes number values unquoted', () => {
    const raw = '{"dose":"{{number:dose_mg}}"}';
    const out = lib.substitutePlaceholders(raw, { dose_mg: 0.5 });
    const parsed = JSON.parse(out);
    assert.equal(parsed.dose, 0.5);
    assert.equal(typeof parsed.dose, 'number');
  });

  test('coerces string "0.5" to number 0.5', () => {
    const raw = '{"dose":"{{number:dose_mg}}"}';
    const out = lib.substitutePlaceholders(raw, { dose_mg: '0.5' });
    assert.equal(JSON.parse(out).dose, 0.5);
  });

  test('non-finite number substitutes as 0', () => {
    const raw = '{"dose":"{{number:dose_mg}}"}';
    const out = lib.substitutePlaceholders(raw, { dose_mg: 'not a number' });
    assert.equal(JSON.parse(out).dose, 0);
  });

  test('boolean substitutes correctly', () => {
    const raw = '{"flag":"{{boolean:flag}}"}';
    assert.equal(JSON.parse(lib.substitutePlaceholders(raw, { flag: true })).flag, true);
    assert.equal(JSON.parse(lib.substitutePlaceholders(raw, { flag: false })).flag, false);
    assert.equal(JSON.parse(lib.substitutePlaceholders(raw, { flag: 'true' })).flag, true);
  });

  test('empty value uses type-appropriate default', () => {
    const raw = '{"a":"{{string:s}}","b":"{{number:n}}","c":"{{boolean:b}}"}';
    const out = lib.substitutePlaceholders(raw, {});
    const parsed = JSON.parse(out);
    assert.equal(parsed.a, '');
    assert.equal(parsed.b, 0);
    assert.equal(parsed.c, false);
  });

  test('escapes JSON special characters in string values', () => {
    const raw = '{"name":"{{string:name}}"}';
    const out = lib.substitutePlaceholders(raw, { name: 'has "quotes" and \\ backslash' });
    const parsed = JSON.parse(out);
    assert.equal(parsed.name, 'has "quotes" and \\ backslash');
  });
});

describe('parseSubstituted', () => {
  test('returns parsed manifest on valid input', () => {
    const raw = '{"$schema":"klebb.datafile.v1","meta":{"id":"{{string:id}}"}}';
    const { manifest, error } = lib.parseSubstituted(raw, { id: 'weight' });
    assert.equal(error, null);
    assert.equal(manifest.meta.id, 'weight');
  });

  test('returns error object on invalid JSON', () => {
    // Corrupt the JSON with a trailing stray character.
    const raw = '{"id":"{{string:id}}"';
    const { manifest, error } = lib.parseSubstituted(raw, { id: 'x' });
    assert.equal(manifest, null);
    assert.ok(error);
  });
});
