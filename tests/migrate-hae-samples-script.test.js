// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/migrate-hae-samples-script.test.js
//
// scripts/migrate-hae-samples.js folds an existing raw-file archive into the
// samples table (#546). It runs once, on real instances, against the only copy
// of months of health history, so the properties worth pinning are the ones
// that decide whether that data survives:
//
//   - a dry run leaves the live database and the files exactly as they were
//   - a real run only removes the files AFTER replay equivalence verifies
//   - a mismatch aborts with the files still in place
//   - running it twice imports nothing the second time

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { createSandbox, cleanupSandbox } = require('./helpers/sandbox');

const REPO_ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'migrate-hae-samples.js');

let sqliteAvailable = true;
try { require('node:sqlite'); } catch { sqliteAvailable = false; }
const skip = sqliteAvailable ? false : 'node:sqlite unavailable on this Node';

function run(sandbox, args = []) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HEALTH_HOME: sandbox, HEALTH_HOME_WARNED: '1' },
  });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

function rawDir(sandbox) {
  return path.join(sandbox, 'data', 'auto-export', 'raw');
}

// A history with the shapes that make the migration non-trivial: overlapping
// running totals, an intra-push repeat, an uncatalogued metric, and workouts.
function seedArchive(sandbox) {
  const dir = rawDir(sandbox);
  fs.mkdirSync(dir, { recursive: true });
  const pushes = [
    { data: { metrics: [
      { name: 'step_count', data: [
        { date: '2026-05-07', qty: 8000 }, { date: '2026-05-08', qty: 3000 }] },
      { name: 'vo2_max', units: 'mL/min/kg', data: [{ date: '2026-05-07', qty: 47.3 }] },
    ]}},
    { data: { metrics: [
      { name: 'step_count', data: [
        { date: '2026-05-08', qty: 9500 },
        { date: '2026-05-09', qty: 1200 },
        { date: '2026-05-09', qty: 1200 }] },
      { name: 'sleep_analysis', data: [
        { date: '2026-05-08', totalSleep: 8.5 }, { date: '2026-05-08', totalSleep: 6.25 }] },
    ], workouts: [
      { name: 'Running', start: '2026-05-08 07:00:00 +1000', duration: 1800 },
    ]}},
    { data: { metrics: [
      { name: 'step_count', data: [{ date: '2026-05-09', qty: 7400 }] },
    ]}},
  ];
  pushes.forEach((p, i) => {
    const stamp = `2026-05-0${7 + i}T000000000Z`;
    fs.writeFileSync(path.join(dir, `${stamp}.json`), JSON.stringify(p));
  });
  return pushes.length;
}

function dbExists(sandbox) {
  return fs.existsSync(path.join(sandbox, 'db', 'klebb.db'));
}

function sampleCount(sandbox) {
  const file = path.join(sandbox, 'db', 'klebb.db');
  if (!fs.existsSync(file)) return 0;
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const t = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='hae_samples'").all();
    if (t.length === 0) return 0;
    return db.prepare('SELECT COUNT(*) AS n FROM hae_samples').get().n;
  } finally {
    db.close();
  }
}

describe('migrate-hae-samples.js', { skip }, () => {
  test('no archive: reports and exits cleanly', () => {
    const sandbox = createSandbox();
    try {
      const r = run(sandbox);
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /no raw archive/);
    } finally { cleanupSandbox(sandbox); }
  });

  test('dry run verifies without touching the live database or the files', () => {
    const sandbox = createSandbox();
    try {
      const count = seedArchive(sandbox);
      const before = fs.readdirSync(rawDir(sandbox)).sort();

      const r = run(sandbox, ['--dry-run']);
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /dry run complete/);
      assert.match(r.out, new RegExp(`pushes imported : ${count}`));
      // Every catalogued metric present verified OK.
      assert.match(r.out, /OK {4}step_count/);
      assert.match(r.out, /OK {4}sleep_analysis/);
      assert.match(r.out, /OK {4}workouts/);

      assert.deepStrictEqual(fs.readdirSync(rawDir(sandbox)).sort(), before,
        'a dry run modified the archive');
      assert.equal(sampleCount(sandbox), 0,
        'a dry run wrote samples into the live database');
    } finally { cleanupSandbox(sandbox); }
  });

  test('a real run imports, verifies, then moves the archive aside', () => {
    const sandbox = createSandbox();
    try {
      seedArchive(sandbox);
      const r = run(sandbox);
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /migration complete/);

      assert.ok(dbExists(sandbox), 'no database was created');
      assert.ok(sampleCount(sandbox) > 0, 'no samples were imported');

      assert.equal(fs.existsSync(rawDir(sandbox)), false,
        'the archive is still in place after a successful migration');
      const moved = fs.readdirSync(path.join(sandbox, 'data', 'auto-export'))
        .filter(f => f.startsWith('raw.migrated-'));
      assert.equal(moved.length, 1, 'the archive was deleted rather than moved aside');
      // Moved, not emptied: the files are the rollback path until pruned.
      assert.equal(
        fs.readdirSync(path.join(sandbox, 'data', 'auto-export', moved[0])).length, 3);

      // The duplication figure is reported, which is the whole point of the
      // exercise and the number an operator sanity-checks against.
      assert.match(r.out, /duplication\s+:/);
      // Uncatalogued metrics are listed as stored for later, not dropped.
      assert.match(r.out, /vo2_max.*not in catalogue/);
    } finally { cleanupSandbox(sandbox); }
  });

  test('running twice imports nothing the second time', () => {
    const sandbox = createSandbox();
    try {
      seedArchive(sandbox);
      assert.equal(run(sandbox).code, 0);
      const after = sampleCount(sandbox);

      // Put the archive back to simulate an operator re-running against a
      // restored copy: the source filenames are the idempotency key.
      const moved = fs.readdirSync(path.join(sandbox, 'data', 'auto-export'))
        .find(f => f.startsWith('raw.migrated-'));
      fs.renameSync(path.join(sandbox, 'data', 'auto-export', moved), rawDir(sandbox));

      const second = run(sandbox);
      assert.equal(second.code, 0, second.out);
      assert.match(second.out, /already present : 3/);
      assert.equal(sampleCount(sandbox), after,
        'a second run stored samples again');
    } finally { cleanupSandbox(sandbox); }
  });

  test('a corrupt archive file is skipped and left in place', () => {
    const sandbox = createSandbox();
    try {
      seedArchive(sandbox);
      fs.writeFileSync(path.join(rawDir(sandbox), 'zzz-broken.json'), '{ not json');
      const r = run(sandbox);
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /unreadable {6}: 1/);
      // It still moved aside with the rest: the file is preserved, not deleted.
      const moved = fs.readdirSync(path.join(sandbox, 'data', 'auto-export'))
        .find(f => f.startsWith('raw.migrated-'));
      assert.ok(fs.existsSync(
        path.join(sandbox, 'data', 'auto-export', moved, 'zzz-broken.json')),
        'an unreadable file was destroyed rather than preserved');
    } finally { cleanupSandbox(sandbox); }
  });

  test('a verification mismatch aborts with the archive untouched', () => {
    // Injects a divergence by corrupting the stored samples between import and
    // verification: proves the gate is real rather than decorative. Without a
    // way to fail, "verified" in the output means nothing.
    const sandbox = createSandbox();
    try {
      seedArchive(sandbox);
      const r = run(sandbox, ['--dry-run']);
      assert.equal(r.code, 0, r.out);

      // Now import for real, then damage a row and re-run: the second run finds
      // the pushes already present, so it verifies against damaged state.
      assert.equal(run(sandbox).code, 0);
      const moved = fs.readdirSync(path.join(sandbox, 'data', 'auto-export'))
        .find(f => f.startsWith('raw.migrated-'));
      fs.renameSync(path.join(sandbox, 'data', 'auto-export', moved), rawDir(sandbox));

      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(path.join(sandbox, 'db', 'klebb.db'));
      db.exec("DELETE FROM hae_samples WHERE metric = 'step_count'");
      db.close();

      const bad = run(sandbox);
      assert.equal(bad.code, 1, `expected a non-zero exit:\n${bad.out}`);
      assert.match(bad.out, /FAILED/);
      assert.match(bad.out, /FAIL {2}step_count/);
      assert.ok(fs.existsSync(rawDir(sandbox)),
        'the archive was removed despite a verification failure');
    } finally { cleanupSandbox(sandbox); }
  });

  test('--prune deletes the moved-aside archive', () => {
    const sandbox = createSandbox();
    try {
      seedArchive(sandbox);
      assert.equal(run(sandbox).code, 0);
      const r = run(sandbox, ['--prune']);
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /pruned raw\.migrated-/);
      const left = fs.readdirSync(path.join(sandbox, 'data', 'auto-export'))
        .filter(f => f.startsWith('raw'));
      assert.deepEqual(left, []);
    } finally { cleanupSandbox(sandbox); }
  });

  test('--prune with nothing to prune is a no-op', () => {
    const sandbox = createSandbox();
    try {
      const r = run(sandbox, ['--prune']);
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /nothing to prune/);
    } finally { cleanupSandbox(sandbox); }
  });
});
