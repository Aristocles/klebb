// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Child-only synthetic SQLite instrumentation. Never use in a real-data process.
// This observes the actual handle and injects at native transaction boundaries.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite = require('node:sqlite');
const home = path.resolve(process.env.HEALTH_HOME || '');
const temp = path.resolve(os.tmpdir());
assert.ok(home.startsWith(temp + path.sep) && path.basename(home).startsWith('eh-test-'),
  'faults require an independently owned synthetic temp home');
const databasePath = path.join(home, 'db', 'klebb.db');
const observationPath = path.resolve(process.env.INDEPENDENT_INGEST_OBSERVATIONS || '');
assert.equal(path.dirname(observationPath), home, 'observations stay in the same synthetic home');
const operation = process.env.INDEPENDENT_INGEST_FAULT || 'observe';
assert.ok(['observe', 'sqlite-full', 'before-commit-kill', 'after-commit-kill',
  'outbox-insert-full'].includes(operation));
const OriginalDatabase = sqlite.DatabaseSync;
const insert = table => new RegExp(
  '^\\s*(?:INSERT\\s+(?:OR\\s+\\w+\\s+)?INTO|REPLACE\\s+INTO)\\s+["`\\[]?' +
  table + '(?:["`\\]]|\\b)', 'i');
const rawInsert = insert('health_records');
const receiptInsert = insert('health_batch_receipts');
const outboxInsert = insert('health_projection_outbox');
const legacyInsert = insert('rows');
const begin = /^\s*BEGIN(?:\s|;|$)/i;
const commit = /^\s*(?:COMMIT|END)(?:\s|;|$)/i;
const rollback = /^\s*ROLLBACK(?:\s|;|$)/i;
let fired = false;
let nextHandleId = 0;
let nextTransactionId = 0;
function observation(event) {
  fs.appendFileSync(observationPath, JSON.stringify(event) + '\n', { encoding: 'utf8', mode: 0o600 });
}
sqlite.DatabaseSync = new Proxy(OriginalDatabase, {
  construct(target, args) {
    const db = Reflect.construct(target, args, target);
    if (typeof args[0] !== 'string' || path.resolve(args[0]) !== databasePath) return db;
    const nativePrepare = db.prepare.bind(db);
    const nativeExec = db.exec.bind(db);
    const handleId = ++nextHandleId;
    let transactionId = 0;
    let transactionActive = false;
    let receiptWritten = false;
    let rawWrites = 0;
    function mode(kind) {
      observation({
        kind,
        handleId,
        transactionId,
        transactionActive,
        journalMode: nativePrepare('PRAGMA journal_mode').get().journal_mode,
        synchronous: nativePrepare('PRAGMA synchronous').get().synchronous,
      });
    }
    function fault(phase) {
      fired = true;
      observation({ kind: 'fault-fired', operation, phase, rawWrites, receiptWritten });
    }
    function before(sql) {
      if (begin.test(sql)) {
        transactionId = ++nextTransactionId;
        transactionActive = false;
        mode('transaction-begin');
      }
      if (rawInsert.test(sql)) {
        mode('native-writer');
        if (!fired && operation === 'sqlite-full') {
          const pages = nativePrepare('PRAGMA page_count').get().page_count;
          assert.ok(Number.isSafeInteger(pages) && pages > 0);
          fault('before-raw-insert');
          // SQLite itself enforces the cap and returns SQLITE_FULL; no JS fs error.
          nativeExec(`PRAGMA max_page_count=${pages}`);
        }
      }
      if (legacyInsert.test(sql)) mode('legacy-writer');
      if (!fired && operation === 'outbox-insert-full' && outboxInsert.test(sql)) {
        fault('before-outbox-insert');
        const error = new Error('synthetic native outbox statement refusal');
        error.code = 'ERR_SQLITE_ERROR';
        error.errcode = 13;
        throw error;
      }
      if (!fired && receiptWritten && commit.test(sql) && operation === 'before-commit-kill') {
        fault('immediately-before-native-commit');
        process.kill(process.pid, 'SIGKILL');
      }
    }
    function after(sql) {
      if (begin.test(sql) || rollback.test(sql)) {
        receiptWritten = false;
        rawWrites = 0;
      }
      if (begin.test(sql)) {
        transactionActive = true;
        observation({ kind: 'transaction-begin-complete', handleId, transactionId });
      }
      if (rollback.test(sql)) transactionActive = false;
      if (rawInsert.test(sql)) rawWrites++;
      if (receiptInsert.test(sql)) receiptWritten = true;
      if (!fired && receiptWritten && commit.test(sql) && operation === 'after-commit-kill') {
        // Called only after the actual native COMMIT method returns.
        fault('immediately-after-native-commit');
        process.kill(process.pid, 'SIGKILL');
      }
      if (commit.test(sql)) {
        receiptWritten = false;
        rawWrites = 0;
        transactionActive = false;
      }
    }
    function invoke(sql, method, args) {
      before(sql);
      let result;
      try { result = method(...args); } catch (error) {
        if (fired && operation === 'sqlite-full' && rawInsert.test(sql)) {
          observation({ kind: 'native-write-error', sqliteResult: error.errcode ?? null });
        }
        throw error;
      }
      after(sql);
      return result;
    }
    db.exec = sql => invoke(sql, nativeExec, [sql]);
    db.prepare = function (sql, ...prepareArgs) {
      const statement = nativePrepare(sql, ...prepareArgs);
      const nativeRun = statement.run.bind(statement);
      statement.run = (...runArgs) => invoke(sql, nativeRun, runArgs);
      return statement;
    };
    return db;
  },
});
