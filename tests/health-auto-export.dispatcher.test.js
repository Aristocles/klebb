// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/health-auto-export.dispatcher.test.js
// Unit tests for the HAE dispatcher in isolation from the HTTP layer.
// Uses a fake registry so we can assert dispatch shape + behaviour
// without spinning up a server or writing to disk.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { dispatch, findSubscribers, extractWrapper, aggregate } = require('../health-auto-export/ingest.js');

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
  test('reads from data.workouts[] and merges same-date sessions', () => {
    const reg = makeRegistry([
      { id: 'workouts', meta: { id: 'workouts',
          ingest: { source: 'hae', metric: 'workouts' } } },
    ]);
    const payload = { data: { workouts: [
      { name: 'Running', start: '2026-05-04 07:00:00 +1000', duration: 1800,
        distance: { qty: 5, units: 'km' },
        activeEnergyBurned: { qty: 320, units: 'kcal' } },
      { name: 'Walking', start: '2026-05-04 18:00:00 +1000', duration: 900,
        distance: { qty: 1.2, units: 'km' },
        activeEnergyBurned: { qty: 80, units: 'kcal' } },
      { name: 'Functional Strength Training',
        start: '2026-05-05 11:00:00 +1000', duration: 2700,
        activeEnergyBurned: { qty: 1104.576, units: 'kJ' } },
    ]}};

    dispatch(reg, payload);
    const rows = reg._snapshot('workouts');
    assert.equal(rows.length, 2);
    const byDate = Object.fromEntries(rows.map(r => [r.date, r]));

    // Two sessions on 2026-05-04 — daily summary sums duration/calories,
    // type list is chronological, startTime is the earliest.
    assert.equal(byDate['2026-05-04'].trained, true);
    assert.equal(byDate['2026-05-04'].type, 'Running, Walking');
    assert.equal(byDate['2026-05-04'].durationMin, 45);    // 30 + 15
    assert.equal(byDate['2026-05-04'].distanceKm, 6.20);   // 5.0 + 1.2
    assert.equal(byDate['2026-05-04'].calories, 400);      // 320 + 80
    assert.equal(byDate['2026-05-04'].startTime, '07:00');

    // Single session on 2026-05-05; kJ → kcal conversion exercised.
    assert.equal(byDate['2026-05-05'].trained, true);
    assert.equal(byDate['2026-05-05'].type, 'Functional Strength Training');
    assert.equal(byDate['2026-05-05'].durationMin, 45);
    assert.equal(byDate['2026-05-05'].calories, 264);      // 1104.576 / 4.184
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

  test('same-date re-push is whole-row replace, never field merge', () => {
    // A sleep push without stage fields must DROP the stages the earlier
    // push carried for that date. If `deep` survives the second push,
    // field-level merge has crept into the upsert.
    const reg = makeRegistry([
      { id: 'sleep-hours', meta: { id: 'sleep-hours',
          ingest: { source: 'hae', metric: 'sleep_analysis' } },
        data: [] },
    ]);

    dispatch(reg, { data: { metrics: [
      { name: 'sleep_analysis', data: [
        { date: '2026-05-01 00:00:00 +1000', totalSleep: 7.5, deep: 1.4, rem: 1.9 },
      ]},
    ]}});
    let rows = reg._snapshot('sleep-hours');
    assert.equal(rows[0].deep, 1.4);
    assert.equal(rows[0].rem, 1.9);

    dispatch(reg, { data: { metrics: [
      { name: 'sleep_analysis', data: [
        { date: '2026-05-01 00:00:00 +1000', totalSleep: 7.5 },
      ]},
    ]}});
    rows = reg._snapshot('sleep-hours');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].hours, 7.5);
    assert.equal(rows[0].deep, undefined, 'deep must be gone: whole-row replace');
    assert.equal(rows[0].rem, undefined, 'rem must be gone: whole-row replace');
  });
});

describe('dispatch: one bad entry never stalls the rest of the push (#553)', () => {
  test('a malformed entry is dropped and later subscribers still ingest', () => {
    // Every catalogue row() dereferences its entry immediately, so a null or
    // wrongly-shaped element used to throw out of dispatch() entirely. The
    // route swallows a post-auth throw into 200 {ok:true, warning} to stop the
    // phone retrying forever, so the visible result was that every LATER
    // subscriber silently stopped ingesting while the push looked successful.
    const reg = makeRegistry([
      { id: 'first-steps', meta: { id: 'first-steps',
          ingest: { source: 'hae', metric: 'step_count' } } },
      { id: 'later-rhr', meta: { id: 'later-rhr',
          ingest: { source: 'hae', metric: 'resting_heart_rate' } } },
    ]);
    const payload = { data: { metrics: [
      { name: 'step_count', data: [
        { date: '2026-05-04 08:00:00 +1000', qty: 1200 },
        null,
        'not an object at all',
        { date: '2026-05-05 10:00:00 +1000', qty: 2000 },
      ]},
      { name: 'resting_heart_rate', data: [
        { date: '2026-05-04 08:00:00 +1000', qty: 58 },
      ]},
    ]}};

    const summary = dispatch(reg, payload);

    // The good rows from the damaged stream survived.
    const steps = reg._snapshot('first-steps');
    assert.equal(steps.length, 2, 'good rows were lost alongside the malformed ones');

    // And the subscriber AFTER the damaged one still ingested, which is the
    // actual regression: it used to get nothing at all.
    const rhr = reg._snapshot('later-rhr');
    assert.ok(Array.isArray(rhr) && rhr.length === 1,
      'a later subscriber was starved by a malformed entry in an earlier metric');

    // The loss is reported rather than passed off as a clean push.
    const stepsSummary = summary.subscribers.find(x => x.id === 'first-steps');
    assert.equal(stepsSummary.droppedEntries, 2, 'the dropped count was not reported');
    assert.ok(summary.warnings.some(w => /dropped 2 of 4/.test(w)),
      `no warning names the partial loss: ${JSON.stringify(summary.warnings)}`);
  });

  test('a stream where every entry is malformed says so', () => {
    const reg = makeRegistry([
      { id: 'my-steps', meta: { id: 'my-steps',
          ingest: { source: 'hae', metric: 'step_count' } } },
    ]);
    const payload = { data: { metrics: [
      { name: 'step_count', data: [null, null, { nope: true }] },
    ]}};
    const summary = dispatch(reg, payload);
    const s = summary.subscribers.find(x => x.id === 'my-steps');
    assert.equal(s.rowsWritten, 0);
    assert.match(s.note, /all 3 entries malformed/);
    assert.ok(summary.warnings.some(w => /all 3 entries malformed/.test(w)),
      'a fully malformed stream produced no warning');
  });

  test('a clean push reports no dropped count at all', () => {
    // The field must be absent rather than 0, so last-push.json stays quiet
    // for the normal case.
    const reg = makeRegistry([
      { id: 'my-steps', meta: { id: 'my-steps',
          ingest: { source: 'hae', metric: 'step_count' } } },
    ]);
    const payload = { data: { metrics: [
      { name: 'step_count', data: [{ date: '2026-05-04 08:00:00 +1000', qty: 1200 }] },
    ]}};
    const summary = dispatch(reg, payload);
    const s = summary.subscribers.find(x => x.id === 'my-steps');
    assert.equal(s.rowsWritten, 1);
    assert.ok(!('droppedEntries' in s), 'a clean push reported a dropped count');
    assert.deepEqual(summary.warnings, []);
  });

  test('a row() that throws is contained, not fatal', () => {
    // Belt and braces: prove containment against a catalogue entry that throws
    // unconditionally, so the guard is exercised even if every real row()
    // becomes defensive later.
    const catalogue = require('../health-auto-export/catalogue.js');
    const original = catalogue.step_count.row;
    catalogue.step_count.row = () => { throw new TypeError('boom'); };
    try {
      const reg = makeRegistry([
        { id: 'boom-steps', meta: { id: 'boom-steps',
            ingest: { source: 'hae', metric: 'step_count' } } },
        { id: 'after-rhr', meta: { id: 'after-rhr',
            ingest: { source: 'hae', metric: 'resting_heart_rate' } } },
      ]);
      const payload = { data: { metrics: [
        { name: 'step_count', data: [{ date: '2026-05-04 08:00:00 +1000', qty: 1 }] },
        { name: 'resting_heart_rate', data: [{ date: '2026-05-04 08:00:00 +1000', qty: 58 }] },
      ]}};
      // Must not throw.
      const summary = dispatch(reg, payload);
      assert.ok(Array.isArray(reg._snapshot('after-rhr')) && reg._snapshot('after-rhr').length === 1,
        'a throwing row() starved the next subscriber');
      assert.ok(summary.warnings.some(w => /malformed/.test(w)));
    } finally {
      catalogue.step_count.row = original;
    }
  });
});

describe('extractWrapper', () => {
  test('returns the wrapper minus name and data', () => {
    const payload = { data: { metrics: [
      { name: 'body_mass', units: 'lb', data: [] },
    ]}};
    assert.deepEqual(extractWrapper(payload, 'body_mass'), { units: 'lb' });
  });

  test('unrecognised wrapper fields pass through untouched', () => {
    const payload = { data: { metrics: [
      { name: 'body_mass', units: 'lb', foo: 1, data: [] },
    ]}};
    assert.deepEqual(extractWrapper(payload, 'body_mass'), { units: 'lb', foo: 1 });
  });

  test('{} for a metric absent from the payload', () => {
    const payload = { data: { metrics: [
      { name: 'step_count', units: 'count', data: [] },
    ]}};
    assert.deepEqual(extractWrapper(payload, 'body_mass'), {});
  });

  test('{} when data.metrics is not an array', () => {
    assert.deepEqual(extractWrapper({ data: { metrics: 'nope' } }, 'body_mass'), {});
  });

  test('{} for null and garbage payloads', () => {
    assert.deepEqual(extractWrapper(null, 'body_mass'), {});
    assert.deepEqual(extractWrapper('garbage', 'body_mass'), {});
    assert.deepEqual(extractWrapper(42, 'body_mass'), {});
  });
});

describe('dispatch: wrapper reaches row() (#587)', () => {
  test('body_mass in lb is stored converted to kg', () => {
    // The unit lives on the metric wrapper, not the sample, so this goes red
    // if dispatch() ever reverts to cat.row(raw) without the wrapper: the
    // unconverted pipeline stores kg: 176.4.
    const reg = makeRegistry([
      { id: 'weight', meta: { id: 'weight',
          ingest: { source: 'hae', metric: 'body_mass' } } },
    ]);
    const payload = { data: { metrics: [
      { name: 'body_mass', units: 'lb', data: [
        { date: '2026-05-04 08:00:00 +1000', qty: 176.4 },
      ]},
    ]}};

    dispatch(reg, payload);
    assert.deepEqual(reg._snapshot('weight'), [{ date: '2026-05-04', kg: 80 }]);
  });
});

describe('aggregate: unknown strategy is loud, and dispatch contains it (#589)', () => {
  test('an unknown strategy throws and the message names it', () => {
    // Quietly behaving like last-per-date turned a catalogue typo into
    // silently wrong data.
    assert.throws(
      () => aggregate([{ date: '2026-05-04', v: 1 }], 'sum-per-dae'),
      /unknown aggregation strategy: sum-per-dae/);
  });

  test('every catalogue entry uses a registered strategy', () => {
    // Pins the whole catalogue so the throw above stays unreachable from
    // shipped code: a new or edited entry with a typoed strategy fails here,
    // not in a customer's push.
    const catalogue = require('../health-auto-export/catalogue.js');
    let checked = 0;
    for (const [key, entry] of Object.entries(catalogue)) {
      assert.doesNotThrow(
        () => aggregate([{ date: '2026-05-04', qty: 1, totalSleep: 7 }], entry.aggregate),
        `catalogue entry "${key}" uses an unregistered aggregation strategy`);
      checked++;
    }
    assert.ok(checked > 10,
      `only ${checked} catalogue entries checked; the pinning loop looks vacuous`);
  });

  test('an aggregate() throw is contained, not fatal', () => {
    // Mirrors the row()-throw containment above: an uncontained throw here
    // would starve every LATER subscriber while the push reports success.
    const catalogue = require('../health-auto-export/catalogue.js');
    const original = catalogue.step_count.aggregate;
    catalogue.step_count.aggregate = 'not-a-strategy';
    try {
      const reg = makeRegistry([
        { id: 'bad-agg-steps', meta: { id: 'bad-agg-steps',
            ingest: { source: 'hae', metric: 'step_count' } } },
        { id: 'after-rhr', meta: { id: 'after-rhr',
            ingest: { source: 'hae', metric: 'resting_heart_rate' } } },
      ]);
      const payload = { data: { metrics: [
        { name: 'step_count', data: [{ date: '2026-05-04 08:00:00 +1000', qty: 1200 }] },
        { name: 'resting_heart_rate', data: [{ date: '2026-05-04 08:00:00 +1000', qty: 58 }] },
      ]}};
      // Must not throw.
      const summary = dispatch(reg, payload);

      assert.ok(Array.isArray(reg._snapshot('after-rhr')) && reg._snapshot('after-rhr').length === 1,
        'a failed aggregation starved the next subscriber');

      const steps = summary.subscribers.find(x => x.id === 'bad-agg-steps');
      assert.equal(steps.rowsWritten, 0);
      assert.match(steps.note, /aggregation failed/);
      assert.ok(summary.warnings.some(w => /aggregation failed: unknown aggregation strategy/.test(w)),
        `no warning names the failed aggregation: ${JSON.stringify(summary.warnings)}`);
    } finally {
      catalogue.step_count.aggregate = original;
    }
  });
});
