// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Child-only actual own-writer observation and native fault activation.
// No credential/header/body output and no production route or test bypass.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const sqlite = require('node:sqlite');
const home = path.resolve(process.env.HEALTH_HOME || '');
assert.equal(path.dirname(home), path.resolve(os.tmpdir()));
assert.ok(path.basename(home).startsWith('eh-test-'));
assert.equal(fs.lstatSync(home).isSymbolicLink(), false);
const database = path.join(home, 'db', 'klebb.db');
const observations = path.resolve(process.env.STICKY_OBSERVATIONS || '');
const enabled = path.resolve(process.env.STICKY_ENABLED || '');
assert.equal(path.dirname(observations), home);
assert.equal(path.dirname(enabled), home);
const operation = process.env.STICKY_FAULT || 'observe';
assert.ok(['observe', 'sqlite-full', 'sqlite-busy', 'late-outbox-refusal',
  'before-commit-kill', 'after-commit-kill', 'held-observe', 'held-freeze'].includes(operation));
const Original = sqlite.DatabaseSync;
let fired = false, nextHandle = 0, nextTransaction = 0;
const record = event => fs.appendFileSync(observations, JSON.stringify(event) + '\n',
  { encoding: 'utf8', mode: 0o600 });
const begin = /^\s*BEGIN(?:\s|;|$)/i;
const commit = /^\s*(?:COMMIT|END)(?:\s|;|$)/i;
const rollback = /^\s*ROLLBACK(?:\s|;|$)/i;
const mutation = /^\s*(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|REPLACE\s+INTO|UPDATE|DELETE\s+FROM)\s+["`[]?(health_[a-z_]+)\b/i;
function ingestHandle() {
  const stack = new Error().stack.replaceAll('\\', '/');
  return /\/lib\/health-connect\/history\.js:/.test(stack) &&
    /\bat (?:[A-Za-z0-9_$]+\.)?commitBatch(?:\s|\()/u.test(stack);
}
sqlite.DatabaseSync = new Proxy(Original, {
  construct(target, args) {
    const relevant = ingestHandle();
    const db = Reflect.construct(target, args, target);
    if (!relevant || args[1]?.readOnly || typeof args[0] !== 'string' ||
        path.resolve(args[0]) !== database) return db;
    const prepare = db.prepare.bind(db), exec = db.exec.bind(db);
    const handleId = ++nextHandle;
    let transactionId = 0, active = false, rawDeleted = 0, tombstonesWritten = 0;
    let guardsWritten = 0, partsDeleted = 0, receiptWritten = false, blocker;
    const parts = () => prepare("SELECT 1 FROM sqlite_schema WHERE name='health_object_parts'").get() ?
      Number(prepare('SELECT count(*) AS n FROM health_object_parts').get().n) : 0;
    function mode(kind) {
      record({ kind, handleId, transactionId, transactionActive: active,
        journalMode: prepare('PRAGMA journal_mode').get().journal_mode,
        synchronous: prepare('PRAGMA synchronous').get().synchronous });
    }
    function fault(phase) {
      fired = true;
      record({ kind: 'fault-fired', operation, phase, handleId, transactionId,
        transactionActive: active, rawDeleted, tombstonesWritten, guardsWritten,
        partsDeleted, receiptWritten });
    }
    function priorEffects() {
      assert.ok(active && rawDeleted > 0 && tombstonesWritten > 0 && guardsWritten > 0 &&
        partsDeleted > 0, 'late fault requires actual earlier changes on this writer');
    }
    function invoke(sql, method, values) {
      const armed = fs.existsSync(enabled);
      if (begin.test(sql)) {
        transactionId = ++nextTransaction;
        rawDeleted = 0; tombstonesWritten = 0; guardsWritten = 0;
        partsDeleted = 0; receiptWritten = false;
        mode('own-writer-before-begin');
        if (armed && !fired && operation === 'sqlite-full') {
          const pageCount = Number(prepare('PRAGMA page_count').get().page_count);
          const freePages = Number(prepare('PRAGMA freelist_count').get().freelist_count);
          assert.ok(pageCount > 0); assert.equal(freePages, 0);
          exec(`PRAGMA max_page_count=${pageCount}`);
          fault('native-max-page-count-set-before-begin');
          record({ kind: 'full-cap', handleId, transactionId, pageCount, freePages });
        }
        if (armed && !fired && operation === 'sqlite-busy') {
          blocker = new Original(database);
          blocker.exec('PRAGMA busy_timeout=100; BEGIN IMMEDIATE');
          fault('actual-competing-writer-holds-begin-immediate');
        }
      }
      const table = mutation.exec(sql)?.[1];
      const priorParts = active && table ? parts() : 0;
      if (armed && !fired && operation === 'late-outbox-refusal' &&
          table === 'health_projection_outbox') {
        priorEffects();
        exec("CREATE TEMP TRIGGER sticky_late_refusal BEFORE INSERT ON health_projection_outbox "
          + "BEGIN SELECT RAISE(ABORT,'synthetic sticky late native statement refusal'); END");
        fault('native-outbox-trigger-after-successful-earlier-effects');
      }
      if (armed && !fired && commit.test(sql) && operation === 'before-commit-kill') {
        priorEffects(); assert.equal(receiptWritten, true);
        fault('immediately-before-native-commit');
        process.kill(process.pid, 'SIGKILL');
      }
      let result;
      try { result = method(...values); }
      catch (error) {
        if (armed && fired) record({ kind: 'actual-native-error', handleId, transactionId,
          sqliteResult: error.errcode ?? null });
        throw error;
      } finally {
        if (blocker) { try { blocker.exec('ROLLBACK'); } finally { blocker.close(); blocker = null; } }
      }
      if (begin.test(sql)) { active = true; mode('own-writer-begin-complete'); }
      if (active && table) {
        const changes = Number(result?.changes ?? prepare('SELECT changes() AS n').get().n);
        assert.ok(Number.isSafeInteger(changes) && changes >= 0);
        if (table === 'health_records' && /^\s*DELETE\b/i.test(sql)) rawDeleted += changes;
        if (table === 'health_tombstones' && !/^\s*DELETE\b/i.test(sql)) tombstonesWritten += changes;
        if (table === 'health_deletion_guards' && !/^\s*DELETE\b/i.test(sql)) guardsWritten += changes;
        partsDeleted += Math.max(0, priorParts - parts());
        if (table === 'health_batch_receipts' && changes > 0) receiptWritten = true;
        record({ kind: 'successful-native-write', handleId, transactionId, table,
          changes, rawDeleted, tombstonesWritten, guardsWritten, partsDeleted, transactionActive: active });
      }
      if (armed && !fired && commit.test(sql) && operation === 'after-commit-kill') {
        priorEffects(); assert.equal(receiptWritten, true);
        active = false; // Actual native COMMIT has already returned.
        fault('immediately-after-native-commit');
        process.kill(process.pid, 'SIGKILL');
      }
      if (commit.test(sql) || rollback.test(sql)) {
        active = false;
        record({ kind: commit.test(sql) ? 'own-writer-commit-complete' : 'own-writer-rollback-complete',
          handleId, transactionId });
      }
      return result;
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
if (operation.startsWith('held-')) {
  const route = process.env.STICKY_HELD_ROUTE;
  assert.ok(['/api/connectors/health-connect/v1/batches',
    '/api/connectors/health-connect/v1/object-parts',
    '/api/connectors/health-connect/v1/object-finalise'].includes(route));
  const emit = http.Server.prototype.emit;
  http.Server.prototype.emit = function (event, ...args) {
    const message = args[0];
    if (event === 'request' && message.method === 'POST' && message.url === route) {
      const original = message[Symbol.asyncIterator].bind(message);
      message[Symbol.asyncIterator] = async function* () {
        let first = true;
        for await (const chunk of original()) {
          if (first && fs.existsSync(enabled)) {
            first = false;
            if (operation === 'held-freeze') require(path.join(__dirname,
              '../../lib/import/freeze')).engage('synthetic-sticky-midbody');
            record({ kind: 'actual-first-body-chunk-consumed', route, bytes: chunk.length });
          }
          yield chunk;
        }
      };
    }
    return Reflect.apply(emit, this, [event, ...args]);
  };
}
