// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/health-auto-export.replay-scaling.test.js
//
// Replay must not get quadratically slower as history grows.
//
// replayMetric used to call mergeByDate() once per push group, and mergeByDate
// rebuilds a Map of the whole accumulated result and re-sorts the whole array
// every call. That is O(groups x accumulated dates). Before the samples table
// (#546) the cost was hidden behind reading 412 MB of JSON; removing the file
// I/O exposed it, and replay runs synchronously inside POST /api/manifests on a
// single-threaded server. Measured on the pre-fix code: 2.5 months of history
// (177 push groups) 16 ms, five years (about 8500 groups) 1084 ms.
//
// The correctness of the replacement is pinned by
// tests/health-auto-export.replay-equivalence.test.js, which compares against
// the pre-#546 algorithm. This file only pins the SHAPE of the cost curve, so a
// future refactor cannot quietly put the quadratic back.

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

// Build a history shaped like a real instance: each push carries a rolling
// window whose most recent day is revised, so pushes overlap and every push
// group is distinct.
function seed(pushes, windowDays) {
  const base = Date.UTC(2020, 0, 1);
  for (let p = 0; p < pushes; p++) {
    const data = [];
    for (let d = 0; d < windowDays; d++) {
      const day = new Date(base + (p + d) * 86400000).toISOString().slice(0, 10);
      data.push({ date: `${day} 08:00:00 +1000`, qty: 1000 + d * 10 + (d === windowDays - 1 ? p : 0) });
    }
    samples.recordPush({ data: { metrics: [{ name: 'step_count', units: 'count', data }] } },
      { receivedAt: new Date(base + p * 3600000).toISOString(), dbFile });
  }
}

function timeReplay(runs = 3) {
  // Warm up, then take the best of several runs: this asserts on a ratio, and a
  // single sample on a loaded CI box is noise.
  replay.replayMetric('step_count', { dbFile });
  let best = Infinity;
  for (let i = 0; i < runs; i++) {
    const t0 = process.hrtime.bigint();
    const r = replay.replayMetric('step_count', { dbFile });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    if (ms < best) best = ms;
    assert.ok(r.rows.length > 0, 'replay produced no rows; the fixture is wrong');
  }
  return best;
}

describe('replay cost scales with history, not history squared', () => {
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'klebb-scale-'));
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

  test('quadrupling the history does not quadratically increase replay time', () => {
    // 400 pushes, then 1600. Under the old per-push merge the work grows as
    // groups x dates, so 4x the history is roughly 16x the time; linear-ish work
    // is roughly 4x. The threshold sits between the two with room for noise.
    seed(400, 7);
    const small = timeReplay();

    // Same database, extended rather than rebuilt, so the small measurement is a
    // true prefix of the large one.
    seed(1600, 7);
    const large = timeReplay();

    const ratio = large / small;
    // Deliberately loose: the point is to catch a return to quadratic (16x+),
    // not to police constant factors. Verified to FAIL on the pre-fix code.
    assert.ok(ratio < 9,
      `replay time grew ${ratio.toFixed(1)}x for 4x the history `
      + `(${small.toFixed(1)}ms -> ${large.toFixed(1)}ms); `
      + 'that is the quadratic per-push merge coming back');

    // And an absolute ceiling, because a ratio alone would pass if BOTH ends
    // were catastrophically slow.
    assert.ok(large < 4000,
      `replay of 2000 pushes took ${large.toFixed(0)}ms; it should be well under a second`);
  });

  test('a five-year history replays fast enough to sit in a request', () => {
    // Replay runs synchronously inside POST /api/manifests, the template route,
    // and the chat create_manifest tool, so this is a latency budget rather than
    // a micro-benchmark. Roughly five years of daily pushes.
    //
    // The ceiling is deliberately tight enough to FAIL on the pre-fix code. A
    // looser one passed against the quadratic version at 4.2 seconds, which
    // would have made this test decorative: it is the kind of pass that looks
    // like coverage and is not.
    seed(1825, 7);
    const ms = timeReplay(2);
    const rows = replay.replayMetric('step_count', { dbFile }).rows.length;
    assert.ok(rows > 1800, `expected about 1831 dates, got ${rows}`);
    assert.ok(ms < 400,
      `replaying five years of history took ${ms.toFixed(0)}ms, which blocks the `
      + 'single-threaded server for too long inside a card-create request');
  });
});
