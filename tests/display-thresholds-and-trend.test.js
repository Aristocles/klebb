// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/display-thresholds-and-trend.test.js
// Pure-function tests for the threshold evaluator and trend computer.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { evaluateThresholds, computeTrend } =
  require(path.join(__dirname, '..', 'public', 'js', 'lib', 'display-template.js'));

describe('evaluateThresholds', () => {
  const bpRules = [
    { ifField: 'systolic', max: 119, colour: '#44ff88', label: 'Optimal' },
    { ifField: 'systolic', max: 129, colour: '#aaaa44', label: 'Elevated' },
    { ifField: 'systolic', max: 139, colour: '#ff7733', label: 'Stage 1' },
    { ifField: 'systolic', max: 999, colour: '#ff3333', label: 'Stage 2' },
  ];

  test('first-match-wins on BP rules', () => {
    const r = evaluateThresholds({ systolic: 115 }, bpRules);
    assert.equal(r.label, 'Optimal');
  });

  test('matches middle rule', () => {
    const r = evaluateThresholds({ systolic: 125 }, bpRules);
    assert.equal(r.label, 'Elevated');
  });

  test('matches last rule when everything earlier fails', () => {
    const r = evaluateThresholds({ systolic: 160 }, bpRules);
    assert.equal(r.label, 'Stage 2');
  });

  test('max is inclusive', () => {
    const r = evaluateThresholds({ systolic: 119 }, bpRules);
    assert.equal(r.label, 'Optimal');
  });

  test('returns null when field missing', () => {
    const r = evaluateThresholds({ diastolic: 80 }, bpRules);
    assert.equal(r, null);
  });

  test('returns null when value is non-numeric', () => {
    const r = evaluateThresholds({ systolic: 'NaN' }, bpRules);
    assert.equal(r, null);
  });

  test('supports min + max combo', () => {
    const rules = [
      { ifField: 'kg', min: 80, max: 100, colour: '#0f0', label: 'Healthy' },
      { ifField: 'kg', min: 101, max: 200, colour: '#f00', label: 'Overweight' },
    ];
    assert.equal(evaluateThresholds({ kg: 85 }, rules).label, 'Healthy');
    assert.equal(evaluateThresholds({ kg: 110 }, rules).label, 'Overweight');
    assert.equal(evaluateThresholds({ kg: 50 }, rules), null);
  });

  test('supports eq rule for categorical matching', () => {
    const rules = [
      { ifField: 'mood', eq: 5, colour: '#0f0', label: 'Great' },
      { ifField: 'mood', eq: 1, colour: '#f00', label: 'Low' },
    ];
    assert.equal(evaluateThresholds({ mood: 5 }, rules).label, 'Great');
    assert.equal(evaluateThresholds({ mood: 1 }, rules).label, 'Low');
    assert.equal(evaluateThresholds({ mood: 3 }, rules), null);
  });

  test('eq matches stringly', () => {
    const rules = [{ ifField: 'mood', eq: '4', colour: '#0f0', label: 'Good' }];
    assert.equal(evaluateThresholds({ mood: 4 }, rules).label, 'Good');
  });

  test('empty thresholds array returns null', () => {
    assert.equal(evaluateThresholds({ systolic: 120 }, []), null);
  });

  test('null row returns null', () => {
    assert.equal(evaluateThresholds(null, bpRules), null);
  });

  test('rule without ifField is ignored', () => {
    const rules = [
      { label: 'wrong' },                  // no ifField
      { ifField: 'x', min: 5, max: 10, label: 'right' },
    ];
    assert.equal(evaluateThresholds({ x: 7 }, rules).label, 'right');
  });

  test('bounds-less rule (no min/max/eq) acts as a catch-all', () => {
    const rules = [
      { ifField: 'x', max: 10, label: 'low' },
      { ifField: 'x', min: 20, label: 'high' },
      { ifField: 'x', label: 'middle' },      // catch-all: 10 < x < 20
    ];
    assert.equal(evaluateThresholds({ x: 5  }, rules).label, 'low');
    assert.equal(evaluateThresholds({ x: 15 }, rules).label, 'middle');
    assert.equal(evaluateThresholds({ x: 25 }, rules).label, 'high');
  });

  test('accepts field alias (backwards compat)', () => {
    const rules = [{ field: 'kg', max: 100, label: 'OK' }];
    assert.equal(evaluateThresholds({ kg: 80 }, rules).label, 'OK');
  });
});

describe('computeTrend', () => {
  const rows = [
    { date: '2026-04-18', kg: 85 },
    { date: '2026-04-19', kg: 86 },
    { date: '2026-04-20', kg: 85.5 },
    { date: '2026-04-21', kg: 86 },
  ];

  test('down direction', () => {
    const current = rows[2]; // 85.5
    const t = computeTrend(current, 'kg', rows);
    assert.equal(t.dir, 'down');
    assert.equal(t.delta, -0.5);
    assert.equal(t.prev.date, '2026-04-19');
  });

  test('up direction', () => {
    const current = rows[1]; // 86 on 04-19
    const t = computeTrend(current, 'kg', rows);
    assert.equal(t.dir, 'up');
    assert.equal(t.delta, 1);
    assert.equal(t.prev.date, '2026-04-18');
  });

  test('flat direction (zero delta)', () => {
    const localRows = [
      { date: '2026-04-19', kg: 86 },
      { date: '2026-04-20', kg: 86 },
    ];
    const t = computeTrend(localRows[1], 'kg', localRows);
    assert.equal(t.dir, 'flat');
    assert.equal(t.delta, 0);
  });

  test('returns null when no prior entry', () => {
    const t = computeTrend(rows[0], 'kg', rows);
    assert.equal(t, null);
  });

  test('returns null when field is non-numeric', () => {
    const bad = [
      { date: '2026-04-19', notes: 'hi' },
      { date: '2026-04-20', notes: 'yo' },
    ];
    const t = computeTrend(bad[1], 'notes', bad);
    assert.equal(t, null);
  });

  test('returns null when row has no date', () => {
    const t = computeTrend({ kg: 85 }, 'kg', rows);
    assert.equal(t, null);
  });

  test('returns null when allRows is not an array', () => {
    assert.equal(computeTrend({ date: '2026-04-20', kg: 85 }, 'kg', null), null);
    assert.equal(computeTrend({ date: '2026-04-20', kg: 85 }, 'kg', 'not-an-array'), null);
  });

  test('skips entries missing the field', () => {
    const mixed = [
      { date: '2026-04-18', kg: 85 },
      { date: '2026-04-19' },              // no kg
      { date: '2026-04-20', kg: 87 },
    ];
    const t = computeTrend(mixed[2], 'kg', mixed);
    assert.equal(t.dir, 'up');
    assert.equal(t.delta, 2);
    assert.equal(t.prev.date, '2026-04-18', 'should skip the dateless-kg entry and go back two days');
  });

  test('finds closest-prior date, not earliest', () => {
    const manyRows = [
      { date: '2026-01-01', kg: 100 },
      { date: '2026-03-15', kg: 90 },
      { date: '2026-04-15', kg: 85 },
      { date: '2026-04-20', kg: 86 },
    ];
    const t = computeTrend(manyRows[3], 'kg', manyRows);
    assert.equal(t.prev.date, '2026-04-15', 'should pick closest prior, not first');
  });

  test('handles future-sorted vs past-sorted input identically', () => {
    const ascending = [
      { date: '2026-04-18', kg: 85 },
      { date: '2026-04-19', kg: 86 },
      { date: '2026-04-20', kg: 85.5 },
    ];
    const descending = [...ascending].reverse();
    const tAsc = computeTrend(ascending[2], 'kg', ascending);
    const tDesc = computeTrend(descending[0], 'kg', descending);
    assert.equal(tAsc.dir, tDesc.dir);
    assert.equal(tAsc.delta, tDesc.delta);
  });
});
