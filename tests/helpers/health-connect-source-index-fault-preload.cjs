// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Child-only actual SQLite publication instrumentation, never a product hook.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite = require('node:sqlite');
const home = path.resolve(process.env.HEALTH_HOME || '');
assert.ok(home.startsWith(path.resolve(os.tmpdir()) + path.sep) &&
  path.basename(home).startsWith('eh-test-'), 'only owned synthetic homes');
const product = path.resolve(process.env.INDEPENDENT_PRODUCT_ROOT || '');
const source = path.join(product, 'lib/health-connect/source-index.js').replaceAll('\\', '/');
const database = path.join(home, 'db/klebb.db');
const observations = path.resolve(process.env.INDEPENDENT_INDEX_OBSERVATIONS || '');
const enabled = path.resolve(process.env.INDEPENDENT_INDEX_FAULT_ENABLED || '');
assert.equal(path.dirname(observations), home);
assert.equal(path.dirname(enabled), home);
const operation = process.env.INDEPENDENT_INDEX_FAULT;
assert.ok(['observe', 'sqlite-full', 'sqlite-busy', 'late-frontier-refusal',
  'before-commit-kill', 'after-commit-kill'].includes(operation));
const Original = sqlite.DatabaseSync;
let nextHandle = 0;
let nextTransaction = 0;
const begin = /^\s*BEGIN(?:\s|;|$)/i;
const commit = /^\s*(?:COMMIT|END)(?:\s|;|$)/i;
const rollback = /^\s*ROLLBACK(?:\s|;|$)/i;
const tableMutation = /^\s*(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|REPLACE\s+INTO|UPDATE|DELETE\s+FROM)\s+["`[]?(health_source_index(?:_frontiers|_state)?)(?:["`\]]|\b)/i;
const indexInsert = /^\s*(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|REPLACE\s+INTO)\s+["`[]?health_source_index(?:["`\]]|\b)/i;
const frontierInsert = /^\s*(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|REPLACE\s+INTO)\s+["`[]?health_source_index_frontiers(?:["`\]]|\b)/i;
const stateWrite = /^\s*(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|REPLACE\s+INTO|UPDATE)\s+["`[]?health_source_index_state(?:["`\]]|\b)/i;
function record(event) {
  fs.appendFileSync(observations, JSON.stringify(event) + '\n', { encoding: 'utf8', mode: 0o600 });
}
function isPublication() {
  // Only the closest frame in the actual producer module counts. A nested
  // recordFailure handle must not inherit its enclosing publishSource frame.
  const frame = new Error().stack.split('\n').find(line => line.replaceAll('\\', '/').includes(source + ':'));
  return !!frame && /\bat (?:[A-Za-z0-9_$]+\.)?publishSource(?:\s|\()/u.test(frame);
}
sqlite.DatabaseSync = new Proxy(Original, {
  construct(target, args) {
    const publication = isPublication();
    const db = Reflect.construct(target, args, target);
    if (!publication || typeof args[0] !== 'string' || path.resolve(args[0]) !== database) return db;
    const prepare = db.prepare.bind(db), exec = db.exec.bind(db);
    const handleId = ++nextHandle;
    let transactionId = 0, active = false, changedRows = 0, frontiersWritten = 0;
    let currentWritten = false, faultArmed = false, lock = null;
    function mode(kind) {
      record({ kind, handleId, transactionId, transactionActive: active,
        journalMode: prepare('PRAGMA journal_mode').get().journal_mode,
        synchronous: prepare('PRAGMA synchronous').get().synchronous });
    }
    function fault(phase, extra = {}) {
      faultArmed = true;
      record({ kind: 'fault-fired', operation, phase, handleId, transactionId,
        earlierChangedRows: changedRows, frontiersWritten, currentWritten, ...extra });
    }
    function before(sql) {
      if (begin.test(sql)) {
        transactionId = ++nextTransaction;
        changedRows = 0; frontiersWritten = 0; currentWritten = false; faultArmed = false;
        mode('publisher-before-begin');
        if (fs.existsSync(enabled) && operation === 'sqlite-busy') {
          lock = new Original(database);
          lock.exec('PRAGMA busy_timeout=100');
          lock.exec('BEGIN IMMEDIATE');
          fault('before-native-publisher-begin');
        }
      }
      if (fs.existsSync(enabled) && !faultArmed && indexInsert.test(sql) && operation === 'sqlite-full') {
        const pages = prepare('PRAGMA page_count').get().page_count;
        const freePages = prepare('PRAGMA freelist_count').get().freelist_count;
        assert.ok(Number.isSafeInteger(pages) && pages > 0);
        assert.equal(freePages, 0, 'fixed large-identity fixture must have no reusable free pages');
        fault('before-large-index-native-insert', { pageCount: pages, freePages });
        exec(`PRAGMA max_page_count=${pages}`);
      }
      if (fs.existsSync(enabled) && !faultArmed && frontierInsert.test(sql) &&
          operation === 'late-frontier-refusal') {
        assert.ok(changedRows > 0, 'actual earlier derived changes must precede late refusal');
        fault('before-late-native-frontier-insert');
        exec("CREATE TEMP TRIGGER independent_index_late_refusal BEFORE INSERT ON health_source_index_frontiers "
          + "BEGIN SELECT RAISE(ABORT, 'synthetic-derived-late-refusal'); END");
      }
      if (commit.test(sql) && fs.existsSync(enabled) && operation === 'before-commit-kill') {
        assert.ok(active && changedRows > 0 && frontiersWritten > 0 && currentWritten);
        fault('immediately-before-publication-native-commit');
        process.kill(process.pid, 'SIGKILL');
      }
    }
    function after(sql, result, args) {
      if (begin.test(sql)) { active = true; mode('publisher-begin-complete'); }
      const table = tableMutation.exec(sql)?.[1];
      if (table) {
        const changes = Number(result?.changes ?? prepare('SELECT changes() AS n').get().n);
        assert.ok(Number.isSafeInteger(changes) && changes >= 0);
        changedRows += changes;
        if (frontierInsert.test(sql)) frontiersWritten += changes;
        if (stateWrite.test(sql) && (/\bcurrent\b/i.test(sql) ||
            args.some(value => value === 'current' ||
              (value && typeof value === 'object' && Object.values(value).includes('current'))))) currentWritten = true;
        record({ kind: 'successful-derived-write', handleId, transactionId,
          table, changes, totalChangedRows: changedRows, transactionActive: active });
      }
      if (commit.test(sql)) {
        if (fs.existsSync(enabled) && operation === 'after-commit-kill') {
          assert.ok(active && changedRows > 0 && frontiersWritten > 0 && currentWritten);
          fault('immediately-after-publication-native-commit');
          process.kill(process.pid, 'SIGKILL');
        }
        active = false;
        record({ kind: 'publisher-commit-complete', handleId, transactionId });
      }
      if (rollback.test(sql)) active = false;
    }
    function invoke(sql, method, args) {
      before(sql);
      try {
        const result = method(...args);
        after(sql, result, args);
        return result;
      } catch (error) {
        record({ kind: 'publisher-native-error', operation, handleId, transactionId,
          sqliteResult: error.errcode ?? null, transactionActive: active });
        throw error;
      } finally {
        if (lock) {
          lock.exec('ROLLBACK'); lock.close(); lock = null;
          record({ kind: 'independent-busy-lock-released', handleId, transactionId });
        }
      }
    }
    db.exec = sql => invoke(sql, exec, [sql]);
    db.prepare = (sql, ...rest) => {
      const statement = prepare(sql, ...rest), run = statement.run.bind(statement);
      statement.run = (...values) => invoke(sql, run, values);
      return statement;
    };
    return db;
  },
});
