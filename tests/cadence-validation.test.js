// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/cadence-validation.test.js
//
// meta.cadence, the opt-in staleness declaration (#570): lenient at load
// (drop the bad field), strict at create / PATCH (throw "invalid cadence: ...",
// which the server maps to 422).
//
// Dropping rather than defaulting is load-bearing. A card with no valid cadence
// is never flagged stale, so a typo makes the card quiet, never noisy.

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateManifestShape, CADENCE_MAX_DAYS } = require('../manifests/registry');

function shape(cadence) {
  const meta = { id: 'weight', label: 'Weight' };
  if (cadence !== undefined) meta.cadence = cadence;
  return { $schema: 'klebb.datafile.v1', meta, data: [] };
}

function strict(cadence) {
  return () => validateManifestShape(shape(cadence), { strictId: true });
}

test.describe('meta.cadence validation: lenient (load)', () => {
  test('keeps a valid whole-day window', () => {
    const m = shape({ expectDays: 7 });
    validateManifestShape(m);
    assert.deepEqual(m.meta.cadence, { expectDays: 7 });
  });

  test('keeps the boundary values', () => {
    for (const days of [1, CADENCE_MAX_DAYS]) {
      const m = shape({ expectDays: days });
      validateManifestShape(m);
      assert.equal(m.meta.cadence.expectDays, days, `expectDays ${days} should survive`);
    }
  });

  test('absent cadence stays absent (never defaulted in)', () => {
    // The whole point of the opt-in: nothing invents a window.
    const m = shape(undefined);
    validateManifestShape(m);
    assert.equal('cadence' in m.meta, false);
  });

  test('drops a zero, negative, fractional or over-max window', () => {
    for (const bad of [0, -3, 1.5, CADENCE_MAX_DAYS + 1, 99999]) {
      const m = shape({ expectDays: bad });
      validateManifestShape(m);
      assert.equal('cadence' in m.meta, false, `expectDays ${bad} should have been dropped`);
    }
  });

  test('drops a non-numeric window', () => {
    for (const bad of ['7', null, true, [], {}, NaN, Infinity]) {
      const m = shape({ expectDays: bad });
      validateManifestShape(m);
      assert.equal('cadence' in m.meta, false, `expectDays ${JSON.stringify(bad)} should have been dropped`);
    }
  });

  test('drops a cadence missing expectDays entirely', () => {
    const m = shape({ every: 'week' });
    validateManifestShape(m);
    assert.equal('cadence' in m.meta, false);
  });

  test('drops a non-object cadence', () => {
    for (const bad of [7, 'weekly', true, [], null]) {
      const m = shape(bad);
      validateManifestShape(m);
      assert.equal('cadence' in m.meta, false, `cadence ${JSON.stringify(bad)} should have been dropped`);
    }
  });

  test('a dropped cadence leaves the rest of meta intact', () => {
    // Lenient means the card still loads; one bad field must not cost the card.
    const m = shape({ expectDays: 'soon' });
    m.meta.label = 'Weight';
    validateManifestShape(m);
    assert.equal(m.meta.id, 'weight');
    assert.equal(m.meta.label, 'Weight');
  });
});

test.describe('meta.cadence validation: strict (create / PATCH)', () => {
  test('accepts a valid window', () => {
    assert.doesNotThrow(strict({ expectDays: 14 }));
  });

  test('accepts an absent cadence', () => {
    assert.doesNotThrow(strict(undefined));
  });

  test('rejects a bad expectDays with the 422 prefix', () => {
    for (const bad of [0, -1, 2.5, '7', null, CADENCE_MAX_DAYS + 1]) {
      assert.throws(strict({ expectDays: bad }), /^Error: invalid cadence: expectDays must be/,
        `expectDays ${JSON.stringify(bad)} should have thrown`);
    }
  });

  test('rejects a non-object cadence with the 422 prefix', () => {
    assert.throws(strict(7), /^Error: invalid cadence: must be an object/);
  });

  test('rejects a cadence missing expectDays', () => {
    assert.throws(strict({}), /^Error: invalid cadence: expectDays must be/);
  });
});
