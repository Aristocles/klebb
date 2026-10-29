// SPDX-License-Identifier: AGPL-3.0-only
// Independent typed SQLite/sidecar observation of an owned synthetic sandbox.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const quote = name => `"${name.replaceAll('"', '""')}"`;
const digest = bytes => `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
function owned(home) {
  const absolute = path.resolve(home), temporary = fs.realpathSync(require('node:os').tmpdir());
  const real = fs.realpathSync(absolute);
  const compare = value => process.platform === 'win32' ? value.toLowerCase() : value;
  assert.equal(compare(real), compare(absolute), 'fixture must have no redirected root');
  assert.ok(compare(real).startsWith(compare(temporary + path.sep)));
  assert.match(path.basename(real), /^eh-test-[A-Za-z0-9_-]+$/);
  return absolute;
}
function scalar(value) {
  if (value === null || typeof value === 'string') return value;
  if (typeof value === 'bigint') return { integer: value.toString() };
  if (ArrayBuffer.isView(value)) return { blob: Buffer.from(value).toString('hex') };
  assert.equal(typeof value, 'number');
  return { real: Object.is(value, -0) ? '-0' : String(value) };
}
function coldRead(home) {
  home = owned(home);
  const db = new DatabaseSync(path.join(home, 'db', 'klebb.db'), { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=5000; BEGIN');
    const schema = db.prepare(
      'SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type COLLATE BINARY,name COLLATE BINARY'
    ).all().map(row => ({ ...row }));
    const tables = [];
    for (const entry of schema.filter(row => row.type === 'table')) {
      const columns = db.prepare(`PRAGMA table_info(${quote(entry.name)})`).all()
        .map(row => ({ name: row.name, type: row.type, notnull: row.notnull, dflt_value: row.dflt_value, pk: row.pk }));
      const names = columns.map(row => row.name);
      assert.ok(names.length);
      const order = names.map(name => `${quote(name)} COLLATE BINARY`).join(',');
      const statement = db.prepare(`SELECT ${names.map(quote).join(',')} FROM ${quote(entry.name)} ORDER BY ${order}`);
      statement.setReadBigInts(true);
      const rows = [];
      for (const row of statement.iterate()) {
        assert.ok(rows.length < 10000, 'bounded synthetic cold fixture');
        rows.push(names.map(name => scalar(row[name])));
      }
      tables.push({ name: entry.name, columns, rows });
    }
    db.exec('COMMIT');
    const sidecars = {};
    for (const relative of ['config.json', 'data/weight.json', 'data/legacy.json',
      'data/auto-export/last-push.json', 'data/auto-export/discovered.json']) {
      const file = path.join(home, relative);
      sidecars[relative] = fs.existsSync(file) ? digest(fs.readFileSync(file)) : null;
    }
    return { schema, tables, sidecars };
  } finally {
    db.close();
  }
}
function table(cold, name) {
  const saved = cold.tables.find(item => item.name === name);
  assert.ok(saved, `required fixture table ${name}`);
  return saved.rows.map(values => Object.fromEntries(saved.columns.map((column, i) => [column.name, values[i]])));
}
function integer(value) {
  assert.ok(value && typeof value.integer === 'string');
  return BigInt(value.integer);
}
function samples(cold) {
  return table(cold, 'hae_samples').map(row => ({
    metric: row.metric, metric_meta: row.metric_meta, doc: row.doc,
    sample_date: row.sample_date, hashHex: row.hash.blob,
    dup_count: Number(integer(row.dup_count)), push_ord: Number(integer(row.push_ord)),
    first_push: Number(integer(row.first_push)), last_push: Number(integer(row.last_push)),
  })).sort((a, b) => a.push_ord - b.push_ord || a.metric.localeCompare(b.metric));
}
function withoutHae(cold) {
  return {
    schema: cold.schema,
    tables: cold.tables.filter(item => !['hae_pushes', 'hae_samples'].includes(item.name))
      .map(item => item.name === 'sqlite_sequence'
        ? { ...item, rows: item.rows.filter(row => row[0] !== 'hae_pushes') } : item),
  };
}
module.exports = { owned, coldRead, table, integer, samples, withoutHae, digest };
