// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Independent SQL readback; never imports production schema/migration code.
const fs = require('node:fs');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const identifier = value => `"${value.replaceAll('"', '""')}"`;
const sha = bytes => 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex');
function typed(value) {
  if (value === null) return { type: 'null' };
  if (typeof value === 'bigint') return { type: 'integer', decimal: value.toString() };
  if (typeof value === 'number') return { type: 'real', decimal: Object.is(value, -0) ? '-0' : String(value) };
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8');
    return bytes.length <= 4096 ? { type: 'text', value } :
      { type: 'text', bytes: bytes.length, digest: sha(bytes) };
  }
  if (value instanceof Uint8Array) {
    const bytes = Buffer.from(value);
    return { type: 'blob', bytes: bytes.length, digest: sha(bytes),
      ...(bytes.length <= 32 ? { hex: bytes.toString('hex') } : {}) };
  }
  throw new Error('Unexpected independent SQLite value type');
}
function coldReadDatabase(filename) {
  if (!fs.statSync(filename).isFile()) throw new Error('Expected existing synthetic database');
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=5000; BEGIN');
    const schema = db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all()
      .map(row => ({ ...row }));
    const tables = {};
    // sqlite_sequence is logical AUTOINCREMENT allocator state, not physical
    // layout. Include all stored tables instead of hiding internal prefixes.
    for (const item of schema.filter(row => row.type === 'table')) {
      const columns = db.prepare(`PRAGMA table_info(${identifier(item.name)})`).all().map(row => row.name);
      const selected = columns.map(identifier).join(',');
      const order = columns.flatMap(name => {
        const column = identifier(name);
        return [`typeof(${column}) COLLATE BINARY`, `${column} COLLATE BINARY`];
      }).join(',');
      const statement = db.prepare(`SELECT ${selected} FROM ${identifier(item.name)} ORDER BY ${order}`);
      statement.setReadBigInts(true);
      tables[item.name] = Array.from(statement.iterate(), row =>
        Object.fromEntries(columns.map(name => [name, typed(row[name])])));
    }
    const integrity = db.prepare('PRAGMA integrity_check').all().map(row => ({ ...row }));
    const userVersion = db.prepare('PRAGMA user_version').get().user_version;
    const applicationId = db.prepare('PRAGMA application_id').get().application_id;
    db.exec('COMMIT');
    return { schema, tables, integrity, userVersion, applicationId };
  } finally { db.close(); }
}
module.exports = { coldReadDatabase, typed, sha };
