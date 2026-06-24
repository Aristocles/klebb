// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/api/issue-423-trend-arrow.test.js
// Regression seed for #423: generic-card trend-arrow colour is metric-aware.
//
// Pre-fix behaviour this test pins:
//   The renderer hardcoded up=red (#ff7755) / down=green (#55cc77) via
//   static CSS classes (.gen-trend.up / .gen-trend.down). That is correct
//   for weight (rising is bad) but INVERTED for "more is better" metrics
//   (sleep hours, steps, protein), where an up-trend is good and should be
//   green. There was no goodDirection knob, no signed delta, and colour was
//   the sole carrier of meaning (fails ~8% of men who are colour-blind).
//
//   On main there is no trendColour / resolveGoodDirection / formatTrendDelta
//   export, so the first require() assertion below fails outright, and the
//   "good-up metric paints an up-trend green" assertion cannot hold because
//   an up-trend was unconditionally red.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const {
  trendColour, resolveGoodDirection, formatTrendDelta, computeTrend,
} = require(path.join(__dirname, '..', '..', 'public', 'js', 'lib', 'display-template.js'));

const GOOD = '#55cc77'; // green
const BAD = '#ff7755';  // red
const NEUTRAL = 'var(--text-muted, var(--text-secondary))';

describe('#423 trendColour is metric-aware', () => {
  test('helper exports exist (absent on main)', () => {
    assert.equal(typeof trendColour, 'function');
    assert.equal(typeof resolveGoodDirection, 'function');
    assert.equal(typeof formatTrendDelta, 'function');
  });

  test('default (no goodDirection) keeps weight semantics: up=bad, down=good', () => {
    assert.equal(trendColour('up', undefined), BAD);
    assert.equal(trendColour('down', undefined), GOOD);
    assert.equal(trendColour('up', null), BAD);
    assert.equal(trendColour('down', null), GOOD);
  });

  test('goodDirection up flips it: up=good, down=bad (sleep/steps/protein)', () => {
    // This is the core #423 bug: on main an up-trend was always red.
    assert.equal(trendColour('up', 'up'), GOOD);
    assert.equal(trendColour('down', 'up'), BAD);
  });

  test('goodDirection down matches the historical weight default', () => {
    assert.equal(trendColour('up', 'down'), BAD);
    assert.equal(trendColour('down', 'down'), GOOD);
  });

  test('goodDirection neutral paints both directions a muted colour', () => {
    assert.equal(trendColour('up', 'neutral'), NEUTRAL);
    assert.equal(trendColour('down', 'neutral'), NEUTRAL);
  });

  test('flat is always neutral regardless of goodDirection', () => {
    assert.equal(trendColour('flat', undefined), NEUTRAL);
    assert.equal(trendColour('flat', 'up'), NEUTRAL);
    assert.equal(trendColour('flat', 'down'), NEUTRAL);
    assert.equal(trendColour('flat', 'neutral'), NEUTRAL);
  });
});

describe('#423 resolveGoodDirection normalises config', () => {
  test('reads canonical goodDirection token', () => {
    assert.equal(resolveGoodDirection({ goodDirection: 'up' }), 'up');
    assert.equal(resolveGoodDirection({ goodDirection: 'down' }), 'down');
    assert.equal(resolveGoodDirection({ goodDirection: 'neutral' }), 'neutral');
  });

  test('absent / unrecognised returns null (→ default semantics)', () => {
    assert.equal(resolveGoodDirection({ field: 'kg' }), null);
    assert.equal(resolveGoodDirection({ goodDirection: 'sideways' }), null);
    assert.equal(resolveGoodDirection(undefined), null);
    assert.equal(resolveGoodDirection(null), null);
  });

  test('lowerIsBetter:true alias (shipped in a demo fixture) maps to down', () => {
    assert.equal(resolveGoodDirection({ field: 'bpm', lowerIsBetter: true }), 'down');
  });
});

describe('#423 formatTrendDelta produces a signed string', () => {
  test('positive delta gets a + sign', () => {
    assert.equal(formatTrendDelta(0.4), '+0.4');
    assert.equal(formatTrendDelta(2), '+2');
  });

  test('negative delta keeps its - sign', () => {
    assert.equal(formatTrendDelta(-0.6), '-0.6');
  });

  test('zero is unsigned', () => {
    assert.equal(formatTrendDelta(0), '0');
  });

  test('float-subtraction noise is trimmed to 2dp', () => {
    // 86 - 85.6 in float is 0.40000000000000036; must read as +0.4.
    assert.equal(formatTrendDelta(86 - 85.6), '+0.4');
  });

  test('non-numeric delta is empty', () => {
    assert.equal(formatTrendDelta(NaN), '');
    assert.equal(formatTrendDelta('x'), '');
  });
});

describe('#423 end-to-end: a good-up metric colours an up-trend green', () => {
  // Steps: more is better. An up-trend (yesterday 8000 → today 9000) was
  // mis-coloured red on main; it must be green now, and the delta +1000.
  const steps = [
    { date: '2026-06-21', count: 8000 },
    { date: '2026-06-22', count: 9000 },
  ];

  test('up-trend on goodDirection:up is green with a +delta', () => {
    const trend = computeTrend(steps[1], 'count', steps);
    assert.equal(trend.dir, 'up');
    const colour = trendColour(trend.dir, resolveGoodDirection({ field: 'count', goodDirection: 'up' }));
    assert.equal(colour, GOOD);
    assert.equal(formatTrendDelta(trend.delta), '+1000');
  });

  test('same up-trend with default (weight-style) config stays red', () => {
    const trend = computeTrend(steps[1], 'count', steps);
    const colour = trendColour(trend.dir, resolveGoodDirection({ field: 'count' }));
    assert.equal(colour, BAD);
  });
});
