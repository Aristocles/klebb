// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Observe the real active owner request and its history writer. Never replace a
// response, fabricate SQLite error codes, or name a future deletion module.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const sqlite = require('node:sqlite');
const OriginalDatabase = sqlite.DatabaseSync;
const directory = process.env.OWNER_DELETE_OBSERVATIONS;
const enabled = process.env.OWNER_DELETE_ENABLED;
const mode = process.env.OWNER_DELETE_MODE;
const home = path.resolve(process.env.HEALTH_HOME || '');
assert.equal(path.dirname(directory), home);
assert.equal(path.dirname(enabled), home);
const applyRoute = '/api/connectors/health-connect/deletions/apply';
const previewRoute = '/api/connectors/health-connect/deletions/preview';
let fullyReadApply = 0, nextHandle = 0, nextEvent = 0, ownerCommitReturned = false;
function record(value) {
  assert.equal(fs.lstatSync(directory).isSymbolicLink(), false);
  const name = String(++nextEvent).padStart(6, '0');
  const target = path.join(directory, `${name}.json`), temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ pid: process.pid, ...value }),
    { flag: 'wx', mode: 0o600 });
  fs.renameSync(temporary, target); // Complete closed bytes precede publication.
}
const emit = http.Server.prototype.emit;
http.Server.prototype.emit = function (event, ...args) {
  const message = args[0], response = args[1];
  if (event === 'request' && message.method === 'POST' &&
      [applyRoute, previewRoute].includes(message.url)) {
    const route = message.url, iterator = message[Symbol.asyncIterator].bind(message);
    let registered = false;
    message[Symbol.asyncIterator] = async function* () {
      let first = true;
      for await (const chunk of iterator()) {
        if (first && chunk.length && fs.existsSync(enabled)) {
          first = false;
          if (mode === 'held-freeze') require(path.join(__dirname, '../../lib/import/freeze'))
            .engage('synthetic-owner-deletion-midbody');
          record({ kind: 'actual-first-body-chunk', route, bytes: chunk.length });
        }
        yield chunk;
      }
      if (route === applyRoute && fs.existsSync(enabled)) {
        registered = true; fullyReadApply++;
      }
    };
    response.once('finish', () => { if (registered) fullyReadApply--; });
  }
  return Reflect.apply(emit, this, [event, ...args]);
};
sqlite.DatabaseSync = new Proxy(OriginalDatabase, {
  construct(Target, args) {
    const db = Reflect.construct(Target, args);
    const stack = new Error().stack || '';
    if (!fullyReadApply || !fs.existsSync(enabled) || args[1]?.readOnly ||
        !stack.includes('health-connect' + path.sep + 'history.js') ||
        /publishSource|prepareAttempt|recordFailure|queueRebuild/.test(stack)) return db;
    const handleId = ++nextHandle;
    let active = false, fired = false;
    const counts = { guards: 0, raw: 0, parts: 0, staging: 0, index: 0,
      receipts: 0, frontiers: 0, jobs: 0, tombstones: 0 };
    const exec = db.exec.bind(db), prepare = db.prepare.bind(db);
    const begin = /^\s*BEGIN\s+IMMEDIATE/i, commit = /^\s*COMMIT/i, rollback = /^\s*ROLLBACK/i;
    const prior = () => {
      assert.equal(active, true, 'actual BEGIN returned without an observed COMMIT/ROLLBACK');
      for (const name of ['guards', 'raw', 'parts', 'index']) {
        assert.ok(counts[name] > 0, `actual successful earlier ${name} mutation required`);
      }
      for (const name of ['receipts', 'frontiers', 'jobs', 'tombstones']) assert.equal(counts[name], 0);
    };
    function event(kind, extra = {}) {
      record({ kind, handleId, transactionId: 1,
        ...(kind === 'actual-native-fault' ? { transactionStateAfterFault: 'not-asserted' } :
          { transactionActive: active }), ...counts, ...extra });
    }
    function invoke(sql, operation, values) {
      let competing;
      if (begin.test(sql)) {
        const journalMode = prepare('PRAGMA journal_mode').get().journal_mode;
        const synchronous = prepare('PRAGMA synchronous').get().synchronous;
        assert.equal(journalMode, 'wal'); assert.equal(synchronous, 2);
        event('own-writer-before-BEGIN', { journalMode, synchronous });
        if (mode === 'sqlite-busy') {
          competing = new OriginalDatabase(args[0]);
          competing.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; BEGIN IMMEDIATE');
        }
        if (mode === 'sqlite-full') {
          const pages = prepare('PRAGMA page_count').get().page_count;
          const freePages = prepare('PRAGMA freelist_count').get().freelist_count;
          assert.equal(freePages, 0);
          exec(`PRAGMA max_page_count=${pages}`);
          event('actual-full-cap', { pages, freePages });
        }
      }
      if (commit.test(sql) && !fired && ['sqlite-full', 'late-refusal', 'before-COMMIT-death'].includes(mode)) {
        prior(); fired = true; event('earlier-successful-own-mutations');
        if (mode === 'before-COMMIT-death') {
          event('before-actual-COMMIT'); process.kill(process.pid, 'SIGKILL');
        }
        // Actual same-handle statement, after all successful earlier effects.
        // The disclosed main pressure table was prepared in a stopped fixture.
        try {
          exec('INSERT INTO owner_deletion_synthetic_pressure VALUES (zeroblob(1048576))');
        } catch (error) {
          event('actual-native-fault', { nativeResult: error.errcode, nativeCode: error.code });
          throw error;
        }
        assert.fail('fixed native pressure control failed to activate');
      }
      const cascadedPartsBefore = active && /\bDELETE\s+FROM\s+health_object_staging\b/i.test(sql) ?
        prepare('SELECT count(*) AS n FROM health_object_parts').get().n : null;
      let result;
      try { result = operation(...values); }
      catch (error) {
        if (error.errcode !== undefined) event('actual-native-fault',
          { nativeResult: error.errcode, nativeCode: error.code });
        throw error;
      } finally {
        if (competing) { competing.exec('ROLLBACK'); competing.close(); }
      }
      if (begin.test(sql)) { active = true; event('own-writer-BEGIN-complete'); }
      if (active && result?.changes > 0) {
        const table = /(?:INTO|UPDATE|FROM)\s+["`]?([a-z_]+)/i.exec(sql)?.[1];
        const names = { health_deletion_guards: 'guards', health_records: 'raw',
          health_object_parts: 'parts', health_object_staging: 'staging',
          health_source_index_state: 'index', health_batch_receipts: 'receipts',
          health_streams: 'frontiers', health_projection_outbox: 'jobs', health_tombstones: 'tombstones' };
        if (names[table]) counts[names[table]] += result.changes;
        if (cascadedPartsBefore !== null) {
          const after = prepare('SELECT count(*) AS n FROM health_object_parts').get().n;
          counts.parts += cascadedPartsBefore - after;
        }
        event('actual-mutation-complete', { table: names[table] || 'other', changes: result.changes });
        if (mode === 'final-fence' && table === 'health_source_index_state' && !fired) {
          prior(); fired = true;
          const filename = path.join(home, 'credentials', 'health-connect.json');
          const state = JSON.parse(fs.readFileSync(filename, 'utf8'));
          assert.notEqual(state.restoreEpoch, 'd8040000-0000-4000-8000-000000000010');
          state.restoreEpoch = 'd8040000-0000-4000-8000-000000000010';
          const temporary = filename + `.owner-fence-${process.pid}.tmp`;
          fs.writeFileSync(temporary, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
          fs.renameSync(temporary, filename);
          event('actual-retained-fence-rotated');
        }
      }
      if (commit.test(sql)) {
        prior(); active = false; event('actual-COMMIT-returned'); ownerCommitReturned = true;
        if (mode === 'after-COMMIT-death') process.kill(process.pid, 'SIGKILL');
      }
      if (rollback.test(sql)) { active = false; event('actual-ROLLBACK-returned'); }
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
if (mode === 'hold-after-COMMIT') {
  const worker = require(path.join(__dirname, '../../lib/health-connect/source-index-worker'));
  const schedule = worker.scheduleSourceIndex, stop = worker.stopSourceIndex;
  const pending = new Set();
  worker.scheduleSourceIndex = sourceStoreId => {
    if (!ownerCommitReturned || !fs.existsSync(enabled)) return schedule(sourceStoreId);
    // Observe real COMMIT before gating ONLY its real post-commit schedule.
    record({ kind: 'actual-post-COMMIT-schedule-deferred', transactionActive: false });
    const release = path.join(home, 'owner-delete-release'), deadline = Date.now() + 10000;
    const timer = setInterval(() => {
      if (fs.existsSync(release)) {
        clearInterval(timer); pending.delete(timer);
        record({ kind: 'actual-post-COMMIT-schedule-released', transactionActive: false });
        schedule(sourceStoreId);
      } else if (Date.now() >= deadline) {
        clearInterval(timer); pending.delete(timer);
        record({ kind: 'bounded-post-COMMIT-schedule-timeout', transactionActive: false });
      }
    }, 25);
    pending.add(timer); timer.unref();
  };
  worker.stopSourceIndex = (...args) => {
    for (const timer of pending) clearInterval(timer);
    pending.clear(); return stop(...args);
  };
}
