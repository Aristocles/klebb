// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/migrate-data-to-db.test.js
// Tests for scripts/migrate-data-to-db.js (the card-data -> datastore
// migration wrapper) and the scripts/dump-card-data.js diff helper.
//
// The migrator is CLI-style; the real-run path spins up the registry against
// a sandbox, so tests invoke it via execSync with --dir pointing at the
// sandbox data dir (which sets HEALTH_HOME to the parent so db/ lands beside
// it).

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { createSandbox, cleanupSandbox } = require('./helpers/sandbox');
const { readStored } = require('./helpers/datastore-readback');

const REPO_ROOT = path.resolve(__dirname, '..');
const MIGRATE = path.join(REPO_ROOT, 'scripts', 'migrate-data-to-db.js');

// node:sqlite is unflagged from 22.13; the CI matrix carried a Node 20 leg
// until the engines floor bumped. Skip where the module is unavailable.
let sqliteAvailable = true;
try { require('node:sqlite'); } catch { sqliteAvailable = false; }
const skip = sqliteAvailable ? false : 'node:sqlite unavailable on this Node';

function run(args, opts = {}) {
  try {
    const stdout = execSync(`node ${MIGRATE} ${args.join(' ')}`, {
      encoding: 'utf8',
      env: { ...process.env, HEALTH_HOME_WARNED: '1' },
    });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status || 1, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

const WEIGHT = {
  $schema: 'klebb.datafile.v1',
  meta: { id: 'weight', label: 'Weight', view: { enabled: true, component: 'generic-card' } },
  description: 'body weight',
  data: [{ date: '2026-04-20', kg: 85 }, { date: '2026-04-21', kg: 84.6 }],
};

const PEPTIDES = {
  $schema: 'klebb.datafile.v1',
  meta: { id: 'peptides', label: 'Schedule', view: { enabled: true, component: 'schedule-card' } },
  data: { items: [{ name: 'BPC-157', doses: [{ scheduledDate: '2026-04-29' }] }], groups: [] },
};

describe('migrate-data-to-db.js --dry-run', { skip }, () => {
  test('reports round-trip OK per candidate and writes nothing', () => {
    const sandbox = createSandbox({ seed: { 'weight.json': WEIGHT, 'peptides.json': PEPTIDES } });
    try {
      const before = fs.readFileSync(path.join(sandbox, 'data', 'weight.json'), 'utf8');
      const { code, stdout } = run(['--dry-run', `--dir ${path.join(sandbox, 'data')}`]);
      assert.equal(code, 0, stdout);
      assert.match(stdout, /weight \(2 row\(s\)\) round-trips/);
      assert.match(stdout, /peptides \(1 row\(s\)\) round-trips/);
      assert.match(stdout, /Safe to migrate/);
      // Nothing written: file unchanged, no db, no backups.
      assert.equal(fs.readFileSync(path.join(sandbox, 'data', 'weight.json'), 'utf8'), before);
      assert.ok(!fs.existsSync(path.join(sandbox, 'db')), 'dry-run creates no db');
      const backups = fs.readdirSync(path.join(sandbox, 'data')).filter(f => /pre-import/.test(f));
      assert.equal(backups.length, 0, 'dry-run creates no backups');
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('skips non-manifest files with a reason', () => {
    const sandbox = createSandbox({ seed: { 'weight.json': WEIGHT } });
    fs.writeFileSync(path.join(sandbox, 'data', 'config.json'), JSON.stringify({ hae: { token: 'x' } }));
    fs.writeFileSync(path.join(sandbox, 'data', 'legacy.json'), JSON.stringify([{ bare: 'array' }]));
    try {
      const { code, stdout } = run(['--dry-run', `--dir ${path.join(sandbox, 'data')}`]);
      assert.equal(code, 0, stdout);
      assert.match(stdout, /skipped config\.json/);
      assert.match(stdout, /skipped legacy\.json/);
    } finally {
      cleanupSandbox(sandbox);
    }
  });
});

describe('migrate-data-to-db.js (real run)', { skip }, () => {
  test('imports data, strips files, verifies deep-equal, and is idempotent', () => {
    const sandbox = createSandbox({ seed: { 'weight.json': WEIGHT, 'peptides.json': PEPTIDES } });
    try {
      const { code, stdout } = run([`--dir ${path.join(sandbox, 'data')}`]);
      assert.equal(code, 0, stdout);
      assert.match(stdout, /weight \(2 row\(s\)\) migrated \+ verified/);
      assert.match(stdout, /peptides \(1 row\(s\)\) migrated \+ verified/);
      assert.match(stdout, /Migration complete/);

      // Files stripped to meta-only, backups beside them.
      const weightFile = JSON.parse(fs.readFileSync(path.join(sandbox, 'data', 'weight.json'), 'utf8'));
      assert.equal('data' in weightFile, false);
      assert.equal(weightFile.description, 'body weight');
      const backups = fs.readdirSync(path.join(sandbox, 'data')).filter(f => /weight\.json\.pre-import-.*\.json/.test(f));
      assert.equal(backups.length, 1);

      // Data is in the store, deep-equal to the original.
      assert.deepStrictEqual(readStored(sandbox, 'weight'), WEIGHT.data);
      assert.deepStrictEqual(readStored(sandbox, 'peptides'), PEPTIDES.data);

      // Idempotent: a second run finds no data keys (already-migrated), still 0.
      const second = run([`--dir ${path.join(sandbox, 'data')}`]);
      assert.equal(second.code, 0, second.stdout);
      assert.match(second.stdout, /already-migrated: 2/);
      // Store value unchanged after the no-op second run.
      assert.deepStrictEqual(readStored(sandbox, 'weight'), WEIGHT.data);
    } finally {
      cleanupSandbox(sandbox);
    }
  });
});

describe('dump-card-data.js diff', { skip }, () => {
  const { diff } = require('../scripts/dump-card-data');
  test('deep-equal dumps pass; a divergence fails and names the card', () => {
    const root = createSandbox();
    const a = path.join(root, 'dumpA');
    const b = path.join(root, 'dumpB');
    fs.mkdirSync(a); fs.mkdirSync(b);
    fs.writeFileSync(path.join(a, 'weight.json'), JSON.stringify([{ date: '2026-01-01', kg: 80 }]));
    fs.writeFileSync(path.join(b, 'weight.json'), JSON.stringify([{ date: '2026-01-01', kg: 80 }]));
    try {
      assert.equal(diff(a, b), 0, 'identical dumps deep-equal');
      // Diverge one card.
      fs.writeFileSync(path.join(b, 'weight.json'), JSON.stringify([{ date: '2026-01-01', kg: 81 }]));
      assert.equal(diff(a, b), 1, 'divergent dumps report a difference');
    } finally {
      cleanupSandbox(root);
    }
  });
});
