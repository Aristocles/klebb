// SPDX-License-Identifier: AGPL-3.0-only
'use strict';

const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { DB_FILE } = require('../../config/paths');
const { decodeMessage, ProtocolError } = require('./protocol');

class HistoryError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}
const unavailable = () => { throw new HistoryError(503, 'storage-unavailable'); };
const tables = Object.freeze({
  health_schema_version: `CREATE TABLE health_schema_version (version INTEGER PRIMARY KEY CHECK(version = 1))`,
  health_records: `CREATE TABLE health_records (
    tenant_id TEXT NOT NULL, source_store_id TEXT NOT NULL, record_type TEXT NOT NULL,
    native_record_id TEXT NOT NULL, serializer_id TEXT NOT NULL, serializer_version INTEGER NOT NULL,
    data_family TEXT NOT NULL, projection TEXT NOT NULL, record_json TEXT NOT NULL,
    PRIMARY KEY (tenant_id, source_store_id, record_type, native_record_id))`,
  health_tombstones: `CREATE TABLE health_tombstones (
    tenant_id TEXT NOT NULL, source_store_id TEXT NOT NULL, record_type TEXT NOT NULL,
    native_record_id TEXT NOT NULL, stream_key TEXT NOT NULL, sequence TEXT NOT NULL,
    PRIMARY KEY (tenant_id, source_store_id, record_type, native_record_id))`,
  health_streams: `CREATE TABLE health_streams (
    stream_key TEXT PRIMARY KEY, record_type TEXT NOT NULL, acknowledged_sequence TEXT NOT NULL)`,
  health_batch_receipts: `CREATE TABLE health_batch_receipts (
    stream_key TEXT NOT NULL, sequence TEXT NOT NULL, batch_id TEXT NOT NULL,
    payload_digest TEXT NOT NULL, receipt_json TEXT NOT NULL,
    PRIMARY KEY (stream_key, sequence), UNIQUE (stream_key, batch_id))`,
  health_projection_outbox: `CREATE TABLE health_projection_outbox (
    stream_key TEXT NOT NULL, sequence TEXT NOT NULL, batch_id TEXT NOT NULL,
    payload_digest TEXT NOT NULL, state TEXT NOT NULL CHECK(state = 'queued'),
    PRIMARY KEY (stream_key, sequence))`,
});
// This is transport scope. Native record keys deliberately exclude installation,
// instance, sharing generation and restore epoch.
function streamKey(binding, recordType) {
  return JSON.stringify([binding.tenantId, binding.instanceId, binding.sourceStoreId,
    binding.installationId, recordType, binding.generation, binding.restoreEpoch]);
}
const uint = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(value) &&
  BigInt(value) <= 9223372036854775807n;
function schemaPresent(db, create = false) {
  const found = db.prepare("SELECT name, sql FROM sqlite_schema WHERE type='table' "
    + "AND name GLOB 'health_*'").all();
  if (found.length === 0) {
    if (!create) return false;
    for (const sql of Object.values(tables)) db.exec(sql);
    db.exec('CREATE INDEX health_receipt_sequence_order ON health_batch_receipts '
      + '(stream_key, length(sequence), sequence)');
    db.prepare('INSERT INTO health_schema_version (version) VALUES (1)').run();
  } else {
    // A missing/changed required table or unknown version fails closed; never
    // replace a partial database with an empty history.
    for (const [name, sql] of Object.entries(tables)) {
      if (found.find(row => row.name === name)?.sql !== sql) unavailable();
    }
  }
  const versions = db.prepare('SELECT version FROM health_schema_version').all();
  if (versions.length !== 1 || versions[0].version !== 1) unavailable();
  return true;
}
function frontier(db, key, binding, recordType) {
  const row = db.prepare('SELECT record_type, acknowledged_sequence FROM health_streams WHERE stream_key = ?').get(key);
  const sequence = row?.acknowledged_sequence ?? '0';
  if (!uint(sequence) || (row && row.record_type !== recordType)) unavailable();
  // Canonical strings sort numerically by length, then ordinal digits.
  // Require the latest receipt, including when a corrupted frontier lags.
  const latest = db.prepare('SELECT sequence FROM health_batch_receipts WHERE stream_key = ? '
    + 'ORDER BY length(sequence) DESC, sequence DESC LIMIT 1').get(key);
  if (latest && (sequence === '0' || !uint(latest.sequence) || latest.sequence !== sequence)) unavailable();
  if (sequence !== '0') {
    const saved = db.prepare('SELECT batch_id, payload_digest, receipt_json FROM health_batch_receipts '
      + 'WHERE stream_key = ? AND sequence = ?').get(key, sequence);
    if (!saved) unavailable();
    const receipt = decodeMessage(saved.receipt_json, { binding, categories: [recordType] });
    if (receipt.kind !== 'durable-receipt' || receipt.recordType !== recordType ||
        receipt.sequence !== sequence || receipt.batchId !== saved.batch_id ||
        receipt.payloadDigest !== saved.payload_digest) unavailable();
  }
  return sequence;
}
function readFrontiers(entries) {
  let db;
  try {
    if (!fs.statSync(DB_FILE).isFile()) unavailable();
    db = new DatabaseSync(DB_FILE, { readOnly: true });
    db.exec('PRAGMA busy_timeout=5000');
    db.exec('BEGIN');
    const present = schemaPresent(db);
    const results = entries.map(({ binding, recordType }) =>
      present ? frontier(db, streamKey(binding, recordType), binding, recordType) : '0');
    db.exec('COMMIT');
    return results;
  } catch { unavailable(); }
  finally { if (db) db.close(); }
}
function withHistoryTransaction(work) {
  let db;
  let transaction = false;
  try {
    // Instance bootstrap owns creation of the main legacy database. Native
    // ingestion must refuse a missing file instead of recreating empty history.
    if (!fs.statSync(DB_FILE).isFile()) unavailable();
    db = new DatabaseSync(DB_FILE);
    db.exec('PRAGMA busy_timeout=5000');
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA synchronous=FULL');
    db.exec('PRAGMA foreign_keys=ON');
    // Durability settings are per connection, so observe this writer before
    // BEGIN instead of relying on a different datastore handle's setting.
    if (db.prepare('PRAGMA journal_mode').get().journal_mode !== 'wal' ||
        db.prepare('PRAGMA synchronous').get().synchronous !== 2) unavailable();
    db.exec('BEGIN IMMEDIATE');
    transaction = true;
    schemaPresent(db, true);
    const result = work(db);
    if (result && typeof result.then === 'function') unavailable();
    db.exec('COMMIT');
    transaction = false;
    return result;
  } catch (error) {
    if (transaction) try { db.exec('ROLLBACK'); } catch {}
    if (error instanceof HistoryError || error instanceof ProtocolError) throw error;
    unavailable();
  } finally { if (db) db.close(); }
}
// Callers can add compact object metadata and remove staging in this same
// transaction. This function never opens a nested writer or commits early.
function commitBatchInTransaction(db, payload, digest) {
  const { binding, recordType, sequence, batchId, changes } = payload;
  const key = streamKey(binding, recordType);
  const receipt = { version: 1, kind: 'durable-receipt', binding, recordType,
    sequence, batchId, payloadDigest: digest };
  decodeMessage(JSON.stringify(receipt), { binding, categories: [recordType] });
  const acknowledged = frontier(db, key, binding, recordType);
  const previous = db.prepare('SELECT sequence, batch_id, payload_digest, receipt_json '
    + 'FROM health_batch_receipts WHERE stream_key = ? AND (sequence = ? OR batch_id = ?)')
    .all(key, sequence, batchId);
  if (previous.length) {
    const original = previous[0];
    if (previous.length !== 1 || original.sequence !== sequence || original.batch_id !== batchId ||
        original.payload_digest !== digest) throw new HistoryError(409, 'conflict');
    if (BigInt(acknowledged) < BigInt(sequence)) unavailable();
    const saved = decodeMessage(original.receipt_json, { binding, categories: [recordType] });
    if (saved.kind !== receipt.kind || saved.sequence !== sequence || saved.batchId !== batchId ||
        saved.payloadDigest !== digest) unavailable();
    return saved;
  }
  if (BigInt(sequence) <= BigInt(acknowledged)) throw new HistoryError(409, 'conflict');
  if (BigInt(sequence) !== BigInt(acknowledged) + 1n) throw new HistoryError(409, 'sequence-gap');
  const remove = db.prepare('DELETE FROM health_records WHERE tenant_id = ? AND source_store_id = ? '
    + 'AND record_type = ? AND native_record_id = ?');
  const untombstone = db.prepare('DELETE FROM health_tombstones WHERE tenant_id = ? '
    + 'AND source_store_id = ? AND record_type = ? AND native_record_id = ?');
  const upsert = db.prepare('INSERT INTO health_records (tenant_id, source_store_id, record_type, '
    + 'native_record_id, serializer_id, serializer_version, data_family, projection, record_json) '
    + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (tenant_id, source_store_id, record_type, native_record_id) '
    + 'DO UPDATE SET serializer_id=excluded.serializer_id, serializer_version=excluded.serializer_version, '
    + 'data_family=excluded.data_family, projection=excluded.projection, record_json=excluded.record_json');
  const tombstone = db.prepare('INSERT INTO health_tombstones (tenant_id, source_store_id, record_type, '
    + 'native_record_id, stream_key, sequence) VALUES (?, ?, ?, ?, ?, ?) '
    + 'ON CONFLICT (tenant_id, source_store_id, record_type, native_record_id) '
    + 'DO UPDATE SET stream_key=excluded.stream_key, sequence=excluded.sequence');
  for (const change of changes) {
    const identity = [binding.tenantId, binding.sourceStoreId, recordType, change.identity.nativeRecordId];
    if (change.operation === 'upsert') {
      upsert.run(...identity, change.serializerId, change.serializerVersion,
        change.dataFamily, change.projection, JSON.stringify(change.record));
      untombstone.run(...identity);
    } else {
      remove.run(...identity);
      tombstone.run(...identity, key, sequence);
    }
  }
  db.prepare('INSERT INTO health_batch_receipts (stream_key, sequence, batch_id, payload_digest, receipt_json) '
    + 'VALUES (?, ?, ?, ?, ?)').run(key, sequence, batchId, digest, JSON.stringify(receipt));
  db.prepare('INSERT INTO health_streams (stream_key, record_type, acknowledged_sequence) VALUES (?, ?, ?) '
    + 'ON CONFLICT (stream_key) DO UPDATE SET acknowledged_sequence=excluded.acknowledged_sequence')
    .run(key, recordType, sequence);
  // The job references a source/type scope for rebuilding from current records
  // and tombstones. It never archives superseded or deleted record payloads.
  db.prepare('INSERT INTO health_projection_outbox (stream_key, sequence, batch_id, payload_digest, state) '
    + "VALUES (?, ?, ?, ?, 'queued')").run(key, sequence, batchId, digest);
  return receipt;
}
function commitBatch(payload, digest) {
  return withHistoryTransaction(db => commitBatchInTransaction(db, payload, digest));
}
module.exports = { commitBatch, readFrontiers, HistoryError, streamKey, frontier,
  withHistoryTransaction, commitBatchInTransaction };
