// SPDX-License-Identifier: AGPL-3.0-only
'use strict';

const definition = Object.freeze({
  id: 'body-mass',
  quantity: 'mass',
  canonicalUnit: 'kg',
  mappingVersion: 1,
  calendarPolicy: 'caller-selected-date',
  statistic: 'point',
});

// Exact physical ratios, with a common denominator of 100000000.
const unitNumerators = Object.freeze({
  kg: 100000000n,
  lb: 45359237n,
  lbs: 45359237n,
  st: 635029318n,
  stone: 635029318n,
});

function toKilograms(quantity, unit) {
  // Use the accepted Number's decimal representation, then round only once
  // when producing the Number row value. No display precision is imposed here.
  const [mantissa, exponent = '0'] = String(quantity).split('e');
  const [integer, fraction = ''] = mantissa.split('.');
  const coefficient = BigInt(integer + fraction) * unitNumerators[unit];
  return Number(`${coefficient}e${Number(exponent) - fraction.length - 8}`);
}

function validDate(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const milliseconds = Date.parse(`${date}T00:00:00.000Z`);
  return Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString().slice(0, 10) === date;
}

function numericQuantity(value) {
  if (typeof value === 'string') {
    if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) return null;
    // A negative nonzero decimal can become -0 when coerced to Number.
    if (value.startsWith('-') && /[1-9]/.test(value.split(/[eE]/, 1)[0])) return null;
    value = Number(value);
  }
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value : null;
}

// Dates are selected by the caller's calendar policy. This adapter neither
// selects sources nor writes cards, and it does not infer a day from timestamps.
function row(value, unit, date, mappingVersion) {
  if (mappingVersion !== definition.mappingVersion || !validDate(date)) return null;
  if (typeof unit !== 'string' || !Object.hasOwn(unitNumerators, unit)) return null;
  const quantity = numericQuantity(value);
  if (quantity === null) return null;
  const kg = toKilograms(quantity, unit);
  return Number.isFinite(kg) ? { date, kg } : null;
}

function fromHae(entry, units, date, mappingVersion = 1) {
  return row(entry?.qty, units, date, mappingVersion);
}

function fromHealthConnect(recordType, record, date, mappingVersion = 1) {
  if (recordType !== 'WeightRecord' || record?.weight?.unit !== 'kg') return null;
  return row(record.weight.value, 'kg', date, mappingVersion);
}

module.exports = { definition, fromHae, fromHealthConnect };
