// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/health-auto-export.samples-export.test.js
//
// HAE history has to survive a portable export (#546).
//
// The samples table lives inside klebb.db, and the export path deliberately
// never stages db/ (a live WAL copy can be torn, and the staged tree is handed
// to a customer, so credentials and sessions must not be in it: pinned by the
// portal's own contract test downstream). So the history is exported as
// payloads and re-imported through the ordinary ingest path.
//
// The property that matters is not "the file exists" but "a card replays to the
// same rows after a round trip". That is what a customer restoring an archive
// actually cares about.

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let tmp;
let dbFile;
let samples;
let replay;

function fresh() {
  for (const m of ['../config/paths', '../health-auto-export/samples',
    '../health-auto-export/replay', '../health-auto-export/ingest',
    '../health-auto-export/catalogue', '../health-auto-export/helpers']) {
    delete require.cache[require.resolve(m)];
  }
  samples = require('../health-auto-export/samples');
  replay = require('../health-auto-export/replay');
}

function m(name, data, extra = {}) {
  return { data: { metrics: [{ name, ...extra, data }] } };
}

// A history with every property that could be lost in a round trip: overlapping
// running totals, an intra-push repeat, two same-minute samples, an
// uncatalogued metric, wrapper units, workouts, and full float precision.
function seedHistory() {
  const pushes = [
    { data: { metrics: [
      { name: 'step_count', data: [
        { date: '2026-05-07', qty: 8000 },
        { date: '2026-05-08', qty: 3000 },
      ]},
      { name: 'heart_rate_variability', data: [
        { date: '2026-05-07 02:00:00 +1000', qty: 41.20000000000001 },
        { date: '2026-05-07 02:00:00 +1000', qty: 58.7 },
      ]},
    ]}},
    { data: { metrics: [
      { name: 'step_count', data: [
        { date: '2026-05-08', qty: 9500 },
        { date: '2026-05-09', qty: 1200 },
        { date: '2026-05-09', qty: 1200 },
      ]},
      { name: 'vo2_max', units: 'mL/min/kg', data: [
        { date: '2026-05-08', qty: 47.3 },
      ]},
      { name: 'sleep_analysis', data: [
        { date: '2026-05-08', totalSleep: 8.5 },
        { date: '2026-05-08', totalSleep: 6.25 },
      ]},
    ], workouts: [
      { name: 'Running', start: '2026-05-08 07:00:00 +1000', duration: 1800,
        route: [{ latitude: -33.86785123456789, longitude: 151.20732, altitude: 12.3 }] },
    ]}},
    m('step_count', [{ date: '2026-05-09', qty: 7400 }]),
  ];
  for (let i = 0; i < pushes.length; i++) {
    samples.recordPush(pushes[i], { receivedAt: `2026-05-0${7 + i}T00:00:00.000Z`, dbFile });
  }
}

describe('HAE sample history survives a portable export', () => {
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'klebb-hae-export-'));
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

  test('every catalogued metric replays identically after an export round trip', () => {
    seedHistory();
    const metrics = ['step_count', 'heart_rate_variability', 'sleep_analysis', 'workouts'];
    const before = {};
    for (const metric of metrics) {
      before[metric] = replay.replayMetric(metric, { dbFile }).rows;
    }
    const exported = samples.exportPushes({ dbFile });
    const beforeCount = samples.sampleCount({ dbFile });
    samples.close();

    // A genuinely fresh instance: new database file, nothing carried over.
    const restoredDb = path.join(tmp, 'restored', 'klebb.db');
    fresh();
    const r = samples.importPushes(exported, { dbFile: restoredDb });
    assert.equal(r.pushes, exported.length);

    assert.equal(samples.sampleCount({ dbFile: restoredDb }), beforeCount,
      'the restored instance holds a different number of samples');
    for (const metric of metrics) {
      assert.deepStrictEqual(
        replay.replayMetric(metric, { dbFile: restoredDb }).rows,
        before[metric],
        `${metric} did not survive the round trip`);
    }
  });

  test('an uncatalogued metric survives the round trip with its units', () => {
    // The whole reason the store keeps uncatalogued metrics: they have no other
    // home. An export that dropped them would quietly break the promise.
    seedHistory();
    const exported = samples.exportPushes({ dbFile });
    samples.close();

    const restoredDb = path.join(tmp, 'restored2', 'klebb.db');
    fresh();
    samples.importPushes(exported, { dbFile: restoredDb });

    const rows = samples.forMetric('vo2_max', { dbFile: restoredDb });
    assert.equal(rows.length, 1, 'vo2_max was lost in the export');
    assert.deepEqual(JSON.parse(rows[0].doc), { date: '2026-05-08', qty: 47.3 });
    assert.deepEqual(JSON.parse(rows[0].metric_meta), { units: 'mL/min/kg' },
      'the wrapper units were lost, so a later backfill would use the wrong scale');
  });

  test('float precision and intra-push repeats survive', () => {
    seedHistory();
    const exported = samples.exportPushes({ dbFile });
    samples.close();

    const restoredDb = path.join(tmp, 'restored3', 'klebb.db');
    fresh();
    samples.importPushes(exported, { dbFile: restoredDb });

    const hrv = samples.forMetric('heart_rate_variability', { dbFile: restoredDb })
      .map(r => JSON.parse(r.doc).qty);
    assert.ok(hrv.includes(41.20000000000001), `precision lost: ${JSON.stringify(hrv)}`);

    const dup = samples.forMetric('step_count', { dbFile: restoredDb })
      .find(r => JSON.parse(r.doc).qty === 1200);
    assert.equal(dup.dup_count, 2, 'the intra-push repeat was flattened');
  });

  test('re-importing the same export adds nothing', () => {
    seedHistory();
    const exported = samples.exportPushes({ dbFile });
    const count = samples.sampleCount({ dbFile });

    const second = samples.importPushes(exported, { dbFile });
    assert.equal(second.inserted, 0, 'a re-import stored samples again');
    assert.equal(samples.sampleCount({ dbFile }), count);
  });

  test('an empty history exports as an empty list', () => {
    assert.deepEqual(samples.exportPushes({ dbFile }), []);
  });

  test('a push that carried nothing is not exported as an empty payload', () => {
    // recordPush records the push row even when the payload had no samples
    // (it is a real event, and diagnostics report it). Exporting it would
    // create a payload with no data, which on re-import would consume a push
    // number and shift the grouping of everything after it.
    samples.recordPush({ data: { metrics: [] } }, { receivedAt: 't0', dbFile });
    samples.recordPush(m('step_count', [{ date: '2026-05-09', qty: 10 }]),
      { receivedAt: 't1', dbFile });

    const exported = samples.exportPushes({ dbFile });
    assert.equal(exported.length, 1, 'an empty push was exported');
    assert.ok(exported[0].payload.data.metrics.length > 0);
  });

  test('the streamed export yields exactly what the array form returns (#655)', () => {
    seedHistory();
    const array = samples.exportPushes({ dbFile });
    const streamed = [...samples.exportPushesStream({ dbFile })];
    assert.ok(array.length > 0, 'fixture produced no pushes');
    assert.deepStrictEqual(streamed, array);
  });

  test('the per-push walk runs on the index, not a table scan (#655)', () => {
    // Structural: without idx_hae_samples_last_push every push costs a full
    // scan and a big export goes quadratic. EXPLAIN QUERY PLAN is stable
    // enough to pin the access path.
    seedHistory();
    samples.close();
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbFile, { readOnly: true });
    try {
      const plan = db.prepare(
        'EXPLAIN QUERY PLAN SELECT metric, metric_meta, doc, dup_count '
        + 'FROM hae_samples WHERE last_push = ? ORDER BY push_ord').all(1);
      const detail = plan.map(r => r.detail).join('; ');
      assert.match(detail, /USING INDEX idx_hae_samples_last_push/, detail);
    } finally {
      db.close();
    }
  });
});
