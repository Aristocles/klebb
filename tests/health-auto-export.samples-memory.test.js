// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/health-auto-export.samples-memory.test.js
//
// Recording a push must cost memory in proportion to the payload's BYTES, not
// to its sample COUNT.
//
// recordPush used to build an array of every sample and then a Map keyed by
// content hash, both alive at once alongside the request body string and the
// parsed object. Because the cost was per sample, the 100 MB body cap did not
// bound it: measured against a 256 MB heap, a 6.57 MB body of a million bare
// numbers died, while a 6.20 MB body holding one large sample was fine. The
// pre-#546 code survived the same input, so this was a regression introduced
// with the samples table, not an inherited limit. A crash here is worse than a
// dropped push: the phone retries, so the container restart-loops.
//
// Two of these tests spawn a child process with a constrained heap. That is the
// only honest way to test an out-of-memory condition: asserting on
// process.memoryUsage() in-process measures whatever the garbage collector
// happened to be doing, and a peak-heap delta came out NEGATIVE when tried.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

let sqliteAvailable = true;
try { require('node:sqlite'); } catch { sqliteAvailable = false; }
const skip = sqliteAvailable ? false : 'node:sqlite unavailable on this Node';

const SAMPLES_MODULE = path.join(__dirname, '..', 'health-auto-export', 'samples');

// Record a payload in a child process with --max-old-space-size=<heapMb>.
// `shape` is 'many' (one sample per element, tiny each) or 'few' (one enormous
// sample), which is how the per-sample versus per-byte question gets settled.
function recordInChild(heapMb, shape, n) {
  const script = `
    const fs = require('fs'), os = require('os'), path = require('path');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'klebb-mem-'));
    process.env.HEALTH_HOME = tmp;
    process.env.HEALTH_HOME_WARNED = '1';
    let body;
    if (process.argv[1] === 'many') {
      const a = [];
      for (let i = 0; i < ${n}; i++) a.push(i);
      body = '{"data":{"metrics":[{"name":"x","data":[' + a.join(',') + ']}]}}';
    } else {
      const pad = 'y'.repeat(${n});
      body = '{"data":{"metrics":[{"name":"x","data":[{"date":"2026-01-01","note":"' + pad + '"}]}]}}';
    }
    const bytes = Buffer.byteLength(body);
    const payload = JSON.parse(body);
    const s = require(${JSON.stringify(SAMPLES_MODULE)});
    const r = s.recordPush(payload, { receivedAt: 't', dbFile: path.join(tmp, 'db', 'k.db') });
    s.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('OK ' + bytes + ' ' + r.seen + ' ' + r.inserted);
  `;
  const res = spawnSync(process.execPath,
    [`--max-old-space-size=${heapMb}`, '-e', script, shape],
    { encoding: 'utf8', timeout: 240000 });
  const out = `${res.stdout || ''}${res.stderr || ''}`;
  const ok = /^OK /m.exec(res.stdout || '');
  return {
    survived: !!ok,
    oom: /heap limit|out of memory/i.test(out),
    bytes: ok ? Number(ok.input.split(' ')[1]) : 0,
    seen: ok ? Number(ok.input.split(' ')[2]) : 0,
    output: out.slice(-400),
  };
}

describe('recording a push costs memory per byte, not per sample', { skip }, () => {
  test('a million-sample push survives a 128 MB heap', () => {
    // Exactly the input that used to be fatal. 128 MB stands in for a small
    // container; a 256 MB instance is the documented low end.
    const r = recordInChild(128, 'many', 1_000_000);
    assert.ok(!r.oom, `ran out of memory on a ${(r.bytes / 1048576).toFixed(1)} MB body:\n${r.output}`);
    assert.ok(r.survived, `child did not complete:\n${r.output}`);
    assert.equal(r.seen, 1_000_000, 'not every sample was recorded');
    // The body really is small: this is not a test that a big body works.
    assert.ok(r.bytes < 10 * 1048576,
      `fixture body is ${(r.bytes / 1048576).toFixed(1)} MB; it is meant to be well under the cap`);
  });

  test('sample count, not byte count, is what used to decide life or death', () => {
    // Two payloads of near-identical size on the same heap. Before the fix the
    // many-sample one died and the few-sample one lived, which is the whole
    // argument for why lowering the byte cap could never have fixed this.
    const many = recordInChild(128, 'many', 1_000_000);
    const few = recordInChild(128, 'few', 6_500_000);

    const sizesClose = Math.abs(many.bytes - few.bytes) < 1.5 * 1048576;
    assert.ok(sizesClose,
      `the two fixtures must be comparable in size, got ${(many.bytes / 1048576).toFixed(1)} MB `
      + `and ${(few.bytes / 1048576).toFixed(1)} MB`);
    assert.ok(!many.oom, `the many-sample payload ran out of memory:\n${many.output}`);
    assert.ok(!few.oom, `the few-sample payload ran out of memory:\n${few.output}`);
    assert.equal(many.seen, 1_000_000);
    assert.equal(few.seen, 1);
  });

  test('flatten is lazy rather than building an array of every sample', () => {
    // Structural, and cheap. The streaming property is easy to undo by
    // "tidying" the generator back into a map/filter chain, and the consequence
    // does not show up until a large push on a small container.
    const samples = require('../health-auto-export/samples');
    const it = samples.flatten({ data: { metrics: [
      { name: 'x', data: [{ date: '2026-01-01', qty: 1 }, { date: '2026-01-02', qty: 2 }] },
    ]}});
    assert.equal(typeof it[Symbol.iterator], 'function', 'flatten no longer returns an iterable');
    assert.ok(typeof it.next === 'function',
      'flatten returns an array or other materialised collection rather than a lazy iterator');
    const first = it.next();
    assert.equal(first.done, false);
    assert.equal(first.value.metric, 'x');
    assert.deepEqual([...it].map(v => v.sample.qty), [2],
      'consuming one value did not leave the rest of the sequence');
  });
});

describe('dup_count semantics survived moving into the upsert', { skip }, () => {
  // The intra-push dedupe moved from a Map into the ON CONFLICT clause. Getting
  // the last_push comparison backwards would either accumulate a re-sent
  // sample's count forever or lose an intra-push repeat, and either silently
  // changes a sum-per-date total on replay. The replay-equivalence suite covers
  // the end result; this covers the stored columns directly.
  let tmp;
  let dbFile;
  let samples;

  function setup() {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'klebb-dup-'));
    process.env.HEALTH_HOME = tmp;
    process.env.HEALTH_HOME_WARNED = '1';
    dbFile = path.join(tmp, 'db', 'klebb.db');
    for (const m of ['../config/paths', '../health-auto-export/samples',
      '../health-auto-export/helpers']) {
      delete require.cache[require.resolve(m)];
    }
    samples = require('../health-auto-export/samples');
  }

  function teardown() {
    try { samples.close(); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    delete process.env.HEALTH_HOME;
  }

  const m = (name, data) => ({ data: { metrics: [{ name, data }] } });

  test('a sample repeated three times in one push stores dup_count 3', () => {
    setup();
    try {
      samples.recordPush(m('step_count', [
        { date: '2026-05-09', qty: 1000 },
        { date: '2026-05-09', qty: 1000 },
        { date: '2026-05-09', qty: 1000 },
      ]), { receivedAt: 't1', dbFile });

      const rows = samples.forMetric('step_count', { dbFile });
      assert.equal(rows.length, 1, 'the repeats did not collapse to one row');
      assert.equal(rows[0].dup_count, 3, 'the repeat count is wrong');
      assert.equal(rows[0].push_ord, 0, 'the first occurrence should own the position');
    } finally { teardown(); }
  });

  test('a later push re-sending the sample once resets dup_count to 1', () => {
    setup();
    try {
      samples.recordPush(m('step_count', [
        { date: '2026-05-09', qty: 1000 },
        { date: '2026-05-09', qty: 1000 },
      ]), { receivedAt: 't1', dbFile });
      samples.recordPush(m('step_count', [
        { date: '2026-05-10', qty: 5 },
        { date: '2026-05-09', qty: 1000 },
      ]), { receivedAt: 't2', dbFile });

      const row = samples.forMetric('step_count', { dbFile })
        .find(r => JSON.parse(r.doc).date === '2026-05-09');
      assert.equal(row.dup_count, 1,
        'dup_count accumulated across pushes; a re-sent sample would be summed twice');
      assert.equal(row.push_ord, 1, 'push_ord did not follow the sample into the newer push');
      assert.equal(row.last_push, 2, 'last_push did not advance');
    } finally { teardown(); }
  });
});
