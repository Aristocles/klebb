// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { createSandbox, cleanupSandbox, REPO_ROOT } = require('./sandbox');
const schema = require('../../lib/health-connect/schema');
const { decodeMessage, validateObjectDeclaration } = require('../../lib/health-connect/protocol');
const RECORDS = [
  {
    "identity": [
      "11111111-1111-4111-8111-111111111111",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "BodyWaterMassRecord",
      "r0-shared-id"
    ],
    "recordJson": "{\"time\":\"2026-01-02T03:04:05.123456789Z\",\"zoneOffset\":\"+11:00\",\"mass\":{\"value\":\"43.125\",\"unit\":\"kg\"},\"metadata\":{\"id\":\"r0-shared-id\",\"dataOrigin\":{\"packageName\":\"example.synthetic.alpha\"},\"device\":{\"manufacturer\":\"Synthetic\",\"model\":\"Fixture Alpha\",\"type\":0},\"lastModifiedTime\":\"2026-01-02T03:05:00.000000001Z\",\"clientRecordId\":null,\"clientRecordVersion\":\"2\",\"recordingMethod\":3}}",
    "expectedUtf8Bytes": 380,
    "expectedRecordDigest": "sha256:e58adccfff037a420d6634ece28e51cc544f306871f45a7238c6e2e87a28cc3f"
  },
  {
    "identity": [
      "11111111-1111-4111-8111-111111111111",
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      "BodyWaterMassRecord",
      "r0-shared-id"
    ],
    "recordJson": "{\"time\":\"2026-01-02T03:04:05.123456789Z\",\"zoneOffset\":null,\"mass\":{\"value\":\"43.125\",\"unit\":\"kg\"},\"metadata\":{\"id\":\"r0-shared-id\",\"dataOrigin\":{\"packageName\":\"example.synthetic.beta\"},\"device\":{\"manufacturer\":null,\"model\":null,\"type\":0},\"lastModifiedTime\":\"2026-01-02T03:05:00.000000002Z\",\"clientRecordId\":null,\"clientRecordVersion\":\"1\",\"recordingMethod\":0}}",
    "expectedUtf8Bytes": 357,
    "expectedRecordDigest": "sha256:c75f9ec48ec178af6f10bfa22907417e79b0e45bb4cd4ac00e50b16a248d41e1"
  },
  {
    "identity": [
      "11111111-1111-4111-8111-111111111111",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "CyclingPedalingCadenceRecord",
      "r0-shared-id"
    ],
    "recordJson": "{\"startTime\":\"2026-01-02T03:00:00Z\",\"endTime\":\"2026-01-02T03:10:00Z\",\"startZoneOffset\":\"+11:00\",\"endZoneOffset\":\"+11:00\",\"samples\":[{\"time\":\"2026-01-02T03:01:00.000000001Z\",\"revolutionsPerMinute\":\"62.5\"},{\"time\":\"2026-01-02T03:05:00.000000002Z\",\"revolutionsPerMinute\":\"91.25\"}],\"metadata\":{\"id\":\"r0-shared-id\",\"dataOrigin\":{\"packageName\":\"example.synthetic.alpha\"},\"device\":{\"manufacturer\":\"Synthetic\",\"model\":\"Fixture Alpha\",\"type\":0},\"lastModifiedTime\":\"2026-01-02T03:11:00.000000001Z\",\"clientRecordId\":null,\"clientRecordVersion\":\"1\",\"recordingMethod\":3}}",
    "expectedUtf8Bytes": 557,
    "expectedRecordDigest": "sha256:87bc00ed3b441a2c5626223c2fe28019086bf28a799bdd0594bd284bec6eeec2"
  }
];
const REPORT = '# Synthetic import\n\nA fixed report.\n';
const digest = bytes => 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex');
const binding = { tenantId: RECORDS[0].identity[0], instanceId: '22222222-2222-4222-8222-222222222222',
  sourceStoreId: RECORDS[0].identity[1], installationId: 'synthetic-import-installation',
  generation: '0', restoreEpoch: '33333333-3333-4333-8333-333333333333' };
const TYPE = RECORDS[0].identity[2];
const KEY = JSON.stringify([binding.tenantId, binding.instanceId, binding.sourceStoreId,
  binding.installationId, TYPE, binding.generation, binding.restoreEpoch]);
const AUTH = { version: 1, tenantId: binding.tenantId, instanceId: binding.instanceId,
  restoreEpoch: binding.restoreEpoch, grants: [], connectors: [] };
const quote = name => '"' + name.replaceAll('"', '""') + '"';
function seed(home, mode, wal) {
  const file = path.join(home, 'db', 'klebb.db');
  process.env.KLEBB_SKIP_HOME_ENV = '1'; process.env.HEALTH_HOME_WARNED = '1';
  const store = require('../../lib/datastore').open(file); store.load(); store.close();
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
    db.exec('CREATE TABLE hae_pushes (push_seq INTEGER PRIMARY KEY AUTOINCREMENT, received_at TEXT NOT NULL, source_file TEXT UNIQUE)');
    if (mode === 'native-view-only') {
      const ddl = 'CREATE VIEW health_records AS SELECT 1';
      db.exec(ddl); db.exec('COMMIT');
      assert.equal(db.prepare('PRAGMA integrity_check(1)').get().integrity_check, 'ok');
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE type='table' AND lower(name) GLOB 'health_*'").get().n, 0);
      assert.equal(db.prepare("SELECT sql FROM sqlite_schema WHERE type='view' AND name='health_records'").get().sql, ddl);
      return;
    }
    const v2 = mode === 'guards' || mode.startsWith('empty-v2');
    for (const [name, ddl] of Object.entries(schema.nativeTables)) db.exec(name === 'health_schema_version' && v2 ? schema.markerV2 : ddl);
    db.prepare('INSERT INTO health_schema_version VALUES (?)').run(v2 ? 2 : 1);
    db.exec('CREATE INDEX health_receipt_sequence_order ON health_batch_receipts (stream_key, length(sequence), sequence)');
    if (v2) db.exec(schema.guardV2);
    const objects = ['staging','parts','object-receipt','objects-partial'].includes(mode) || mode.endsWith('-optional');
    const index = ['index-entry','index-frontier','index-state','index-partial'].includes(mode) || mode.endsWith('-optional');
    if (objects) {
      for (const ddl of Object.values(schema.objectTables)) db.exec(ddl);
      db.exec('CREATE INDEX health_object_expiry ON health_object_staging (expires_at)');
    }
    if (index) for (const ddl of Object.values(schema.sourceIndexTables)) db.exec(ddl);
    for (const record of RECORDS) {
      assert.equal(Buffer.byteLength(record.recordJson), record.expectedUtf8Bytes);
      assert.equal(digest(record.recordJson), record.expectedRecordDigest);
      if (mode === 'records') db.prepare('INSERT INTO health_records VALUES (?,?,?,?,?,?,?,?,?)').run(
        ...record.identity, 'health-connect-record', 1, 'ordinary', 'raw-only', record.recordJson);
    }
    const id = [binding.tenantId, binding.sourceStoreId, TYPE, 'retained-control-id'];
    if (mode === 'tombstones') db.prepare('INSERT INTO health_tombstones VALUES (?,?,?,?,?,?)').run(...id, KEY, '1');
    if (mode === 'guards') db.prepare('INSERT INTO health_deletion_guards VALUES (?,?,?,?,?,?,?,?,?)').run(...id, 0, 1, null, null, null);
    if (mode === 'stream') db.prepare('INSERT INTO health_streams VALUES (?,?,?)').run(KEY, TYPE, '0');
    const receipt = { version: 1, kind: 'durable-receipt', binding, recordType: TYPE,
      sequence: '1', batchId: 'retained-batch', payloadDigest: digest('fixed retained batch') };
    decodeMessage(JSON.stringify(receipt), { binding, categories: [TYPE] });
    if (mode === 'batch-receipt') db.prepare('INSERT INTO health_batch_receipts VALUES (?,?,?,?,?)').run(
      KEY, '1', receipt.batchId, receipt.payloadDigest, JSON.stringify(receipt));
    if (mode === 'outbox') db.prepare('INSERT INTO health_projection_outbox VALUES (?,?,?,?,?)').run(KEY, '1', receipt.batchId, receipt.payloadDigest, 'queued');
    const bytes = Buffer.from(RECORDS[0].recordJson);
    const declaration = { binding, recordType: TYPE, batchId: 'retained-object-batch', sequence: '1',
      identity: { tenantId: id[0], sourceStoreId: id[1], recordType: id[2], nativeRecordId: id[3] },
      objectId: 'retained-object', objectDigest: digest(bytes), partCount: 1, totalBytes: bytes.length };
    validateObjectDeclaration(declaration, { binding, categories: [TYPE] });
    if (mode === 'staging' || mode === 'parts') db.prepare('INSERT INTO health_object_staging VALUES (?,?,?,?,?)').run(
      KEY, JSON.stringify(declaration), 1, 2, bytes.length);
    if (mode === 'parts') db.prepare('INSERT INTO health_object_parts VALUES (?,?,?,?)').run(KEY, 0, bytes, digest(bytes));
    if (mode === 'object-receipt') db.prepare('INSERT INTO health_object_receipts VALUES (?,?,?,?,?)').run(
      KEY, '1', declaration.batchId, JSON.stringify(declaration), JSON.stringify([{ partIndex: 0, partDigest: digest(bytes), partBytes: bytes.length }]));
    if (mode === 'index-entry') db.prepare('INSERT INTO health_source_index VALUES (?,?,?,?,?)').run(...id, 'tombstone');
    if (mode === 'index-frontier') db.prepare('INSERT INTO health_source_index_frontiers VALUES (?,?,?,?,?)').run(id[0], id[1], KEY, TYPE, '1');
    if (mode === 'index-state') db.prepare('INSERT INTO health_source_index_state VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(
      id[0], id[1], 'source-index-v1', 'failed', binding.restoreEpoch, null, 3, null, 'storage-unavailable', null, null);
    if (mode === 'native-partial') db.exec('DROP TABLE health_tombstones');
    if (mode === 'native-incompatible') db.exec('ALTER TABLE health_records ADD COLUMN extra TEXT');
    if (mode === 'native-unknown') db.exec('CREATE TABLE health_unknown_control (id TEXT)');
    if (mode === 'native-missing-index') db.exec('DROP INDEX health_receipt_sequence_order');
    if (mode === 'objects-partial') db.exec('DROP TABLE health_object_parts');
    if (mode === 'index-partial') db.exec('DROP TABLE health_source_index_frontiers');
    if (mode === 'native-unknown-view') {
      const ddl = 'CREATE VIEW health_unknown_control AS SELECT 1';
      db.exec(ddl);
      assert.equal(db.prepare("SELECT sql FROM sqlite_schema WHERE type='view' AND name='health_unknown_control'").get().sql, ddl);
    }
    db.exec('COMMIT');
    assert.equal(db.prepare('PRAGMA integrity_check(1)').get().integrity_check, 'ok');
    if (wal) assert.equal(db.prepare('PRAGMA journal_mode=WAL').get().journal_mode, 'wal');
  } finally { db.close(); }
  if (mode === 'database-corrupt') fs.writeFileSync(file, 'retained invalid SQLite bytes');
  if (mode === 'database-directory') { fs.unlinkSync(file); fs.mkdirSync(file); }
}
function fixture(mode, wal = false) {
  const root = createSandbox(), home = path.join(root, 'target'), tree = path.join(root, 'archive');
  for (const p of ['data','credentials','sessions','reports']) fs.mkdirSync(path.join(home,p), { recursive: true });
  fs.mkdirSync(path.join(tree,'data'), { recursive: true }); fs.mkdirSync(path.join(tree,'reports'));
  fs.writeFileSync(path.join(tree,'reports','synthetic.md'), REPORT);
  fs.writeFileSync(path.join(tree,'klebb-export.json'), JSON.stringify({ format: 'klebb.export.v1', formatVersion: 1,
    appVersion: '0.0.0', exportedAt: '2026-01-02T00:00:00.000Z', inventory: { cards: [], reports: [
      { file: 'reports/synthetic.md', bytes: Buffer.byteLength(REPORT), sha256: digest(REPORT).slice(7) }], other: [] } }));
  if (!mode.startsWith('authority-') && !['absent','generic-credentials'].includes(mode)) seed(home, mode, wal);
  const file = path.join(home,'credentials','health-connect.json');
  if (mode.startsWith('authority-')) {
    const state = JSON.parse(JSON.stringify(AUTH));
    if (mode === 'authority-grant') state.grants = [{ verifier: digest('synthetic grant'), ownerId: 'synthetic-owner',
      instanceId: binding.instanceId, sourceStoreId: binding.sourceStoreId, restoreEpoch: binding.restoreEpoch,
      categories: [TYPE], name: 'Synthetic source', expiresAt: '2026-01-02T00:00:00.000Z', consumedAt: null }];
    if (mode === 'authority-connector') state.connectors = [{ id: '44444444-4444-4444-8444-444444444444',
      credentialVerifier: digest('synthetic connector'), ownerId: 'synthetic-owner', installationId: binding.installationId,
      sourceStoreId: binding.sourceStoreId, restoreEpoch: binding.restoreEpoch, categories: [TYPE],
      generations: { [TYPE]: '0' }, name: 'Synthetic source', createdAt: '2026-01-02T00:00:00.000Z', revokedAt: null }];
    if (mode === 'authority-invalid-entry') state.grants = [null];
    if (mode === 'authority-extra-key') state.extra = true;
    if (mode === 'authority-wrong-version') state.version = 2;
    if (mode === 'authority-bad-uuid') state.tenantId = 'invalid';
    if (mode === 'authority-wrong-arrays') state.connectors = {};
    if (mode === 'authority-too-many') state.grants = Array(129).fill(null);
    let text = JSON.stringify(state);
    if (mode === 'authority-malformed') text = '{';
    if (mode === 'authority-duplicate') text = text.replace('{', '{"version":1,');
    if (mode === 'authority-oversize') text = ' '.repeat(1048577);
    if (mode === 'authority-directory') fs.mkdirSync(file); else fs.writeFileSync(file, text);
  }
  if (mode === 'generic-credentials') fs.writeFileSync(path.join(home,'credentials','webauthn.json'), '[]');
  return { root, home, tree, wal };
}
function files(root, prefix = '') {
  return fs.readdirSync(path.join(root,prefix), { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))
    .flatMap(ent => { const rel = path.posix.join(prefix,ent.name), abs = path.join(root,rel);
      if (ent.isDirectory()) return [{ path: rel, kind: 'directory' }, ...files(root,rel)];
      assert(ent.isFile(), 'Fixture inventory never follows links'); const b = fs.readFileSync(abs);
      return [{ path: rel, kind: 'file', bytes: b.length, digest: digest(b) }]; });
}
const value = v => typeof v === 'bigint' ? { integer: String(v) } : ArrayBuffer.isView(v) ?
  { blob: Buffer.from(v).toString('hex') } : v;
function cold(home) {
  const file = path.join(home,'db','klebb.db'); let db, sql = null;
  if (fs.existsSync(file) && fs.statSync(file).isFile()) {
    try {
      db = new DatabaseSync(file, { readOnly: true }); db.exec('BEGIN');
      const ddl = db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();
      const tables = ddl.filter(x => x.type === 'table').map(x => {
        const cols = db.prepare(`PRAGMA table_info(${quote(x.name)})`).all();
        const order = cols.flatMap(c => [`typeof(${quote(c.name)})`, `${quote(c.name)} COLLATE BINARY`]).join(',');
        const s = db.prepare(`SELECT * FROM ${quote(x.name)} ORDER BY ${order}`); s.setReadBigInts(true);
        return { name: x.name, rows: s.all().map(r => Object.fromEntries(Object.entries(r).map(([k,v]) => [k,value(v)]))) };
      }); db.exec('COMMIT'); sql = { ddl, tables };
    } catch (e) { sql = { readError: e.code || e.name }; } finally { if (db) db.close(); }
  }
  return { sql, files: files(home) };
}
function run(f, apply = false, overrides = {}) {
  const env = { ...process.env }; for (const k of Object.keys(env)) if (k.startsWith('HEALTH_')) delete env[k];
  Object.assign(env, { HEALTH_HOME: f.home, HEALTH_HOME_WARNED: '1', KLEBB_SKIP_HOME_ENV: '1' }, overrides);
  const r = spawnSync(process.execPath, [path.join(REPO_ROOT,'scripts','import-tree.js'), f.tree,
    '--target',f.home,...(apply ? ['--apply'] : [])], { cwd: REPO_ROOT, env, encoding: 'utf8', timeout: 60000, maxBuffer: 2097152 });
  assert.ifError(r.error); assert.equal(r.signal,null); assert.notEqual(r.status,null);
  return { status: r.status, out: r.stdout + r.stderr };
}
function dispose(f) {
  assert.equal(path.dirname(f.root), path.resolve(os.tmpdir())); assert(path.basename(f.root).startsWith('eh-test-'));
  cleanupSandbox(f.root);
}
module.exports = { fixture, cold, files, run, dispose, RECORDS, REPORT,
  RETAINED_SECRETS: [digest('synthetic grant'), digest('synthetic connector')] };
