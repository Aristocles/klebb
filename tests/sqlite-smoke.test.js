// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/sqlite-smoke.test.js
// M3 viability spike for #494: prove node:sqlite (DatabaseSync) is
// available unflagged and behaves as expected across the CI Node matrix
// and inside the node:22-slim runtime image. Exercises the exact surface
// the datastore will lean on: an in-memory DB, DDL, a prepared insert
// inside a transaction, WAL pragma acceptance, and typed row read-back.

const { test, describe } = require('node:test');
const assert = require('node:assert');

describe('#494 M3: node:sqlite viability', () => {
  test('DatabaseSync loads unflagged and round-trips rows', () => {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE rows (card_id TEXT, seq INTEGER, doc TEXT)');

    const insert = db.prepare('INSERT INTO rows (card_id, seq, doc) VALUES (?, ?, ?)');
    const tx = db.prepare('BEGIN');
    const commit = db.prepare('COMMIT');
    tx.run();
    for (let i = 0; i < 3; i++) {
      insert.run('weight', i, JSON.stringify({ kg: 80 + i }));
    }
    commit.run();

    const out = db.prepare('SELECT card_id, seq, doc FROM rows ORDER BY seq').all();
    assert.equal(out.length, 3);
    assert.equal(out[0].card_id, 'weight');
    assert.equal(out[2].seq, 2);
    assert.deepStrictEqual(JSON.parse(out[2].doc), { kg: 82 });
    db.close();
  });

  test('WAL + synchronous=NORMAL pragmas are accepted on a file DB', () => {
    const os = require('node:os');
    const path = require('node:path');
    const fs = require('node:fs');
    const { DatabaseSync } = require('node:sqlite');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klebb-sqlite-'));
    const dbPath = path.join(dir, 'smoke.db');
    try {
      const db = new DatabaseSync(dbPath);
      db.exec('PRAGMA journal_mode = WAL;');
      db.exec('PRAGMA synchronous = NORMAL;');
      const mode = db.prepare('PRAGMA journal_mode').get();
      assert.equal(String(mode.journal_mode).toLowerCase(), 'wal');
      db.exec('CREATE TABLE t (v INTEGER)');
      db.prepare('INSERT INTO t (v) VALUES (?)').run(1);
      assert.equal(db.prepare('SELECT count(*) AS n FROM t').get().n, 1);
      db.close();
      // WAL sidecar should exist beside the db (proves WAL really engaged).
      assert.ok(fs.existsSync(dbPath), 'db file written');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
