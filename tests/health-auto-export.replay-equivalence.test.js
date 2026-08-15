// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/health-auto-export.replay-equivalence.test.js
//
// The primary safety net for #546: replaying a card from the deduplicated
// samples table must produce byte-identical rows to replaying it from the raw
// file archive it replaced.
//
// The old algorithm is reimplemented here, deliberately, as the oracle. It is
// nine lines lifted from the pre-#546 replay.js, and comparing against it is
// the only way to test "identical to what shipped" rather than "identical to
// what I now think shipped". It must not be refactored to share code with the
// implementation under test, or the test stops proving anything.
//
// Every scenario is one where a plausible-looking implementation diverges:
//   sum-per-date + re-sent running totals   -> #168, 5x step counts
//   last-per-date + intra-push order        -> wrong night's sleep
//   mean-per-date + dropped duplicates      -> wrong average
//   a sample repeated inside one push       -> halved total

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let tmp;
let dbFile;
let samples;
let replay;
let ingest;
let catalogue;

function fresh() {
  for (const m of ['../config/paths', '../health-auto-export/samples',
    '../health-auto-export/replay', '../health-auto-export/ingest',
    '../health-auto-export/catalogue', '../health-auto-export/helpers']) {
    delete require.cache[require.resolve(m)];
  }
  samples = require('../health-auto-export/samples');
  replay = require('../health-auto-export/replay');
  ingest = require('../health-auto-export/ingest');
  catalogue = require('../health-auto-export/catalogue');
}

// The pre-#546 algorithm, verbatim in behaviour: per push, map each entry
// through the catalogue, aggregate within the push, mergeByDate against the
// running state. This is the oracle.
function replayFromPayloads(pushes, metric) {
  const cat = catalogue[metric];
  let merged = [];
  for (const payload of pushes) {
    const entries = ingest.extractEntries(payload, { ...cat, _metricName: metric });
    if (!entries || entries.length === 0) continue;
    // row() takes the metric wrapper as its second argument (body_mass reads
    // `units` from it). The oracle reimplements the pre-#546 CONTROL FLOW, not
    // an older row() signature, so it has to pass the wrapper as well or it
    // would diverge on units alone.
    const wrapper = ingest.extractWrapper(payload, metric);
    const mapped = [];
    for (const raw of entries) {
      const row = cat.row(raw, wrapper);
      if (row && row.date) mapped.push(row);
    }
    if (mapped.length === 0) continue;
    merged = ingest.mergeByDate(merged, ingest.aggregate(mapped, cat.aggregate));
  }
  return merged;
}

// Record the same pushes into the table and replay from it.
function replayViaTable(pushes, metric) {
  for (let i = 0; i < pushes.length; i++) {
    samples.recordPush(pushes[i], { receivedAt: `t${i}`, dbFile });
  }
  return replay.replayMetric(metric, { dbFile }).rows;
}

function assertEquivalent(pushes, metric, label) {
  const expected = replayFromPayloads(pushes, metric);
  const actual = replayViaTable(pushes, metric);
  assert.deepStrictEqual(actual, expected,
    `${label}: table replay diverged from file replay`);
  return expected;
}

function m(name, data) {
  return { data: { metrics: [{ name, data }] } };
}

describe('replay equivalence: samples table vs raw file archive', () => {
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'klebb-equiv-'));
    process.env.HEALTH_HOME = tmp;
    process.env.HEALTH_HOME_WARNED = '1';
    dbFile = path.join(tmp, 'db', 'klebb.db');
    fresh();
  });

  afterEach(() => {
    try { samples.close(); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    delete process.env.HEALTH_HOME;
  });

  test('sum-per-date with re-sent running totals (the #168 shape)', () => {
    // Each push carries the running total for the current day. The right answer
    // is the LAST push's total, not the sum of all of them. Aggregating a flat
    // deduplicated bag gives 1000+2000+3000 = 6000.
    const pushes = [
      m('step_count', [{ date: '2026-05-09', qty: 1000 }]),
      m('step_count', [{ date: '2026-05-09', qty: 2000 }]),
      m('step_count', [{ date: '2026-05-09', qty: 3000 }]),
    ];
    const rows = assertEquivalent(pushes, 'step_count', 'running totals');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].count, 3000, 'oracle itself is wrong; fixture is broken');
  });

  test('sum-per-date where an identical total is re-sent unchanged', () => {
    // The dedupe case that matters most: push 2 and 3 are byte-identical, so
    // only one row is stored, and the stored row must still land in the LAST
    // push's group.
    const pushes = [
      m('step_count', [{ date: '2026-05-09', qty: 1000 }]),
      m('step_count', [{ date: '2026-05-09', qty: 2000 }]),
      m('step_count', [{ date: '2026-05-09', qty: 2000 }]),
    ];
    const rows = assertEquivalent(pushes, 'step_count', 'identical re-send');
    assert.equal(rows[0].count, 2000);
    assert.equal(samples.sampleCount({ dbFile }), 2, 'expected the re-send to dedupe');
  });

  test('sum-per-date across several days with an overlapping window', () => {
    // The real HAE pattern: a rolling window that re-sends settled days
    // verbatim and revises the current one.
    const pushes = [
      m('step_count', [
        { date: '2026-05-07', qty: 8000 },
        { date: '2026-05-08', qty: 3000 },
      ]),
      m('step_count', [
        { date: '2026-05-07', qty: 8000 },
        { date: '2026-05-08', qty: 9500 },
        { date: '2026-05-09', qty: 1200 },
      ]),
      m('step_count', [
        { date: '2026-05-08', qty: 9500 },
        { date: '2026-05-09', qty: 7400 },
      ]),
    ];
    const rows = assertEquivalent(pushes, 'step_count', 'rolling window');
    const byDate = Object.fromEntries(rows.map(r => [r.date, r.count]));
    assert.deepEqual(byDate,
      { '2026-05-07': 8000, '2026-05-08': 9500, '2026-05-09': 7400 });
  });

  test('a sample repeated inside one push is summed twice', () => {
    const pushes = [
      m('step_count', [
        { date: '2026-05-09', qty: 500 },
        { date: '2026-05-09', qty: 500 },
      ]),
    ];
    const rows = assertEquivalent(pushes, 'step_count', 'intra-push repeat');
    assert.equal(rows[0].count, 1000,
      'the oracle says both copies count; the fixture is not exercising it');
  });

  test('last-per-date depends on order within a push', () => {
    // sleep_analysis keeps the last matching entry in payload order, so the
    // stored order has to be preserved exactly.
    const pushes = [
      m('sleep_analysis', [
        { date: '2026-05-09', totalSleep: 6.5, source: 'Apple Watch' },
        { date: '2026-05-09', totalSleep: 7.2, source: 'Apple Watch' },
        { date: '2026-05-09', totalSleep: 6.9, source: 'iPhone' },
      ]),
    ];
    const rows = assertEquivalent(pushes, 'sleep_analysis', 'intra-push order');
    assert.equal(rows[0].hours, 6.9, 'fixture no longer distinguishes order');
    assert.equal(rows[0].source, 'iPhone');
  });

  test('last-per-date order is payload order, not any content order', () => {
    // The previous test passed even with within-push ordering broken, because
    // its values happened to sort the same way as the payload listed them.
    // Here the winning entry sorts FIRST by every content-derived order
    // (numerically and as JSON text), so anything other than true payload
    // order picks 8.5 instead of 1.5.
    const pushes = [
      m('sleep_analysis', [
        { date: '2026-05-09', totalSleep: 8.5 },
        { date: '2026-05-09', totalSleep: 1.5 },
      ]),
    ];
    const rows = assertEquivalent(pushes, 'sleep_analysis', 'payload order');
    assert.equal(rows[0].hours, 1.5,
      'the fixture no longer distinguishes payload order from content order');
  });

  test('last-per-date across pushes with a revision', () => {
    const pushes = [
      m('sleep_analysis', [{ date: '2026-05-09', totalSleep: 6.5 }]),
      m('sleep_analysis', [{ date: '2026-05-09', totalSleep: 7.2 }]),
      m('sleep_analysis', [
        { date: '2026-05-09', totalSleep: 7.2 },
        { date: '2026-05-10', totalSleep: 8.1 },
      ]),
    ];
    const rows = assertEquivalent(pushes, 'sleep_analysis', 'cross-push revision');
    assert.equal(rows.length, 2);
  });

  test('mean-per-date over many same-day samples', () => {
    const pushes = [
      m('heart_rate_variability', [
        { date: '2026-05-09 02:00:00 +1000', qty: 40 },
        { date: '2026-05-09 03:00:00 +1000', qty: 50 },
      ]),
      m('heart_rate_variability', [
        { date: '2026-05-09 02:00:00 +1000', qty: 40 },
        { date: '2026-05-09 03:00:00 +1000', qty: 50 },
        { date: '2026-05-09 04:00:00 +1000', qty: 90 },
      ]),
    ];
    const rows = assertEquivalent(pushes, 'heart_rate_variability', 'mean');
    assert.equal(rows[0].ms, 60, 'expected the mean of the LAST push (40,50,90)');
  });

  test('mean-per-date where two same-minute samples share a value', () => {
    // Two identical samples in one push: content dedupe stores one row, and
    // the mean must still be over both.
    const pushes = [
      m('heart_rate_variability', [
        { date: '2026-05-09 02:00:00 +1000', qty: 40 },
        { date: '2026-05-09 02:00:00 +1000', qty: 40 },
        { date: '2026-05-09 03:00:00 +1000', qty: 100 },
      ]),
    ];
    const rows = assertEquivalent(pushes, 'heart_rate_variability', 'dup in mean');
    assert.equal(rows[0].ms, 60, 'the duplicate was not counted (40+40+100)/3');
  });

  test('max-per-date and boolean-any strategies', () => {
    // Exercises the remaining aggregate branches through whichever catalogue
    // entries use them, so a strategy is not left unproven.
    const strategies = new Map();
    for (const [key, entry] of Object.entries(catalogue)) {
      if (!strategies.has(entry.aggregate)) strategies.set(entry.aggregate, key);
    }
    // Every strategy the catalogue actually uses gets at least one equivalence
    // check, so adding a metric with a new strategy fails loudly here rather
    // than silently shipping an unverified path.
    for (const [strategy, metric] of strategies) {
      if (catalogue[metric].from === 'workouts') continue;
      const pushes = [
        m(metric, [
          { date: '2026-05-09', qty: 10, totalSleep: 6, systolic: 120, diastolic: 80 },
          { date: '2026-05-09', qty: 30, totalSleep: 7, systolic: 130, diastolic: 85 },
        ]),
        m(metric, [
          { date: '2026-05-09', qty: 30, totalSleep: 7, systolic: 130, diastolic: 85 },
          { date: '2026-05-10', qty: 20, totalSleep: 8, systolic: 118, diastolic: 78 },
        ]),
      ];
      // Fresh database per strategy so metrics do not interfere.
      samples.close();
      fs.rmSync(path.join(tmp, 'db'), { recursive: true, force: true });
      assertEquivalent(pushes, metric, `strategy ${strategy}`);
    }
  });

  test('workouts merge per date, including a same-day second session', () => {
    const pushes = [
      { data: { workouts: [
        { name: 'Running', start: '2026-05-09 07:00:00 +1000', duration: 1800,
          distance: { qty: 5, units: 'km' }, activeEnergyBurned: { qty: 300, units: 'kcal' },
          avgHeartRate: { qty: 150 }, maxHeartRate: { qty: 175 } },
      ]}},
      { data: { workouts: [
        { name: 'Running', start: '2026-05-09 07:00:00 +1000', duration: 1800,
          distance: { qty: 5, units: 'km' }, activeEnergyBurned: { qty: 300, units: 'kcal' },
          avgHeartRate: { qty: 150 }, maxHeartRate: { qty: 175 } },
        { name: 'Walking', start: '2026-05-09 18:00:00 +1000', duration: 1200,
          distance: { qty: 1.5, units: 'km' }, avgHeartRate: { qty: 95 } },
      ]}},
    ];
    const rows = assertEquivalent(pushes, 'workouts', 'workouts merge');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].sessionCount, 2, 'fixture no longer merges two sessions');
    assert.equal(rows[0].type, 'Running, Walking');
  });

  test('a push carrying nothing for the metric does not create a group', () => {
    const pushes = [
      m('step_count', [{ date: '2026-05-09', qty: 100 }]),
      m('vo2_max', [{ date: '2026-05-09', qty: 47 }]),
      m('step_count', [{ date: '2026-05-10', qty: 200 }]),
    ];
    assertEquivalent(pushes, 'step_count', 'unrelated push');
    const r = replay.replayMetric('step_count', { dbFile });
    assert.equal(r.pushesScanned, 2, 'the vo2_max-only push was counted as a step group');
  });

  test('a malformed entry among good ones does not lose the good ones', () => {
    const pushes = [
      m('step_count', [
        { date: '2026-05-09', qty: 100 },
        { qty: 999 },                       // no date
        { date: 'not-a-date', qty: 5 },
        { date: '2026-05-10', qty: 200 },
      ]),
    ];
    const rows = assertEquivalent(pushes, 'step_count', 'malformed entries');
    assert.equal(rows.length, 2);
  });

  test('50 overlapping pushes of mixed metrics stay equivalent', () => {
    // Scale, because the divergences this test exists to catch are order- and
    // grouping-dependent and a three-push fixture can pass by luck.
    const pushes = [];
    for (let p = 0; p < 50; p++) {
      const steps = [];
      const hrv = [];
      const sleep = [];
      // A rolling 7-day window whose current day is revised each push.
      for (let d = 0; d < 7; d++) {
        const day = 10 + ((p + d) % 20);
        const date = `2026-05-${String(day).padStart(2, '0')}`;
        steps.push({ date, qty: 1000 * d + (d === 6 ? p * 7 : 0) });
        hrv.push({ date: `${date} 0${d}:00:00 +1000`, qty: 40 + ((p * d) % 25) });
        sleep.push({ date, totalSleep: 6 + ((p + d) % 4) * 0.25 });
      }
      pushes.push({ data: { metrics: [
        { name: 'step_count', data: steps },
        { name: 'heart_rate_variability', data: hrv },
        { name: 'sleep_analysis', data: sleep },
      ]}});
    }

    // Record once, then verify each metric against the oracle over the same
    // push list.
    for (let i = 0; i < pushes.length; i++) {
      samples.recordPush(pushes[i], { receivedAt: `t${i}`, dbFile });
    }
    for (const metric of ['step_count', 'heart_rate_variability', 'sleep_analysis']) {
      assert.deepStrictEqual(
        replay.replayMetric(metric, { dbFile }).rows,
        replayFromPayloads(pushes, metric),
        `${metric} diverged at scale`);
    }
    // And the dedupe is doing real work at this scale, otherwise the test is
    // just replaying 50 disjoint pushes.
    const stored = samples.sampleCount({ dbFile });
    const sent = 50 * 21;
    assert.ok(stored < sent * 0.5,
      `expected heavy dedupe, stored ${stored} of ${sent} sent`);
  });

  test('an uncatalogued metric replays as null rather than throwing', () => {
    samples.recordPush(m('vo2_max', [{ date: '2026-05-09', qty: 47 }]),
      { receivedAt: 't1', dbFile });
    const r = replay.replayMetric('vo2_max', { dbFile });
    assert.equal(r.rows, null);
    assert.equal(r.pushesScanned, 0);
  });
});
