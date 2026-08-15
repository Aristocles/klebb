// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/health-auto-export.replay.test.js
// Unit tests for the replay module.
//
// Since #546 the source of truth is the deduplicated samples table rather than
// a directory of archived payload files, so each fixture records a push through
// the same path the live endpoint uses. The assertions are unchanged: they are
// about replay semantics, which the storage swap must not alter.

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let tmp;
let replay;
let samples;

function reloadModule() {
  delete require.cache[require.resolve('../config/paths')];
  delete require.cache[require.resolve('../health-auto-export/replay')];
  delete require.cache[require.resolve('../health-auto-export/samples')];
  delete require.cache[require.resolve('../health-auto-export/ingest')];
  delete require.cache[require.resolve('../health-auto-export/catalogue')];
  delete require.cache[require.resolve('../health-auto-export/helpers')];
  replay = require('../health-auto-export/replay');
  samples = require('../health-auto-export/samples');
}

// Minimal registry stub with data() + get() + writeData() + list().
function makeRegistry(manifests) {
  const state = new Map();
  for (const m of manifests) state.set(m.id, { ...m, data: m.data ?? [] });
  return {
    list() {
      return [...state.values()].map(e => ({ id: e.id, meta: e.meta }));
    },
    get(id) {
      const e = state.get(id);
      if (!e) return null;
      return { meta: e.meta, data: e.data, description: null, schema: null, version: 'klebb.datafile.v1' };
    },
    data(id) {
      const e = state.get(id);
      return e ? e.data : null;
    },
    writeData(id, rows) {
      const e = state.get(id);
      if (!e) throw new Error(`unknown: ${id}`);
      e.data = rows;
    },
    _snapshot(id) { return state.get(id)?.data; },
  };
}

// Record a push the way the live endpoint does. Named for what it replaces so
// the fixtures below read the same as they did against the file archive; the
// stamp is the push's receivedAt, and push order follows call order.
function writeRawPayload(stampMs, payload) {
  samples.recordPush(payload, {
    receivedAt: new Date(stampMs).toISOString(),
  });
}

describe('replayFromArchive', () => {
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eh-replay-'));
    process.env.HEALTH_HOME = tmp;
    process.env.HEALTH_HOME_WARNED = '1';
    reloadModule();
  });

  afterEach(() => {
    try { samples.close(); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    delete process.env.HEALTH_HOME;
  });

  test('no archive: zero rows, no writes', () => {
    const reg = makeRegistry([
      { id: 'steps', meta: { id: 'steps', ingest: { source: 'hae', metric: 'step_count' } } },
    ]);
    const r = replay.replayFromArchive(reg, 'steps');
    assert.equal(r.rowsWritten, 0);
    assert.equal(r.pushesScanned, 0);
    assert.equal(r.skipped, false);
    assert.deepEqual(reg._snapshot('steps'), []);
  });

  test('single archived push: replays into empty subscriber', () => {
    writeRawPayload(Date.parse('2026-05-06T00:00:00Z'), { data: { metrics: [
      { name: 'step_count', data: [{ date: '2026-05-06 08:00:00 +1000', qty: 4200 }] },
    ]}});

    const reg = makeRegistry([
      { id: 'steps', meta: { id: 'steps', ingest: { source: 'hae', metric: 'step_count' } } },
    ]);
    const r = replay.replayFromArchive(reg, 'steps');
    assert.equal(r.rowsWritten, 1);
    assert.equal(r.pushesScanned, 1);
    assert.equal(r.skipped, false);
    const rows = reg._snapshot('steps');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].count, 4200);
  });

  test('multiple pushes merge by date: later push replaces earlier for same date', () => {
    // Push 1: today's running total is 4200.
    writeRawPayload(Date.parse('2026-05-06T00:00:00Z'), { data: { metrics: [
      { name: 'step_count', data: [{ date: '2026-05-06', qty: 4200 }] },
    ]}});
    // Push 2: HAE re-sends today as 8000 (later running total) and adds 2026-05-07.
    writeRawPayload(Date.parse('2026-05-07T00:00:00Z'), { data: { metrics: [
      { name: 'step_count', data: [
        { date: '2026-05-06', qty: 8000 },
        { date: '2026-05-07', qty: 7700 },
      ]},
    ]}});

    const reg = makeRegistry([
      { id: 'steps', meta: { id: 'steps', ingest: { source: 'hae', metric: 'step_count' } } },
    ]);
    replay.replayFromArchive(reg, 'steps');
    const rows = reg._snapshot('steps');
    const byDate = Object.fromEntries(rows.map(r => [r.date, r.count]));
    // Per-push semantics (matching the live dispatcher): push 2's 2026-05-06
    // REPLACES push 1's, rather than being summed on top of it. Historical
    // double-summing was the root cause of #168.
    assert.equal(byDate['2026-05-06'], 8000);
    assert.equal(byDate['2026-05-07'], 7700);
  });

  test('overlapping pushes do not double-count sum-per-date metrics (#168)', () => {
    // Simulates the real-world HAE scheduled-push pattern: each push
    // contains a running-total view of today's samples. Push 1 says
    // today=1000, push 2 says today=2000, push 3 says today=2000.
    // Correct end state is 2000 (the last push wins, matching live
    // dispatch). Before #168 the flattened aggregator would sum all
    // samples across pushes and report 5000.
    writeRawPayload(Date.parse('2026-05-09T00:00:00Z'), { data: { metrics: [
      { name: 'step_count', data: [{ date: '2026-05-09', qty: 1000 }] },
    ]}});
    writeRawPayload(Date.parse('2026-05-09T06:00:00Z'), { data: { metrics: [
      { name: 'step_count', data: [{ date: '2026-05-09', qty: 2000 }] },
    ]}});
    writeRawPayload(Date.parse('2026-05-09T12:00:00Z'), { data: { metrics: [
      { name: 'step_count', data: [{ date: '2026-05-09', qty: 2000 }] },
    ]}});

    const reg = makeRegistry([
      { id: 'steps', meta: { id: 'steps', ingest: { source: 'hae', metric: 'step_count' } } },
    ]);
    replay.replayFromArchive(reg, 'steps');
    const rows = reg._snapshot('steps');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].count, 2000);
  });

  test('overlapping pushes honour last-per-date correctly for sleep_analysis', () => {
    // Push 1: initial sleep sample for the night.
    writeRawPayload(Date.parse('2026-05-09T06:00:00Z'), { data: { metrics: [
      { name: 'sleep_analysis', data: [
        { date: '2026-05-09', totalSleep: 6.5, source: 'Apple Watch' },
      ]},
    ]}});
    // Push 2: corrected/refined sample for the same night — "last wins".
    writeRawPayload(Date.parse('2026-05-09T12:00:00Z'), { data: { metrics: [
      { name: 'sleep_analysis', data: [
        { date: '2026-05-09', totalSleep: 7.2, source: 'Apple Watch' },
      ]},
    ]}});

    const reg = makeRegistry([
      { id: 'sleep', meta: { id: 'sleep', ingest: { source: 'hae', metric: 'sleep_analysis' } } },
    ]);
    replay.replayFromArchive(reg, 'sleep');
    const rows = reg._snapshot('sleep');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].hours, 7.2);
  });

  test('idempotent: skips when data is non-empty (default)', () => {
    writeRawPayload(Date.parse('2026-05-06T00:00:00Z'), { data: { metrics: [
      { name: 'step_count', data: [{ date: '2026-05-06', qty: 4200 }] },
    ]}});
    const reg = makeRegistry([
      { id: 'steps',
        meta: { id: 'steps', ingest: { source: 'hae', metric: 'step_count' } },
        data: [{ date: '2025-01-01', count: 99999 }] },
    ]);
    const r = replay.replayFromArchive(reg, 'steps');
    assert.equal(r.skipped, true);
    assert.equal(r.rowsWritten, 0);
    // Pre-existing data untouched.
    const rows = reg._snapshot('steps');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].count, 99999);
  });

  test('force: true overrides the non-empty guard and rewrites data[]', () => {
    writeRawPayload(Date.parse('2026-05-06T00:00:00Z'), { data: { metrics: [
      { name: 'step_count', data: [{ date: '2026-05-06', qty: 4200 }] },
    ]}});
    const reg = makeRegistry([
      { id: 'steps',
        meta: { id: 'steps', ingest: { source: 'hae', metric: 'step_count' } },
        data: [{ date: '2025-01-01', count: 99999 }] },
    ]);
    const r = replay.replayFromArchive(reg, 'steps', { force: true });
    assert.equal(r.skipped, false);
    assert.equal(r.rowsWritten, 1);
    const rows = reg._snapshot('steps');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].date, '2026-05-06');
    assert.equal(rows[0].count, 4200);
  });

  test('body_mass replay converts lb via the stored metric wrapper', () => {
    // Without groupsByPush carrying the wrapper, live ingest converts lb to kg
    // while a backfill replay silently does not, and the two disagree for the
    // same date. This is the only test that fails in that state.
    writeRawPayload(Date.parse('2026-05-06T00:00:00Z'), { data: { metrics: [
      { name: 'body_mass', units: 'lb', data: [{ date: '2026-05-06', qty: 176.4 }] },
    ]}});
    const reg = makeRegistry([
      { id: 'weight',
        meta: { id: 'weight', ingest: { source: 'hae', metric: 'body_mass' } },
        data: [{ date: '2025-01-01', kg: 99 }] },
    ]);
    const r = replay.replayFromArchive(reg, 'weight', { force: true });
    assert.equal(r.skipped, false);
    assert.equal(r.rowsWritten, 1);
    const rows = reg._snapshot('weight');
    assert.equal(rows.length, 1);
    // An unconverted replay stores 176.4.
    assert.deepStrictEqual(rows[0], { date: '2026-05-06', kg: 80 });
  });

  test('not HAE-backed: skipped with no writes', () => {
    writeRawPayload(Date.parse('2026-05-06T00:00:00Z'), { data: { metrics: [
      { name: 'step_count', data: [{ date: '2026-05-06', qty: 4200 }] },
    ]}});
    const reg = makeRegistry([
      { id: 'plain', meta: { id: 'plain' } }, // no ingest
    ]);
    const r = replay.replayFromArchive(reg, 'plain');
    assert.equal(r.skipped, true);
    assert.equal(r.rowsWritten, 0);
  });

  test('unknown catalogue metric: skipped', () => {
    writeRawPayload(Date.parse('2026-05-06T00:00:00Z'), { data: {}});
    const reg = makeRegistry([
      { id: 'x', meta: { id: 'x', ingest: { source: 'hae', metric: 'no_such_metric' } } },
    ]);
    const r = replay.replayFromArchive(reg, 'x');
    assert.equal(r.skipped, true);
  });

  test('workouts pseudo-metric replays from data.workouts[]', () => {
    writeRawPayload(Date.parse('2026-05-06T00:00:00Z'), { data: { workouts: [
      { name: 'Running', start: '2026-05-06 07:00:00 +1000' },
      { name: 'Walking', start: '2026-05-07 18:00:00 +1000' },
    ]}});
    const reg = makeRegistry([
      { id: 'w', meta: { id: 'w', ingest: { source: 'hae', metric: 'workouts' } } },
    ]);
    replay.replayFromArchive(reg, 'w');
    const rows = reg._snapshot('w');
    assert.equal(rows.length, 2);
    assert.equal(rows[0].trained, true);
  });

  test('an unusable stored sample is skipped, not fatal', () => {
    // The file-archive equivalent of this test fed replay a corrupt JSON file.
    // A payload that will not parse can no longer reach the store at all (the
    // endpoint quarantines it), so the surviving hazard is a stored sample the
    // catalogue cannot map: one bad sample must not cost the whole card.
    writeRawPayload(Date.parse('2026-05-06T00:00:00Z'), { data: { metrics: [
      { name: 'step_count', data: [
        null,
        { date: '2026-05-06', qty: 4200 },
        { nothing: 'useful' },
      ]},
    ]}});

    const reg = makeRegistry([
      { id: 'steps', meta: { id: 'steps', ingest: { source: 'hae', metric: 'step_count' } } },
    ]);
    const r = replay.replayFromArchive(reg, 'steps');
    assert.equal(r.rowsWritten, 1);
    assert.equal(reg._snapshot('steps')[0].count, 4200);
    assert.ok(r.pushesScanned >= 1);
  });
});
