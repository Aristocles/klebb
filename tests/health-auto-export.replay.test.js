// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/health-auto-export.replay.test.js
// Unit tests for the replay-from-archive module.

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let tmp;
let replay;

function reloadModule() {
  delete require.cache[require.resolve('../config/paths')];
  delete require.cache[require.resolve('../health-auto-export/replay')];
  delete require.cache[require.resolve('../health-auto-export/ingest')];
  delete require.cache[require.resolve('../health-auto-export/catalogue')];
  delete require.cache[require.resolve('../health-auto-export/helpers')];
  replay = require('../health-auto-export/replay');
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

function writeRawPayload(stampMs, payload) {
  const rawDir = path.join(tmp, 'data', 'auto-export', 'raw');
  fs.mkdirSync(rawDir, { recursive: true });
  const stamp = new Date(stampMs).toISOString().replace(/[:.]/g, '');
  fs.writeFileSync(path.join(rawDir, `${stamp}.json`), JSON.stringify(payload));
}

describe('replayFromArchive', () => {
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eh-replay-'));
    process.env.HEALTH_HOME = tmp;
    process.env.HEALTH_HOME_WARNED = '1';
    reloadModule();
  });

  afterEach(() => {
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

  test('multiple pushes merge by date; aggregation applied per metric', () => {
    writeRawPayload(Date.parse('2026-05-06T00:00:00Z'), { data: { metrics: [
      { name: 'step_count', data: [{ date: '2026-05-06', qty: 4200 }] },
    ]}});
    writeRawPayload(Date.parse('2026-05-07T00:00:00Z'), { data: { metrics: [
      { name: 'step_count', data: [
        { date: '2026-05-06', qty: 500 },   // extra steps for same date
        { date: '2026-05-07', qty: 7700 },
      ]},
    ]}});

    const reg = makeRegistry([
      { id: 'steps', meta: { id: 'steps', ingest: { source: 'hae', metric: 'step_count' } } },
    ]);
    replay.replayFromArchive(reg, 'steps');
    const rows = reg._snapshot('steps');
    const byDate = Object.fromEntries(rows.map(r => [r.date, r.count]));
    // step_count aggregate is sum-per-date: 4200 + 500 = 4700 on 2026-05-06
    assert.equal(byDate['2026-05-06'], 4700);
    assert.equal(byDate['2026-05-07'], 7700);
  });

  test('idempotent: skips when data is non-empty', () => {
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

  test('corrupt raw file is skipped, not fatal', () => {
    const rawDir = path.join(tmp, 'data', 'auto-export', 'raw');
    fs.mkdirSync(rawDir, { recursive: true });
    fs.writeFileSync(path.join(rawDir, 'bad.json'), '{ not json');
    // Valid file alongside.
    writeRawPayload(Date.parse('2026-05-06T00:00:00Z'), { data: { metrics: [
      { name: 'step_count', data: [{ date: '2026-05-06', qty: 4200 }] },
    ]}});

    const reg = makeRegistry([
      { id: 'steps', meta: { id: 'steps', ingest: { source: 'hae', metric: 'step_count' } } },
    ]);
    const r = replay.replayFromArchive(reg, 'steps');
    assert.equal(r.rowsWritten, 1);
    // pushesScanned counts only successfully-parsed files.
    assert.ok(r.pushesScanned >= 1);
  });
});
