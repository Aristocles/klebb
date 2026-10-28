// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Cold readback uses separately fixed table/column contracts and compares
// logical effects without consulting the implementation's in-memory state.
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
function coldReadNative(home) {
  const db = new DatabaseSync(path.join(home, 'db', 'klebb.db'), { readOnly: true });
  try {
    db.exec('BEGIN');
    const nativeNames = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' "
      + "AND name GLOB 'health_*' AND name NOT IN ('health_source_index',"
      + "'health_source_index_frontiers','health_source_index_state') ORDER BY name").all().map(row => row.name);
    // These three rebuildable tables have their own independent schema/full-row
    // reader and publication/failure/death checks. Preserve every original
    // native/object table here, including unexpected additional native tables.
    // A refused request may legitimately never initialise the additive store.
    // Absence means empty native history; a partial schema is never accepted.
    if (nativeNames.length === 0) {
      const legacyCards = db.prepare('SELECT * FROM cards ORDER BY card_id').all();
      const legacyRows = db.prepare('SELECT * FROM rows ORDER BY card_id, container, seq').all();
      db.exec('COMMIT');
      return { records: [], tombstoneIds: [], receipts: [], frontiers: [], jobs: [],
        legacyCards, legacyRows, logicalNativeDump: '{}' };
    }
    for (const required of ['health_records', 'health_tombstones', 'health_batch_receipts',
      'health_streams', 'health_projection_outbox']) {
      if (!nativeNames.includes(required)) throw new Error('Incomplete synthetic native schema');
    }
    const records = db.prepare('SELECT tenant_id, source_store_id, record_type, native_record_id, record_json '
      + 'FROM health_records ORDER BY tenant_id, source_store_id, record_type, native_record_id').all()
      .map(row => ({
        identity: { tenantId: row.tenant_id, sourceStoreId: row.source_store_id,
          recordType: row.record_type, nativeRecordId: row.native_record_id },
        record: JSON.parse(row.record_json),
      }));
    const tombstoneIds = db.prepare('SELECT native_record_id FROM health_tombstones ORDER BY native_record_id')
      .all().map(row => row.native_record_id);
    const receipts = db.prepare('SELECT receipt_json FROM health_batch_receipts '
      + 'ORDER BY length(sequence), sequence').all().map(row => JSON.parse(row.receipt_json));
    const frontiers = db.prepare('SELECT record_type, acknowledged_sequence FROM health_streams '
      + 'ORDER BY record_type').all().map(row => ({
        recordType: row.record_type, acknowledgedSequence: row.acknowledged_sequence,
      }));
    const jobs = db.prepare('SELECT batch_id, state FROM health_projection_outbox ORDER BY batch_id').all()
      .map(row => ({ batchId: row.batch_id, state: row.state }));
    const legacyCards = db.prepare('SELECT * FROM cards ORDER BY card_id').all();
    const legacyRows = db.prepare('SELECT * FROM rows ORDER BY card_id, container, seq').all();
    const nativeRows = {};
    for (const name of nativeNames) {
      if (!/^health_[a-z_]+$/.test(name)) throw new Error('Unexpected synthetic schema name');
      nativeRows[name] = db.prepare(`SELECT * FROM "${name}"`).all();
    }
    db.exec('COMMIT');
    return { records, tombstoneIds, receipts, frontiers, jobs, legacyCards, legacyRows,
      logicalNativeDump: JSON.stringify(nativeRows) };
  } finally { db.close(); }
}
module.exports = { coldReadNative };
