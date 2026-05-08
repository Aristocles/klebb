// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/health-auto-export.dispatcher.test.js
// Unit tests for the HAE dispatcher in isolation from the HTTP layer.
// Uses a fake registry so we can assert dispatch shape + behaviour
// without spinning up a server or writing to disk.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { dispatch, findSubscribers } = require('../health-auto-export/ingest.js');

// Build a minimal registry stub that looks enough like the real one to
// satisfy dispatch(): list(), data(id), writeData(id, rows).
function makeRegistry(manifests) {
  const state = new Map();
  for (const m of manifests) state.set(m.id, { ...m, data: m.data ?? [] });
  return {
    list() {
      return [...state.values()].map(e => ({ id: e.id, meta: e.meta }));
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
    _snapshot(id) {
      return state.get(id)?.data;
    },
  };
}

describe('findSubscribers', () => {
  test('returns only manifests with meta.ingest.source === "hae"', () => {
    const reg = makeRegistry([
      { id: 'a', meta: { id: 'a', ingest: { source: 'hae', metric: 'step_count' } } },
      { id: 'b', meta: { id: 'b' } },
      { id: 'c', meta: { id: 'c', ingest: { source: 'other', metric: 'x' } } },
    ]);
    assert.deepEqual(findSubscribers(reg), [{ id: 'a', metric: 'step_count' }]);
  });
});

describe('dispatch: happy path', () => {
  test('routes step_count to a subscriber', () => {
    const reg = makeRegistry([
      { id: 'my-steps', meta: { id: 'my-steps',
          ingest: { source: 'hae', metric: 'step_count' } } },
    ]);
    const payload = { data: { metrics: [
      { name: 'step_count', data: [
        { date: '2026-05-04 08:00:00 +1000', qty: 1200 },
        { date: '2026-05-04 12:00:00 +1000', qty: 3200 },
        { date: '2026-05-05 10:00:00 +1000', qty: 2000 },
      ]},
    ]}};

    const summary = dispatch(reg, payload);

    assert.equal(summary.subscribers.length, 1);
    assert.equal(summary.subscribers[0].rowsWritten, 2);
    assert.deepEqual(summary.availableUnsubscribed, []);

    const rows = reg._snapshot('my-steps');
    const byDate = Object.fromEntries(rows.map(r => [r.date, r.count]));
    assert.equal(byDate['2026-05-04'], 4400);
    assert.equal(byDate['2026-05-05'], 2000);
  });
});

describe('dispatch: no subscribers', () => {
  test('unsubscribed payload lists availableUnsubscribed', () => {
    const reg = makeRegistry([]);
    const payload = { data: { metrics: [
      { name: 'sleep_analysis', data: [{ date: '2026-05-04', totalSleep: 7 }] },
      { name: 'step_count', data: [{ date: '2026-05-04', qty: 1000 }] },
    ]}};

    const summary = dispatch(reg, payload);

    assert.deepEqual(summary.subscribers, []);
    assert.deepEqual(summary.availableUnsubscribed.sort(),
      ['sleep_analysis', 'step_count']);
  });
});

describe('dispatch: subscribed metric absent from payload', () => {
  test('records zero rows with a no-entries note; no availableUnsubscribed entry', () => {
    const reg = makeRegistry([
      { id: 'my-hrv', meta: { id: 'my-hrv',
          ingest: { source: 'hae', metric: 'heart_rate_variability' } } },
    ]);
    const payload = { data: { metrics: [
      { name: 'step_count', data: [{ date: '2026-05-04', qty: 1000 }] },
    ]}};

    const summary = dispatch(reg, payload);
    assert.equal(summary.subscribers[0].rowsWritten, 0);
    assert.match(summary.subscribers[0].note, /no entries/);
    assert.deepEqual(summary.availableUnsubscribed, ['step_count']);
  });
});

describe('dispatch: unknown metric in meta.ingest', () => {
  test('records a warning, does not throw', () => {
    const reg = makeRegistry([
      { id: 'my-typo', meta: { id: 'my-typo',
          ingest: { source: 'hae', metric: 'no_such_metric' } } },
    ]);
    const payload = { data: { metrics: [] }};
    const summary = dispatch(reg, payload);
    assert.equal(summary.subscribers[0].rowsWritten, 0);
    assert.match(summary.warnings[0], /not in catalogue/);
  });
});

describe('dispatch: multiple subscribers to same metric', () => {
  test('both receive the same rows', () => {
    const reg = makeRegistry([
      { id: 'sleep-a', meta: { id: 'sleep-a',
          ingest: { source: 'hae', metric: 'sleep_analysis' } } },
      { id: 'sleep-b', meta: { id: 'sleep-b',
          ingest: { source: 'hae', metric: 'sleep_analysis' } } },
    ]);
    const payload = { data: { metrics: [
      { name: 'sleep_analysis', data: [
        { date: '2026-05-04', totalSleep: 7.5 },
      ]},
    ]}};

    dispatch(reg, payload);
    assert.equal(reg._snapshot('sleep-a')[0].hours, 7.5);
    assert.equal(reg._snapshot('sleep-b')[0].hours, 7.5);
  });
});

describe('dispatch: workouts pseudo-metric', () => {
  test('reads from data.workouts[]', () => {
    const reg = makeRegistry([
      { id: 'workouts', meta: { id: 'workouts',
          ingest: { source: 'hae', metric: 'workouts' } } },
    ]);
    const payload = { data: { workouts: [
      { name: 'Running', start: '2026-05-04 07:00:00 +1000' },
      { name: 'Walking', start: '2026-05-04 18:00:00 +1000' },
      { name: 'Functional Strength Training', start: '2026-05-05 11:00:00 +1000' },
    ]}};

    dispatch(reg, payload);
    const rows = reg._snapshot('workouts');
    assert.equal(rows.length, 2);
    const byDate = Object.fromEntries(rows.map(r => [r.date, r]));
    assert.equal(byDate['2026-05-04'].trained, true);
    assert.equal(byDate['2026-05-04'].type, 'Running');
    assert.equal(byDate['2026-05-05'].trained, true);
  });
});

describe('dispatch: malformed entries dropped silently', () => {
  test('mixed valid + invalid: only valid rows upserted', () => {
    const reg = makeRegistry([
      { id: 'steps', meta: { id: 'steps',
          ingest: { source: 'hae', metric: 'step_count' } } },
    ]);
    const payload = { data: { metrics: [
      { name: 'step_count', data: [
        { date: '2026-05-04', qty: 100 },
        { qty: 200 },                          // no date
        { date: '2026-05-04', qty: 'nope' },   // bad qty
        { date: '2026-05-05', qty: 500 },
      ]},
    ]}};

    dispatch(reg, payload);
    const rows = reg._snapshot('steps');
    assert.equal(rows.length, 2);
    const byDate = Object.fromEntries(rows.map(r => [r.date, r.count]));
    assert.equal(byDate['2026-05-04'], 100);
    assert.equal(byDate['2026-05-05'], 500);
  });

  test('all entries malformed: manifest not touched', () => {
    const reg = makeRegistry([
      { id: 'steps', meta: { id: 'steps',
          ingest: { source: 'hae', metric: 'step_count' } },
        data: [{ date: '2026-04-01', count: 9999 }] },
    ]);
    const payload = { data: { metrics: [
      { name: 'step_count', data: [
        { qty: 200 },
        { date: '2026-05-04', qty: 'nope' },
      ]},
    ]}};

    dispatch(reg, payload);
    // Pre-existing data preserved; the "all-malformed" branch doesn't write.
    const rows = reg._snapshot('steps');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].count, 9999);
  });
});

describe('dispatch: merge preserves prior dates', () => {
  test('re-posting a new date does not wipe earlier dates', () => {
    const reg = makeRegistry([
      { id: 'steps', meta: { id: 'steps',
          ingest: { source: 'hae', metric: 'step_count' } },
        data: [{ date: '2026-05-01', count: 5000 }] },
    ]);
    const payload = { data: { metrics: [
      { name: 'step_count', data: [{ date: '2026-05-02', qty: 7000 }] },
    ]}};

    dispatch(reg, payload);
    const rows = reg._snapshot('steps');
    const byDate = Object.fromEntries(rows.map(r => [r.date, r.count]));
    assert.equal(byDate['2026-05-01'], 5000);
    assert.equal(byDate['2026-05-02'], 7000);
  });

  test('re-posting same date overwrites the row for that date only', () => {
    const reg = makeRegistry([
      { id: 'steps', meta: { id: 'steps',
          ingest: { source: 'hae', metric: 'step_count' } },
        data: [{ date: '2026-05-01', count: 5000 }] },
    ]);
    const payload = { data: { metrics: [
      { name: 'step_count', data: [{ date: '2026-05-01', qty: 9001 }] },
    ]}};

    dispatch(reg, payload);
    const rows = reg._snapshot('steps');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].count, 9001);
  });
});
