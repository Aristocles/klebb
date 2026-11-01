// SPDX-License-Identifier: AGPL-3.0-only
'use strict';

const nativeTables = Object.freeze({
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

const objectTables = Object.freeze({
  health_object_staging: `CREATE TABLE health_object_staging (
    stream_key TEXT PRIMARY KEY, declaration_json TEXT NOT NULL,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, reservation_bytes INTEGER NOT NULL)`,
  health_object_parts: `CREATE TABLE health_object_parts (
    stream_key TEXT NOT NULL, part_index INTEGER NOT NULL, part_bytes BLOB NOT NULL, part_digest TEXT NOT NULL,
    PRIMARY KEY (stream_key, part_index),
    FOREIGN KEY (stream_key) REFERENCES health_object_staging(stream_key) ON DELETE CASCADE)`,
  health_object_receipts: `CREATE TABLE health_object_receipts (
    stream_key TEXT NOT NULL, sequence TEXT NOT NULL, batch_id TEXT NOT NULL,
    declaration_json TEXT NOT NULL, parts_json TEXT NOT NULL,
    PRIMARY KEY (stream_key, sequence), UNIQUE (stream_key, batch_id))`,
});

const sourceIndexTables = Object.freeze({
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

const sourcePolicyTables = Object.freeze({
  health_source_policy_state: `CREATE TABLE health_source_policy_state (
 version INTEGER NOT NULL CHECK (version=1),
 tenant_id TEXT NOT NULL,
 owner_id TEXT NOT NULL,
 epoch TEXT NOT NULL,
 revision TEXT NOT NULL CHECK (typeof(revision)='text' AND length(revision) BETWEEN 1 AND 19 AND revision NOT GLOB '*[^0-9]*' AND (revision='0' OR substr(revision,1,1)!='0') AND (length(revision)<19 OR revision<='9223372036854775807')),
 knowledge TEXT NOT NULL CHECK (knowledge IN ('UNKNOWN','COMPLETE')),
 source_count INTEGER NOT NULL CHECK (typeof(source_count)='integer' AND source_count BETWEEN 0 AND 128),
 PRIMARY KEY (tenant_id,owner_id)
)`,
  health_source_policy_sources: `CREATE TABLE health_source_policy_sources (
 tenant_id TEXT NOT NULL,
 source_store_id TEXT NOT NULL,
 owner_id TEXT NOT NULL,
 policy_id TEXT NOT NULL UNIQUE,
 lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active','retired')),
 knowledge TEXT NOT NULL CHECK (knowledge IN ('UNKNOWN','COMPLETE')),
 retain_committed_history INTEGER NOT NULL CHECK (typeof(retain_committed_history)='integer' AND retain_committed_history IN (0,1)),
 category_count INTEGER NOT NULL CHECK (typeof(category_count)='integer' AND category_count BETWEEN 0 AND 128),
 reconciled_epoch TEXT,
 PRIMARY KEY (tenant_id,source_store_id)
)`,
  health_source_policy_categories: `CREATE TABLE health_source_policy_categories (
 tenant_id TEXT NOT NULL,
 source_store_id TEXT NOT NULL,
 record_type TEXT NOT NULL,
 sharing TEXT NOT NULL CHECK (sharing IN ('enabled','stopped')),
 generation TEXT NOT NULL CHECK (typeof(generation)='text' AND length(generation) BETWEEN 1 AND 19 AND generation NOT GLOB '*[^0-9]*' AND (generation='0' OR substr(generation,1,1)!='0') AND (length(generation)<19 OR generation<='9223372036854775807')),
 PRIMARY KEY (tenant_id,source_store_id,record_type),
 FOREIGN KEY (tenant_id,source_store_id) REFERENCES health_source_policy_sources (tenant_id,source_store_id)
)`,
});

function validateSourcePolicySchema(db, refuse) {
  const found = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema "
    + "WHERE lower(name) GLOB 'health_source_policy_*' "
    + "OR lower(tbl_name) GLOB 'health_source_policy_*'").all();
  if (!found.length) return;
  for (const [name, sql] of Object.entries(sourcePolicyTables)) {
    if (found.find(row => row.type === 'table' && row.name === name)?.sql !== sql) refuse();
  }
  for (const row of found) {
    if (row.type === 'table' && Object.hasOwn(sourcePolicyTables, row.name)
        && row.sql === sourcePolicyTables[row.name]) continue;
    if (row.type === 'index' && row.sql === null && Object.hasOwn(sourcePolicyTables, row.tbl_name)
        && row.name.startsWith(`sqlite_autoindex_${row.tbl_name}_`)) continue;
    refuse();
  }
}

const markerV2 = "CREATE TABLE health_schema_version (version INTEGER PRIMARY KEY CHECK(version = 2))";
const guardV2 = `CREATE TABLE health_deletion_guards (
    tenant_id TEXT NOT NULL, source_store_id TEXT NOT NULL, record_type TEXT NOT NULL,
    native_record_id TEXT NOT NULL,
    source_deleted INTEGER NOT NULL CHECK(source_deleted IN (0, 1)),
    user_suppressed INTEGER NOT NULL CHECK(user_suppressed IN (0, 1)),
    source_stream_key TEXT, source_sequence TEXT, footprint_json TEXT,
    PRIMARY KEY (tenant_id, source_store_id, record_type, native_record_id),
    CHECK(source_deleted = 1 OR user_suppressed = 1),
    CHECK((source_deleted = 1 AND source_stream_key IS NOT NULL AND source_sequence IS NOT NULL)
       OR (source_deleted = 0 AND source_stream_key IS NULL AND source_sequence IS NULL)),
    CHECK(footprint_json IS NULL OR (
        length(CAST(footprint_json AS BLOB)) <= 2048
        AND json_valid(footprint_json)
        AND json_type(footprint_json) = 'object'))
)`;

const restorePublicationTables = Object.freeze({
  health_restore_publication: `CREATE TABLE health_restore_publication (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  version INTEGER NOT NULL CHECK(version = 1), publication_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL, instance_id TEXT NOT NULL, restore_epoch TEXT NOT NULL,
  metadata_json TEXT NOT NULL, metadata_sha256 TEXT NOT NULL, envelope_json TEXT NOT NULL)`,
  health_restore_source_owners: `CREATE TABLE health_restore_source_owners (
  tenant_id TEXT NOT NULL, source_store_id TEXT NOT NULL, owner_id TEXT NOT NULL,
  PRIMARY KEY (tenant_id, source_store_id))`,
});

module.exports = { nativeTables, objectTables, sourceIndexTables, restorePublicationTables, markerV2, guardV2,
  sourcePolicyTables, validateSourcePolicySchema };
