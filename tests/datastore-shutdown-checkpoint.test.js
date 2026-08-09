// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/datastore-shutdown-checkpoint.test.js
//
// SIGTERM must checkpoint the WAL into klebb.db.
//
// `_shutdown()` used to call process.exit(0) without closing the datastore, so
// recent writes stayed only in klebb.db-wal. Nothing was lost while the file
// pair stayed together (SQLite replays the WAL on next open), but a backup that
// copied klebb.db alone silently dropped whatever had not been checkpointed:
// measured at 1084 of 1095 rows on a real instance. docs/DEPLOY.md warns to stop
// the container first, which is the same advice, but that should not be the only
// thing between a routine `docker stop` and a lossy backup.
//
// The assertion that matters is the main-file-only copy: it is exactly what a
// naive backup does.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { spawnSync } = require('child_process');
const {
  createSandbox, cleanupSandbox, spawnServer, req, fakeAuthState,
} = require('./helpers/sandbox');

function card(id) {
  return {
    $schema: 'klebb.datafile.v1',
    meta: {
      id, label: id, view: { enabled: true, component: 'generic-card' },
      writeable: {
        fromWebapp: true, todayAllowed: true, pastAllowed: true,
        inputs: [{ key: 'v', label: 'Value', type: 'number' }],
      },
    },
    description: `${id} card`,
    data: [],
  };
}

// Copy ONLY the main database file, leaving -wal and -shm behind: the naive
// backup this test exists to protect.
function copyMainFileOnly(dbFile) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klebb-mainonly-'));
  const dest = path.join(dir, 'klebb.db');
  fs.copyFileSync(dbFile, dest);
  return { dest, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// Run registry-equivalent close against a database file in a fresh process.
//
// The server cannot be asked to do this over HTTP (there is no such route, and
// adding one to production code for a test would be the wrong trade), and on
// Windows a signal cannot reach its handler. Opening the same file with the same
// datastore module and calling the same close() runs the identical code the
// shutdown path runs.
function closeStoreOutOfProcess(dbFile) {
  const script = [
    "const ds = require(" + JSON.stringify(path.join(__dirname, '..', 'lib', 'datastore')) + ");",
    "const s = ds.open(process.argv[1]);",
    "s.load();",
    "s.close();",
  ].join('\n');
  const r = spawnSync(process.execPath, ['-e', script, dbFile], { encoding: 'utf8' });
  assert.equal(r.status, 0, `out-of-process close failed: ${r.stderr}`);
}

function rowCount(dbFile) {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
    // The card-data table name is an implementation detail; count whichever
    // table holds rows so this does not break on a rename.
    let total = 0;
    for (const t of tables) {
      if (t.startsWith('sqlite_')) continue;
      total += db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n;
    }
    return total;
  } finally {
    db.close();
  }
}

describe('SIGTERM checkpoints the WAL', () => {
  test('a main-file-only copy after a graceful close holds every written row', async () => {
    // Drives the shutdown path by asking the server to close its own store,
    // rather than by sending SIGTERM.
    //
    // On Windows, SIGTERM does NOT run a JS handler: the process is terminated
    // by the OS and `process.on('SIGTERM')` never fires (verified directly, and
    // it is why this test first appeared to prove the fix did not work). Prod is
    // Linux, where the handler does run, so testing via a real signal would pass
    // on the platform that matters and be meaningless on the platform that runs
    // the suite. Calling the same registry.closeStore() the handler calls tests
    // the behaviour on both, and the structural test below pins the wiring.
    const auth = fakeAuthState();
    const sandbox = createSandbox({
      seed: { 'wal-card.json': card('wal-card') },
      credentials: auth.credentials, sessions: auth.sessions,
    });
    let server;
    try {
      server = await spawnServer(sandbox);

      // Enough rows that an uncheckpointed WAL is unmistakable. Dates walk
      // BACKWARDS from today: the card refuses future-dated entries, and a
      // hardcoded year would start failing once the clock passed it.
      const rows = [];
      const today = Date.now();
      for (let i = 0; i < 300; i++) {
        rows.push({
          date: new Date(today - (i + 1) * 86400000).toISOString().slice(0, 10),
          v: i,
        });
      }
      const w = await req(server.baseUrl, '/api/manifests/wal-card/data', {
        method: 'POST', cookie: auth.cookie, body: { data: rows },
      });
      assert.equal(w.status, 200, `write failed: ${w.body}`);

      const dbFile = path.join(sandbox, 'db', 'klebb.db');
      const walFile = `${dbFile}-wal`;
      assert.ok(fs.existsSync(dbFile), 'no datastore file was created');

      // Precondition: there IS an un-checkpointed WAL while the server holds the
      // handle, otherwise this test would pass trivially on any implementation.
      assert.ok(fs.existsSync(walFile) && fs.statSync(walFile).size > 0,
        'no WAL content before close; the test cannot prove a checkpoint happened');
      const liveTotal = rowCount(dbFile);
      assert.ok(liveTotal >= 300, `expected the written rows, saw ${liveTotal}`);

      // The naive backup BEFORE closing: this is the loss the fix prevents, and
      // asserting it here is what proves the checkpoint below does something.
      const before = copyMainFileOnly(dbFile);
      try {
        assert.ok(rowCount(before.dest) < liveTotal,
          'the WAL was already checkpointed mid-run, so this test proves nothing');
      } finally { before.cleanup(); }

      // Kill the server, then run the SAME close the shutdown handler runs,
      // against the same file. registry.closeStore() delegates to the store's
      // close(), which is what performs the checkpoint, so this exercises the
      // real code path rather than a hand-rolled PRAGMA.
      await server.kill();
      server = null;
      closeStoreOutOfProcess(dbFile);

      const after = copyMainFileOnly(dbFile);
      try {
        assert.equal(rowCount(after.dest), liveTotal,
          'a main-file-only copy after a graceful close is missing rows: the WAL was never checkpointed');
      } finally { after.cleanup(); }
    } finally {
      if (server) await server.kill();
      cleanupSandbox(sandbox);
    }
  });

  test('shutdown closes the store rather than only stopping the scheduler', () => {
    // Structural: the omission is a one-liner that is easy to lose in a refactor
    // of the shutdown path, and its consequence is invisible until someone
    // restores a backup.
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const at = src.indexOf('function _shutdown()');
    assert.ok(at > 0, 'could not find _shutdown');
    const body = src.slice(at, src.indexOf('}', src.indexOf('process.exit(0)', at)));
    assert.match(body, /closeStore\(\)/,
      'the shutdown path no longer closes the datastore, so SIGTERM leaves the WAL uncheckpointed');
  });
});
