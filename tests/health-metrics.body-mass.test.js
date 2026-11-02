// SPDX-License-Identifier: AGPL-3.0-only
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { definition, fromHae, fromHealthConnect } = require('../lib/health-metrics/body-mass');

test('body-mass mapping publishes its immutable version and explicit calendar contract', () => {
  assert.deepEqual(definition, {
    id: 'body-mass',
    quantity: 'mass',
    canonicalUnit: 'kg',
    mappingVersion: 1,
    calendarPolicy: 'caller-selected-date',
    statistic: 'point',
  });
  assert.ok(Object.isFrozen(definition));
});

test('invented HAE pounds and Health Connect kilograms produce the same precise card row', () => {
  // Independently fixed physical definition: 1 lb = 0.45359237 kg.
  const expected = { date: '2040-02-03', kg: 45.359237 };
  const hae = { date: '2040-02-02 23:30:00 +0000', qty: 100 };
  const native = {
    time: '2040-02-02T23:30:00Z',
    zoneOffset: '+05:45',
    weight: { unit: 'kg', value: '45.359237' },
  };
  const before = JSON.stringify({ hae, native });
  assert.deepEqual(fromHae(hae, 'lb', expected.date), expected);
  assert.deepEqual(fromHealthConnect('WeightRecord', native, expected.date), expected);
  assert.equal(JSON.stringify({ hae, native }), before);
});

test('invented stones and native kilograms preserve a leap-day row without display rounding', () => {
  // Independently fixed physical definition: 1 stone = 6.35029318 kg.
  const expected = { date: '2040-02-29', kg: 63.5029318 };
  for (const units of ['st', 'stone']) {
    assert.deepEqual(fromHae({ qty: 10 }, units, expected.date), expected);
  }
  assert.deepEqual(fromHealthConnect('WeightRecord', {
    weight: { unit: 'kg', value: '63.5029318' },
  }, expected.date), expected);
});

test('kilograms, pounds aliases and zero retain the date/kg row shape', () => {
  assert.deepEqual(fromHae({ qty: '51.125' }, 'kg', '2040-02-03'),
    { date: '2040-02-03', kg: 51.125 });
  assert.deepEqual(fromHae({ qty: 100 }, 'lbs', '2040-02-03'),
    { date: '2040-02-03', kg: 45.359237 });
  assert.deepEqual(fromHae({ qty: 0 }, 'kg', '2040-02-03'),
    { date: '2040-02-03', kg: 0 });
});

test('ambiguous units, invalid quantities, dates and mapping versions are refused', () => {
  for (const units of [undefined, null, '', 'furlongs', '__proto__']) {
    assert.equal(fromHae({ qty: 100 }, units, '2040-02-03'), null);
  }
  for (const qty of [undefined, null, true, '', ' ', '0x10', NaN, Infinity, -1]) {
    assert.equal(fromHae({ qty }, 'kg', '2040-02-03'), null);
  }
  assert.equal(fromHae({ qty: Number.MAX_VALUE }, 'stone', '2040-02-03'), null);
  for (const date of [undefined, '2041-02-29', '2040-13-03', '2040-02-30', '2040-2-3']) {
    assert.equal(fromHae({ qty: 100 }, 'lb', date), null);
  }
  for (const version of [0, 2, '1', null]) {
    assert.equal(fromHae({ qty: 100 }, 'lb', '2040-02-03', version), null);
  }
});

test('native adapter refuses other quantities and units rather than guessing body mass', () => {
  const record = { weight: { unit: 'kg', value: '45.359237' } };
  for (const type of ['BoneMassRecord', 'LeanBodyMassRecord', 'BodyWaterMassRecord', undefined]) {
    assert.equal(fromHealthConnect(type, record, '2040-02-03'), null);
  }
  assert.equal(fromHealthConnect('WeightRecord', { mass: record.weight }, '2040-02-03'), null);
  assert.equal(fromHealthConnect('WeightRecord', {
    weight: { unit: 'lb', value: '100' },
  }, '2040-02-03'), null);
});

test('HAE refuses mathematically negative nonzero decimals before Number underflow', () => {
  // 10^-400 is below half the smallest positive binary64 subnormal.
  for (const qty of ['-1e-400', '-1E-400', '-0.01e-400', '-.0001E-400', '-1e-4']) {
    assert.equal(fromHae({ qty }, 'kg', '2040-02-03'), null);
  }
});

test('native body mass refuses negative nonzero scientific decimals before coercion', () => {
  for (const value of ['-1e-400', '-1E-400', '-0.01e-400', '-.0001E-400', '-1e-4']) {
    assert.equal(fromHealthConnect('WeightRecord', {
      weight: { unit: 'kg', value },
    }, '2040-02-03'), null);
  }
});

test('accepted zero and positive Number precision remain unchanged at both adapters', () => {
  const zero = { date: '2040-02-03', kg: 0 };
  for (const value of ['0', '-0', '-0.000', '-.0E-9999', '-000.000e400', -0, '1e-400']) {
    assert.deepEqual(fromHae({ qty: value }, 'kg', zero.date), zero);
    assert.deepEqual(fromHealthConnect('WeightRecord', {
      weight: { unit: 'kg', value },
    }, zero.date), zero);
  }
  for (const value of ['1e2', '1E2']) {
    assert.deepEqual(fromHae({ qty: value }, 'lb', zero.date),
      { date: zero.date, kg: 45.359237 });
    assert.deepEqual(fromHealthConnect('WeightRecord', {
      weight: { unit: 'kg', value },
    }, zero.date), { date: zero.date, kg: 100 });
  }
  for (const value of [-1, -0.0001, NaN]) {
    assert.equal(fromHae({ qty: value }, 'kg', zero.date), null);
    assert.equal(fromHealthConnect('WeightRecord', {
      weight: { unit: 'kg', value },
    }, zero.date), null);
  }
});
