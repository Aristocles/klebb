// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/health-auto-export.samples.test.js
//
// The deduplicated sample store that replaced the raw-file archive (#546).
//
// Every assertion here is aimed at a way this can lose data silently. The
// store is the ONLY home for the metrics with no catalogue entry, so a bug
// that drops or collapses samples has no second copy to recover from.

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let tmp;
let dbFile;
let samples;

function fresh() {
  delete require.cache[require.resolve('../config/paths')];
  delete require.cache[require.resolve('../health-auto-export/samples')];
  delete require.cache[require.resolve('../health-auto-export/helpers')];
  samples = require('../health-auto-export/samples');
}

function metricPush(name, data, extra = {}) {
  return { data: { metrics: [{ name, ...extra, data }] } };
}

describe('HAE sample store', () => {
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'klebb-samples-'));
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

  test('an identical re-send stores nothing new', () => {
    const push = metricPush('step_count', [
      { date: '2026-05-06 08:00:00 +1000', qty: 4200, source: 'iPhone' },
    ]);
    const first = samples.recordPush(push, { receivedAt: 't1', dbFile });
    assert.equal(first.inserted, 1);

    const second = samples.recordPush(push, { receivedAt: 't2', dbFile });
    assert.equal(second.seen, 1, 'the payload still carried the sample');
    assert.equal(second.inserted, 0, 'but it was already stored');
    assert.equal(samples.sampleCount({ dbFile }), 1);
    // Both pushes are recorded even though the second added no samples: push
    // identity is what replay groups by.
    assert.equal(samples.pushCount({ dbFile }), 2);
  });

  test('key order does not defeat dedupe', () => {
    // HAE serialises the same sample with different key order between pushes.
    // On raw strings this produced a 68% false-conflict rate; canonicalising
    // the keys before hashing takes it to zero.
    samples.recordPush(metricPush('step_count', [
      { date: '2026-05-06', qty: 4200, source: 'iPhone' },
    ]), { receivedAt: 't1', dbFile });
    samples.recordPush(metricPush('step_count', [
      { source: 'iPhone', qty: 4200, date: '2026-05-06' },
    ]), { receivedAt: 't2', dbFile });

    assert.equal(samples.sampleCount({ dbFile }), 1,
      'permuted keys stored a second copy of the same sample');
  });

  test('nested key order does not defeat dedupe either', () => {
    samples.recordPush({ data: { workouts: [
      { name: 'Run', start: '2026-05-06 07:00:00 +1000',
        heartRate: { avg: 140, max: 165 } },
    ]}}, { receivedAt: 't1', dbFile });
    samples.recordPush({ data: { workouts: [
      { start: '2026-05-06 07:00:00 +1000', name: 'Run',
        heartRate: { max: 165, avg: 140 } },
    ]}}, { receivedAt: 't2', dbFile });

    assert.equal(samples.sampleCount({ dbFile }), 1,
      'canonicalisation is not recursive: a nested object defeated the dedupe');
  });

  test('two distinct samples at the same minute and source both survive', () => {
    // The trap that makes a `metric|date|source` composite key wrong: Apple
    // Health really does emit several samples with the same timestamp from the
    // same device, and a composite key would keep only the last.
    samples.recordPush(metricPush('heart_rate_variability', [
      { date: '2026-05-06 08:00:00 +1000', qty: 41.2, source: 'Apple Watch' },
      { date: '2026-05-06 08:00:00 +1000', qty: 58.7, source: 'Apple Watch' },
    ]), { receivedAt: 't1', dbFile });

    assert.equal(samples.sampleCount({ dbFile }), 2,
      'two genuinely different same-minute samples collapsed into one');
  });

  test('a sample repeated within one push is counted, not collapsed', () => {
    // Content dedupe would store one row. For a sum-per-date metric that
    // silently halves the total, so the repeat count is stored.
    const r = samples.recordPush(metricPush('step_count', [
      { date: '2026-05-06', qty: 1000 },
      { date: '2026-05-06', qty: 1000 },
    ]), { receivedAt: 't1', dbFile });

    assert.equal(r.seen, 2);
    assert.equal(samples.sampleCount({ dbFile }), 1, 'stored once');
    const rows = samples.forMetric('step_count', { dbFile });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].dup_count, 2, 'the repeat was not counted');
  });

  test('full-precision qty round-trips bit-identically', () => {
    // HAE sends IEEE-754 tails like 62.00000000000001 because Apple Health
    // averages under the hood. Anything that reformats the number changes what
    // a future catalogue change would compute from it.
    const exact = 62.00000000000001;
    const tiny = 1.7976931348623157e+308;
    const negZeroish = -0.30000000000000004;
    samples.recordPush(metricPush('body_mass', [
      { date: '2026-05-06', qty: exact },
      { date: '2026-05-07', qty: tiny },
      { date: '2026-05-08', qty: negZeroish },
    ]), { receivedAt: 't1', dbFile });

    const got = samples.forMetric('body_mass', { dbFile })
      .map(r => JSON.parse(r.doc).qty);
    assert.ok(got.includes(exact), `lost precision: ${JSON.stringify(got)}`);
    assert.ok(got.includes(tiny));
    assert.ok(got.includes(negZeroish));
    // Strict identity, not approximate equality: a reformat that rounded to
    // 62 would still pass a tolerance check.
    assert.strictEqual(got.find(v => String(v).startsWith('62')), exact);
  });

  test('an uncatalogued metric is stored in full', () => {
    // 19 of the 25 metrics a real iPhone pushes have no catalogue entry. The
    // table is their only home, so a catalogued-only store would hit the size
    // target by destroying exactly the data the docs promise survives.
    const catalogue = require('../health-auto-export/catalogue');
    assert.equal(catalogue.vo2_max, undefined,
      'fixture assumes vo2_max is uncatalogued; pick another metric');

    samples.recordPush(metricPush('vo2_max', [
      { date: '2026-05-06', qty: 47.3, units: 'mL/min/kg' },
    ]), { receivedAt: 't1', dbFile });

    const rows = samples.forMetric('vo2_max', { dbFile });
    assert.equal(rows.length, 1);
    assert.deepEqual(JSON.parse(rows[0].doc),
      { date: '2026-05-06', qty: 47.3, units: 'mL/min/kg' });
  });

  test('the metric wrapper units are stored and separate samples by units', () => {
    // `data.metrics[]` carries units on the wrapper, not the sample. For an
    // uncatalogued metric that value is the difference between a right and a
    // wrong number when someone backfills it later.
    samples.recordPush(metricPush('respiratory_rate',
      [{ date: '2026-05-06', qty: 14 }], { units: 'count/min' }),
      { receivedAt: 't1', dbFile });
    samples.recordPush(metricPush('respiratory_rate',
      [{ date: '2026-05-06', qty: 14 }], { units: 'count/hr' }),
      { receivedAt: 't2', dbFile });

    assert.equal(samples.sampleCount({ dbFile }), 2,
      'a units change silently reinterpreted the earlier samples');
  });

  test('the same sample shape under two metric names does not collapse', () => {
    // {date, qty} is the shape of nearly every metric, so the metric name has
    // to be part of the key.
    samples.recordPush({ data: { metrics: [
      { name: 'step_count', data: [{ date: '2026-05-06', qty: 12 }] },
      { name: 'mindful_minutes', data: [{ date: '2026-05-06', qty: 12 }] },
    ]}}, { receivedAt: 't1', dbFile });

    assert.equal(samples.sampleCount({ dbFile }), 2);
    assert.equal(samples.forMetric('step_count', { dbFile }).length, 1);
    assert.equal(samples.forMetric('mindful_minutes', { dbFile }).length, 1);
  });

  test('workouts store under the pseudo-metric name', () => {
    samples.recordPush({ data: { workouts: [
      { name: 'Running', start: '2026-05-06 07:00:00 +1000' },
    ]}}, { receivedAt: 't1', dbFile });

    const rows = samples.forMetric('workouts', { dbFile });
    assert.equal(rows.length, 1);
    assert.equal(JSON.parse(rows[0].doc).name, 'Running');
  });

  test('a huge GPS route survives verbatim and dedupes on re-send', () => {
    // Routes were 25 MB of the archive. They are not pruned: dedupe already
    // collapses the re-sends (90 workout objects, 12 unique), and rounding
    // coordinates would be a one-way loss for a few MB.
    const route = [];
    for (let i = 0; i < 500; i++) {
      route.push({
        latitude: -33.86785 + i * 0.000001,
        longitude: 151.20732 + i * 0.000001,
        altitude: 12.3456789,
        timestamp: `2026-05-06 07:${String(i % 60).padStart(2, '0')}:00 +1000`,
      });
    }
    const push = { data: { workouts: [
      { name: 'Run', start: '2026-05-06 07:00:00 +1000', route },
    ]}};
    samples.recordPush(push, { receivedAt: 't1', dbFile });
    samples.recordPush(push, { receivedAt: 't2', dbFile });
    samples.recordPush(push, { receivedAt: 't3', dbFile });

    assert.equal(samples.sampleCount({ dbFile }), 1, 're-sent route stored again');
    const stored = JSON.parse(samples.forMetric('workouts', { dbFile })[0].doc);
    assert.equal(stored.route.length, 500);
    assert.strictEqual(stored.route[7].latitude, route[7].latitude,
      'coordinate precision was altered');
  });

  test('sourceFile makes an import idempotent', () => {
    const push = metricPush('step_count', [{ date: '2026-05-06', qty: 1 }]);
    const a = samples.recordPush(push, { receivedAt: 't1', sourceFile: 'p1.json', dbFile });
    const b = samples.recordPush(push, { receivedAt: 't1', sourceFile: 'p1.json', dbFile });

    assert.equal(a.skipped, false);
    assert.equal(b.skipped, true, 'the same archive file imported twice');
    assert.equal(samples.pushCount({ dbFile }), 1,
      'a re-imported file created a second push row, which would change replay grouping');
  });

  test('live pushes without a sourceFile are never treated as duplicates', () => {
    // source_file is NULL for live pushes and SQLite treats NULLs as distinct
    // under UNIQUE, which is the behaviour this relies on. If that were not
    // true, the second live push of an instance would be dropped.
    for (let i = 0; i < 3; i++) {
      samples.recordPush(metricPush('step_count', [{ date: '2026-05-06', qty: i }]),
        { receivedAt: `t${i}`, dbFile });
    }
    assert.equal(samples.pushCount({ dbFile }), 3);
    assert.equal(samples.sampleCount({ dbFile }), 3);
  });

  test('last_push follows the most recent carrier of a sample', () => {
    // The column replay groups by. If it stayed at the first sighting, a
    // re-sent running total would aggregate under the wrong push.
    const s = { date: '2026-05-06', qty: 1000 };
    samples.recordPush(metricPush('step_count', [s]), { receivedAt: 't1', dbFile });
    samples.recordPush(metricPush('step_count', [{ date: '2026-05-07', qty: 5 }]),
      { receivedAt: 't2', dbFile });
    samples.recordPush(metricPush('step_count', [s]), { receivedAt: 't3', dbFile });

    const row = samples.forMetric('step_count', { dbFile })
      .find(r => JSON.parse(r.doc).date === '2026-05-06');
    assert.equal(row.last_push, 3, 'last_push did not advance to the latest push');
  });

  test('a malformed payload records a push and no samples, without throwing', () => {
    for (const bad of [null, {}, { data: null }, { data: { metrics: 'nope' } },
      { data: { metrics: [null, { name: 'x' }, { data: [] }] } },
      { data: { workouts: 'nope' } }]) {
      const r = samples.recordPush(bad, { receivedAt: 't', dbFile });
      assert.equal(r.seen, 0);
      assert.equal(r.inserted, 0);
    }
    assert.equal(samples.sampleCount({ dbFile }), 0);
  });

  test('metricSummary reports coverage per metric', () => {
    samples.recordPush({ data: { metrics: [
      { name: 'step_count', data: [
        { date: '2026-05-01', qty: 1 }, { date: '2026-05-09', qty: 2 }] },
      { name: 'vo2_max', data: [{ date: '2026-05-04', qty: 47 }] },
    ]}}, { receivedAt: 't1', dbFile });

    const byMetric = Object.fromEntries(
      samples.metricSummary({ dbFile }).map(m => [m.metric, m]));
    assert.equal(byMetric.step_count.samples, 2);
    assert.equal(byMetric.step_count.firstDate, '2026-05-01');
    assert.equal(byMetric.step_count.lastDate, '2026-05-09');
    assert.equal(byMetric.vo2_max.samples, 1);
  });

  test('the store survives a close and reopen', () => {
    samples.recordPush(metricPush('step_count', [{ date: '2026-05-06', qty: 7 }]),
      { receivedAt: 't1', dbFile });
    samples.close();
    fresh();
    assert.equal(samples.sampleCount({ dbFile }), 1);
    // And a re-send after reopening still dedupes: the hash is stable across
    // processes, not just within one.
    samples.recordPush(metricPush('step_count', [{ date: '2026-05-06', qty: 7 }]),
      { receivedAt: 't2', dbFile });
    assert.equal(samples.sampleCount({ dbFile }), 1);
  });
});
