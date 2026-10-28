// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { fixture, run, close, coldReadDatabase, unchanged, noCopy } =
  require('../helpers/health-connect-guard-migration-fixture.cjs');

async function refusesWithoutLosingMarkerOwnedDdl(sql, type) {
  const data = await fixture();
  try {
    const db = new DatabaseSync(data.database);
    try {
      db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
      db.exec(sql);
      db.exec('COMMIT');
    } finally { db.close(); }
    data.before = coldReadDatabase(data.database);
    assert.deepEqual(data.before.schema.filter(row => row.name === 'synthetic_marker_extra'),
      [{ type, name: 'synthetic_marker_extra', tbl_name: 'health_schema_version', sql }]);
    assert.deepEqual(data.before.tables.health_schema_version,
      [{ version: { type: 'integer', decimal: '1' } }]);
    assert.equal(data.before.tables.health_deletion_guards, undefined);
    noCopy(data);
    // Exact V1 remains safe only if every non-version DDL object can survive.
    // Replacing the marker would implicitly drop this independent extra DDL.
    const result = await run(data);
    assert.equal(result.code, 1, 'refuse unsupported marker-owned DDL before migration');
    assert.deepEqual(result.json, { ok: false, status: 503, code: 'storage-unavailable' });
    unchanged(data);
    noCopy(data);
  } finally { close(data); }
}

test('M17 explicit migration refuses marker-owned secondary index without copy or DDL/row loss', async () => {
  await refusesWithoutLosingMarkerOwnedDdl(
    'CREATE INDEX synthetic_marker_extra ON health_schema_version(version)', 'index');
});

test('M18 explicit migration refuses harmless marker-owned trigger without copy or DDL/row loss', async () => {
  await refusesWithoutLosingMarkerOwnedDdl(
    'CREATE TRIGGER synthetic_marker_extra AFTER INSERT ON health_schema_version BEGIN SELECT 1; END',
    'trigger');
});

async function refusesWithoutChangingMarkerForeignKeyRows(childDdl) {
  const data = await fixture();
  try {
    const db = new DatabaseSync(data.database);
    try {
      db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
      db.exec(childDdl);
      db.prepare('INSERT INTO synthetic_marker_child (id,marker_version,note) VALUES (?,?,?)')
        .run('synthetic-child-row', 1, 'preserve nonempty marker dependency');
      db.exec('COMMIT');
    } finally { db.close(); }
    data.before = coldReadDatabase(data.database);
    assert.deepEqual(data.before.schema.filter(row => row.name === 'synthetic_marker_child'),
      [{ type: 'table', name: 'synthetic_marker_child', tbl_name: 'synthetic_marker_child', sql: childDdl }]);
    assert.deepEqual(data.before.tables.synthetic_marker_child, [{
      id: { type: 'text', value: 'synthetic-child-row' },
      marker_version: { type: 'integer', decimal: '1' },
      note: { type: 'text', value: 'preserve nonempty marker dependency' },
    }]);
    noCopy(data);
    const result = await run(data);
    assert.equal(result.code, 1, 'refuse marker foreign-key dependencies before migration');
    assert.deepEqual(result.json, { ok: false, status: 503, code: 'storage-unavailable' });
    unchanged(data);
    noCopy(data);
  } finally { close(data); }
}

test('M19 explicit migration refuses uppercase marker CASCADE dependency without copy or child-row loss', async () => {
  await refusesWithoutChangingMarkerForeignKeyRows(
    'CREATE TABLE synthetic_marker_child (id TEXT PRIMARY KEY, marker_version INTEGER NOT NULL, '
      + 'note TEXT NOT NULL, FOREIGN KEY (marker_version) REFERENCES "HEALTH_SCHEMA_VERSION"(version) ON DELETE CASCADE)');
});

test('M20 explicit migration refuses marker SET NULL dependency without copy or child-row mutation', async () => {
  await refusesWithoutChangingMarkerForeignKeyRows(
    'CREATE TABLE synthetic_marker_child (id TEXT PRIMARY KEY, marker_version INTEGER, '
      + 'note TEXT NOT NULL, FOREIGN KEY (marker_version) REFERENCES health_schema_version(version) ON DELETE SET NULL)');
});
