// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/export-to.test.js
// exportTo(targetDir, opts), the in-process entry point lifted out of the
// export CLI (#615). Pins the two things an in-process caller depends on:
// it throws on failure instead of exiting, and it never closes the shared
// samples module singleton. Inside a live server that handle belongs to the
// ingest path, so an exportTo that closed it would take the server's own
// handle down with it.
//
// Fresh-require tests only — never mix spawnServer sandbox tests into this
// file (require-cache purge makes the runner hang).

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let sqliteAvailable = true;
try { require('node:sqlite'); } catch { sqliteAvailable = false; }
const skip = sqliteAvailable ? false : 'node:sqlite unavailable on this Node';

let home;
let walFile;
let samples;
let exportTo;
let targets;

function fresh() {
  delete require.cache[require.resolve('../config/paths')];
  delete require.cache[require.resolve('../health-auto-export/samples')];
  delete require.cache[require.resolve('../health-auto-export/helpers')];
  delete require.cache[require.resolve('../scripts/export-embed')];
  samples = require('../health-auto-export/samples');
  ({ exportTo } = require('../scripts/export-embed'));
}

function newTarget() {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'klebb-exportto-'));
  targets.push(t);
  return t;
}

describe('exportTo in-process', { skip }, () => {
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'klebb-exportto-home-'));
    process.env.HEALTH_HOME = home;
    process.env.HEALTH_HOME_WARNED = '1';
    targets = [];
    fs.mkdirSync(path.join(home, 'data'));
    fs.writeFileSync(path.join(home, 'data', 'weight.json'), JSON.stringify({
      $schema: 'klebb.datafile.v1',
      meta: { id: 'weight', label: 'Weight', view: { enabled: true, component: 'generic-card' } },
      data: [{ date: '2026-05-01', kg: 80 }],
    }, null, 2));
    walFile = path.join(home, 'db', 'klebb.db-wal');
    fresh();
    samples.recordPush({ data: { metrics: [
      { name: 'step_count', units: 'count', data: [{ date: '2026-05-01', qty: 4200 }] },
    ] } }, { receivedAt: 't1' });
  });

  afterEach(() => {
    try { samples.close(); } catch {}
    for (const t of targets) { try { fs.rmSync(t, { recursive: true, force: true }); } catch {} }
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
    delete process.env.HEALTH_HOME;
  });

  test('runs twice in a row and leaves the shared samples handle open', () => {
    assert.ok(fs.existsSync(walFile), 'precondition: the samples handle has a live WAL');

    const realClose = samples.close;
    let closes = 0;
    samples.close = (...args) => { closes += 1; return realClose.apply(null, args); };
    let first; let second;
    try {
      first = exportTo(newTarget());
      second = exportTo(newTarget());
    } finally {
      samples.close = realClose;
    }

    for (const r of [first, second]) {
      assert.equal(r.counts.inline, 1);
      assert.equal(r.counts.haePushes, 1);
      assert.ok(fs.existsSync(path.join(r.target, 'klebb-export.json')), 'provenance manifest written');
      assert.ok(fs.existsSync(path.join(r.target, 'data', 'auto-export', 'samples.json')));
    }

    assert.equal(closes, 0, 'exportTo closed the shared samples singleton');
    // Independent evidence from the filesystem: closing the last connection
    // checkpoints and deletes the WAL, so the sidecar surviving both exports
    // means the singleton's handle really stayed open throughout.
    assert.ok(fs.existsSync(walFile),
      'the WAL sidecar vanished: something closed the samples handle');

    // And the module keeps working through the SAME handle, no reopen.
    const next = samples.recordPush({ data: { metrics: [
      { name: 'step_count', units: 'count', data: [{ date: '2026-05-02', qty: 5100 }] },
    ] } }, { receivedAt: 't2' });
    assert.equal(next.pushSeq, 2);
    assert.equal(samples.pushCount(), 2);
  });

  test('throws instead of exiting, and a failed call leaves the module usable', () => {
    const occupied = newTarget();
    fs.writeFileSync(path.join(occupied, 'stray.txt'), 'x');
    assert.throws(() => exportTo(occupied), /exists and is not empty/);
    assert.throws(() => exportTo(path.join(home, 'data', 'nested')),
      /must not sit inside the data dir/);

    assert.equal(samples.pushCount(), 1, 'the samples module survived the failed calls');
    const ok = exportTo(newTarget());
    assert.equal(ok.counts.haePushes, 1);
  });

  test('the streamed samples.json is byte-identical to the whole-array form (#655)', () => {
    // The writer moved from one JSON.stringify over the full pushes array to
    // an incremental per-push emit. Downstream (drain, validate, humans,
    // inventory checksums pinned by contract tests) must not be able to tell.
    samples.recordPush({ data: {
      metrics: [{ name: 'heart_rate_variability', data: [
        { date: '2026-05-02 02:00:00 +1000', qty: 41.20000000000001 },
        { date: '2026-05-02 02:00:00 +1000', qty: 41.20000000000001 },
      ] }],
      workouts: [{ name: 'Running', start: '2026-05-02 07:00:00 +1000', duration: 1800 }],
    } }, { receivedAt: 't2' });

    const target = newTarget();
    exportTo(target);
    const file = path.join(target, 'data', 'auto-export', 'samples.json');
    const streamed = fs.readFileSync(file, 'utf8');
    const whole = JSON.stringify({ version: 1, pushes: samples.exportPushes() }, null, 2);
    assert.strictEqual(streamed, whole);
  });

  test('no pushes means no samples file and no empty auto-export dir', () => {
    samples.wipeAll();
    const target = newTarget();
    const res = exportTo(target);
    assert.equal(res.counts.haePushes, 0);
    assert.ok(!fs.existsSync(path.join(target, 'data', 'auto-export')),
      'an empty export must not leave the directory behind');
  });
});
