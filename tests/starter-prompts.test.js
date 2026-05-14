// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/starter-prompts.test.js
// Pure-function tests for the chat-widget starter-prompt picker.
// See #195.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { candidatesFor, pickStarterPrompts } =
  require(path.join(__dirname, '..', 'public', 'js', 'lib', 'starter-prompts.js'));

// Deterministic RNG factory — produces a sequence of values from 0 to
// just-under-1 so the Fisher–Yates shuffle is reproducible.
function seededRandom(seed) {
  let s = seed >>> 0;
  return () => {
    // xorshift32
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return ((s >>> 0) % 1_000_000) / 1_000_000;
  };
}

describe('candidatesFor', () => {
  test('declared starterPrompts are returned cleaned', () => {
    const card = {
      id: 'hrv',
      label: 'HRV',
      chat: {
        starterPrompts: [
          { text: 'What is my average HRV this week?', kind: 'data' },
          { text: 'Switch HRV units', kind: 'tweak' },
        ],
      },
    };
    const out = candidatesFor(card);
    assert.equal(out.length, 2);
    assert.equal(out[0].text, 'What is my average HRV this week?');
    assert.equal(out[0].kind, 'data');
    assert.equal(out[0].cardId, 'hrv');
    assert.equal(out[1].kind, 'tweak');
  });

  test('unknown kind defaults to data', () => {
    const card = {
      id: 'x',
      label: 'X',
      chat: { starterPrompts: [{ text: 'ok', kind: 'weird' }] },
    };
    const out = candidatesFor(card);
    assert.equal(out[0].kind, 'data');
  });

  test('trims whitespace and drops empty text', () => {
    const card = {
      id: 'x',
      label: 'X',
      chat: {
        starterPrompts: [
          { text: '   ', kind: 'data' },
          { text: '  real prompt  ', kind: 'data' },
          { kind: 'data' },
          { text: 'no kind' },
        ],
      },
    };
    const out = candidatesFor(card);
    assert.equal(out.length, 2);
    assert.equal(out[0].text, 'real prompt');
    assert.equal(out[1].text, 'no kind');
    assert.equal(out[1].kind, 'data');
  });

  test('absent starterPrompts produces a default data prompt', () => {
    const card = { id: 'weight', label: 'Weight' };
    const out = candidatesFor(card);
    assert.equal(out.length, 1);
    assert.equal(out[0].text, 'Show me my Weight data');
    assert.equal(out[0].kind, 'data');
    assert.equal(out[0].cardId, 'weight');
  });

  test('empty starterPrompts array also falls through to default', () => {
    const card = { id: 'weight', label: 'Weight', chat: { starterPrompts: [] } };
    const out = candidatesFor(card);
    assert.equal(out.length, 1);
    assert.equal(out[0].text, 'Show me my Weight data');
  });

  test('no label → falls back to id', () => {
    const card = { id: 'blood-pressure' };
    const out = candidatesFor(card);
    assert.equal(out[0].text, 'Show me my blood-pressure data');
  });
});

describe('pickStarterPrompts', () => {
  const sampleCards = [
    { id: 'mood', label: 'Mood', chat: { starterPrompts: [
      { text: 'mood avg', kind: 'data' },
      { text: 'mood tweak', kind: 'tweak' },
    ] } },
    { id: 'weight', label: 'Weight', chat: { starterPrompts: [
      { text: 'weight trend', kind: 'data' },
    ] } },
    { id: 'hrv', label: 'HRV', chat: { starterPrompts: [
      { text: 'hrv now', kind: 'data' },
      { text: 'hrv tweak', kind: 'tweak' },
    ] } },
    { id: 'bp', label: 'BP' }, // no starterPrompts — falls back
  ];

  test('returns at most count chips', () => {
    const out = pickStarterPrompts(sampleCards, { count: 3, random: seededRandom(1) });
    assert.ok(out.length <= 3);
  });

  test('never repeats the same card', () => {
    const out = pickStarterPrompts(sampleCards, { count: 7, random: seededRandom(2) });
    const ids = out.map(p => p.cardId);
    assert.equal(new Set(ids).size, ids.length);
  });

  test('balance: when both kinds are available, the first few chips interleave', () => {
    // Eight cards, half data, half tweak.
    const cards = [];
    for (let i = 0; i < 4; i++) {
      cards.push({ id: `d${i}`, label: `D${i}`, chat: { starterPrompts: [{ text: `data-${i}`, kind: 'data' }] } });
    }
    for (let i = 0; i < 4; i++) {
      cards.push({ id: `t${i}`, label: `T${i}`, chat: { starterPrompts: [{ text: `tweak-${i}`, kind: 'tweak' }] } });
    }
    const out = pickStarterPrompts(cards, { count: 8, random: seededRandom(42) });
    // Expect a 1:1 interleave: data, tweak, data, tweak, ...
    // (with 4+4 supply the balancer hits exact alternation).
    for (let i = 0; i < out.length; i++) {
      const expected = i % 2 === 0 ? 'data' : 'tweak';
      assert.equal(out[i].kind, expected, `position ${i} should be ${expected}, got ${out[i].kind}`);
    }
  });

  test('supply-limited: all-data cards yield all-data chips, no crash', () => {
    const cards = [
      { id: 'a', label: 'A', chat: { starterPrompts: [{ text: 'a', kind: 'data' }] } },
      { id: 'b', label: 'B', chat: { starterPrompts: [{ text: 'b', kind: 'data' }] } },
    ];
    const out = pickStarterPrompts(cards, { count: 5, random: seededRandom(3) });
    assert.equal(out.length, 2);
    assert.ok(out.every(p => p.kind === 'data'));
  });

  test('empty card list → empty result', () => {
    assert.deepEqual(pickStarterPrompts([], { count: 7, random: seededRandom(4) }), []);
  });

  test('cards without chat.starterPrompts contribute the generated default', () => {
    const cards = [
      { id: 'weight', label: 'Weight' },
      { id: 'bp', label: 'BP' },
    ];
    const out = pickStarterPrompts(cards, { count: 7, random: seededRandom(5) });
    assert.equal(out.length, 2);
    assert.ok(out.every(p => p.kind === 'data'));
    const texts = out.map(p => p.text).sort();
    assert.deepEqual(texts, ['Show me my BP data', 'Show me my Weight data']);
  });
});
