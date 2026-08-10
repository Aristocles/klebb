// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/reingest-hae-script.test.js
// Integration test for scripts/reingest-hae.js. The manifest file is
// meta-only (rows live in the datastore), so the pre-reingest backup must
// re-embed the card's current data: restoring the backup over <id>.json
// re-imports those rows via the import inbox.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { createSandbox, cleanupSandbox } = require('./helpers/sandbox');
const { readStored } = require('./helpers/datastore-readback');

const REPO_ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'reingest-hae.js');

let sqliteAvailable = true;
try { require('node:sqlite'); } catch { sqliteAvailable = false; }
const skip = sqliteAvailable ? false : 'node:sqlite unavailable on this Node';

const STEPS = {
  $schema: 'klebb.datafile.v1',
  meta: {
    id: 'steps', label: 'Steps',
    ingest: { source: 'hae', metric: 'step_count' },
    view: { enabled: true, component: 'generic-card' },
  },
  data: [{ date: '2026-05-01', count: 1111 }],
};

function run(sandbox, args = []) {
  return execSync(`node ${SCRIPT} ${args.join(' ')}`, {
    encoding: 'utf8',
    env: { ...process.env, HEALTH_HOME: sandbox, HEALTH_HOME_WARNED: '1' },
  });
}

// Seed a stored push the way a live ingest would. Runs out-of-process against
// the sandbox's database so this file never opens a second handle of its own,
// and so the seeding uses exactly the code the endpoint uses.
function writeRawPush(sandbox, payload) {
  const script = 'const s=require(' + JSON.stringify(
    path.join(REPO_ROOT, 'health-auto-export', 'samples')) + ');'
    + 's.recordPush(JSON.parse(process.argv[1]),{receivedAt:"2026-05-02T00:00:00.000Z"});'
    + 's.close();';
  execSync(`node -e ${JSON.stringify(script)} ${JSON.stringify(JSON.stringify(payload))}`, {
    encoding: 'utf8',
    env: { ...process.env, HEALTH_HOME: sandbox, HEALTH_HOME_WARNED: '1' },
  });
}

describe('reingest-hae.js', { skip }, () => {
  test('backup re-embeds current rows; datastore holds the replayed state', () => {
    const sandbox = createSandbox({ seed: { 'steps.json': STEPS } });
    try {
      writeRawPush(sandbox, { data: { metrics: [
        { name: 'step_count', data: [{ date: '2026-05-02 08:00:00 +1000', qty: 2222 }] },
      ]}});

      const out = run(sandbox, ['--id=steps']);
      assert.match(out, /steps: rowsWritten=1/);

      // Backup carries the pre-reingest rows re-embedded, restorable via
      // the import inbox.
      const dataDir = path.join(sandbox, 'data');
      const backups = fs.readdirSync(dataDir)
        .filter(f => f.startsWith('steps.json.pre-reingest-'));
      assert.equal(backups.length, 1, 'exactly one pre-reingest backup');
      const backup = JSON.parse(fs.readFileSync(path.join(dataDir, backups[0]), 'utf8'));
      assert.deepStrictEqual(backup.data, [{ date: '2026-05-01', count: 1111 }]);
      assert.equal(backup.meta.id, 'steps');

      // The datastore holds the replayed archive state, not the old rows.
      const stored = readStored(sandbox, 'steps');
      assert.deepStrictEqual(stored, [{ date: '2026-05-02', count: 2222 }]);

      // The canonical manifest file stays meta-only.
      const file = JSON.parse(fs.readFileSync(path.join(dataDir, 'steps.json'), 'utf8'));
      assert.ok(!('data' in file), 'manifest file must not regain a data key');
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('dry-run reports without writing', () => {
    const sandbox = createSandbox({ seed: { 'steps.json': STEPS } });
    try {
      writeRawPush(sandbox, { data: { metrics: [
        { name: 'step_count', data: [{ date: '2026-05-02 08:00:00 +1000', qty: 2222 }] },
      ]}});

      const out = run(sandbox, ['--dry-run']);
      assert.match(out, /would re-ingest/);

      const dataDir = path.join(sandbox, 'data');
      const backups = fs.readdirSync(dataDir)
        .filter(f => f.startsWith('steps.json.pre-reingest-'));
      assert.equal(backups.length, 0, 'dry-run must not write backups');
      // Boot import (registry.init inside the script) stores the seeded
      // rows; dry-run must leave them untouched.
      const stored = readStored(sandbox, 'steps');
      assert.deepStrictEqual(stored, [{ date: '2026-05-01', count: 1111 }]);
    } finally {
      cleanupSandbox(sandbox);
    }
  });
});
