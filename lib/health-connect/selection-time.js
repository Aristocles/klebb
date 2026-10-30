// SPDX-License-Identifier: AGPL-3.0-only
'use strict';

// Proleptic Gregorian days and nanoseconds; no millisecond rounding or zone inference.
function instant(value, canonical = false) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 64) return null;
  const m = /^([+-]?\d{4,10})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d{1,9}))?Z$/.exec(value);
  if (!m || m[0] !== value) return null;
  let year = BigInt(m[1]);
  const month = Number(m[2]), day = Number(m[3]), fraction = m[7] || '';
  const leap = year % 4n === 0n && (year % 100n !== 0n || year % 400n === 0n);
  if (year < -1000000000n || year > 1000000000n || month < 1 || month > 12 ||
      day < 1 || day > [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]) return null;
  if (canonical) {
    const digits = (year < 0n ? -year : year).toString().padStart(4, '0');
    const spelling = (year < 0n ? '-' : year > 9999n ? '+' : '') + digits;
    if (m[1] !== spelling || (fraction && fraction.endsWith('0'))) return null;
  }
  year -= month <= 2 ? 1n : 0n;
  const era = (year - (year < 0n ? 399n : 0n)) / 400n;
  const y = year - era * 400n, shifted = BigInt(month + (month > 2 ? -3 : 9));
  const days = era * 146097n + y * 365n + y / 4n - y / 100n +
    (153n * shifted + 2n) / 5n + BigInt(day) - 1n - 719468n;
  return ((days * 24n + BigInt(m[4])) * 3600n + BigInt(m[5]) * 60n + BigInt(m[6])) *
    1000000000n + BigInt(fraction.padEnd(9, '0'));
}

module.exports = { instant };
