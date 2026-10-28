// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Actual publisher observations and controlled catalogue-fence input, not a
// simulated restore, callback error or substituted SQLite result.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite = require('node:sqlite');
const home = path.resolve(process.env.HEALTH_HOME || '');
assert.ok(home.startsWith(path.resolve(os.tmpdir()) + path.sep));
assert.ok(path.basename(home).startsWith('eh-test-'));
const product = path.resolve(process.env.INDEPENDENT_PRODUCT_ROOT || '');
const source = path.join(product, 'lib/health-connect/source-index.js').replaceAll('\\', '/');
const database = path.join(home, 'db', 'klebb.db');
const catalogue = path.join(home, 'credentials', 'health-connect.json');
const observations = path.resolve(process.env.INDEPENDENT_INDEX_LIFECYCLE_OBSERVATIONS || '');
const enabled = path.resolve(process.env.INDEPENDENT_INDEX_LIFECYCLE_ENABLED || '');
assert.equal(path.dirname(observations), home);
assert.equal(path.dirname(enabled), home);
const action = process.env.INDEPENDENT_INDEX_LIFECYCLE_ACTION;
assert.ok(['observe', 'rotate'].includes(action));
const newEpoch = process.env.INDEPENDENT_INDEX_LIFECYCLE_NEW_EPOCH;
if (action === 'rotate') assert.match(newEpoch, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
const Original = sqlite.DatabaseSync;
let nextHandle = 0, nextTransaction = 0, rotated = false;
const begin = /^\s*BEGIN(?:\s|;|$)/i;
const commit = /^\s*(?:COMMIT|END)(?:\s|;|$)/i;
const rollback = /^\s*ROLLBACK(?:\s|;|$)/i;
const mutation = /^\s*(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+(health_source_index(?:_frontiers|_state)?)(?:\s|\()/i;
function record(event) {
  fs.appendFileSync(observations, JSON.stringify({ observedAt: Date.now(), ...event }) + '\n',
    { encoding: 'utf8', mode: 0o600 });
}
function isPublisher() {
  const frame = new Error().stack.split('\n')
    .find(line => line.replaceAll('\\', '/').includes(source + ':'));
  return !!frame && /\bat (?:[A-Za-z0-9_$]+\.)?publishSource(?:\s|\()/u.test(frame);
}
sqlite.DatabaseSync = new Proxy(Original, {
  construct(target, args) {
    const publisher = isPublisher();
    const db = Reflect.construct(target, args, target);
    if (!publisher || typeof args[0] !== 'string' || path.resolve(args[0]) !== database) return db;
    const prepare = db.prepare.bind(db), exec = db.exec.bind(db);
    const handleId = ++nextHandle;
    let transactionId = 0, active = false, identitiesWritten = 0, frontiersWritten = 0;
    function mode(kind) {
      record({ kind, handleId, transactionId, transactionActive: active,
        journalMode: prepare('PRAGMA journal_mode').get().journal_mode,
        synchronous: prepare('PRAGMA synchronous').get().synchronous });
    }
    function invoke(sql, method, values) {
      if (begin.test(sql)) {
        transactionId = ++nextTransaction;
        identitiesWritten = 0; frontiersWritten = 0;
        mode('publisher-before-begin');
      }
      const result = method(...values);
      if (begin.test(sql)) { active = true; mode('publisher-begin-complete'); }
      const table = mutation.exec(sql)?.[1];
      if (table) {
        const changes = Number(result?.changes ?? prepare('SELECT changes() AS n').get().n);
        assert.ok(Number.isSafeInteger(changes) && changes >= 0);
        if (/^\s*INSERT\b/i.test(sql) && table === 'health_source_index') identitiesWritten += changes;
        if (/^\s*INSERT\b/i.test(sql) && table === 'health_source_index_frontiers') frontiersWritten += changes;
        record({ kind: 'successful-derived-write', handleId, transactionId,
          table, changes, transactionActive: active });
        if (table === 'health_source_index_state' && /\bcurrent\b/i.test(sql) &&
            action === 'rotate' && !rotated && fs.existsSync(enabled)) {
          assert.ok(active && identitiesWritten > 0 && frontiersWritten > 0 && changes > 0);
          const pending = prepare('SELECT state,published_restore_epoch FROM health_source_index_state').all();
          assert.equal(pending.length, 1);
          assert.equal(pending[0].state, 'current', 'actual pending SQL current row was written');
          const state = JSON.parse(fs.readFileSync(catalogue, 'utf8'));
          const oldEpoch = state.restoreEpoch;
          assert.notEqual(oldEpoch, newEpoch);
          state.restoreEpoch = newEpoch;
          fs.writeFileSync(catalogue, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
          rotated = true;
          record({ kind: 'actual-catalogue-fence-rotated-after-publication-writes',
            handleId, transactionId, oldEpoch, newEpoch, identitiesWritten, frontiersWritten,
            pendingState: pending[0].state, pendingPublishedEpoch: pending[0].published_restore_epoch,
            transactionActive: active });
        }
      }
      if (commit.test(sql)) {
        active = false;
        record({ kind: 'publisher-commit-complete', handleId, transactionId });
      }
      if (rollback.test(sql)) {
        active = false;
        record({ kind: 'publisher-rollback-complete', handleId, transactionId });
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
record({ kind: 'lifecycle-observer-loaded', action });
