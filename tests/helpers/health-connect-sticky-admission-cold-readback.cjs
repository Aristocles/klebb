// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Independent typed SQL readback. Exactly three rebuildable index tables are
// separated; every other stored table, allocator and schema object is retained.
const path = require('node:path');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { typed, sha } = require('./health-connect-guard-migration-cold-readback.cjs');
const quote = name => `"${name.replaceAll('"', '""')}"`;
const markersByHome = new Map();
function registerMarkers(home, markers) {
  if (markers.length) markersByHome.set(home, markers);
  else markersByHome.delete(home);
}
const DERIVED = Object.freeze([
  'health_source_index', 'health_source_index_frontiers', 'health_source_index_state',
]);
function coldRead(home) {
  const filename = path.join(home, 'db', 'klebb.db');
  assert.ok(fs.statSync(filename).isFile());
  const db = new DatabaseSync(filename, { readOnly: true });
  const markers = (markersByHome.get(home) || []).map(marker => {
    assert.ok(marker.length > 20); return Buffer.from(marker);
  });
  let whole;
  try {
    db.exec('PRAGMA busy_timeout=5000; BEGIN');
    const schema = db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name')
      .all().map(row => ({ ...row }));
    const tables = {};
    for (const item of schema.filter(row => row.type === 'table')) {
      const columns = db.prepare(`PRAGMA table_info(${quote(item.name)})`).all().map(row => row.name);
      const order = columns.flatMap(name => [
        `typeof(${quote(name)}) COLLATE BINARY`, `${quote(name)} COLLATE BINARY`,
      ]).join(',');
      const statement = db.prepare(`SELECT ${columns.map(quote).join(',')} FROM ${quote(item.name)} ORDER BY ${order}`);
      statement.setReadBigInts(true);
      tables[item.name] = Array.from(statement.iterate(), row => {
        // Check actual bytes BEFORE large values become digest-only evidence.
        // Marker assertions never print the marker or offending stored value.
        for (const value of Object.values(row)) {
          if (typeof value === 'string' || value instanceof Uint8Array) {
            const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value);
            for (const marker of markers) {
              assert.equal(bytes.includes(marker), false, 'issued authority in stored logical bytes');
            }
          }
        }
        return Object.fromEntries(columns.map(name => [name, typed(row[name])]));
      });
    }
    whole = { schema, tables,
      integrity: db.prepare('PRAGMA integrity_check').all().map(row => ({ ...row })),
      userVersion: db.prepare('PRAGMA user_version').get().user_version,
      applicationId: db.prepare('PRAGMA application_id').get().application_id };
    db.exec('COMMIT');
  } finally { db.close(); }
  const native = { ...whole, tables: {}, schema: [] };
  const derived = { tables: {}, schema: [] };
  for (const row of whole.schema) {
    (DERIVED.includes(row.tbl_name) ? derived : native).schema.push(row);
  }
  for (const [name, rows] of Object.entries(whole.tables)) {
    (DERIVED.includes(name) ? derived : native).tables[name] = rows;
  }
  // BLOB lengths/digests in coldReadDatabase come from actual Uint8Array bytes,
  // not declaration or part_digest columns. Include both for corruption proof.
  const physical = (native.tables.health_object_parts || []).map(row => ({
    streamKey: row.stream_key, index: row.part_index, actual: row.part_bytes,
    savedDigest: row.part_digest,
  }));
  return { native, derived, physical };
}
const value = typed => typed?.type === 'text' ? typed.value :
  typed?.type === 'integer' ? typed.decimal : typed?.type === 'null' ? null : typed;
function rows(snapshot, table) {
  return (snapshot.native.tables[table] || []).map(row =>
    Object.fromEntries(Object.entries(row).map(([key, item]) => [key, value(item)])));
}
function identityRows(snapshot, table, identity) {
  return rows(snapshot, table).filter(row => row.tenant_id === identity.tenantId &&
    row.source_store_id === identity.sourceStoreId && row.record_type === identity.recordType &&
    row.native_record_id === identity.nativeRecordId);
}
module.exports = { coldRead, rows, identityRows, sha, DERIVED, registerMarkers };
