// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Isolated child driver. Outputs bounded observations, never stored values.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const root = path.resolve(process.env.INDEPENDENT_PRODUCT_ROOT || path.join(__dirname, '../..'));
const home = path.resolve(process.env.HEALTH_HOME || '');
assert.equal(path.dirname(home), path.resolve(os.tmpdir()));
assert.ok(path.basename(home).startsWith('eh-test-'));
const bank = require('../fixtures/health-connect/guard-migration-v2.json');
const ordinary = require(path.join(root, 'tests/fixtures/health-connect/durable-history-independent-vectors.json'));
const database = path.join(home, 'db/klebb.db');
const history = require(path.join(root, 'lib/health-connect/history'));
const command = process.argv[2];
const development = process.platform === 'win32' && process.env.INDEPENDENT_WINDOWS_DEVELOPMENT !== '0';
const boundary = { tenantId: ordinary.binding.tenantId, restoreEpoch: ordinary.binding.restoreEpoch,
  sources: [{ sourceStoreId: ordinary.binding.sourceStoreId, ownerId: 'synthetic-migration-owner' }] };
function seed() {
  const store = require(path.join(root, 'lib/datastore')).open();
  try { store.setData(bank.legacyId, bank.legacyData); } finally { store.close(); }
  const samples = require(path.join(root, 'health-auto-export/samples'));
  try { samples.recordPush(bank.haePayload, { receivedAt: bank.haeReceivedAt }); }
  finally { samples.close(); }
  const original = ordinary.vectors.find(item => item.id === 'initial-raw-only');
  const first = history.commitBatch(JSON.parse(original.payloadJson), original.payloadDigest);
  assert.deepEqual(first, original.expectedReceipt);
  const { makeObject } = require(path.join(root, 'tests/helpers/health-connect-independent-object-fixtures.cjs'));
  const objects = require(path.join(root, 'lib/health-connect/objects'));
  const complete = makeObject(ordinary.binding, bank.completeObject);
  for (const frame of complete.partFrames) assert.deepEqual(objects.stagePart(frame),
    complete.partReceipts[frame.partIndex]);
  assert.deepEqual(JSON.parse(JSON.stringify(objects.finaliseObject(complete.finalise))), complete.receipt);
  const active = makeObject(ordinary.binding, bank.activeObject);
  assert.deepEqual(objects.stagePart(active.partFrames[0]), active.partReceipts[0]);
  // Controlled trusted storage boundary only; this is not authority/fence evidence.
  const index = require(path.join(root, 'lib/health-connect/source-index'));
  assert.equal(index.prepareAttempt(boundary, ordinary.binding.sourceStoreId), true);
  assert.equal(index.publishSource(boundary, ordinary.binding.sourceStoreId), true);
  const db = new DatabaseSync(database);
  try {
    db.exec(bank.typedDdl);
    const insert = db.prepare('INSERT INTO migration_typed_fixture(kind,value) VALUES (?,?)');
    for (const row of bank.typedRows) {
      if (row.type === 'integer') insert.run(row.kind, BigInt(row.decimal));
      else if (row.type === 'real') db.prepare('INSERT INTO migration_typed_fixture(kind,value) VALUES (?,CAST(? AS REAL))')
        .run(row.kind, row.decimal);
      else if (row.type === 'blob') insert.run(row.kind, Buffer.from(row.hex, 'hex'));
      else insert.run(row.kind, row.value ?? null);
    }
    db.exec(bank.sentinelDdl);
    db.exec('VACUUM; PRAGMA wal_checkpoint(TRUNCATE)');
    assert.equal(db.prepare('PRAGMA freelist_count').get().freelist_count, 0);
  } finally { db.close(); }
  return { seeded: true };
}
function callback(db, metadata) {
  const version = db.prepare('SELECT version FROM health_schema_version').get().version;
  const guards = !!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='health_deletion_guards'").get();
  return { version, guards, guardRows: guards ?
    db.prepare('SELECT count(*) AS n FROM health_deletion_guards').get().n : null,
  metadata: metadata ?? null };
}
let result;
try {
  if (command === 'seed') result = seed();
  else if (command === 'migrate') result = history.withHistoryTransaction(callback,
    { deletionSchema: true, ...(development ? { windowsDevelopment: true } : {}) });
  else if (command === 'default') result = history.withHistoryTransaction(callback);
  else if (command === 'snapshot') result = history.readHistorySnapshot((db, present) => ({
    present, version: present ? db.prepare('SELECT version FROM health_schema_version').get().version : null }));
  else if (command === 'frontiers') result = { frontiers: history.readFrontiers([
    { binding: ordinary.binding, recordType: ordinary.category }]) };
  else if (command === 'object-default') {
    const { makeObject } = require(path.join(root, 'tests/helpers/health-connect-independent-object-fixtures.cjs'));
    const frame = makeObject(ordinary.binding, bank.activeObject).partFrames[0];
    const result = require(path.join(root, 'lib/health-connect/objects')).stagePart(frame);
    process.stdout.write(JSON.stringify({ ok: true, result: { kind: result.kind, partIndex: result.partIndex } }) + '\n');
    process.exit(0);
  } else if (command === 'index-default') {
    const result = require(path.join(root, 'lib/health-connect/source-index')).readStatus(boundary);
    process.stdout.write(JSON.stringify({ ok: true, result: { sourceCount: result.sources.length } }) + '\n');
    process.exit(0);
  } else throw new Error('Unknown synthetic migration command');
  process.stdout.write(JSON.stringify({ ok: true, result }) + '\n');
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, status: error.status ?? null,
    code: error.code === 'storage-unavailable' ? error.code : 'unexpected-test-driver-error' }) + '\n');
  process.exitCode = 1;
}
