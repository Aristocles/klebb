// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { DatabaseSync } = require('node:sqlite');
const { objectTables, sourceIndexTables, restorePublicationTables, markerV2, guardV2,
  validateSourcePolicySchema } = require('./schema');

const refuse = () => { throw new Error('storage-unavailable'); };
const quote = name => '"' + name.replaceAll('"', '""') + '"';
function optionalSchemas(db) {
  validateSourcePolicySchema(db, refuse);
  const found = db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='table'").all();
  for (const tables of [objectTables, sourceIndexTables, restorePublicationTables]) {
    if (!Object.keys(tables).some(name => found.some(row => row.name === name))) continue;
    for (const [name, sql] of Object.entries(tables)) {
      if (found.find(row => row.name === name)?.sql !== sql) refuse();
    }
  }
}
function validateMigrationSchema(db) {
  // Replacing the marker drops its owned objects and can cascade into
  // referencing tables. Refuse these dependencies before publishing a copy.
  if (db.prepare("SELECT 1 FROM sqlite_schema WHERE tbl_name='health_schema_version' "
    + "AND type IN ('index','trigger') LIMIT 1").get()) refuse();
  for (const { name } of db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all()) {
    if (db.prepare(`PRAGMA foreign_key_list(${quote(name)})`).all().some(reference =>
      reference.table.toLowerCase() === 'health_schema_version')) refuse();
  }
  optionalSchemas(db);
  const indexes = db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='index'").all();
  const required = {
    health_receipt_sequence_order: 'CREATE INDEX health_receipt_sequence_order ON health_batch_receipts '
      + '(stream_key, length(sequence), sequence)',
  };
  if (db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='health_object_staging'").get()) {
    required.health_object_expiry = 'CREATE INDEX health_object_expiry ON health_object_staging (expires_at)';
  }
  for (const [name, sql] of Object.entries(required)) {
    if (indexes.find(row => row.name === name)?.sql !== sql) refuse();
  }
  integrity(db);
}
function schema(db) {
  // rootpage describes physical layout and may legitimately change in VACUUM.
  return db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();
}
function integrity(db) {
  if (db.prepare('PRAGMA integrity_check(1)').get()?.integrity_check !== 'ok') refuse();
}
function verifyCopy(source, filename) {
  const copy = new DatabaseSync(filename, { readOnly: true });
  try {
    integrity(copy);
    const expectedSchema = schema(source);
    if (!isDeepStrictEqual(schema(copy), expectedSchema)) refuse();
    // Include sqlite_sequence: its AUTOINCREMENT frontier is retained HAE state.
    for (const table of expectedSchema.filter(row => row.type === 'table')) {
      const columns = source.prepare(`PRAGMA table_info(${quote(table.name)})`).all();
      if (!columns.length) refuse();
      const order = columns.flatMap(column => [
        `typeof(${quote(column.name)})`, `${quote(column.name)} COLLATE BINARY`,
      ]).join(',');
      const sql = `SELECT * FROM ${quote(table.name)} ORDER BY ${order}`;
      const leftStatement = source.prepare(sql);
      const rightStatement = copy.prepare(sql);
      leftStatement.setReadBigInts(true);
      rightStatement.setReadBigInts(true);
      const left = leftStatement.iterate();
      const right = rightStatement.iterate();
      try {
        for (;;) {
          const expected = left.next();
          const actual = right.next();
          if (expected.done !== actual.done) refuse();
          if (expected.done) break;
          if (!isDeepStrictEqual(expected.value, actual.value)) refuse();
        }
      } finally {
        left.return?.();
        right.return?.();
      }
    }
  } finally { copy.close(); }
}
function migrateNativeV2(db, filename, options) {
  // The history caller tracks successful BEGIN IMMEDIATE on its WAL/FULL
  // writer. DatabaseSync.isTransaction is unavailable at the Node 22.13 floor.
  const directory = fs.realpathSync(path.dirname(filename));
  const stamp = new Date().toISOString().replace(/\D/g, '');
  const safetyCopy = `${path.basename(filename)}.pre-health-deletion-v2-${stamp}-${crypto.randomUUID()}.db`;
  const destination = path.join(directory, safetyCopy);
  const temporary = destination + '.tmp';
  if (fs.existsSync(destination)) refuse();
  let reserved = false;
  let reader;
  try {
    const reserve = fs.openSync(temporary, 'wx', 0o600);
    reserved = true;
    fs.closeSync(reserve);
    reader = new DatabaseSync(filename, { readOnly: true });
    reader.exec('PRAGMA busy_timeout=5000');
    reader.prepare('VACUUM INTO ?').run(temporary);
    reader.close();
    reader = null;
    if (!fs.lstatSync(temporary).isFile()) refuse();
    verifyCopy(db, temporary);
    const descriptor = fs.openSync(temporary, 'r+');
    try { fs.fsyncSync(descriptor); }
    finally { fs.closeSync(descriptor); }
    if (fs.existsSync(destination)) refuse();
    fs.renameSync(temporary, destination);
    if (process.platform !== 'win32') {
      const descriptor = fs.openSync(directory, 'r');
      try { fs.fsyncSync(descriptor); }
      finally { fs.closeSync(descriptor); }
    } else if (options.windowsDevelopment !== true) refuse();
    // No original schema or row change precedes verified copy publication.
    db.exec(guardV2);
    db.exec('DROP TABLE health_schema_version');
    db.exec(markerV2);
    db.prepare('INSERT INTO health_schema_version (version) VALUES (2)').run();
    return { safetyCopy, directoryDurability: process.platform === 'win32'
      ? 'windows-development' : 'posix' };
  } finally {
    if (reader) reader.close();
    if (reserved) {
      // Remove only the exclusively owned temporary file; published copies stay.
      try { fs.unlinkSync(temporary); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
}
module.exports = { migrateNativeV2, validateMigrationSchema };
