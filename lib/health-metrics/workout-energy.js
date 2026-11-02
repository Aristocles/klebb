// SPDX-License-Identifier: AGPL-3.0-only
'use strict';

const { toKcal } = require('../../health-auto-export/helpers');

const definition = Object.freeze({
  quantity: 'energy',
  kind: 'active',
  canonicalUnit: 'kcal',
  statistic: 'interval-total',
  calendarPolicy: 'caller-selected-date',
  mappingVersion: 1,
  rowRounding: 'nearest-whole-calorie-per-session',
});

function toKilocalories(kind, quantity, unit) {
  if (kind !== 'active' || (unit !== 'kcal' && unit !== 'kJ')) return null;
  if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity < 0) return null;
  const kcal = toKcal(quantity, unit);
  return Number.isFinite(kcal) ? kcal : null;
}

function numericQuantity(value) {
  if (typeof value === 'string') {
    if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) return null;
    if (value.startsWith('-') && /[1-9]/.test(value.split(/[eE]/, 1)[0])) return null;
    value = Number(value);
  }
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function row(kind, value, unit, date, mappingVersion) {
  if (mappingVersion !== 1 || typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const day = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== date) return null;
  const quantity = numericQuantity(value);
  if (quantity === null) return null;
  const kcal = toKilocalories(kind, quantity, unit);
  // Match the existing workout row: actual zero is omitted; a positive
  // fraction may round to zero. Calendar and session association are caller-owned.
  return kcal !== null && kcal > 0 ? { date, calories: Math.round(kcal) } : null;
}

function fromHae(kind, field, date, mappingVersion = 1) {
  return row(kind, field?.qty, field?.units, date, mappingVersion);
}

function fromHealthConnect(recordType, record, date, mappingVersion = 1) {
  if (recordType !== 'ActiveCaloriesBurnedRecord' || record?.energy?.unit !== 'kcal') return null;
  return row('active', record.energy.value, 'kcal', date, mappingVersion);
}

module.exports = { definition, toKilocalories, fromHae, fromHealthConnect };
