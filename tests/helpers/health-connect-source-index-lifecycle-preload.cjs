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
const catalogue = path.join(home, 'credentials', 'health-connect-policy.json');
const observations = path.resolve(process.env.INDEPENDENT_INDEX_LIFECYCLE_OBSERVATIONS || '');
const enabled = path.resolve(process.env.INDEPENDENT_INDEX_LIFECYCLE_ENABLED || '');
assert.equal(path.dirname(observations), home);
assert.equal(path.dirname(enabled), home);
const action = process.env.INDEPENDENT_INDEX_LIFECYCLE_ACTION;
assert.ok(['observe', 'rotate'].includes(action));
const newEpoch = process.env.INDEPENDENT_INDEX_LIFECYCLE_NEW_EPOCH;
if (action === 'rotate') assert.match(newEpoch, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
const Original = sqlite.DatabaseSync;
let nextHandle = 0, nextTransaction = 0, rotated = false, pendingCustody = null;
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
          const pending = prepare('SELECT tenant_id,source_store_id,state,published_restore_epoch FROM health_source_index_state').all();
          assert.equal(pending.length, 1);
          assert.equal(pending[0].state, 'current', 'actual pending SQL current row was written');
          const current = JSON.parse(fs.readFileSync(catalogue, 'utf8'));
          const selected = current.namespaces.filter(namespace => namespace.state.tenantId === pending[0].tenant_id &&
            namespace.state.connectors.some(connector => connector.sourceStoreId === pending[0].source_store_id));
          assert.equal(selected.length, 1);
          const namespace = selected[0], state = namespace.state;
          const custody = prepare('SELECT owner_id,epoch FROM health_source_policy_state WHERE tenant_id=?')
            .get(state.tenantId);
          assert.equal(custody.owner_id, namespace.ownerId);
          const oldEpoch = state.restoreEpoch;
          assert.equal(custody.epoch, oldEpoch);
          assert.notEqual(oldEpoch, newEpoch);
          state.restoreEpoch = newEpoch;
          for (const grant of state.grants) grant.restoreEpoch = newEpoch;
          for (const connector of state.connectors) {
            connector.restoreEpoch = newEpoch;
            connector.revokedAt ||= new Date().toISOString();
          }
          fs.writeFileSync(catalogue, JSON.stringify(current), { encoding: 'utf8', mode: 0o600 });
          pendingCustody = { tenantId: state.tenantId, ownerId: namespace.ownerId, oldEpoch };
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
        if (pendingCustody) {
          const custody = pendingCustody;
          exec('BEGIN IMMEDIATE');
          try {
            assert.equal(prepare('UPDATE health_source_policy_state SET epoch=?, '
              + 'revision=CAST(CAST(revision AS INTEGER)+1 AS TEXT) WHERE tenant_id=? AND owner_id=? AND epoch=?')
              .run(newEpoch, custody.tenantId, custody.ownerId, custody.oldEpoch).changes, 1);
            assert.equal(prepare('UPDATE health_source_policy_sources SET reconciled_epoch=NULL WHERE tenant_id=?')
              .run(custody.tenantId).changes, 1);
            assert.equal(prepare("UPDATE health_source_policy_categories SET sharing='stopped', "
              + 'readiness_epoch=NULL,readiness_installation_id=NULL,readiness_generation=NULL,'
              + 'readiness_query_digest=NULL,readiness_report_digest=NULL,readiness_mac=NULL WHERE tenant_id=?')
              .run(custody.tenantId).changes, 1);
            exec('COMMIT');
          } catch (error) { try { exec('ROLLBACK'); } catch {} throw error; }
          pendingCustody = null;
          record({ kind: 'actual-managed-custody-control-complete-after-publisher-rollback',
            handleId, transactionId, tenantId: custody.tenantId, oldEpoch: custody.oldEpoch, newEpoch });
        }
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
