// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/health-auto-export.samples-inbox-memory.test.js
//
// Draining the samples inbox must cost memory in proportion to ONE push,
// never the file (#632). A real cross-instance restore fed a samples.json
// of tens of MB into a container with a 256 MB cap; the old drain read and
// JSON.parse'd the whole file and the heap died mid-drain, so boot recovery
// re-crashed on every restart until a pass squeaked under the ceiling. The
// validator's per-file size cap is not the guard: an in-cap file can still
// exceed a small container's heap.
//
// Same discipline as samples-memory: subprocesses with a constrained heap,
// because that is the only honest way to test an out-of-memory condition.
// The whole-file leg is a permanent control: it proves the 48 MB cap is low
// enough to kill the OLD approach on this exact file, so the streaming
// leg's survival means something.

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
const TARGET_BYTES = 60 * 1024 * 1024;

let home;
let file;
let pushCount = 0;

// ~60 MB of realistic pushes, streamed to disk so the TEST process never
// holds the file either. Each push mixes small step/heart-rate samples with
// route-carrying workouts, so the drain binds both many small docs and the
// multi-KB strings that actually killed the production heap.
function generate(target) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'w');
  let bytes = fs.writeSync(fd, '{"version":1,"pushes":[');
  let n = 0;
  while (bytes < target) {
    const day = String((n % 27) + 1).padStart(2, '0');
    const steps = [];
    for (let i = 0; i < 120; i++) {
      steps.push({ date: `2026-03-${day} ${String(i % 24).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00 +1000`, qty: n * 1000 + i, source: 'iPhone' });
    }
    const workouts = [];
    for (let w = 0; w < 30; w++) {
      const route = [];
      for (let p = 0; p < 150; p++) {
        route.push({ latitude: -33.86 - (n * 150 + p) / 1e6, longitude: 151.2 + (w * 150 + p) / 1e6, altitude: 12 + (p % 30) });
      }
      workouts.push({ name: 'Running', start: `2026-03-${day} ${String(w % 24).padStart(2, '0')}:00:00 +1000`, duration: 1800 + w, route });
    }
    const push = {
      receivedAt: `2026-03-${day}T0${n % 10}:00:00.000Z`,
      payload: { data: {
        metrics: [{ name: 'step_count', units: 'count', data: steps }],
        workouts,
      } },
    };
    bytes += fs.writeSync(fd, (n ? ',' : '') + JSON.stringify(push));
    n += 1;
  }
  fs.writeSync(fd, ']}');
  fs.closeSync(fd);
  return n;
}

function inChild(script) {
  const res = spawnSync(process.execPath,
    [`--max-old-space-size=${HEAP_MB}`, '-e', script],
    { encoding: 'utf8', cwd: REPO_ROOT, timeout: 300000,
      env: { ...process.env, HEALTH_HOME: home, HEALTH_HOME_WARNED: '1' } });
  const out = `${res.stdout || ''}${res.stderr || ''}`;
  const ok = /^OK (\d+) (\d+)/m.exec(res.stdout || '');
  return {
    survived: !!ok,
    oom: /heap limit|out of memory|heap_oom/i.test(out),
    pushes: ok ? Number(ok[1]) : 0,
    inserted: ok ? Number(ok[2]) : 0,
    output: out.slice(-400),
  };
}

describe('samples inbox drain survives a small heap', { skip }, () => {
  before(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'klebb-inbox-mem-'));
    file = path.join(home, 'data', 'auto-export', 'samples.json');
    pushCount = generate(TARGET_BYTES);
    assert.ok(fs.statSync(file).size >= TARGET_BYTES, 'fixture came out under target');
  });

  after(() => {
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  });

  test(`control: the old whole-file JSON.parse dies on this file under ${HEAP_MB} MB`, () => {
    // Exactly what drain() used to do. If this ever starts surviving, the
    // heap cap no longer proves anything and both legs need retuning.
    const r = inChild(`
      const fs = require('fs');
      const inbox = require('./health-auto-export/samples-inbox');
      const samples = require('./health-auto-export/samples');
      const parsed = JSON.parse(fs.readFileSync(inbox.FILE, 'utf8'));
      const res = samples.importPushes(parsed.pushes);
      console.log('OK ' + res.pushes + ' ' + res.inserted);
    `);
    assert.ok(!r.survived, `the whole-file parse survived ${HEAP_MB} MB; the control is vacuous:\n${r.output}`);
    assert.ok(r.oom, `the whole-file leg died of something other than the heap:\n${r.output}`);
  });

  test(`the streaming drain completes the same file under ${HEAP_MB} MB with the right push count`, () => {
    const r = inChild(`
      const inbox = require('./health-auto-export/samples-inbox');
      const samples = require('./health-auto-export/samples');
      (async () => {
        const res = await inbox.drain();
        console.log('OK ' + res.pushes + ' ' + res.inserted);
        console.log('COUNT ' + samples.pushCount());
        samples.close();
      })();
    `);
    assert.ok(!r.oom, `the streaming drain ran out of memory:\n${r.output}`);
    assert.ok(r.survived, `the streaming drain did not complete:\n${r.output}`);
    assert.strictEqual(r.pushes, pushCount, 'not every push was imported');
    assert.match(r.output, new RegExp(`COUNT ${pushCount}\\b`), 'the table disagrees with the drain result');
    assert.ok(!fs.existsSync(file), 'samples.json was not renamed aside after the low-heap drain');
  });
});
