// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Isolated migration-child probes; no product hooks, routes or test bypasses.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite = require('node:sqlite');
const home = path.resolve(process.env.HEALTH_HOME || '');
assert.equal(path.dirname(home), path.resolve(os.tmpdir()));
assert.ok(path.basename(home).startsWith('eh-test-'));
const database = path.join(home, 'db/klebb.db');
const directory = path.dirname(database);
const observation = path.resolve(process.env.INDEPENDENT_MIGRATION_OBSERVATIONS || '');
assert.equal(path.dirname(observation), home);
const operation = process.env.INDEPENDENT_MIGRATION_FAULT;
assert.ok(['observe', 'sqlite-full', 'sqlite-busy', 'vacuum-refusal',
  'copy-corrupt', 'copy-row-change', 'copy-blob-change', 'copy-int64-change', 'copy-sequence-change',
  'file-fsync-eio', 'rename-eio', 'directory-fsync-eio', 'late-marker-refusal',
  'occupied-destination', 'before-commit-kill', 'after-commit-kill'].includes(operation));
const Original = sqlite.DatabaseSync;
const native = { append: fs.appendFileSync, open: fs.openSync, close: fs.closeSync,
  fsync: fs.fsyncSync, rename: fs.renameSync, write: fs.writeFileSync, writeBytes: fs.writeSync };
const handles = new Map();
const files = new Map();
const directories = new Set();
let nextHandle = 0, writerId = null, writerActive = false, guardCreated = false;
let markerInserted = false, renamed = false, faultFired = false;
const same = (value, expected) => typeof value === 'string' && path.resolve(value) === expected;
const safety = value => typeof value === 'string' && path.dirname(path.resolve(value)) === directory &&
  path.basename(value).startsWith(path.basename(database) + '.pre-health-deletion-v2-');
const temporary = value => safety(value) && value.endsWith('.db.tmp');
function record(kind, extra = {}) {
  native.append(observation, JSON.stringify({ kind, operation, writerId, writerActive,
    guardCreated, markerInserted, renamed, ...extra }) + '\n', { encoding: 'utf8', mode: 0o600 });
}
function fault(phase, extra = {}) {
  assert.equal(faultFired, false, 'one selected native fault only');
  faultFired = true;
  record('fault-fired', { phase, ...extra });
}
function eio(phase) { const error = new Error(phase); error.code = 'EIO'; return error; }
function compareProbe() {
  const competing = new Original(database);
  try {
    competing.exec('PRAGMA busy_timeout=1');
    assert.throws(() => competing.exec('BEGIN IMMEDIATE'), error => {
      record('reservation-native-busy', { sqliteResult: error.errcode ?? null });
      return error.errcode === 5;
    });
  } finally { competing.close(); }
}
function corruptCopy(filename) {
  if (operation === 'copy-corrupt') {
    const descriptor = native.open(filename, 'r+');
    try { native.writeBytes(descriptor, Buffer.from('BAD'), 0, 3, 0); }
    finally { native.close(descriptor); }
  } else {
    const db = new Original(filename);
    try {
      let result;
      if (operation === 'copy-row-change') {
        result = db.prepare("UPDATE migration_typed_fixture SET value=? WHERE kind='embedded-nul'")
          .run('changed same-count copy fixture');
      } else if (operation === 'copy-blob-change') {
        result = db.prepare("UPDATE migration_typed_fixture SET value=? WHERE kind='blob'")
          .run(Buffer.from('0001027f80feff01', 'hex'));
      } else if (operation === 'copy-int64-change') {
        result = db.prepare("UPDATE migration_typed_fixture SET value=? WHERE kind='maximum'")
          .run(9223372036854775806n);
      } else if (operation === 'copy-sequence-change') {
        result = db.prepare("UPDATE sqlite_sequence SET seq=seq+1 WHERE name='hae_pushes'").run();
      }
      assert.equal(result.changes, 1);
    } finally { db.close(); }
  }
  fault('after-successful-native-vacuum-before-real-copy-verification');
}
sqlite.DatabaseSync = new Proxy(Original, {
  construct(target, args) {
    const db = Reflect.construct(target, args, target);
    const file = typeof args[0] === 'string' ? path.resolve(args[0]) : null;
    if (file !== database && !safety(file)) return db;
    const id = ++nextHandle;
    const ownWriter = file === database && args[1]?.readOnly !== true;
    handles.set(id, { ownWriter, readOnly: args[1]?.readOnly === true });
    if (ownWriter) {
      assert.equal(writerId, null, 'only the original migration writer');
      writerId = id;
      record('original-writer-open', { handleId: id });
    } else record(safety(file) ? 'copy-reader-open' : 'source-reader-open',
      { handleId: id, readOnly: args[1]?.readOnly === true });
    const prepare = db.prepare.bind(db), exec = db.exec.bind(db), close = db.close.bind(db);
    let busy = null;
    function before(sql, values) {
      if (ownWriter && /^\s*BEGIN(?:\s|;|$)/i.test(sql)) {
        record('writer-before-begin', { handleId: id,
          journalMode: prepare('PRAGMA journal_mode').get().journal_mode,
          synchronous: prepare('PRAGMA synchronous').get().synchronous });
        if (operation === 'sqlite-busy') {
          busy = new Original(database);
          busy.exec('PRAGMA busy_timeout=100; BEGIN IMMEDIATE');
          fault('before-original-native-begin');
        }
      }
      if (/^\s*VACUUM\s+INTO\b/i.test(sql)) {
        assert.equal(ownWriter, false);
        assert.equal(args[1]?.readOnly, true);
        assert.equal(writerActive, true);
        assert.ok(temporary(values[0]), 'parameterized owned temporary destination');
        compareProbe();
        record('native-vacuum-before', { handleId: id, parameterized: /\?/.test(sql) });
        if (operation === 'vacuum-refusal') {
          const occupied = new Original(values[0]);
          try {
            occupied.exec('CREATE TABLE independent_vacuum_refusal (value TEXT NOT NULL)');
            occupied.prepare('INSERT INTO independent_vacuum_refusal VALUES (?)')
              .run('nonempty owned output refuses VACUUM');
          } finally { occupied.close(); }
          fault('before-native-vacuum-occupied-output');
        }
      }
      if (ownWriter && /\bCREATE\s+TABLE\s+health_deletion_guards\b/i.test(sql) &&
          operation === 'sqlite-full') {
        const pageCount = prepare('PRAGMA page_count').get().page_count;
        const freePages = prepare('PRAGMA freelist_count').get().freelist_count;
        assert.ok(Number.isSafeInteger(pageCount) && pageCount > 0);
        assert.equal(freePages, 0, 'fixed fixture has no reusable pages');
        exec(`PRAGMA max_page_count=${pageCount}`);
        fault('before-native-guard-create', { pageCount, freePages });
      }
      if (ownWriter && /^\s*INSERT\s+INTO\s+health_schema_version\b/i.test(sql) &&
          operation === 'late-marker-refusal') {
        assert.equal(guardCreated, true);
        exec("CREATE TEMP TRIGGER independent_migration_marker_refusal BEFORE INSERT ON health_schema_version "
          + "WHEN NEW.version=2 BEGIN SELECT RAISE(ABORT,'synthetic-late-marker-refusal'); END");
        fault('before-native-v2-marker-insert-after-successful-guard-ddl');
      }
      if (ownWriter && /^\s*COMMIT(?:\s|;|$)/i.test(sql) && operation === 'before-commit-kill') {
        assert.ok(writerActive && guardCreated && markerInserted && renamed);
        fault('immediately-before-original-native-commit');
        process.kill(process.pid, 'SIGKILL');
      }
    }
    function after(sql, values) {
      if (ownWriter && /^\s*BEGIN(?:\s|;|$)/i.test(sql)) {
        writerActive = true; record('writer-begin-complete', { handleId: id });
      }
      if (/^\s*VACUUM\s+INTO\b/i.test(sql)) {
        record('native-vacuum-success', { handleId: id });
        if (['copy-corrupt', 'copy-row-change', 'copy-blob-change', 'copy-int64-change',
          'copy-sequence-change'].includes(operation)) {
          corruptCopy(values[0]);
        }
      }
      if (ownWriter && /\bCREATE\s+TABLE\s+health_deletion_guards\b/i.test(sql)) {
        guardCreated = true; record('guard-create-success', { handleId: id });
      }
      if (ownWriter && /^\s*INSERT\s+INTO\s+health_schema_version\b/i.test(sql)) {
        markerInserted = true; record('v2-marker-insert-success', { handleId: id });
      }
      if (ownWriter && /^\s*COMMIT(?:\s|;|$)/i.test(sql)) {
        record('writer-native-commit-success', { handleId: id });
        if (operation === 'after-commit-kill') {
          assert.ok(writerActive && guardCreated && markerInserted && renamed);
          fault('immediately-after-original-native-commit');
          process.kill(process.pid, 'SIGKILL');
        }
        writerActive = false;
      }
      if (ownWriter && /^\s*ROLLBACK(?:\s|;|$)/i.test(sql)) {
        record('writer-native-rollback-success', { handleId: id }); writerActive = false;
      }
    }
    function invoke(sql, method, values) {
      before(sql, values);
      try {
        const result = method(...values);
        after(sql, values);
        return result;
      } catch (error) {
        record('sqlite-native-error', { handleId: id, sqliteResult: error.errcode ?? null });
        throw error;
      } finally {
        if (busy) { busy.exec('ROLLBACK'); busy.close(); busy = null; }
      }
    }
    db.exec = sql => invoke(sql, exec, [sql]);
    db.prepare = (sql, ...rest) => {
      const statement = prepare(sql, ...rest), run = statement.run.bind(statement);
      statement.run = (...values) => invoke(sql, run, values);
      return statement;
    };
    db.close = (...values) => {
      const result = close(...values);
      if (ownWriter) { record('original-writer-close', { handleId: id }); writerActive = false; }
      return result;
    };
    return db;
  },
});
fs.openSync = function (file, ...args) {
  if (operation === 'occupied-destination' && temporary(file) && args[0] === 'wx' && !faultFired) {
    const descriptor = native.open(file, 'wx', 0o600);
    try {
      const payload = Buffer.from('pre-existing independently occupied copy destination', 'utf8');
      assert.equal(native.writeBytes(descriptor, payload, 0, payload.length), payload.length);
    } finally { native.close(descriptor); }
    fault('before-exclusive-temp-open-existing-destination', { occupiedBasename: path.basename(file) });
  }
  const descriptor = native.open(file, ...args);
  if (safety(file)) files.set(descriptor, { temporary: temporary(file) });
  if (same(file, directory)) directories.add(descriptor);
  return descriptor;
};
fs.fsyncSync = function (descriptor, ...args) {
  if (files.has(descriptor)) {
    if (operation === 'file-fsync-eio') {
      fault('at-copy-file-fsync-before-rename');
      throw eio('synthetic-copy-file-fsync-eio');
    }
    const result = native.fsync(descriptor, ...args);
    record('copy-file-fsync-success');
    return result;
  }
  if (directories.has(descriptor)) {
    assert.equal(renamed, true);
    if (operation === 'directory-fsync-eio') {
      fault('at-posix-parent-fsync-after-copy-rename');
      throw eio('synthetic-parent-directory-fsync-eio');
    }
    const result = native.fsync(descriptor, ...args);
    record('copy-directory-fsync-success');
    return result;
  }
  return native.fsync(descriptor, ...args);
};
fs.renameSync = function (from, to, ...args) {
  if (temporary(from) && safety(to) && !to.endsWith('.tmp')) {
    if (operation === 'rename-eio') {
      fault('at-copy-rename-after-file-fsync');
      throw eio('synthetic-copy-rename-eio');
    }
    const result = native.rename(from, to, ...args);
    renamed = true; record('copy-rename-success');
    return result;
  }
  return native.rename(from, to, ...args);
};
fs.closeSync = function (descriptor, ...args) {
  files.delete(descriptor); directories.delete(descriptor);
  return native.close(descriptor, ...args);
};
