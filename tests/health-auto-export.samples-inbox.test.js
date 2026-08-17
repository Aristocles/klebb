// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/health-auto-export.samples-inbox.test.js
//
// The samples inbox drain (#632: streamed, one push at a time) must be
// byte-for-byte equivalent to the array-form import it replaced: same
// tables, same error semantics (unreadable rename-aside, the no-pushes
// message, the legacy bare-array form), same rename-aside on success. Plus
// the two properties only the stream has: a scanner that cannot be fooled
// by "]}," inside a string value, and an event-loop yield between batches
// so a live server keeps answering during a long drain.
//
// Fresh-require tests only (config/paths freezes HEALTH_HOME at require
// time); no spawnServer here. The liveness-over-HTTP proof lives in
// tests/api/issue-632-streaming-drain.test.js.

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let sqliteAvailable = true;
try { require('node:sqlite'); } catch { sqliteAvailable = false; }
const skip = sqliteAvailable ? false : 'node:sqlite unavailable on this Node';

let tmp;
let inbox;
let samples;

function fresh() {
  for (const m of ['../config/paths', '../health-auto-export/samples',
    '../health-auto-export/samples-inbox', '../health-auto-export/helpers']) {
    delete require.cache[require.resolve(m)];
  }
  inbox = require('../health-auto-export/samples-inbox');
  samples = require('../health-auto-export/samples');
}

function writeInbox(text) {
  fs.mkdirSync(path.dirname(inbox.FILE), { recursive: true });
  fs.writeFileSync(inbox.FILE, typeof text === 'string' ? text : JSON.stringify(text));
}

function autoExportNames() {
  try {
    return fs.readdirSync(path.dirname(inbox.FILE));
  } catch {
    return [];
  }
}

function push(date, qty) {
  return {
    receivedAt: `${date}T00:00:00.000Z`,
    payload: { data: { metrics: [{ name: 'step_count', units: 'count', data: [{ date, qty }] }] } },
  };
}

function dumpTables(dbFile) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbFile);
  try {
    return {
      pushes: db.prepare('SELECT push_seq, received_at FROM hae_pushes ORDER BY push_seq').all(),
      samples: db.prepare(
        'SELECT hex(hash) AS hash, metric, metric_meta, sample_date, doc, dup_count, '
        + 'push_ord, first_push, last_push FROM hae_samples ORDER BY hash').all(),
    };
  } finally {
    db.close();
  }
}

describe('samples inbox drain', { skip }, () => {
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'klebb-inbox-'));
    process.env.HEALTH_HOME = tmp;
    process.env.HEALTH_HOME_WARNED = '1';
    fresh();
  });

  afterEach(() => {
    try { samples.close(); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    delete process.env.HEALTH_HOME;
  });

  test('streamed drain produces tables deep-equal to the array-form import of the same file', async () => {
    // Every property that could trip a per-element parse: an intra-push
    // repeat, wrapper units, workouts, an empty-payload item to skip, and
    // strings full of scanner bait.
    const pushes = [
      push('2026-05-01', 4100),
      {
        receivedAt: '2026-05-02T00:00:00.000Z',
        payload: { data: {
          metrics: [
            { name: 'step_count', units: 'count', data: [
              { date: '2026-05-02', qty: 5200 },
              { date: '2026-05-02', qty: 5200 },
            ] },
            { name: 'notes', data: [{ date: '2026-05-02', text: 'bait: ]}, and \\" and [{' }] },
          ],
          workouts: [{ name: 'Running', start: '2026-05-02 07:00:00 +1000', duration: 1800 }],
        } },
      },
      { receivedAt: '2026-05-03T00:00:00.000Z' },
      push('2026-05-04', 900),
    ];
    writeInbox({ version: 1, pushes });

    const res = await inbox.drain();
    assert.strictEqual(res.pushes, 3, 'the payload-less item must be skipped');
    assert.ok(res.inserted > 0);
    samples.close();

    const arrayDb = path.join(tmp, 'array', 'klebb.db');
    const r = samples.importPushes(pushes, { dbFile: arrayDb });
    assert.strictEqual(r.pushes, 3);
    samples.close();

    assert.deepStrictEqual(dumpTables(path.join(tmp, 'db', 'klebb.db')), dumpTables(arrayDb),
      'the streamed drain and the array-form import disagree on the stored tables');
  });

  test('drain renames aside on success and the next drain is a no-op', async () => {
    writeInbox({ version: 1, pushes: [push('2026-05-01', 4100)] });
    const res = await inbox.drain();
    assert.strictEqual(res.pushes, 1);
    assert.match(res.backup, /^samples\.json\.imported-/);
    const names = autoExportNames();
    assert.ok(!names.includes('samples.json'), 'samples.json was not renamed aside');
    assert.strictEqual(names.filter(n => n.startsWith('samples.json.imported-')).length, 1);
    assert.strictEqual(await inbox.drain(), null, 'a drained inbox must be empty');
    assert.strictEqual(samples.pushCount(), 1, 'the rename must prevent a double import');
  });

  test('the legacy bare-array form still drains', async () => {
    writeInbox([push('2026-05-01', 4100), push('2026-05-02', 5200)]);
    const res = await inbox.drain();
    assert.strictEqual(res.pushes, 2);
    assert.strictEqual(samples.pushCount(), 2);
    assert.ok(!autoExportNames().includes('samples.json'));
  });

  test('a "]}," inside a string value must not end an element', async () => {
    // The exact shape that would fool a depth-only scanner: the string
    // closes the array, the object and starts the next element.
    const text = '{"version":1,"pushes":['
      + '{"receivedAt":"t1","payload":{"data":{"metrics":[{"name":"notes","data":['
      + '{"date":"2026-05-01","text":"]},{\\"forged\\":1}"}]}]}}},'
      + '{"receivedAt":"t2","payload":{"data":{"metrics":[{"name":"notes","data":['
      + '{"date":"2026-05-02","text":"escaped quote \\" then ]}"}]}]}}}'
      + ']}';
    writeInbox(text);
    const res = await inbox.drain();
    assert.strictEqual(res.pushes, 2, 'the scanner split an element inside a string');
    const rows = samples.forMetric('notes');
    assert.deepStrictEqual(rows.map(r => JSON.parse(r.doc).text).sort(), [
      ']},{"forged":1}',
      'escaped quote " then ]}',
    ]);
  });

  test('not JSON at all: unreadable rename-aside and the boot-facing message', async () => {
    writeInbox('this is not json');
    await assert.rejects(() => inbox.drain(), /samples\.json is not valid JSON \(moved to samples\.json\.unreadable-\d+\)/);
    const names = autoExportNames();
    assert.ok(!names.includes('samples.json'));
    assert.strictEqual(names.filter(n => n.startsWith('samples.json.unreadable-')).length, 1,
      'the unparseable file must be renamed aside so it cannot fail every boot');
  });

  test('a malformed element mid-array gets the same unreadable semantics', async () => {
    const good = JSON.stringify(push('2026-05-01', 4100));
    writeInbox(`{"version":1,"pushes":[${good},{"receivedAt":"t2","payload":{broken}]}`);
    await assert.rejects(() => inbox.drain(), /samples\.json is not valid JSON \(moved to samples\.json\.unreadable-\d+\)/);
    assert.strictEqual(autoExportNames().filter(n => n.startsWith('samples.json.unreadable-')).length, 1);
    // The good prefix landed before the bad element was hit; content dedupe
    // makes a re-import of the repaired file add nothing twice.
    assert.strictEqual(samples.pushCount(), 1);
  });

  test('a truncated file (structurally broken) is unreadable, not silently partial', async () => {
    const good = JSON.stringify(push('2026-05-01', 4100));
    writeInbox(`{"version":1,"pushes":[${good}`);
    await assert.rejects(() => inbox.drain(), /samples\.json is not valid JSON/);
    assert.strictEqual(autoExportNames().filter(n => n.startsWith('samples.json.unreadable-')).length, 1);
  });

  test('valid JSON without a pushes[] array keeps its exact error, and the file stays', async () => {
    for (const body of ['{"version":1}', '{"pushes":5}', '42']) {
      writeInbox(body);
      await assert.rejects(() => inbox.drain(), /^Error: samples\.json has no pushes\[\] array$/);
      assert.ok(autoExportNames().includes('samples.json'),
        `the no-pushes case must leave the file in place (body: ${body})`);
      fs.rmSync(inbox.FILE, { force: true });
    }
  });

  test('the drain never imports more than a small batch per event-loop turn', async () => {
    // Hundreds of tiny pushes fit in one 64 KB read, so without the
    // per-batch yield a whole chunk's worth imports in a single macrotask
    // and a live server answers nothing mid-drain. Counted structurally
    // (imports per turn, reset from a competing setImmediate) rather than
    // by wall-clock turns, which vary with fs latency.
    const pushes = [];
    for (let i = 0; i < 1000; i++) {
      pushes.push(push(`2026-01-${String((i % 28) + 1).padStart(2, '0')}`, i));
    }
    writeInbox({ version: 1, pushes });

    const realImportPush = samples.importPush;
    let inThisTurn = 0;
    let maxPerTurn = 0;
    samples.importPush = (item, opts) => {
      inThisTurn += 1;
      if (inThisTurn > maxPerTurn) maxPerTurn = inThisTurn;
      return realImportPush(item, opts);
    };
    let running = true;
    const reset = () => { inThisTurn = 0; if (running) setImmediate(reset); };
    setImmediate(reset);
    let res;
    try {
      res = await inbox.drain();
    } finally {
      running = false;
      samples.importPush = realImportPush;
    }

    assert.strictEqual(res.pushes, 1000);
    // YIELD_EVERY is 20; the reset can straddle a batch boundary, so allow
    // slack. Without the yield a single chunk imports 400+ in one turn.
    assert.ok(maxPerTurn <= 60,
      `${maxPerTurn} pushes imported in one event-loop turn: the per-batch yield is gone`);
  });
});
