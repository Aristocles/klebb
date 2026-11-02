// SPDX-License-Identifier: AGPL-3.0-only
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const energy = require('../lib/health-metrics/workout-energy');
const catalogue = require('../health-auto-export/catalogue');
const date = '2040-02-03';

// Independent physical definition: 1 kcal = 4.184 kJ. Expected literals
// below are fixed separately from either adapter or the legacy converter.
test('paired active energy uses the existing rounded calories row and caller date', () => {
  const expected = { date, calories: 123 };
  const hae = { qty: '515.155', units: 'kJ' };
  const native = { startTime: '2040-02-02T23:30:00Z', startZoneOffset: '+05:45',
    energy: { unit: 'kcal', value: '123.125', sdkUnitValues: { kJ: '515.1550000811884' } } };
  const before = JSON.stringify({ hae, native });
  assert.deepEqual(energy.fromHae('active', hae, date), expected);
  assert.deepEqual(energy.fromHealthConnect('ActiveCaloriesBurnedRecord', native, date), expected);
  assert.equal(JSON.stringify({ hae, native }), before);
});

test('independent half and exact-integer fixtures retain per-session rounding', () => {
  for (const fixture of [
    { kj: '516.724', kcal: '123.5', expected: 124 },
    { kj: '1104.576', kcal: '264', expected: 264 },
    { kj: '1.046', kcal: '0.25', expected: 0 },
  ]) {
    const expected = { date, calories: fixture.expected };
    assert.deepEqual(energy.fromHae('active', { qty: fixture.kj, units: 'kJ' }, date), expected);
    assert.deepEqual(energy.fromHealthConnect('ActiveCaloriesBurnedRecord', {
      energy: { value: fixture.kcal, unit: 'kcal' },
    }, date), expected);
  }
});

test('active energy is not total energy or basal metabolic rate', () => {
  for (const kind of ['total', 'basal', undefined]) {
    assert.equal(energy.fromHae(kind, { qty: 264, units: 'kcal' }, date), null);
    assert.equal(energy.toKilocalories(kind, 264, 'kcal'), null);
  }
  for (const type of ['TotalCaloriesBurnedRecord', 'BasalMetabolicRateRecord', undefined]) {
    assert.equal(energy.fromHealthConnect(type, {
      energy: { unit: 'kcal', value: '264' }, basalMetabolicRate: { unit: 'W', value: '80.125' },
    }, date), null);
  }
});

test('the versioned adapters refuse unsupported units and malformed values', () => {
  for (const unit of [undefined, null, '', 'Wh', 'J', 'kcal/day']) {
    assert.equal(energy.fromHae('active', { qty: 264, units: unit }, date), null);
  }
  for (const unit of ['kJ', 'Wh', undefined]) {
    assert.equal(energy.fromHealthConnect('ActiveCaloriesBurnedRecord', {
      energy: { value: '264', unit },
    }, date), null);
  }
  for (const value of ['', ' ', '0x10', true, null, -1, '-1e-400', Infinity, NaN]) {
    assert.equal(energy.fromHae('active', { qty: value, units: 'kcal' }, date), null);
  }
  assert.equal(energy.fromHae('active', { qty: 0, units: 'kcal' }, date), null);
  assert.equal(energy.fromHae('active', { qty: 264, units: 'kcal' }, '2041-02-29'), null);
  assert.equal(energy.fromHae('active', { qty: 264, units: 'kcal' }, date, 2), null);
});

test('direct catalogue seam preserves legacy unknown unitless and bare HAE values', () => {
  for (const fixture of [
    { field: { qty: 250, units: 'Wh' }, calories: 250 },
    { field: { qty: 250, units: 'J' }, calories: 250 },
    { field: { qty: '120' }, calories: 120 },
    { field: 120, calories: 120 },
    { field: { qty: '0x10', units: 'unknown' }, calories: 16 },
    { field: { qty: true, units: 'unknown' }, calories: 1 },
    { field: { qty: 516.724, units: 'kJ' }, calories: 124 },
  ]) {
    const input = { name: 'Synthetic session', start: `${date} 09:30:00 +0545`,
      activeEnergyBurned: fixture.field };
    const before = JSON.stringify(input);
    assert.deepEqual(catalogue.workouts.row(input), {
      date, trained: true, type: 'Synthetic session', calories: fixture.calories, startTime: '09:30',
    });
    assert.equal(JSON.stringify(input), before);
  }
});

test('the immutable definition names quantity kind unit calendar and version', () => {
  assert.deepEqual(energy.definition, {
    quantity: 'energy', kind: 'active', canonicalUnit: 'kcal', statistic: 'interval-total',
    calendarPolicy: 'caller-selected-date', mappingVersion: 1,
    rowRounding: 'nearest-whole-calorie-per-session',
  });
  assert.ok(Object.isFrozen(energy.definition));
});
