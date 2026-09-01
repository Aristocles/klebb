// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/export-memory.test.js
//
// Exporting must cost memory in proportion to ONE push, never the table
// (#655). A single GET /api/export on a real-sized history OOM'd a
// memory-capped container: the samples read was one .all() that
// materialised every row (plus a JS string per doc column) before a byte
// was written, and the zip writer then held the raw and deflated copies of
// the staged file at once.
//
// Same discipline as the #632/#639 suites: subprocesses with a constrained
// heap. The whole-table leg is a permanent control proving the cap kills
// the OLD read on this exact table, so the streamed leg's survival means
// something.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

let sqliteAvailable = true;
try { require('node:sqlite'); } catch { sqliteAvailable = false; }
const skip = sqliteAvailable ? false : 'node:sqlite unavailable on this Node';

const REPO_ROOT = path.resolve(__dirname, '..');
const HEAP_MB = 48;
const TARGET_DOC_BYTES = 60 * 1024 * 1024;

let home;
let dbFile;
let pushCount = 0;

// ~60MB of stored docs: route-heavy workouts so individual docs are multi-KB
// strings (what actually blew the production heap), seeded through the real
// ingest path in THIS process (uncapped).
function seed() {
  fs.mkdirSync(path.join(home, 'data'), { recursive: true });
  process.env.HEALTH_HOME = home;
  process.env.HEALTH_HOME_WARNED = '1';
  delete require.cache[require.resolve('../config/paths')];
  delete require.cache[require.resolve('../health-auto-export/samples')];
  delete require.cache[require.resolve('../health-auto-export/helpers')];
  const samples = require('../health-auto-export/samples');
  let bytes = 0;
  let n = 0;
  while (bytes < TARGET_DOC_BYTES) {
    const day = String((n % 27) + 1).padStart(2, '0');
    const workouts = [];
    for (let w = 0; w < 30; w++) {
      const route = [];
      for (let p = 0; p < 150; p++) {
        route.push({ latitude: -33.86 - (n * 150 + p) / 1e6, longitude: 151.2 + (w * 150 + p) / 1e6, altitude: 12 + (p % 30) });
      }
      workouts.push({ name: 'Running', start: `2026-03-${day} ${String(w % 24).padStart(2, '0')}:00:00 +1000`, duration: 1800 + w, route });
    }
    const steps = [];
    for (let i = 0; i < 120; i++) {
      steps.push({ date: `2026-03-${day} ${String(i % 24).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00 +1000`, qty: n * 1000 + i, source: 'iPhone' });
    }
    const payload = { data: { metrics: [{ name: 'step_count', units: 'count', data: steps }], workouts } };
    bytes += JSON.stringify(payload).length;
    samples.recordPush(payload, { receivedAt: `2026-03-${day}T0${n % 10}:00:00.000Z` });
    n += 1;
  }
  samples.close();
  delete process.env.HEALTH_HOME;
  return n;
}

function inChild(script) {
  const res = spawnSync(process.execPath,
    [`--max-old-space-size=${HEAP_MB}`, '-e', script],
    { encoding: 'utf8', cwd: REPO_ROOT, timeout: 300000,
      env: { ...process.env, HEALTH_HOME: home, HEALTH_HOME_WARNED: '1' } });
  const out = `${res.stdout || ''}${res.stderr || ''}`;
  const ok = /^OK (\d+)/m.exec(res.stdout || '');
  return {
    survived: !!ok,
    oom: /heap limit|out of memory|heap_oom/i.test(out),
    pushes: ok ? Number(ok[1]) : 0,
    output: out.slice(-400),
  };
}

describe('export survives a small heap', { skip }, () => {
  before(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'klebb-export-mem-'));
    dbFile = path.join(home, 'db', 'klebb.db');
    pushCount = seed();
    assert.ok(fs.statSync(dbFile).size >= TARGET_DOC_BYTES / 2, 'fixture table came out too small');
  });

  after(() => {
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  });

  test(`control: the whole-table read dies on this table under ${HEAP_MB} MB`, () => {
    // Exactly what exportPushes used to do. If this ever starts surviving,
    // the heap cap no longer proves anything and both legs need retuning.
    const r = inChild(`
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(${JSON.stringify(dbFile)}, { readOnly: true });
      const rows = db.prepare(
        'SELECT s.metric, s.metric_meta, s.doc, s.dup_count, s.last_push, p.received_at '
        + 'FROM hae_samples s JOIN hae_pushes p ON p.push_seq = s.last_push '
        + 'ORDER BY s.last_push, s.push_ord').all();
      const docs = rows.map(r => JSON.parse(r.doc));
      console.log('OK ' + docs.length);
    `);
    assert.ok(!r.survived, `the whole-table read survived ${HEAP_MB} MB; the control is vacuous:\n${r.output}`);
    assert.ok(r.oom, `the whole-table leg died of something other than the heap:\n${r.output}`);
  });

  test(`exportTo + writeZip complete the same table under ${HEAP_MB} MB`, () => {
    const r = inChild(`
      const fs = require('fs');
      const os = require('os');
      const path = require('path');
      const { exportTo } = require('./scripts/export-embed');
      const { writeZip } = require('./lib/zip/write');
      const samples = require('./health-auto-export/samples');
      const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'klebb-exp-mem-')), 'tree');
      (async () => {
        const res = exportTo(target);
        const file = path.join(target, 'data', 'auto-export', 'samples.json');
        const zip = path.join(path.dirname(target), 'out.zip');
        await writeZip(zip, [{ name: 'data/auto-export/samples.json', sourcePath: file }]);
        if (!fs.statSync(zip).size) throw new Error('empty zip');
        if (fs.existsSync(zip + '.spill')) throw new Error('spill file left behind');
        console.log('OK ' + res.counts.haePushes);
        samples.close();
        fs.rmSync(path.dirname(target), { recursive: true, force: true });
      })().catch(e => { console.error(e.stack || String(e)); process.exit(1); });
    `);
    assert.ok(!r.oom, `the streamed export ran out of memory:\n${r.output}`);
    assert.ok(r.survived, `the streamed export did not complete:\n${r.output}`);
    assert.strictEqual(r.pushes, pushCount, 'not every push was exported');
  });
});
