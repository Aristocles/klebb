// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Disclosed stopped synthetic inventories; these are not capture/admission ACKs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const home = path.resolve(process.env.HEALTH_HOME || '');
assert.equal(path.dirname(home), path.resolve(os.tmpdir()));
assert.ok(path.basename(home).startsWith('eh-test-'));
assert.equal(fs.lstatSync(home).isSymbolicLink(), false);
const filename = path.join(home, 'db', 'klebb.db');
assert.ok(fs.statSync(filename).isFile(), 'controls never create a missing database');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const sha = bytes => 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex');
const ordinal = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const db = new DatabaseSync(filename);
let result;
function exhaust(source) {
  const rows = db.prepare('SELECT stream_key,acknowledged_sequence FROM health_streams').all()
    .filter(row => JSON.parse(row.stream_key)[2] === source.sourceStoreId)
    .map(row => [row.stream_key, row.acknowledged_sequence]).sort((a, b) => ordinal(a[0], b[0]));
  const changed = db.prepare("UPDATE health_source_index_state SET state='failed',"
    + 'requested_restore_epoch=?,requested_vector_digest=?,attempt_count=3,'
    + "next_attempt_at=NULL,error_code='storage-unavailable' WHERE tenant_id=? AND source_store_id=?")
    .run(source.restoreEpoch, rows.length > 1000 ? null : sha(Buffer.from(JSON.stringify(rows))),
      source.tenantId, source.sourceStoreId);
  assert.equal(changed.changes, 1);
}
try {
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
  if (input.command === 'exhaust') {
    exhaust(input.binding); result = { exhausted: true };
  } else if (input.command === 'pressure') {
    // This named fixture-only table is part of the before snapshot. It remains
    // empty on rollback; no production table/schema/migration is substituted.
    db.exec('CREATE TABLE owner_deletion_synthetic_pressure (payload BLOB NOT NULL)');
    if (input.refusal) db.exec("CREATE TRIGGER owner_deletion_synthetic_pressure_refusal "
      + "BEFORE INSERT ON owner_deletion_synthetic_pressure BEGIN "
      + "SELECT RAISE(ABORT,'synthetic disclosed late write refusal'); END");
    result = { pressureTable: true };
  } else if (input.command === 'raw-bytes') {
    const { binding, identities, totalBytes } = input;
    assert.ok(identities.length <= 100);
    db.prepare('DELETE FROM health_records WHERE tenant_id=? AND source_store_id=?')
      .run(binding.tenantId, binding.sourceStoreId);
    const insert = db.prepare('INSERT INTO health_records VALUES (?,?,?,?,?,?,?,?,?)');
    let remaining = totalBytes;
    for (let index = 0; index < identities.length; index++) {
      const id = identities[index].nativeRecordId;
      const record = structuredClone(input.record);
      record.metadata.id = id; record.extension = { padding: '' };
      const minimum = Buffer.byteLength(JSON.stringify(record));
      const bytes = index === identities.length - 1 ? remaining :
        Math.floor(totalBytes / identities.length);
      assert.ok(bytes >= minimum && bytes <= 1048576);
      record.extension.padding = 'P'.repeat(bytes - minimum);
      const json = JSON.stringify(record);
      assert.equal(Buffer.byteLength(json), bytes);
      insert.run(binding.tenantId, binding.sourceStoreId, input.recordType, id,
        'health-connect-record', 1, 'ordinary', 'raw-only', json);
      remaining -= bytes;
    }
    assert.equal(remaining, 0); exhaust(binding);
    result = { records: identities.length, bytes: totalBytes };
  } else if (input.command === 'vector') {
    const { binding, recordType, count } = input;
    const sourceRows = db.prepare('SELECT stream_key FROM health_streams').all()
      .filter(row => JSON.parse(row.stream_key)[2] === binding.sourceStoreId);
    assert.equal(sourceRows.length, 1, 'keep original real beta stream');
    for (let index = 1; index < count; index++) {
      const b = { ...binding, installationId: `stopped-vector-${index}`, generation: String(index + 10) };
      const key = JSON.stringify([b.tenantId, b.instanceId, b.sourceStoreId,
        b.installationId, recordType, b.generation, b.restoreEpoch]);
      const batchId = `stopped-vector-${index}`, digest = sha(Buffer.from(batchId));
      const receipt = { version: 1, kind: 'durable-receipt', binding: b, recordType,
        sequence: '1', batchId, payloadDigest: digest };
      db.prepare('INSERT INTO health_streams VALUES (?,?,?)').run(key, recordType, '1');
      db.prepare('INSERT INTO health_batch_receipts VALUES (?,?,?,?,?)')
        .run(key, '1', batchId, digest, JSON.stringify(receipt));
      db.prepare('INSERT INTO health_projection_outbox VALUES (?,?,?,?,?)')
        .run(key, '1', batchId, digest, 'queued');
    }
    exhaust(binding); result = { streams: count };
  } else throw new Error('Unexpected owner-deletion synthetic control');
  db.exec('COMMIT');
  if (input.vacuum) {
    db.exec('VACUUM; PRAGMA wal_checkpoint(TRUNCATE)');
    assert.equal(db.prepare('PRAGMA freelist_count').get().freelist_count, 0);
  }
  process.stdout.write(JSON.stringify({ ok: true, result }) + '\n');
} catch (error) {
  try { db.exec('ROLLBACK'); } catch {}
  process.stdout.write(JSON.stringify({ ok: false, code: error.code || null,
    sqliteResult: error.errcode || null }) + '\n');
  process.exitCode = 1;
} finally { db.close(); }
