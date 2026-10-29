// SPDX-License-Identifier: AGPL-3.0-only
// Transparent, owned-sandbox native witnesses; no fabricated SQLite result.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const sqlite = require('node:sqlite');
const Original = sqlite.DatabaseSync;
const control = process.env.HAE_DURABILITY_CONTROL;
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function publish(file, value) {
  const bytes = Buffer.from(JSON.stringify(value));
  const temporary = `${file}.next`;
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(descriptor, bytes); } finally { fs.closeSync(descriptor); }
  fs.renameSync(temporary, file);
}
// The lock is held by an actual separate SQLite process, not a refusal stub.
if (process.argv[2] === '--holder') {
  const [file, ready, release] = process.argv.slice(3);
  assert.ok(file && ready && release);
  const home = require('./hae-history-durability-cold-readback.cjs').owned(path.dirname(path.dirname(file)));
  assert.equal(path.resolve(file), path.join(home, 'db', 'klebb.db'));
  assert.equal(path.dirname(ready), path.join(home, '.hae-history-durability'));
  assert.equal(path.dirname(release), path.dirname(ready));
  assert.match(path.basename(ready), /^holder-ready-\d+\.json$/);
  assert.match(path.basename(release), /^holder-release-\d+\.json$/);
  const db = new Original(file);
  db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; BEGIN IMMEDIATE');
  publish(ready, { pid: process.pid, acquiredNativeBeginImmediate: true });
  const started = Date.now();
  const poll = () => {
    if (fs.existsSync(release) || Date.now() - started >= 12000) {
      db.exec('ROLLBACK'); db.close(); return;
    }
    setTimeout(poll, 10);
  };
  poll();
} else if (control) {
  const home = require('./hae-history-durability-cold-readback.cjs').owned(process.env.HEALTH_HOME);
  assert.equal(path.resolve(control), path.join(home, '.hae-history-durability'));
  assert.ok(!fs.lstatSync(control).isSymbolicLink());
  const file = path.join(home, 'db', 'klebb.db');
  let sequence = 0, handles = 0;
  const config = () => {
    const names = fs.readdirSync(control).filter(name => /^arm-\d{4}\.json$/.test(name)).sort();
    assert.ok(names.length <= 16);
    return names.length ? JSON.parse(fs.readFileSync(path.join(control, names.at(-1)), 'utf8'))
      : { revision: 0, mode: 'observe' };
  };
  const record = (kind, values = {}) => {
    const current = config();
    assert.ok(++sequence <= 256);
    publish(path.join(control,
      `event-${String(current.revision).padStart(4, '0')}-${process.pid}-${String(sequence).padStart(4, '0')}.json`),
    { sequence, revision: current.revision, pid: process.pid, kind, ...values });
  };
  const primary = error => Number.isInteger(error.errcode) ? error.errcode & 255 : null;
  function wrap(db, role, handle) {
    const nativeExec = db.exec.bind(db), nativePrepare = db.prepare.bind(db);
    let active = false, pushWrites = 0, sampleWrites = 0, cardDeletes = 0;
    let capacityBefore = null;
    const earlier = () => ({ pushWrites, sampleWrites, cardDeletes });
    return new Proxy(db, {
      get(target, key) {
        if (key === 'exec') return sql => {
          const begin = /^\s*BEGIN\b/i.test(sql), commit = /^\s*COMMIT\b/i.test(sql);
          const rollback = /^\s*ROLLBACK\b/i.test(sql);
          const current = config();
          if (begin) {
            pushWrites = sampleWrites = cardDeletes = 0;
            if (role === 'history') {
              if (capacityBefore !== null && current.mode !== 'full') {
                nativeExec(`PRAGMA max_page_count=${capacityBefore}`);
                capacityBefore = null;
              }
              record('history-before-begin', {
                handle, sql: sql.trim(),
                journalMode: nativePrepare('PRAGMA journal_mode').get().journal_mode,
                synchronous: nativePrepare('PRAGMA synchronous').get().synchronous,
                busyTimeout: nativePrepare('PRAGMA busy_timeout').get().timeout,
              });
              if (current.mode === 'full') {
                const pages = nativePrepare('PRAGMA page_count').get().page_count;
                const free = nativePrepare('PRAGMA freelist_count').get().freelist_count;
                const size = nativePrepare('PRAGMA page_size').get().page_size;
                assert.ok((free + 1) * size < 1048576, 'fixed pressure cannot fit spare pages');
                capacityBefore = nativePrepare('PRAGMA max_page_count').get().max_page_count;
                nativeExec(`PRAGMA max_page_count=${pages}`);
                assert.equal(nativePrepare('PRAGMA max_page_count').get().max_page_count, pages);
                record('native-page-ceiling', { handle, pages, freePages: free, pageSize: size,
                  fixedPressureBytes: 1048576, previousMaximumPages: capacityBefore });
              }
              if (current.mode === 'busy') {
                const ready = path.join(control, `holder-ready-${current.revision}.json`);
                const release = path.join(control, `holder-release-${current.revision}.json`);
                const holder = spawn(process.execPath, [__filename, '--holder', file, ready, release],
                  { env: { ...process.env, NODE_OPTIONS: '', HAE_DURABILITY_CONTROL: '' },
                    stdio: ['ignore', 'ignore', 'ignore'] });
                const deadline = Date.now() + 2000;
                while (!fs.existsSync(ready) && Date.now() < deadline) sleep(10);
                assert.ok(fs.existsSync(ready), 'real independent holder readiness');
                const proof = JSON.parse(fs.readFileSync(ready, 'utf8'));
                assert.equal(proof.pid, holder.pid);
                assert.equal(proof.acquiredNativeBeginImmediate, true);
                record('independent-lock-acquired', { handle, holderPid: holder.pid });
              }
            }
          }
          if (commit && role === 'history' && current.mode === 'before-commit') {
            assert.ok(active && pushWrites === 1 && sampleWrites >= 1);
            record('death-before-native-commit', { handle, nativeTransactionActive: true, earlier: earlier() });
            process.kill(process.pid, 'SIGKILL');
          }
          let result;
          try { result = nativeExec(sql); } catch (error) {
            record('native-exec-failure', { role, handle, statement: begin ? 'BEGIN' : commit ? 'COMMIT' : 'other',
              nativeCode: error.errcode ?? null, primaryCode: primary(error), code: error.code,
              earlier: earlier(), observerBeginSinceLastCommit: active });
            throw error;
          }
          if (begin) { active = true; record(`${role}-begin`, { handle, sql: sql.trim() }); }
          if (rollback) { active = false; record(`${role}-rollback`, { handle, earlier: earlier() }); }
          if (commit) {
            const prior = earlier();
            active = false;
            record(`${role}-commit`, { handle, nativeTransactionActive: false, earlier: prior });
            if (role === 'history' && current.mode === 'after-commit') {
              assert.ok(pushWrites === 1 && sampleWrites >= 1);
              record('death-after-native-commit', { handle, nativeTransactionActive: false, earlier: prior });
              process.kill(process.pid, 'SIGKILL');
            }
          }
          return result;
        };
        if (key === 'prepare') return sql => {
          const statement = nativePrepare(sql);
          return new Proxy(statement, {
            get(stmt, member) {
              if (member === 'run') return (...args) => {
                let result;
                try { result = stmt.run(...args); } catch (error) {
                  record('native-statement-failure', { role, handle, nativeCode: error.errcode ?? null,
                    primaryCode: primary(error), code: error.code, earlier: earlier(),
                    observerBeginSinceLastCommit: active });
                  throw error;
                }
                if (role === 'history' && /^\s*INSERT INTO hae_pushes\b/i.test(sql)) {
                  pushWrites++;
                  record('history-push-write', { handle, pushSequence: String(result.lastInsertRowid) });
                }
                if (role === 'history' && /^\s*INSERT INTO hae_samples\b/i.test(sql)) {
                  sampleWrites++;
                  record('history-sample-write', { handle, ordinal: sampleWrites, metric: args[1] });
                }
                if (role === 'card' && /^\s*DELETE FROM rows\b/i.test(sql) && args[0] === 'weight') {
                  cardDeletes++;
                  record('card-prior-delete', { handle, changedRows: Number(result.changes) });
                }
                return result;
              };
              const value = Reflect.get(stmt, member, stmt);
              return typeof value === 'function' ? value.bind(stmt) : value;
            },
          });
        };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }
  function WitnessDatabase(...args) {
    const db = new Original(...args);
    const stack = new Error().stack;
    const same = path.resolve(String(args[0])) === path.resolve(file);
    const role = same && /health-auto-export[/\\]samples\.js/.test(stack) ? 'history'
      : same && /lib[/\\]datastore[/\\]index\.js/.test(stack) ? 'card' : null;
    if (!role || args[1]?.readOnly) return db;
    const handle = ++handles;
    record('own-writer-open', { role, handle, readOnly: false });
    return wrap(db, role, handle);
  }
  WitnessDatabase.prototype = Original.prototype;
  Object.setPrototypeOf(WitnessDatabase, Original);
  sqlite.DatabaseSync = WitnessDatabase;
  const response = require('node:http').ServerResponse.prototype;
  const writeHead = response.writeHead;
  response.writeHead = function (...args) {
    if (this.req?.method === 'POST' && this.req.url === '/api/health-auto-export') {
      record('response-head', { status: args[0] });
    }
    return Reflect.apply(writeHead, this, args);
  };
}
