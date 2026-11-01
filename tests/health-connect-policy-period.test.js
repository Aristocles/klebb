// SPDX-License-Identifier: AGPL-3.0-only
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyKnownPeriod } = require('../lib/health-connect/policy-period');

// Fixed nanosecond coordinates and independently chosen relation literals.
const CASES = [
  [
    "T01",
    null,
    null,
    "20",
    "UNKNOWN"
  ],
  [
    "T02",
    null,
    [
      "10",
      "30"
    ],
    "20",
    "UNKNOWN"
  ],
  [
    "T03",
    null,
    [
      "20",
      "30"
    ],
    "20",
    "UNKNOWN"
  ],
  [
    "T04",
    [
      "instant",
      "19"
    ],
    null,
    "20",
    "MATCH"
  ],
  [
    "T05",
    [
      "instant",
      "20"
    ],
    null,
    "20",
    "NO_MATCH"
  ],
  [
    "T06",
    [
      "instant",
      "21"
    ],
    null,
    "20",
    "NO_MATCH"
  ],
  [
    "T07",
    [
      "instant",
      "10"
    ],
    [
      "10",
      "30"
    ],
    "20",
    "MATCH"
  ],
  [
    "T08",
    [
      "instant",
      "9"
    ],
    [
      "10",
      "30"
    ],
    "20",
    "NO_MATCH"
  ],
  [
    "T09",
    [
      "instant",
      "15"
    ],
    [
      "10",
      "15"
    ],
    "20",
    "NO_MATCH"
  ],
  [
    "T10",
    [
      "interval",
      "0",
      "10"
    ],
    [
      "10",
      "30"
    ],
    "20",
    "NO_MATCH"
  ],
  [
    "T11",
    [
      "interval",
      "20",
      "30"
    ],
    [
      "10",
      "30"
    ],
    "20",
    "NO_MATCH"
  ],
  [
    "T12",
    [
      "interval",
      "9",
      "11"
    ],
    [
      "10",
      "30"
    ],
    "20",
    "MATCH"
  ],
  [
    "T13",
    [
      "interval",
      "19",
      "21"
    ],
    [
      "10",
      "30"
    ],
    "20",
    "MATCH"
  ],
  [
    "T14",
    [
      "interval",
      "0",
      "40"
    ],
    [
      "10",
      "30"
    ],
    "20",
    "MATCH"
  ],
  [
    "T15",
    [
      "interval",
      "11",
      "12"
    ],
    [
      "10",
      "30"
    ],
    "20",
    "MATCH"
  ],
  [
    "T16",
    [
      "interval",
      "1",
      "2"
    ],
    [
      "10",
      "30"
    ],
    "20",
    "NO_MATCH"
  ],
  [
    "T17",
    [
      "interval",
      "21",
      "22"
    ],
    null,
    "20",
    "NO_MATCH"
  ],
  [
    "T18",
    [
      "interval",
      "0",
      "40"
    ],
    [
      "20",
      "30"
    ],
    "20",
    "NO_MATCH"
  ],
  [
    "T19",
    [
      "instant",
      "25"
    ],
    [
      "21",
      "30"
    ],
    "20",
    "NO_MATCH"
  ],
  [
    "T20",
    [
      "interval",
      "10",
      "11"
    ],
    [
      "10",
      "11"
    ],
    "20",
    "MATCH"
  ],
  [
    "T21",
    [
      "interval",
      "9",
      "10"
    ],
    [
      "10",
      "11"
    ],
    "20",
    "NO_MATCH"
  ],
  [
    "T22",
    [
      "instant",
      "-1"
    ],
    null,
    "0",
    "MATCH"
  ],
  [
    "T23",
    [
      "instant",
      "1767323220000000000"
    ],
    null,
    "1767323220000000000",
    "NO_MATCH"
  ],
  [
    "T24",
    [
      "instant",
      "1767323219999999999"
    ],
    null,
    "1767323220000000000",
    "MATCH"
  ]
];

function parsedPeriod(value) {
  if (value === null) return null;
  return value[0] === 'instant' ? { kind: 'instant', timeNs: BigInt(value[1]) } :
    { kind: 'interval', startNs: BigInt(value[1]), endNs: BigInt(value[2]) };
}
function parsedWindow(value) {
  return value === null ? null : { startNs: BigInt(value[0]), endNs: BigInt(value[1]) };
}

for (const [id, period, window, cutoff, expected] of CASES) {
  test(`policy period ${id}`, () => {
    const footprint = parsedPeriod(period), requested = parsedWindow(window);
    const cutoffNs = BigInt(cutoff);
    assert.equal(typeof classifyKnownPeriod, 'function');
    assert.equal(typeof cutoffNs, 'bigint');
    if (id === 'T04') {
      assert.deepEqual(footprint, { kind: 'instant', timeNs: 19n });
      assert.equal(requested, null);
      assert.equal(cutoffNs, 20n);
    }
    assert.equal(classifyKnownPeriod(footprint, requested, cutoffNs), expected,
      `${id} fixed temporal relation`);
  });
}

test('policy period P01 rejects a rounded cutoff input', () => {
  assert.throws(() => classifyKnownPeriod({ kind: 'instant', timeNs: 19n }, null, 20), TypeError);
});
test('policy period P02 requires a strictly ordered known interval', () => {
  assert.throws(() => classifyKnownPeriod({ kind: 'interval', startNs: 10n, endNs: 10n }, null, 20n), TypeError);
});
test('policy period P03 requires a strictly ordered requested interval', () => {
  assert.throws(() => classifyKnownPeriod({ kind: 'instant', timeNs: 19n },
    { startNs: 10n, endNs: 10n }, 20n), TypeError);
});

test('policy period I01 keeps a crossing lower-bound record and its metadata intact', () => {
  const footprint = Object.freeze({ kind: 'interval', startNs: 9n, endNs: 11n,
    startZoneOffset: '+11:00', endZoneOffset: null,
    samples: Object.freeze([Object.freeze({ timeNs: 10n, value: '1.25' })]) });
  const requested = Object.freeze({ startNs: 10n, endNs: 30n });
  const before = structuredClone([footprint, requested, 20n]);
  assert.equal(classifyKnownPeriod(footprint, requested, 20n), 'MATCH');
  assert.deepEqual([footprint, requested, 20n], before);
});
test('policy period I02 keeps a crossing-cutoff record and its metadata intact', () => {
  const footprint = Object.freeze({ kind: 'interval', startNs: 19n, endNs: 21n,
    startZoneOffset: null, endZoneOffset: '+11:00',
    samples: Object.freeze([Object.freeze({ timeNs: 21n, value: '2.5' })]) });
  const requested = Object.freeze({ startNs: 10n, endNs: 30n });
  const before = structuredClone([footprint, requested, 20n]);
  assert.equal(classifyKnownPeriod(footprint, requested, 20n), 'MATCH');
  assert.deepEqual([footprint, requested, 20n], before);
});
test('policy period I03 keeps missing time and an empty old intersection unchanged', () => {
  const requested = Object.freeze({ startNs: 20n, endNs: 30n });
  const before = structuredClone([null, requested, 20n]);
  assert.equal(classifyKnownPeriod(null, requested, 20n), 'UNKNOWN');
  assert.deepEqual([null, requested, 20n], before);
});
