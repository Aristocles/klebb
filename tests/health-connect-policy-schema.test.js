// SPDX-License-Identifier: AGPL-3.0-only
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

// Every database and configuration path belongs to this synthetic fixture.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-sql-test-'));
const dbDirectory = path.join(root, 'db');
fs.mkdirSync(dbDirectory);
const databaseFile = path.join(dbDirectory, 'klebb.db');
const pathOverrides = ['HEALTH_HOME', 'HEALTH_DATA_DIR', 'HEALTH_REPORTS_DIR',
  'HEALTH_AUTO_EXPORT_DIR', 'HEALTH_SESSIONS_DIR', 'HEALTH_CREDENTIALS_DIR',
  'HEALTH_ARCHIVE_DIR', 'HEALTH_CONFIG_PATH', 'HEALTH_DB_DIR', 'HEALTH_DB_FILE',
  'HEALTH_CHAT_DIR', 'HEALTH_USER_FILE', 'HEALTH_NOTIFICATIONS_STATE_FILE',
  'HEALTH_INBOX_DIR', 'HEALTH_KEYS_DIR', 'HEALTH_VAPID_FILE',
  'HEALTH_PUSH_SUBSCRIPTIONS_FILE', 'HEALTH_SYSTEM_PROMPT_FILE',
  'KLEBB_SKIP_HOME_ENV', 'HEALTH_HOME_WARNED'];
const savedEnvironment = new Map(pathOverrides.map(key => [key, process.env[key]]));
for (const key of pathOverrides) delete process.env[key];
process.env.HEALTH_HOME = root;
process.env.HEALTH_DB_FILE = databaseFile;
process.env.KLEBB_SKIP_HOME_ENV = '1';
process.env.HEALTH_HOME_WARNED = '1';
test.after(() => {
  for (const [key, value] of savedEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

const { nativeTables, objectTables, sourceIndexTables, restorePublicationTables,
  markerV2, guardV2 } = require('../lib/health-connect/schema');
const { nativeRetained } = require('../lib/import/target-native');
const { validateMigrationSchema } = require('../lib/health-connect/guard-migration');
const { withHistoryTransaction } = require('../lib/health-connect/history');
assert.equal(require('../config/paths').DB_FILE, databaseFile);

// These are fixed SQL catalog literals, separate from the production registry.
const POLICY_DDL = Object.freeze({
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

// Declared COMPLETE is fixture data: reading or retaining it grants no authority.
const FIXED = {
  "unknown": {
    "version": 1,
    "tenant_id": "11111111-1111-4111-8111-111111111111",
    "owner_id": "synthetic-policy-owner",
    "epoch": "44444444-4444-4444-8444-444444444444",
    "revision": "0",
    "knowledge": "UNKNOWN",
    "source_count": 0
  },
  "declaredEmpty": {
    "version": 1,
    "tenant_id": "11111111-1111-4111-8111-111111111111",
    "owner_id": "synthetic-policy-owner",
    "epoch": "44444444-4444-4444-8444-444444444444",
    "revision": "0",
    "knowledge": "COMPLETE",
    "source_count": 0
  },
  "mixed": {
    "stateRows": [
      {
        "version": 1,
        "tenant_id": "11111111-1111-4111-8111-111111111111",
        "owner_id": "synthetic-policy-owner",
        "epoch": "44444444-4444-4444-8444-444444444444",
        "revision": "12",
        "knowledge": "COMPLETE",
        "source_count": 2
      }
    ],
    "sourceRows": [
      {
        "tenant_id": "11111111-1111-4111-8111-111111111111",
        "source_store_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "owner_id": "synthetic-policy-owner",
        "policy_id": "r0-policy-alpha",
        "lifecycle": "active",
        "knowledge": "COMPLETE",
        "retain_committed_history": 1,
        "category_count": 2,
        "reconciled_epoch": null
      },
      {
        "tenant_id": "11111111-1111-4111-8111-111111111111",
        "source_store_id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        "owner_id": "synthetic-policy-owner",
        "policy_id": "r0-policy-beta",
        "lifecycle": "active",
        "knowledge": "COMPLETE",
        "retain_committed_history": 1,
        "category_count": 1,
        "reconciled_epoch": null
      }
    ],
    "categoryRows": [
      {
        "tenant_id": "11111111-1111-4111-8111-111111111111",
        "source_store_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "record_type": "StepsRecord",
        "sharing": "enabled",
        "generation": "3"
      },
      {
        "tenant_id": "11111111-1111-4111-8111-111111111111",
        "source_store_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "record_type": "WeightRecord",
        "sharing": "stopped",
        "generation": "8"
      },
      {
        "tenant_id": "11111111-1111-4111-8111-111111111111",
        "source_store_id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        "record_type": "WeightRecord",
        "sharing": "enabled",
        "generation": "7"
      }
    ]
  },
  "native": {
    "rawRows": [
      {
        "identity": [
          "11111111-1111-4111-8111-111111111111",
          "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          "StepsRecord",
          "raw-invented-id"
        ],
        "nativeKeyJson": "[\"11111111-1111-4111-8111-111111111111\",\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\",\"StepsRecord\",\"raw-invented-id\"]",
        "serializerId": "health-connect-record",
        "serializerVersion": 1,
        "dataFamily": "ordinary",
        "projection": "raw-only",
        "expectedUtf8Bytes": 123,
        "expectedRecordDigest": "sha256:413bf7b7c7ebf785d7bd7746f36e94e63b8df8812d8c0630fb8efc5778e84566",
        "recordJson": "{\"knownType\":null,\"nested\":{\"retained\":[1,\"\u00e9\"],\"empty\":null},\"native\":{\"recordType\":\"StepsRecord\",\"id\":\"raw-invented-id\"}}"
      }
    ],
    "actualSQLTombstoneRows": [
      {
        "tenant_id": "11111111-1111-4111-8111-111111111111",
        "source_store_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "record_type": "WeightRecord",
        "native_record_id": "same-invented-id",
        "stream_key": "[\"11111111-1111-4111-8111-111111111111\",\"22222222-2222-4222-8222-222222222222\",\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\",\"33333333-3333-4333-8333-333333333333\",\"WeightRecord\",\"3\",\"44444444-4444-4444-8444-444444444444\"]",
        "sequence": "7"
      }
    ],
    "actualSQLGuardRows": [
      {
        "tenant_id": "11111111-1111-4111-8111-111111111111",
        "source_store_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "record_type": "StepsRecord",
        "native_record_id": "same-invented-id",
        "source_deleted": 0,
        "user_suppressed": 1,
        "source_stream_key": null,
        "source_sequence": null,
        "footprint_json": null
      },
      {
        "tenant_id": "11111111-1111-4111-8111-111111111111",
        "source_store_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "record_type": "WeightRecord",
        "native_record_id": "same-invented-id",
        "source_deleted": 1,
        "user_suppressed": 1,
        "source_stream_key": "[\"11111111-1111-4111-8111-111111111111\",\"22222222-2222-4222-8222-222222222222\",\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\",\"33333333-3333-4333-8333-333333333333\",\"WeightRecord\",\"3\",\"44444444-4444-4444-8444-444444444444\"]",
        "source_sequence": "7",
        "footprint_json": null
      }
    ],
    "historicalSuppressions": [
      {
        "sourceStoreId": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        "type": "WeightRecord",
        "startInclusive": "2025-12-01T00:00:00Z",
        "endExclusive": "2026-01-01T00:00:00Z",
        "explicitReimportAllowed": false
      }
    ]
  }
};
const receiptIndex = 'CREATE INDEX health_receipt_sequence_order ON health_batch_receipts '
  + '(stream_key, length(sequence), sequence)';
const quote = name => '"' + name.replaceAll('"', '""') + '"';
const plain = rows => rows.map(row => ({ ...row }));
let fileNumber = 0;

function insert(db, table, row) {
  const columns = Object.keys(row);
  db.prepare(`INSERT INTO ${quote(table)} (${columns.map(quote).join(',')}) VALUES (`
    + columns.map(() => '?').join(',') + ')').run(...columns.map(column => row[column]));
}
function seed(filename, version = 1, policy = [], fill = 'empty') {
  const db = new DatabaseSync(filename);
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON');
    for (const [name, sql] of Object.entries(nativeTables)) {
      db.exec(name === 'health_schema_version' && version === 2 ? markerV2 : sql);
    }
    if (version === 2) db.exec(guardV2);
    db.exec(receiptIndex);
    for (const sql of Object.values({ ...objectTables, ...sourceIndexTables,
      ...restorePublicationTables })) db.exec(sql);
    db.exec('CREATE INDEX health_object_expiry ON health_object_staging (expires_at)');
    db.prepare('INSERT INTO health_schema_version VALUES (?)').run(version);
    for (const sql of policy) db.exec(sql);
    if (fill === 'category-only') {
      db.exec('PRAGMA foreign_keys=OFF');
      assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 0);
      insert(db, 'health_source_policy_categories', FIXED.mixed.categoryRows[0]);
    } else if (fill === 'unknown' || fill === 'declared-empty') {
      insert(db, 'health_source_policy_state', fill === 'unknown' ? FIXED.unknown : FIXED.declaredEmpty);
    } else if (fill === 'sources') {
      for (const row of FIXED.mixed.sourceRows) insert(db, 'health_source_policy_sources', row);
    } else if (fill === 'mixed') {
      for (const row of FIXED.mixed.stateRows) insert(db, 'health_source_policy_state', row);
      for (const row of FIXED.mixed.sourceRows) insert(db, 'health_source_policy_sources', row);
      for (const row of FIXED.mixed.categoryRows) insert(db, 'health_source_policy_categories', row);
      const raw = FIXED.native.rawRows[0];
      insert(db, 'health_records', {
        tenant_id: raw.identity[0], source_store_id: raw.identity[1],
        record_type: raw.identity[2], native_record_id: raw.identity[3],
        serializer_id: raw.serializerId, serializer_version: raw.serializerVersion,
        data_family: raw.dataFamily, projection: raw.projection, record_json: raw.recordJson,
      });
      for (const row of FIXED.native.actualSQLTombstoneRows) insert(db, 'health_tombstones', row);
      if (version === 2) {
        for (const row of FIXED.native.actualSQLGuardRows) insert(db, 'health_deletion_guards', row);
      }
    }
  } finally { db.close(); }
}
function read(filename, work) {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    db.exec('BEGIN');
    const result = work(db);
    db.exec('COMMIT');
    return result;
  } finally { db.close(); }
}
function snapshot(db) {
  const catalog = plain(db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema '
    + 'ORDER BY type,name').all());
  const rows = {};
  for (const table of catalog.filter(row => row.type === 'table')) {
    const columns = db.prepare(`PRAGMA table_info(${quote(table.name)})`).all();
    rows[table.name] = plain(db.prepare(`SELECT * FROM ${quote(table.name)} ORDER BY `
      + columns.map(column => quote(column.name)).join(',')).all());
  }
  return { catalog, rows };
}
function fresh(version, policy, fill) {
  const filename = path.join(dbDirectory, `case-${++fileNumber}.db`);
  seed(filename, version, policy, fill);
  return filename;
}
function assertLiteralRows(db, version) {
  assert.deepEqual(plain(db.prepare('SELECT * FROM health_source_policy_state').all()), FIXED.mixed.stateRows);
  assert.deepEqual(plain(db.prepare('SELECT * FROM health_source_policy_sources ORDER BY source_store_id').all()),
    FIXED.mixed.sourceRows);
  assert.deepEqual(plain(db.prepare('SELECT * FROM health_source_policy_categories ORDER BY source_store_id,record_type').all()),
    FIXED.mixed.categoryRows);
  assert.deepEqual(plain(db.prepare('SELECT * FROM health_tombstones').all()), FIXED.native.actualSQLTombstoneRows);
  const raw = db.prepare('SELECT * FROM health_records').get();
  assert.deepEqual([raw.tenant_id, raw.source_store_id, raw.record_type, raw.native_record_id],
    FIXED.native.rawRows[0].identity);
  assert.equal(raw.record_json, FIXED.native.rawRows[0].recordJson);
  assert.equal(Buffer.byteLength(raw.record_json, 'utf8'), 123);
  assert.equal('sha256:' + crypto.createHash('sha256').update(raw.record_json).digest('hex'),
    'sha256:413bf7b7c7ebf785d7bd7746f36e94e63b8df8812d8c0630fb8efc5778e84566');
  if (version === 2) {
    assert.deepEqual(plain(db.prepare('SELECT * FROM health_deletion_guards ORDER BY record_type').all()),
      FIXED.native.actualSQLGuardRows);
  }
}
function publishedCopies() {
  return fs.readdirSync(dbDirectory).filter(name => name.startsWith('klebb.db.pre-health-deletion-v2-')
    && name.endsWith('.db')).sort();
}

test('PSQL01 original native schemas and optional families use healthy existing APIs', () => {
  for (const version of [1, 2]) {
    const filename = fresh(version, [], 'empty');
    read(filename, db => {
      assert.doesNotThrow(() => validateMigrationSchema(db));
      assert.equal(nativeRetained(db), false);
    });
    const writer = new DatabaseSync(filename);
    try {
      insert(writer, 'health_streams', { stream_key: 'invented-stream',
        record_type: 'WeightRecord', acknowledged_sequence: '0' });
    } finally { writer.close(); }
    read(filename, db => assert.equal(nativeRetained(db), true));
  }
});

test('PSQL02 exact policy family retains data and survives verified copy and known precommit rollback', () => {
  for (const version of [1, 2]) {
    for (const fill of ['empty', 'unknown', 'declared-empty', 'sources', 'mixed', 'category-only']) {
      const filename = fresh(version, Object.values(POLICY_DDL), fill);
      read(filename, db => {
        const before = snapshot(db);
        if (fill === 'category-only') {
          assert.deepEqual([
            db.prepare('SELECT COUNT(*) AS count FROM health_source_policy_state').get().count,
            db.prepare('SELECT COUNT(*) AS count FROM health_source_policy_sources').get().count,
            db.prepare('SELECT COUNT(*) AS count FROM health_source_policy_categories').get().count,
          ], [0, 0, 1]);
          assert.deepEqual(plain(db.prepare('SELECT * FROM health_source_policy_categories').all()),
            [FIXED.mixed.categoryRows[0]]);
        }
        assert.doesNotThrow(() => validateMigrationSchema(db));
        assert.equal(nativeRetained(db), fill !== 'empty', `retention for ${fill}`);
        if (fill === 'mixed') assertLiteralRows(db, version);
        assert.deepEqual(snapshot(db), before);
      });
    }
  }

  seed(databaseFile, 1, Object.values(POLICY_DDL), 'mixed');
  const before = read(databaseFile, snapshot);
  const options = { deletionSchema: true };
  if (process.platform === 'win32') options.windowsDevelopment = true;
  let reachedWork = false;
  let reachedKnownFailure = false;
  let rollbackCopy;
  assert.throws(() => withHistoryTransaction((db, migration) => {
    reachedWork = true;
    rollbackCopy = migration.safetyCopy;
    assert.equal(db.prepare('SELECT version FROM health_schema_version').get().version, 2);
    db.exec("UPDATE health_source_policy_state SET revision='13'; DELETE FROM health_records");
    assert.equal(db.prepare('SELECT revision FROM health_source_policy_state').get().revision, '13');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM health_records').get().count, 0);
    reachedKnownFailure = true;
    throw new Error('invented-known-precommit-failure');
  }, options), error => error.status === 503 && error.code === 'storage-unavailable');
  assert.equal(reachedWork, true, 'the original writer reached its callback');
  assert.equal(reachedKnownFailure, true, 'both writes preceded the deliberate precommit failure');
  assert.deepEqual(read(databaseFile, snapshot), before);
  assert.deepEqual(read(path.join(dbDirectory, rollbackCopy), snapshot), before);
  assert.deepEqual(publishedCopies(), [rollbackCopy]);

  const migration = withHistoryTransaction((db, result) => {
    assert.equal(db.prepare('SELECT version FROM health_schema_version').get().version, 2);
    assert.deepEqual(plain(db.prepare('SELECT * FROM health_deletion_guards').all()), []);
    return result;
  }, options);
  assert.deepEqual(read(path.join(dbDirectory, migration.safetyCopy), snapshot), before);
  read(databaseFile, db => {
    assert.equal(db.prepare('SELECT version FROM health_schema_version').get().version, 2);
    assert.deepEqual(plain(db.prepare('SELECT * FROM health_source_policy_state').all()), FIXED.mixed.stateRows);
    assert.deepEqual(plain(db.prepare('SELECT * FROM health_source_policy_sources ORDER BY source_store_id').all()),
      FIXED.mixed.sourceRows);
    assert.deepEqual(plain(db.prepare('SELECT * FROM health_source_policy_categories ORDER BY source_store_id,record_type').all()),
      FIXED.mixed.categoryRows);
    for (const [name, rows] of Object.entries(before.rows)) {
      if (name !== 'health_schema_version') {
        const columns = db.prepare(`PRAGMA table_info(${quote(name)})`).all();
        assert.deepEqual(plain(db.prepare(`SELECT * FROM ${quote(name)} ORDER BY `
          + columns.map(column => quote(column.name)).join(',')).all()), rows);
      }
    }
    for (const row of before.catalog.filter(row => row.name !== 'health_schema_version')) {
      assert.deepEqual({ ...db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name=?').get(row.name) }, row);
    }
  });
  assert.equal(publishedCopies().length, 2);
  assert.equal(fs.readdirSync(dbDirectory).some(name => name.endsWith('.tmp')), false);
});

test('PSQL03 partial or altered policy schemas and undeclared owned objects refuse before writes', () => {
  const values = Object.values(POLICY_DDL);
  const copiesBefore = publishedCopies();
  const cases = [
    ['state only', [values[0]]], ['sources only', [values[1]]], ['categories only', [values[2]]],
    ['state and sources', [values[0], values[1]]],
    ['state and categories', [values[0], values[2]]],
    ['sources and categories', [values[1], values[2]]],
    ['unsupported policy version', [values[0].replace('(version=1)', '(version=2)'), values[1], values[2]]],
    ['altered column', [values[0].replace('epoch TEXT', 'epoch BLOB'), values[1], values[2]]],
    ['altered constraint', [values[0], values[1].replace('policy_id TEXT NOT NULL UNIQUE', 'policy_id TEXT NOT NULL'), values[2]]],
    ['altered spacing', [values[0].replace('tenant_id TEXT', 'tenant_id  TEXT'), values[1], values[2]]],
    ['case-altered policy name', [values[0].replace('health_source_policy_state', 'HEALTH_SOURCE_POLICY_STATE'), values[1], values[2]]],
    ['policy-named view', ['CREATE VIEW health_source_policy_state AS SELECT 1 AS version']],
    ['undeclared policy table', ['CREATE TABLE health_source_policy_extra (value TEXT)']],
    ['policy-owned index', [...values, 'CREATE INDEX unrelated_policy_idx ON health_source_policy_state (owner_id)']],
    ['policy-owned trigger', [...values, 'CREATE TRIGGER unrelated_policy_trigger AFTER INSERT ON health_source_policy_state BEGIN SELECT 1; END']],
    ['policy-named unrelated index', [...values, 'CREATE INDEX health_source_policy_extra ON health_streams (record_type)']],
    ['policy-named unrelated trigger', [...values, 'CREATE TRIGGER health_source_policy_extra AFTER INSERT ON health_streams BEGIN SELECT 1; END']],
  ];
  for (const [label, policy] of cases) {
    const filename = fresh(1, policy, 'empty');
    read(filename, db => {
      const before = snapshot(db);
      assert.throws(() => validateMigrationSchema(db), { message: 'storage-unavailable' }, label);
      assert.throws(() => nativeRetained(db), { message: 'target-storage-unavailable' }, label);
      assert.deepEqual(snapshot(db), before, label);
    });
    assert.deepEqual(publishedCopies(), copiesBefore, 'schema recognition publishes no extra migration copy');
  }
});
