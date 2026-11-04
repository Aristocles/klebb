// SPDX-License-Identifier: AGPL-3.0-only
'use strict';

const bodyMass = require('./body-mass');

function validDate(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const value = Date.parse(`${date}T00:00:00.000Z`);
  return Number.isFinite(value) && new Date(value).toISOString().slice(0, 10) === date;
}

// Pure display rows: callers supply the selected date and authenticated history.
// These values do not establish permission, completeness or a saved projection.
function mapHealthConnectRow(recordType, record, date, mappingVersion = 1) {
  if (recordType === 'WeightRecord') {
    return bodyMass.fromHealthConnect(recordType, record, date, mappingVersion);
  }
  if (recordType !== 'StepsRecord' || mappingVersion !== 1 || !validDate(date)
      || typeof record?.count !== 'string' || !/^(0|[1-9]\d{0,18})$/.test(record.count)) return null;
  const count = BigInt(record.count);
  if (count > 9223372036854775807n || count > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return { date, count: Number(count) };
}

// Inputs are already selected daily rows, not a bag of every producer or push.
// Keep legacy HAE values; select exactly one provider on either side of the date.
function selectDisplayRows(metric, haeRows, nativeRows, switchDate) {
  const field = metric === 'step_count' ? 'count' : metric === 'body_mass' ? 'kg' : null;
  if (!field || !validDate(switchDate) || !Array.isArray(haeRows) || !Array.isArray(nativeRows)) {
    throw new TypeError('invalid selected display input');
  }
  const selected = new Map();
  for (const [source, rows] of [['hae', haeRows], ['health-connect', nativeRows]]) {
    for (const row of rows) {
      if (!validDate(row?.date)) throw new TypeError('invalid selected display date');
      const eligible = source === 'hae' ? row.date < switchDate : row.date >= switchDate;
      if (!eligible) continue;
      const value = row[field];
      if (typeof value !== 'number' || !Number.isFinite(value)
          || (source === 'health-connect'
            && (value < 0 || (field === 'count' && !Number.isSafeInteger(value))))) {
        throw new TypeError('unrepresentable selected display value');
      }
      if (selected.has(row.date)) throw new TypeError('ambiguous selected daily rows');
      selected.set(row.date, { row: { date: row.date, [field]: value }, source });
    }
  }
  const dates = [...selected.keys()].sort();
  return {
    rows: dates.map(date => selected.get(date).row),
    selectedSources: dates.map(date => ({ date, source: selected.get(date).source })),
  };
}

module.exports = { mapHealthConnectRow, selectDisplayRows };
