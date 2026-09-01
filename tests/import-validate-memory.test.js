// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/import-validate-memory.test.js
//
// Validating an import tree must cost memory in proportion to ONE push,
// never the samples file (#639). The first real-sized restore into a
// memory-capped container was OOM-killed inside POST /api/import/start:
// the drain had been streaming since #632, but validateTree still read and
// JSON.parse'd the whole samples.json for its plan counts, twice per job,
// and hashed it whole a third time for the inventory check.
//
// Same discipline as the #632 suites: subprocesses with a constrained heap,
// because that is the only honest way to test an out-of-memory condition.
// The whole-file leg is a permanent control: it proves the 48 MB cap is low
// enough to kill the OLD approach on this exact file, so the streaming
// leg's survival means something.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const HEAP_MB = 48;
const TARGET_BYTES = 60 * 1024 * 1024;

let home;
let tree;
let samplesFile;
let pushCount = 0;

// ~60 MB of realistic pushes, streamed to disk so the TEST process never
// holds the file either. Same shape as the #632 fixtures: many small
// samples plus multi-KB route strings per push.
function generate(target) {
  fs.mkdirSync(path.dirname(samplesFile), { recursive: true });
  const fd = fs.openSync(samplesFile, 'w');
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

function sha256Chunked(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(1024 * 1024);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      hash.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function inChild(script) {
  const res = spawnSync(process.execPath,
    [`--max-old-space-size=${HEAP_MB}`, '-e', script],
    { encoding: 'utf8', cwd: REPO_ROOT, timeout: 300000,
      env: { ...process.env, HEALTH_HOME: home, HEALTH_HOME_WARNED: '1' } });
  const out = `${res.stdout || ''}${res.stderr || ''}`;
  const ok = /^OK (\d+) (true|false)/m.exec(res.stdout || '');
  return {
    survived: !!ok,
    oom: /heap limit|out of memory|heap_oom/i.test(out),
    pushes: ok ? Number(ok[1]) : 0,
    ok: ok ? ok[2] === 'true' : false,
    output: out.slice(-400),
  };
}

describe('validateTree survives a small heap', () => {
  before(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'klebb-val-mem-'));
    tree = path.join(home, 'tree');
    samplesFile = path.join(tree, 'data', 'auto-export', 'samples.json');
    pushCount = generate(TARGET_BYTES);
    assert.ok(fs.statSync(samplesFile).size >= TARGET_BYTES, 'fixture came out under target');
    // A real manifest with the samples checksum, so the streamed scan AND
    // the chunked inventory hash both run under the cap.
    fs.writeFileSync(path.join(tree, 'klebb-export.json'), JSON.stringify({
      format: 'klebb.export.v1',
      formatVersion: 1,
      appVersion: '0.0.0',
      exportedAt: '2026-08-17T00:00:00.000Z',
      inventory: {
        cards: [],
        samples: { file: 'data/auto-export/samples.json', pushes: pushCount, sha256: sha256Chunked(samplesFile) },
        reports: [],
        other: [],
      },
    }, null, 2));
  });

  after(() => {
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  });

  test(`control: the old whole-file parse dies on this file under ${HEAP_MB} MB`, () => {
    // Exactly what validateTree used to do with samples.json. If this ever
    // starts surviving, the heap cap no longer proves anything and both
    // legs need retuning.
    const r = inChild(`
      const fs = require('fs');
      const s = JSON.parse(fs.readFileSync(${JSON.stringify(samplesFile)}, 'utf8'));
      const empty = s.pushes.filter(p => !p || !p.payload).length;
      console.log('OK ' + (s.pushes.length - empty) + ' true');
    `);
    assert.ok(!r.survived, `the whole-file parse survived ${HEAP_MB} MB; the control is vacuous:\n${r.output}`);
    assert.ok(r.oom, `the whole-file leg died of something other than the heap:\n${r.output}`);
  });

  test(`the streamed validateTree completes the same tree under ${HEAP_MB} MB with the right plan`, () => {
    const r = inChild(`
      const { validateTree } = require('./lib/import/validate');
      validateTree(${JSON.stringify(tree)}).then(res => {
        console.log('OK ' + res.plan.samplesPushes + ' ' + res.ok);
      });
    `);
    assert.ok(!r.oom, `the streamed validate ran out of memory:\n${r.output}`);
    assert.ok(r.survived, `the streamed validate did not complete:\n${r.output}`);
    assert.strictEqual(r.pushes, pushCount, 'plan.samplesPushes disagrees with the fixture');
    assert.strictEqual(r.ok, true, 'the tree must validate clean, checksum included');
  });
});
