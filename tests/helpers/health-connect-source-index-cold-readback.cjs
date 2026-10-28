// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Independently fixed SQLite contracts. This reader never imports the worker.
const assert = require('node:assert/strict');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const TABLE_DDL = Object.freeze({
  health_source_index: `CREATE TABLE health_source_index (
  tenant_id TEXT NOT NULL, source_store_id TEXT NOT NULL,
  record_type TEXT NOT NULL, native_record_id TEXT NOT NULL,
  entry_kind TEXT NOT NULL CHECK(entry_kind IN ('record', 'tombstone')),
  PRIMARY KEY (tenant_id, source_store_id, record_type, native_record_id))`,
  health_source_index_frontiers: `CREATE TABLE health_source_index_frontiers (
  tenant_id TEXT NOT NULL, source_store_id TEXT NOT NULL,
  stream_key TEXT NOT NULL, record_type TEXT NOT NULL,
  acknowledged_sequence TEXT NOT NULL,
  PRIMARY KEY (tenant_id, source_store_id, stream_key))`,
  health_source_index_state: `CREATE TABLE health_source_index_state (
  tenant_id TEXT NOT NULL, source_store_id TEXT NOT NULL,
  target_id TEXT NOT NULL CHECK(target_id = 'source-index-v1'),
  state TEXT NOT NULL CHECK(state IN ('queued', 'failed', 'current')),
  requested_restore_epoch TEXT NOT NULL,
  requested_vector_digest TEXT,
  attempt_count INTEGER NOT NULL CHECK(attempt_count BETWEEN 0 AND 3),
  next_attempt_at INTEGER,
  error_code TEXT,
  published_restore_epoch TEXT,
  published_at INTEGER,
  PRIMARY KEY (tenant_id, source_store_id))`,
});
const TABLE_NAMES = Object.freeze(Object.keys(TABLE_DDL));
const REQUIRED_NATIVE = ['health_records', 'health_tombstones',
  'health_batch_receipts', 'health_streams', 'health_projection_outbox'];
const ordinal = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const normaliseSql = sql => sql.replace(/\bIF\s+NOT\s+EXISTS\s+/i, '')
  .replace(/\s+/g, ' ').trim().replace(/;$/, '');

function orderedRows(db, name) {
  if (!/^health_[a-z_]+$/.test(name)) throw new Error('Unexpected synthetic schema name');
  return db.prepare(`SELECT * FROM "${name}"`).all()
    .map(row => ({ ...row }))
    .sort((left, right) => ordinal(JSON.stringify(left), JSON.stringify(right)));
}

function readIndex(db, schema) {
  const schemaRows = schema.filter(row => TABLE_NAMES.includes(row.name));
  if (schemaRows.length === 0) {
    return { schemaPresent: false, schemaRows: [],
      indexRows: [], frontierRows: [], stateRows: [] };
  }
  assert.equal(schemaRows.length, TABLE_NAMES.length, 'complete derived schema exists');
  for (const row of schemaRows) {
    assert.equal(normaliseSql(row.sql), normaliseSql(TABLE_DDL[row.name]),
      `independently fixed ${row.name} definition is unchanged`);
  }
  return {
    schemaPresent: true,
    schemaRows,
    indexRows: db.prepare('SELECT * FROM health_source_index '
      + 'ORDER BY tenant_id, source_store_id, record_type, native_record_id').all()
      .map(row => ({ ...row })),
    frontierRows: db.prepare('SELECT * FROM health_source_index_frontiers '
      + 'ORDER BY tenant_id, source_store_id, stream_key').all()
      .map(row => ({ ...row })),
    stateRows: db.prepare('SELECT * FROM health_source_index_state '
      + 'ORDER BY tenant_id, source_store_id').all()
      .map(row => ({ ...row })),
  };
}

function readNative(db, schema) {
  const nativeSchema = schema.filter(row => !TABLE_NAMES.includes(row.name));
  const names = nativeSchema.map(row => row.name);
  const legacyCards = db.prepare('SELECT * FROM cards ORDER BY card_id').all();
  const legacyRows = db.prepare('SELECT * FROM rows ORDER BY card_id, container, seq').all();
  if (names.length === 0) {
    if (schema.length) throw new Error('Derived index exists without native history');
    return { records: [], tombstoneIds: [], typedTombstones: [],
      receipts: [], frontiers: [], jobs: [], legacyCards, legacyRows,
      nativeSchema, nativeTables: {}, logicalNativeDump: '{}' };
  }
  for (const name of REQUIRED_NATIVE) {
    if (!names.includes(name)) throw new Error('Incomplete synthetic native schema');
  }
  const nativeTables = {};
  for (const name of names) nativeTables[name] = orderedRows(db, name);
  const records = db.prepare('SELECT tenant_id, source_store_id, record_type, '
    + 'native_record_id, record_json FROM health_records '
    + 'ORDER BY tenant_id, source_store_id, record_type, native_record_id').all()
    .map(row => ({
      identity: { tenantId: row.tenant_id, sourceStoreId: row.source_store_id,
        recordType: row.record_type, nativeRecordId: row.native_record_id },
      record: JSON.parse(row.record_json),
    }));
  const typedTombstones = db.prepare('SELECT tenant_id, source_store_id, record_type, '
    + 'native_record_id FROM health_tombstones '
    + 'ORDER BY tenant_id, source_store_id, record_type, native_record_id').all()
    .map(row => ({ tenantId: row.tenant_id, sourceStoreId: row.source_store_id,
      recordType: row.record_type, nativeRecordId: row.native_record_id }));
  const receipts = db.prepare('SELECT receipt_json FROM health_batch_receipts '
    + 'ORDER BY stream_key, length(sequence), sequence').all()
    .map(row => JSON.parse(row.receipt_json));
  const frontiers = db.prepare('SELECT record_type, acknowledged_sequence FROM health_streams '
    + 'ORDER BY stream_key').all().map(row => ({
      recordType: row.record_type, acknowledgedSequence: row.acknowledged_sequence,
    }));
  const jobs = db.prepare('SELECT batch_id, state FROM health_projection_outbox '
    + 'ORDER BY stream_key, length(sequence), sequence').all()
    .map(row => ({ batchId: row.batch_id, state: row.state }));
  return {
    records, typedTombstones,
    tombstoneIds: typedTombstones.map(identity => identity.nativeRecordId),
    receipts, frontiers, jobs, legacyCards, legacyRows, nativeSchema, nativeTables,
    logicalNativeDump: JSON.stringify(nativeTables),
  };
}

function coldReadSourceState(home) {
  // readOnly prevents a missing database from being created as empty truth.
  const db = new DatabaseSync(path.join(home, 'db', 'klebb.db'), { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=5000');
    db.exec('BEGIN');
    const schema = db.prepare("SELECT name, sql FROM sqlite_schema WHERE type='table' "
      + "AND name GLOB 'health_*' ORDER BY name").all();
    const snapshot = { native: readNative(db, schema), index: readIndex(db, schema) };
    db.exec('COMMIT');
    return snapshot;
  } finally { db.close(); }
}

const coldReadSourceIndex = home => coldReadSourceState(home).index;
const coldReadSourceNative = home => coldReadSourceState(home).native;
function publicationOf(index) {
  return {
    indexRows: index.indexRows,
    frontierRows: index.frontierRows,
    publishedStateRows: index.stateRows
      .filter(row => row.published_restore_epoch !== null || row.published_at !== null)
      .map(row => ({
        tenant_id: row.tenant_id, source_store_id: row.source_store_id,
        published_restore_epoch: row.published_restore_epoch, published_at: row.published_at,
      })),
  };
}
module.exports = { coldReadSourceState, coldReadSourceIndex, coldReadSourceNative,
  publicationOf, TABLE_DDL, TABLE_NAMES };
