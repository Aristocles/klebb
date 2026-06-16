// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/time-of-day.test.js
// Unit tests for the schedule time-of-day chip helper. Renderer DOM
// behaviour for the chip itself lives in the e2e suite.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { TIME_OF_DAY_TOKENS, emojiFor, chipsFor } = require('../public/js/lib/time-of-day.js');

describe('TIME_OF_DAY_TOKENS', () => {
  test('exposes the canonical four-slot vocabulary in order', () => {
    assert.deepEqual(TIME_OF_DAY_TOKENS, ['morning', 'midday', 'evening', 'night']);
  });
});

describe('emojiFor', () => {
  test('maps each token to its built-in emoji', () => {
    assert.equal(emojiFor('morning'), '☀️');
    assert.equal(emojiFor('midday'), '🌤️');
    assert.equal(emojiFor('evening'), '🌙');
    assert.equal(emojiFor('night'), '💤');
  });

  test('returns empty string for unknown / non-string input', () => {
    assert.equal(emojiFor('dawn'), '');
    assert.equal(emojiFor(''), '');
    assert.equal(emojiFor(null), '');
    assert.equal(emojiFor(undefined), '');
    assert.equal(emojiFor(7), '');
  });
});

describe('chipsFor', () => {
  test('string token: returns one chip with token / emoji / label', () => {
    assert.deepEqual(chipsFor('morning'), [
      { token: 'morning', emoji: '☀️', label: 'Morning' },
    ]);
  });

  test('array of tokens: returns one chip per token, in canonical order', () => {
    assert.deepEqual(chipsFor(['evening', 'morning']), [
      { token: 'morning', emoji: '☀️', label: 'Morning' },
      { token: 'evening', emoji: '🌙', label: 'Evening' },
    ]);
  });

  test('canonical order is morning < midday < evening < night regardless of input', () => {
    const out = chipsFor(['night', 'morning', 'evening', 'midday']);
    assert.deepEqual(out.map(c => c.token), ['morning', 'midday', 'evening', 'night']);
  });

  test('drops duplicates', () => {
    assert.deepEqual(chipsFor(['morning', 'morning', 'evening']).map(c => c.token),
      ['morning', 'evening']);
  });

  test('drops unknown / non-string tokens but keeps valid ones', () => {
    const out = chipsFor(['morning', 'dawn', 42, null, 'night']);
    assert.deepEqual(out.map(c => c.token), ['morning', 'night']);
  });

  test('missing or invalid value returns empty array', () => {
    assert.deepEqual(chipsFor(undefined), []);
    assert.deepEqual(chipsFor(null), []);
    assert.deepEqual(chipsFor(''), []);
    assert.deepEqual(chipsFor(123), []);
    assert.deepEqual(chipsFor({}), []);
    assert.deepEqual(chipsFor([]), []);
    assert.deepEqual(chipsFor(['dawn', 'noon']), []);
  });

  test('label is the capitalised form of the token', () => {
    assert.equal(chipsFor('morning')[0].label, 'Morning');
    assert.equal(chipsFor('midday')[0].label, 'Midday');
    assert.equal(chipsFor('evening')[0].label, 'Evening');
    assert.equal(chipsFor('night')[0].label, 'Night');
  });
});
