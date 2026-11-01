// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const INVENTORY = {
  "catalog": {
    "version": 1,
    "logicalTenantId": "11111111-1111-4111-8111-111111111111",
    "sources": [
      {
        "sourceStoreId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "provider": "health-connect-native",
        "policyRef": "r0-policy-alpha"
      },
      {
        "sourceStoreId": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        "provider": "health-connect-native",
        "policyRef": "r0-policy-beta"
      }
    ]
  },
  "records": [
    {
      "label": "alpha-body-water",
      "identity": [
        "11111111-1111-4111-8111-111111111111",
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "BodyWaterMassRecord",
        "r0-shared-id"
      ],
      "recordJson": "{\"time\":\"2026-01-02T03:04:05.123456789Z\",\"zoneOffset\":\"+11:00\",\"mass\":{\"value\":\"43.125\",\"unit\":\"kg\"},\"metadata\":{\"id\":\"r0-shared-id\",\"dataOrigin\":{\"packageName\":\"example.synthetic.alpha\"},\"device\":{\"manufacturer\":\"Synthetic\",\"model\":\"Fixture Alpha\",\"type\":0},\"lastModifiedTime\":\"2026-01-02T03:05:00.000000001Z\",\"clientRecordId\":null,\"clientRecordVersion\":\"2\",\"recordingMethod\":3}}",
      "nativeKeyJson": "[\"11111111-1111-4111-8111-111111111111\",\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\",\"BodyWaterMassRecord\",\"r0-shared-id\"]",
      "serializerId": "health-connect-record",
      "serializerVersion": 1,
      "dataFamily": "ordinary",
      "projection": "raw-only",
      "expectedUtf8Bytes": 380,
      "expectedRecordDigest": "sha256:e58adccfff037a420d6634ece28e51cc544f306871f45a7238c6e2e87a28cc3f"
    },
    {
      "label": "beta-body-water",
      "identity": [
        "11111111-1111-4111-8111-111111111111",
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        "BodyWaterMassRecord",
        "r0-shared-id"
      ],
      "recordJson": "{\"time\":\"2026-01-02T03:04:05.123456789Z\",\"zoneOffset\":null,\"mass\":{\"value\":\"43.125\",\"unit\":\"kg\"},\"metadata\":{\"id\":\"r0-shared-id\",\"dataOrigin\":{\"packageName\":\"example.synthetic.beta\"},\"device\":{\"manufacturer\":null,\"model\":null,\"type\":0},\"lastModifiedTime\":\"2026-01-02T03:05:00.000000002Z\",\"clientRecordId\":null,\"clientRecordVersion\":\"1\",\"recordingMethod\":0}}",
      "nativeKeyJson": "[\"11111111-1111-4111-8111-111111111111\",\"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb\",\"BodyWaterMassRecord\",\"r0-shared-id\"]",
      "serializerId": "health-connect-record",
      "serializerVersion": 1,
      "dataFamily": "ordinary",
      "projection": "raw-only",
      "expectedUtf8Bytes": 357,
      "expectedRecordDigest": "sha256:c75f9ec48ec178af6f10bfa22907417e79b0e45bb4cd4ac00e50b16a248d41e1"
    },
    {
      "label": "alpha-cycling-cadence",
      "identity": [
        "11111111-1111-4111-8111-111111111111",
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "CyclingPedalingCadenceRecord",
        "r0-shared-id"
      ],
      "recordJson": "{\"startTime\":\"2026-01-02T03:00:00Z\",\"endTime\":\"2026-01-02T03:10:00Z\",\"startZoneOffset\":\"+11:00\",\"endZoneOffset\":\"+11:00\",\"samples\":[{\"time\":\"2026-01-02T03:01:00.000000001Z\",\"revolutionsPerMinute\":\"62.5\"},{\"time\":\"2026-01-02T03:05:00.000000002Z\",\"revolutionsPerMinute\":\"91.25\"}],\"metadata\":{\"id\":\"r0-shared-id\",\"dataOrigin\":{\"packageName\":\"example.synthetic.alpha\"},\"device\":{\"manufacturer\":\"Synthetic\",\"model\":\"Fixture Alpha\",\"type\":0},\"lastModifiedTime\":\"2026-01-02T03:11:00.000000001Z\",\"clientRecordId\":null,\"clientRecordVersion\":\"1\",\"recordingMethod\":3}}",
      "nativeKeyJson": "[\"11111111-1111-4111-8111-111111111111\",\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\",\"CyclingPedalingCadenceRecord\",\"r0-shared-id\"]",
      "serializerId": "health-connect-record",
      "serializerVersion": 1,
      "dataFamily": "ordinary",
      "projection": "raw-only",
      "expectedUtf8Bytes": 557,
      "expectedRecordDigest": "sha256:87bc00ed3b441a2c5626223c2fe28019086bf28a799bdd0594bd284bec6eeec2"
    }
  ],
  "sourcePolicies": [
    {
      "id": "r0-policy-alpha",
      "sourceStoreId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "sharing": "stopped",
      "retainCommittedHistory": true,
      "priorGenerationProvenance": "7"
    },
    {
      "id": "r0-policy-beta",
      "sourceStoreId": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      "sharing": "enabled",
      "retainCommittedHistory": true,
      "priorGenerationProvenance": "3"
    }
  ],
  "tombstones": [
    {
      "tenantId": "11111111-1111-4111-8111-111111111111",
      "sourceStoreId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "nativeRecordId": "r0-deleted-known",
      "knownType": "StepsRecord",
      "reason": "source-delete"
    },
    {
      "tenantId": "11111111-1111-4111-8111-111111111111",
      "sourceStoreId": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      "nativeRecordId": "r0-deleted-unknown",
      "knownType": null,
      "reason": "source-delete"
    }
  ],
  "suppressions": [
    {
      "sourceStoreId": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      "type": "WeightRecord",
      "startInclusive": "2025-12-01T00:00:00Z",
      "endExclusive": "2026-01-01T00:00:00Z",
      "explicitReimportAllowed": false
    }
  ]
};
const COUNTS = Object.freeze({ sources: 2, records: 3, sourcePolicies: 2, tombstones: 2, suppressions: 1 });
const OWNER = 'synthetic-current-owner';
const TENANT = '11111111-1111-4111-8111-111111111111';
const ALPHA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BETA = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const sha = text => 'sha256:' + crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
function envelope(inventory = INVENTORY) {
  return { version: 1, counts: { ...COUNTS }, sha256: sha(JSON.stringify({
    catalog: inventory.catalog, records: inventory.records, sourcePolicies: inventory.sourcePolicies,
    tombstones: inventory.tombstones, suppressions: inventory.suppressions,
  })) };
}
function metadata(inventory = INVENTORY) {
  return { catalog: inventory.catalog,
    recordDescriptors: inventory.records.map(({ recordJson, ...descriptor }) => descriptor),
    sourcePolicies: inventory.sourcePolicies, tombstones: inventory.tombstones,
    suppressions: inventory.suppressions };
}
function sqlSnapshot(dbFile) {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const schema = db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();
    const rows = Object.fromEntries(schema.filter(row => row.type === 'table' && !row.name.startsWith('sqlite_'))
      .map(row => [row.name, db.prepare('SELECT * FROM "' + row.name.replaceAll('"', '""') + '"').all()
        .map(value => JSON.stringify(value)).sort()]));
    return { schema: JSON.parse(JSON.stringify(schema)), rows };
  } finally { db.close(); }
}

const { nativeTables } = require('../lib/health-connect/schema');
const { issueOwnerApproval } = require('../lib/import/owner-approval');
const { preparePublication, publishPreparedPublication, readPublication } =
  require('../lib/import/native-publication');
function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'native-publication-test-'));
  fs.mkdirSync(path.join(home, 'db')); fs.mkdirSync(path.join(home, 'credentials'));
  const dbFile = path.join(home, 'db', 'klebb.db');
  const db = new DatabaseSync(dbFile);
  try {
    db.exec('CREATE TABLE sentinel (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
    db.prepare('INSERT INTO sentinel VALUES (?,?)').run(1, 'retain-me');
    for (const ddl of Object.values(nativeTables)) db.exec(ddl);
    db.exec('INSERT INTO health_schema_version VALUES (1)');
    db.exec('CREATE INDEX health_receipt_sequence_order ON health_batch_receipts (stream_key, length(sequence), sequence)');
  } finally { db.close(); }
  let currentOwner = OWNER;
  const actor = { ownerId: OWNER, check: () => currentOwner };
  const approval = issueOwnerApproval(actor, { jobId: 'synthetic-import-job', treePath: path.join(home, 'tree'),
    targetHome: home, selectedDbFile: dbFile });
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const credentialFile = path.join(home, 'credentials', 'health-connect.json');
  const inventory = () => ({ database: sqlSnapshot(dbFile), credentials: fs.existsSync(credentialFile)
    ? fs.readFileSync(credentialFile).toString('hex') : null });
  return { home, dbFile, actor, approval, inventory, setOwner: owner => { currentOwner = owner; } };
}
const invalid = { status: 400, code: 'IMPORT_PUBLICATION_INVALID' };
test('publishes three independent raw identities and complete metadata in the selected database', t => {
  const data = setup(t), before = data.inventory();
  for (const record of INVENTORY.records) {
    assert.equal(Buffer.byteLength(record.recordJson, 'utf8'), record.expectedUtf8Bytes);
    assert.equal(sha(record.recordJson), record.expectedRecordDigest);
  }
  const token = preparePublication(data.approval, clone(INVENTORY), envelope());
  publishPreparedPublication(token);
  const published = readPublication(data.dbFile);
  assert.equal(published.tenantId, TENANT); assert.deepEqual(published.counts, COUNTS);
  assert.deepEqual(published.sources, [{ sourceStoreId: ALPHA, ownerId: OWNER }, { sourceStoreId: BETA, ownerId: OWNER }]);
  assert.match(published.instanceId, /^[a-f0-9-]{36}$/); assert.match(published.restoreEpoch, /^[a-f0-9-]{36}$/);
  const db = new DatabaseSync(data.dbFile, { readOnly: true });
  try {
    const rows = db.prepare('SELECT * FROM health_records ORDER BY source_store_id,record_type,native_record_id').all();
    assert.equal(rows.length, 3);
    for (const expected of INVENTORY.records) {
      const row = rows.find(row => JSON.stringify([row.tenant_id,row.source_store_id,row.record_type,row.native_record_id]) === expected.nativeKeyJson);
      assert.ok(row, 'each fixed source/type/native ID remains separate');
      assert.equal(row.record_json, expected.recordJson); assert.equal(sha(row.record_json), expected.expectedRecordDigest);
      assert.equal(row.serializer_id, expected.serializerId); assert.equal(row.serializer_version, expected.serializerVersion);
      assert.equal(row.data_family, 'ordinary'); assert.equal(row.projection, 'raw-only');
    }
    const header = db.prepare('SELECT * FROM health_restore_publication').get();
    assert.equal(header.singleton, 1); assert.equal(header.version, 1);
    assert.deepEqual(JSON.parse(header.metadata_json), metadata());
    assert.equal(header.metadata_sha256, sha(header.metadata_json));
    assert.deepEqual(JSON.parse(header.envelope_json), envelope());
    assert.equal(JSON.parse(header.metadata_json).tombstones[1].knownType, null);
    for (const table of ['health_streams','health_batch_receipts','health_projection_outbox'])
      assert.equal(db.prepare('SELECT count(*) AS count FROM ' + table).get().count, 0);
    assert.equal(db.prepare('SELECT value FROM sentinel WHERE id=1').get().value, 'retain-me');
  } finally { db.close(); }
  assert.equal(data.inventory().credentials, before.credentials);
});
test('rejects checksum, count, raw byte and foreign input-source corruptions without publication', t => {
  const cases = [
    [clone(INVENTORY), { ...envelope(), counts: { ...COUNTS, records: 2 } }],
    [clone(INVENTORY), { ...envelope(), sha256: 'sha256:' + '0'.repeat(64) }],
  ];
  const corrupt = clone(INVENTORY); corrupt.records[0].recordJson = corrupt.records[0].recordJson.replace('43.125', '43.126');
  cases.push([corrupt, envelope(corrupt)]);
  const foreign = clone(INVENTORY); foreign.records[0].identity[1] = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  foreign.records[0].nativeKeyJson = JSON.stringify(foreign.records[0].identity); cases.push([foreign, envelope(foreign)]);
  const foreignTenant = clone(INVENTORY); foreignTenant.records[0].identity[0] = '99999999-9999-4999-8999-999999999999';
  foreignTenant.records[0].nativeKeyJson = JSON.stringify(foreignTenant.records[0].identity); cases.push([foreignTenant, envelope(foreignTenant)]);
  for (const [candidate, footer] of cases) {
    const data = setup(t), before = data.inventory();
    assert.throws(() => preparePublication(data.approval, candidate, footer), invalid);
    assert.deepEqual(data.inventory(), before); assert.equal(readPublication(data.dbFile), null);
  }
});
test('structural capabilities and a current foreign owner cannot publish', t => {
  const data = setup(t), before = data.inventory();
  assert.throws(() => preparePublication({ ...data.approval }, clone(INVENTORY), envelope()),
    { status: 409, code: 'IMPORT_APPROVAL_REQUIRED' });
  const token = preparePublication(data.approval, clone(INVENTORY), envelope()); data.setOwner('synthetic-other-owner');
  assert.throws(() => publishPreparedPublication(token), { status: 403, code: 'IMPORT_OWNER_MISMATCH' });
  assert.deepEqual(data.inventory(), before); assert.equal(readPublication(data.dbFile), null);
});
test('real second-record SQL refusal rolls back earlier staged raw data and the entire optional publication family', t => {
  const data = setup(t); const db = new DatabaseSync(data.dbFile);
  try { db.exec("CREATE TRIGGER refuse_beta BEFORE INSERT ON health_records WHEN NEW.source_store_id='" + BETA +
    "' BEGIN SELECT RAISE(ABORT, 'synthetic storage refusal'); END"); } finally { db.close(); }
  const before = data.inventory(), token = preparePublication(data.approval, clone(INVENTORY), envelope());
  assert.throws(() => publishPreparedPublication(token), { status: 503, code: 'storage-unavailable' });
  assert.deepEqual(data.inventory(), before); assert.equal(readPublication(data.dbFile), null);
});

test('an already retained foreign native target refuses publication and preserves all committed target evidence', t => {
  const data = setup(t), db = new DatabaseSync(data.dbFile);
  try {
    db.prepare('INSERT INTO health_records VALUES (?,?,?,?,?,?,?,?,?)').run(
      '99999999-9999-4999-8999-999999999999', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      'BodyWaterMassRecord', 'r0-shared-id', 'health-connect-record', 1, 'ordinary', 'raw-only',
      INVENTORY.records[0].recordJson);
  } finally { db.close(); }
  const before = data.inventory();
  const token = preparePublication(data.approval, clone(INVENTORY), envelope());
  assert.throws(() => publishPreparedPublication(token),
    { status:409, code:'IMPORT_PUBLICATION_TARGET_NOT_FRESH' });
  assert.deepEqual(data.inventory(), before);
  assert.equal(readPublication(data.dbFile), null);
  const retained = new DatabaseSync(data.dbFile, { readOnly:true });
  try {
    const rows = retained.prepare('SELECT * FROM health_records').all();
    assert.equal(rows.length, 1); assert.equal(rows[0].tenant_id, '99999999-9999-4999-8999-999999999999');
    assert.equal(rows[0].source_store_id, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc');
    assert.equal(rows[0].record_json, INVENTORY.records[0].recordJson);
  } finally { retained.close(); }
});
test('a real database close fault after SQL COMMIT preserves committed publication and reports pending recovery', t => {
  const data = setup(t), before = data.inventory();
  const token = preparePublication(data.approval, clone(INVENTORY), envelope());
  const originalClose = DatabaseSync.prototype.close;
  let actualCloseCalls = 0, pending;
  // Existing Node test mock surface only: no publisher hook or fabricated transaction.
  // Native prototype configurability is required; unsupported setup is not acceptance evidence.
  const closeMock = t.mock.method(DatabaseSync.prototype, 'close', function () {
    originalClose.call(this); actualCloseCalls++;
    if (actualCloseCalls === 1) throw new Error('synthetic close failure after real close');
  });
  try {
    assert.throws(() => publishPreparedPublication(token), error => {
      assert.equal(error.status, 503); assert.equal(error.code, 'COMMITTED_PENDING_RECOVERY');
      assert.ok(error.publication, 'known committed descriptor remains attached to the refusal');
      pending = error.publication; return true;
    });
  } finally { closeMock.mock.restore(); }
  assert.equal(actualCloseCalls, 1);
  const committed = readPublication(data.dbFile);
  assert.deepEqual(committed, pending); assert.equal(committed.tenantId, TENANT);
  assert.deepEqual(committed.counts, COUNTS);
  assert.deepEqual(committed.sources, [{sourceStoreId:ALPHA,ownerId:OWNER},{sourceStoreId:BETA,ownerId:OWNER}]);
  const after = data.inventory();
  assert.notDeepEqual(after.database, before.database, 'committed state must not be relabelled rolled back');
  assert.equal(after.credentials, before.credentials);
  const db = new DatabaseSync(data.dbFile, { readOnly:true });
  try {
    const header = db.prepare('SELECT * FROM health_restore_publication').get();
    assert.equal(header.singleton, 1); assert.equal(header.publication_id, pending.publicationId);
    assert.deepEqual(JSON.parse(header.metadata_json), metadata());
    assert.equal(header.metadata_sha256, sha(header.metadata_json));
    const rows = db.prepare('SELECT * FROM health_records').all(); assert.equal(rows.length, 3);
    for (const record of INVENTORY.records) {
      const row = rows.find(value => JSON.stringify([value.tenant_id,value.source_store_id,
        value.record_type,value.native_record_id]) === record.nativeKeyJson);
      assert.ok(row); assert.equal(row.record_json, record.recordJson);
      assert.equal(sha(row.record_json), record.expectedRecordDigest);
    }
  } finally { db.close(); }
});


test('initial verification accepts the independently frozen three-record input without writes', t => {
  const data = setup(t), token = preparePublication(data.approval, clone(INVENTORY), envelope());
  const published = publishPreparedPublication(token), before = data.inventory();
  const initial = readPublication(data.dbFile, { initialPreparedToken: token });
  assert.deepEqual(initial, published); assert.equal(initial.tenantId, TENANT);
  assert.deepEqual(initial.counts, COUNTS);
  assert.deepEqual(initial.sources, [{ sourceStoreId: ALPHA, ownerId: OWNER }, { sourceStoreId: BETA, ownerId: OWNER }]);
  assert.deepEqual(data.inventory(), before);
  const db = new DatabaseSync(data.dbFile, { readOnly: true });
  try {
    const rows = db.prepare('SELECT * FROM health_records').all(); assert.equal(rows.length, 3);
    for (const expected of INVENTORY.records) {
      const row = rows.find(value => JSON.stringify([value.tenant_id,value.source_store_id,
        value.record_type,value.native_record_id]) === expected.nativeKeyJson);
      assert.ok(row); assert.equal(row.record_json, expected.recordJson);
      assert.equal(Buffer.byteLength(row.record_json, 'utf8'), expected.expectedUtf8Bytes);
      assert.equal(sha(row.record_json), expected.expectedRecordDigest);
      assert.equal(row.serializer_id, expected.serializerId); assert.equal(row.serializer_version, expected.serializerVersion);
      assert.equal(row.data_family, expected.dataFamily); assert.equal(row.projection, expected.projection);
    }
    const header = db.prepare('SELECT * FROM health_restore_publication').get();
    assert.deepEqual(JSON.parse(header.metadata_json), metadata());
    assert.deepEqual(JSON.parse(header.envelope_json), envelope());
    assert.equal(db.prepare('SELECT value FROM sentinel WHERE id=1').get().value, 'retain-me');
  } finally { db.close(); }
  assert.deepEqual(data.inventory(), before);
});

test('initial verification refuses a same-length raw payload change against the trusted original input', t => {
  const data = setup(t), token = preparePublication(data.approval, clone(INVENTORY), envelope());
  publishPreparedPublication(token);
  const changed = INVENTORY.records[0].recordJson.replace('43.125', '43.126');
  assert.equal(Buffer.byteLength(changed, 'utf8'), 380);
  assert.equal(sha(changed), 'sha256:44fdc668a9f033c60c708d74f15d51e39ac2a2927de165edeb259f27b39ff920');
  const db = new DatabaseSync(data.dbFile);
  try {
    const result = db.prepare('UPDATE health_records SET record_json=? WHERE tenant_id=? AND source_store_id=? AND record_type=? AND native_record_id=?')
      .run(changed, ...INVENTORY.records[0].identity); assert.equal(result.changes, 1);
  } finally { db.close(); }
  const before = data.inventory();
  assert.throws(() => readPublication(data.dbFile, { initialPreparedToken: token }),
    { status: 503, code: 'storage-unavailable' });
  assert.deepEqual(data.inventory(), before);
  assert.deepEqual(readPublication(data.dbFile).counts, COUNTS);
  assert.deepEqual(data.inventory(), before);
});

test('initial verification refuses a syntactically valid all-zero stored envelope digest', t => {
  const data = setup(t), token = preparePublication(data.approval, clone(INVENTORY), envelope());
  publishPreparedPublication(token);
  const storedFooter = { ...envelope(), sha256: 'sha256:' + '0'.repeat(64) };
  const db = new DatabaseSync(data.dbFile);
  try {
    const result = db.prepare('UPDATE health_restore_publication SET envelope_json=? WHERE singleton=1')
      .run(JSON.stringify(storedFooter)); assert.equal(result.changes, 1);
  } finally { db.close(); }
  const before = data.inventory();
  assert.throws(() => readPublication(data.dbFile, { initialPreparedToken: token }),
    { status: 503, code: 'storage-unavailable' });
  assert.deepEqual(data.inventory(), before);
});

test('initial verification rejects copied, foreign-owner and alternate-database capabilities before reading', t => {
  const data = setup(t), other = setup(t);
  const token = preparePublication(data.approval, clone(INVENTORY), envelope());
  publishPreparedPublication(token);
  const before = data.inventory(), otherBefore = other.inventory();
  const originalLstat = fs.lstatSync; let readerCalls = 0;
  const lstatMock = t.mock.method(fs, 'lstatSync', function (...args) {
    readerCalls++; return originalLstat.apply(this, args);
  });
  try {
    assert.throws(() => readPublication(data.dbFile, { initialPreparedToken: { ...token } }),
      { status: 409, code: 'IMPORT_APPROVAL_REQUIRED' });
    assert.equal(readerCalls, 0);
    data.setOwner('synthetic-other-owner');
    assert.throws(() => readPublication(data.dbFile, { initialPreparedToken: token }),
      { status: 403, code: 'IMPORT_OWNER_MISMATCH' });
    assert.equal(readerCalls, 0);
    data.setOwner(OWNER);
    assert.throws(() => readPublication(other.dbFile, { initialPreparedToken: token }),
      { status: 409, code: 'IMPORT_APPROVAL_REQUIRED' });
    assert.equal(readerCalls, 0);
  } finally { lstatMock.mock.restore(); data.setOwner(OWNER); }
  assert.deepEqual(data.inventory(), before); assert.deepEqual(other.inventory(), otherBefore);
});

const ORDINARY_BYTE_INPUT_JSON = "{\"catalog\":{\"version\":1,\"logicalTenantId\":\"11111111-1111-4111-8111-111111111111\",\"sources\":[{\"sourceStoreId\":\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\",\"provider\":\"health-connect-native\",\"policyRef\":\"r0-policy-alpha\"},{\"sourceStoreId\":\"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb\",\"provider\":\"health-connect-native\",\"policyRef\":\"r0-policy-beta\"}]},\"records\":[{\"label\":\"alpha-body-water\",\"identity\":[\"11111111-1111-4111-8111-111111111111\",\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\",\"BodyWaterMassRecord\",\"r0-shared-id\"],\"recordJson\":\"{\\\"time\\\":\\\"2026-01-02T03:04:05.123456789Z\\\",\\\"zoneOffset\\\":\\\"+11:00\\\",\\\"mass\\\":{\\\"value\\\":\\\"43.125\\\",\\\"unit\\\":\\\"kg\\\"},\\\"metadata\\\":{\\\"id\\\":\\\"r0-shared-id\\\",\\\"dataOrigin\\\":{\\\"packageName\\\":\\\"example.synthetic.alpha\\\"},\\\"device\\\":{\\\"manufacturer\\\":\\\"Synthetic\\\",\\\"model\\\":\\\"Fixture Alpha\\\",\\\"type\\\":0},\\\"lastModifiedTime\\\":\\\"2026-01-02T03:05:00.000000001Z\\\",\\\"clientRecordId\\\":null,\\\"clientRecordVersion\\\":\\\"2\\\",\\\"recordingMethod\\\":3}}\",\"nativeKeyJson\":\"[\\\"11111111-1111-4111-8111-111111111111\\\",\\\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\\\",\\\"BodyWaterMassRecord\\\",\\\"r0-shared-id\\\"]\",\"serializerId\":\"health-connect-record\",\"serializerVersion\":1,\"dataFamily\":\"ordinary\",\"projection\":\"raw-only\",\"expectedUtf8Bytes\":380,\"expectedRecordDigest\":\"sha256:e58adccfff037a420d6634ece28e51cc544f306871f45a7238c6e2e87a28cc3f\"},{\"label\":\"beta-body-water\",\"identity\":[\"11111111-1111-4111-8111-111111111111\",\"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb\",\"BodyWaterMassRecord\",\"r0-shared-id\"],\"recordJson\":\"{\\\"time\\\":\\\"2026-01-02T03:04:05.123456789Z\\\",\\\"zoneOffset\\\":null,\\\"mass\\\":{\\\"value\\\":\\\"43.125\\\",\\\"unit\\\":\\\"kg\\\"},\\\"metadata\\\":{\\\"id\\\":\\\"r0-shared-id\\\",\\\"dataOrigin\\\":{\\\"packageName\\\":\\\"example.synthetic.beta\\\"},\\\"device\\\":{\\\"manufacturer\\\":null,\\\"model\\\":null,\\\"type\\\":0},\\\"lastModifiedTime\\\":\\\"2026-01-02T03:05:00.000000002Z\\\",\\\"clientRecordId\\\":null,\\\"clientRecordVersion\\\":\\\"1\\\",\\\"recordingMethod\\\":0}}\",\"nativeKeyJson\":\"[\\\"11111111-1111-4111-8111-111111111111\\\",\\\"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb\\\",\\\"BodyWaterMassRecord\\\",\\\"r0-shared-id\\\"]\",\"serializerId\":\"health-connect-record\",\"serializerVersion\":1,\"dataFamily\":\"ordinary\",\"projection\":\"raw-only\",\"expectedUtf8Bytes\":357,\"expectedRecordDigest\":\"sha256:c75f9ec48ec178af6f10bfa22907417e79b0e45bb4cd4ac00e50b16a248d41e1\"},{\"label\":\"alpha-cycling-cadence\",\"identity\":[\"11111111-1111-4111-8111-111111111111\",\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\",\"CyclingPedalingCadenceRecord\",\"r0-shared-id\"],\"recordJson\":\"{\\\"startTime\\\":\\\"2026-01-02T03:00:00Z\\\",\\\"endTime\\\":\\\"2026-01-02T03:10:00Z\\\",\\\"startZoneOffset\\\":\\\"+11:00\\\",\\\"endZoneOffset\\\":\\\"+11:00\\\",\\\"samples\\\":[{\\\"time\\\":\\\"2026-01-02T03:01:00.000000001Z\\\",\\\"revolutionsPerMinute\\\":\\\"62.5\\\"},{\\\"time\\\":\\\"2026-01-02T03:05:00.000000002Z\\\",\\\"revolutionsPerMinute\\\":\\\"91.25\\\"}],\\\"metadata\\\":{\\\"id\\\":\\\"r0-shared-id\\\",\\\"dataOrigin\\\":{\\\"packageName\\\":\\\"example.synthetic.alpha\\\"},\\\"device\\\":{\\\"manufacturer\\\":\\\"Synthetic\\\",\\\"model\\\":\\\"Fixture Alpha\\\",\\\"type\\\":0},\\\"lastModifiedTime\\\":\\\"2026-01-02T03:11:00.000000001Z\\\",\\\"clientRecordId\\\":null,\\\"clientRecordVersion\\\":\\\"1\\\",\\\"recordingMethod\\\":3}}\",\"nativeKeyJson\":\"[\\\"11111111-1111-4111-8111-111111111111\\\",\\\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\\\",\\\"CyclingPedalingCadenceRecord\\\",\\\"r0-shared-id\\\"]\",\"serializerId\":\"health-connect-record\",\"serializerVersion\":1,\"dataFamily\":\"ordinary\",\"projection\":\"raw-only\",\"expectedUtf8Bytes\":557,\"expectedRecordDigest\":\"sha256:87bc00ed3b441a2c5626223c2fe28019086bf28a799bdd0594bd284bec6eeec2\"}],\"sourcePolicies\":[{\"id\":\"r0-policy-alpha\",\"sourceStoreId\":\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\",\"sharing\":\"stopped\",\"retainCommittedHistory\":true,\"priorGenerationProvenance\":\"7\"},{\"id\":\"r0-policy-beta\",\"sourceStoreId\":\"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb\",\"sharing\":\"enabled\",\"retainCommittedHistory\":true,\"priorGenerationProvenance\":\"3\"}],\"tombstones\":[{\"tenantId\":\"11111111-1111-4111-8111-111111111111\",\"sourceStoreId\":\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\",\"nativeRecordId\":\"r0-deleted-known\",\"knownType\":\"StepsRecord\",\"reason\":\"source-delete\"},{\"tenantId\":\"11111111-1111-4111-8111-111111111111\",\"sourceStoreId\":\"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb\",\"nativeRecordId\":\"r0-deleted-unknown\",\"knownType\":null,\"reason\":\"source-delete\"}],\"suppressions\":[{\"sourceStoreId\":\"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb\",\"type\":\"WeightRecord\",\"startInclusive\":\"2025-12-01T00:00:00Z\",\"endExclusive\":\"2026-01-01T00:00:00Z\",\"explicitReimportAllowed\":false}]}";
const ORDINARY_BYTE_FOOTER_JSON = "{\"version\":1,\"counts\":{\"sources\":2,\"records\":3,\"sourcePolicies\":2,\"tombstones\":2,\"suppressions\":1},\"sha256\":\"sha256:0331b06e9595a6115e11ab8712d7d5884a3e89f96b48fc0348350396342ff00b\"}";

test('ordinary byte preparation accepts exact independently fixed payload and footer without target mutation', t => {
  const data = setup(t), before = data.inventory(); let token;
  const input = Buffer.from(ORDINARY_BYTE_INPUT_JSON, 'utf8'), footer = Buffer.from(ORDINARY_BYTE_FOOTER_JSON, 'utf8');
  assert.equal(input.length, 4419); assert.equal(sha(input), 'sha256:0331b06e9595a6115e11ab8712d7d5884a3e89f96b48fc0348350396342ff00b');
  assert.equal(footer.length, 182); assert.equal(sha(footer), 'sha256:6a29e1acbdc2b06cca969ae35b9acd771717ac69f39fbdcb194104d9e3ef2373');
  assert.doesNotThrow(() => { token = preparePublication(data.approval, input, footer); });
  assert.ok(Object.isFrozen(token));
  const { encodeOrdinaryHistory, decodeOrdinaryHistory } = require('../lib/import/native-publication');
  const encoded = encodeOrdinaryHistory(INVENTORY);
  assert.deepEqual(encoded.inputBytes, input); assert.deepEqual(encoded.footerBytes, footer);
  const decoded = decodeOrdinaryHistory(input, footer);
  assert.equal(decoded.inputJSON, ORDINARY_BYTE_INPUT_JSON); assert.equal(decoded.envelopeJSON, ORDINARY_BYTE_FOOTER_JSON);
  assert.deepEqual(decoded.inventory, INVENTORY); assert.deepEqual(decoded.envelope.counts, COUNTS);
  assert.equal(decoded.inventory.tombstones[1].knownType, null);
  for (let index = 0; index < 3; index++) assert.equal(decoded.inventory.records[index].recordJson, INVENTORY.records[index].recordJson);
  input.fill(0); footer.fill(0);
  assert.equal(decoded.inputJSON, ORDINARY_BYTE_INPUT_JSON); assert.equal(decoded.envelopeJSON, ORDINARY_BYTE_FOOTER_JSON);
  assert.deepEqual(data.inventory(), before);
});

test('ordinary byte preparation refuses fixed corruption, family drift and truncation without target mutation', t => {
  const data = setup(t), before = data.inventory();
  const cases = [
    ["same-length old footer", Buffer.from(ORDINARY_BYTE_INPUT_JSON.replace('43.125', '43.126')), Buffer.from("{\"version\":1,\"counts\":{\"sources\":2,\"records\":3,\"sourcePolicies\":2,\"tombstones\":2,\"suppressions\":1},\"sha256\":\"sha256:0331b06e9595a6115e11ab8712d7d5884a3e89f96b48fc0348350396342ff00b\"}"), "sha256:05e2f5196bf4a63d1d74474f6752ac0684bd914ebe7066d98c1eee028c1bdd63"],
    ["same-length recomputed whole footer retains stale raw digest", Buffer.from(ORDINARY_BYTE_INPUT_JSON.replace('43.125', '43.126')), Buffer.from("{\"version\":1,\"counts\":{\"sources\":2,\"records\":3,\"sourcePolicies\":2,\"tombstones\":2,\"suppressions\":1},\"sha256\":\"sha256:05e2f5196bf4a63d1d74474f6752ac0684bd914ebe7066d98c1eee028c1bdd63\"}"), "sha256:05e2f5196bf4a63d1d74474f6752ac0684bd914ebe7066d98c1eee028c1bdd63"],
    ["zero footer", Buffer.from(ORDINARY_BYTE_INPUT_JSON), Buffer.from("{\"version\":1,\"counts\":{\"sources\":2,\"records\":3,\"sourcePolicies\":2,\"tombstones\":2,\"suppressions\":1},\"sha256\":\"sha256:0000000000000000000000000000000000000000000000000000000000000000\"}"), "sha256:0331b06e9595a6115e11ab8712d7d5884a3e89f96b48fc0348350396342ff00b"],
    ["stale footer", Buffer.from(ORDINARY_BYTE_INPUT_JSON), Buffer.from("{\"version\":1,\"counts\":{\"sources\":2,\"records\":3,\"sourcePolicies\":2,\"tombstones\":2,\"suppressions\":1},\"sha256\":\"sha256:05e2f5196bf4a63d1d74474f6752ac0684bd914ebe7066d98c1eee028c1bdd63\"}"), "sha256:0331b06e9595a6115e11ab8712d7d5884a3e89f96b48fc0348350396342ff00b"],
    ["count drift", Buffer.from(ORDINARY_BYTE_INPUT_JSON), Buffer.from("{\"version\":1,\"counts\":{\"sources\":2,\"records\":2,\"sourcePolicies\":2,\"tombstones\":2,\"suppressions\":1},\"sha256\":\"sha256:0331b06e9595a6115e11ab8712d7d5884a3e89f96b48fc0348350396342ff00b\"}"), "sha256:0331b06e9595a6115e11ab8712d7d5884a3e89f96b48fc0348350396342ff00b"],
    ["missing required family with matching checksum", Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(ORDINARY_BYTE_INPUT_JSON)).filter(([name]) => name !== 'suppressions')))), Buffer.from("{\"version\":1,\"counts\":{\"sources\":2,\"records\":3,\"sourcePolicies\":2,\"tombstones\":2,\"suppressions\":1},\"sha256\":\"sha256:cbf90505f1af3a6c349b08c904c7187b61e24b01cb927a4f2215047a0323534a\"}"), "sha256:cbf90505f1af3a6c349b08c904c7187b61e24b01cb927a4f2215047a0323534a"],
    ["unknown root family with matching checksum", Buffer.from(JSON.stringify({ ...JSON.parse(ORDINARY_BYTE_INPUT_JSON), extraFamily: [] })), Buffer.from("{\"version\":1,\"counts\":{\"sources\":2,\"records\":3,\"sourcePolicies\":2,\"tombstones\":2,\"suppressions\":1},\"sha256\":\"sha256:635025f72480659b8be1ed92e2746fbfbe7dbd5acea85e9a7a220b9d777b1d20\"}"), "sha256:635025f72480659b8be1ed92e2746fbfbe7dbd5acea85e9a7a220b9d777b1d20"],
    ["truncated old footer", Buffer.from(ORDINARY_BYTE_INPUT_JSON.slice(0, -1)), Buffer.from("{\"version\":1,\"counts\":{\"sources\":2,\"records\":3,\"sourcePolicies\":2,\"tombstones\":2,\"suppressions\":1},\"sha256\":\"sha256:0331b06e9595a6115e11ab8712d7d5884a3e89f96b48fc0348350396342ff00b\"}"), "sha256:2e622c7c4acc998ab57884bf479cfb29b3bee76f21568b76f9d88424581af2c3"],
    ["truncated matching byte checksum", Buffer.from(ORDINARY_BYTE_INPUT_JSON.slice(0, -1)), Buffer.from("{\"version\":1,\"counts\":{\"sources\":2,\"records\":3,\"sourcePolicies\":2,\"tombstones\":2,\"suppressions\":1},\"sha256\":\"sha256:2e622c7c4acc998ab57884bf479cfb29b3bee76f21568b76f9d88424581af2c3\"}"), "sha256:2e622c7c4acc998ab57884bf479cfb29b3bee76f21568b76f9d88424581af2c3"],
    ['null footer', Buffer.from(ORDINARY_BYTE_INPUT_JSON), Buffer.from('null'), 'sha256:0331b06e9595a6115e11ab8712d7d5884a3e89f96b48fc0348350396342ff00b'],
  ];
  for (const [name, input, footer, expectedHash] of cases) {
    assert.equal(sha(input), expectedHash, name);
    assert.throws(() => preparePublication(data.approval, input, footer), invalid, name);
    assert.deepEqual(data.inventory(), before, name);
  }
});

test('ordinary byte preparation refuses invalid UTF8, noncanonical bytes and oversized buffers without target mutation', t => {
  const data = setup(t), before = data.inventory();
  const cases = [
    ["invalid input UTF8", Buffer.from([0xc3, 0x28]), Buffer.from("{\"version\":1,\"counts\":{\"sources\":2,\"records\":3,\"sourcePolicies\":2,\"tombstones\":2,\"suppressions\":1},\"sha256\":\"sha256:eddf68639913a3cb8331cdfe7f87559e0beccf2c289c0d90ac4d89b3204004f8\"}"), "sha256:eddf68639913a3cb8331cdfe7f87559e0beccf2c289c0d90ac4d89b3204004f8"],
    ["invalid footer UTF8", Buffer.from(ORDINARY_BYTE_INPUT_JSON), Buffer.from([0xc3, 0x28]), "sha256:0331b06e9595a6115e11ab8712d7d5884a3e89f96b48fc0348350396342ff00b"],
    ["noncanonical leading whitespace with matching checksum", Buffer.from(' ' + ORDINARY_BYTE_INPUT_JSON), Buffer.from("{\"version\":1,\"counts\":{\"sources\":2,\"records\":3,\"sourcePolicies\":2,\"tombstones\":2,\"suppressions\":1},\"sha256\":\"sha256:2c8dede2d5ce5b7dd32fc620eb50e8cb5316984a21090338294080f40698707e\"}"), "sha256:2c8dede2d5ce5b7dd32fc620eb50e8cb5316984a21090338294080f40698707e"],
    ["duplicate root key with matching checksum", Buffer.from(ORDINARY_BYTE_INPUT_JSON.slice(0, -1) + ',"suppressions":' + JSON.stringify(JSON.parse(ORDINARY_BYTE_INPUT_JSON).suppressions) + '}'), Buffer.from("{\"version\":1,\"counts\":{\"sources\":2,\"records\":3,\"sourcePolicies\":2,\"tombstones\":2,\"suppressions\":1},\"sha256\":\"sha256:3d6f98e64ae8bfbb4aaaa5aacdecede4e4a91b92f0a6fd009fe8950ac3ca53a1\"}"), "sha256:3d6f98e64ae8bfbb4aaaa5aacdecede4e4a91b92f0a6fd009fe8950ac3ca53a1"],
    ["noncanonical footer key order", Buffer.from(ORDINARY_BYTE_INPUT_JSON), Buffer.from("{\"sha256\":\"sha256:0331b06e9595a6115e11ab8712d7d5884a3e89f96b48fc0348350396342ff00b\",\"version\":1,\"counts\":{\"sources\":2,\"records\":3,\"sourcePolicies\":2,\"tombstones\":2,\"suppressions\":1}}"), "sha256:0331b06e9595a6115e11ab8712d7d5884a3e89f96b48fc0348350396342ff00b"],
  ];
  for (const [name, input, footer, expectedHash] of cases) {
    assert.equal(sha(input), expectedHash, name);
    assert.throws(() => preparePublication(data.approval, input, footer), invalid, name);
    assert.deepEqual(data.inventory(), before, name);
  }
  assert.throws(() => preparePublication(data.approval, Buffer.alloc(16777217), Buffer.from(ORDINARY_BYTE_FOOTER_JSON)), invalid);
  assert.deepEqual(data.inventory(), before);
  assert.throws(() => preparePublication(data.approval, Buffer.from(ORDINARY_BYTE_INPUT_JSON), Buffer.alloc(16777217)), invalid);
  assert.deepEqual(data.inventory(), before);
});

test('ordinary byte preparation retains existing owner refusals and legacy object acceptance', t => {
  const data = setup(t), before = data.inventory(), invalidBytes = Buffer.from([0xc3, 0x28]);
  assert.throws(() => preparePublication({ ...data.approval }, invalidBytes, invalidBytes),
    { status: 409, code: 'IMPORT_APPROVAL_REQUIRED' });
  data.setOwner('synthetic-other-owner');
  assert.throws(() => preparePublication(data.approval, invalidBytes, invalidBytes),
    { status: 403, code: 'IMPORT_OWNER_MISMATCH' });
  data.setOwner(OWNER);
  assert.doesNotThrow(() => preparePublication(data.approval, clone(INVENTORY), envelope()));
  assert.deepEqual(data.inventory(), before);
});


test('SQLBYTES01 returns owned exact initial SQL bytes and preserves default correction and deletion reads', t => {
  const data = setup(t), token = preparePublication(data.approval, clone(INVENTORY), envelope());
  const published = publishPreparedPublication(token);
  const authority = readPublication(data.dbFile, { initialPreparedToken: token });
  assert.deepEqual(authority, published);
  const before = data.inventory();
  const result = readPublication(data.dbFile, { initialPreparedToken: token, initialOrdinaryBytes: true });
  assert.equal(Buffer.isBuffer(result.inputBytes), true);
  assert.equal(Buffer.isBuffer(result.footerBytes), true);
  assert.deepEqual(Object.keys(result).sort(), ['footerBytes', 'inputBytes', 'publication']);
  assert.deepEqual(result.publication, authority);
  assert.equal(result.inputBytes.length, 4419);
  assert.equal(sha(result.inputBytes), 'sha256:0331b06e9595a6115e11ab8712d7d5884a3e89f96b48fc0348350396342ff00b');
  assert.equal(result.inputBytes.toString('utf8'), ORDINARY_BYTE_INPUT_JSON);
  assert.equal(result.footerBytes.length, 182);
  assert.equal(sha(result.footerBytes), 'sha256:6a29e1acbdc2b06cca969ae35b9acd771717ac69f39fbdcb194104d9e3ef2373');
  assert.equal(result.footerBytes.toString('utf8'), ORDINARY_BYTE_FOOTER_JSON);
  const output = JSON.parse(result.inputBytes.toString('utf8'));
  const footer = JSON.parse(result.footerBytes.toString('utf8'));
  assert.deepEqual(Object.keys(output), ['catalog', 'records', 'sourcePolicies', 'tombstones', 'suppressions']);
  assert.deepEqual(output, INVENTORY); assert.deepEqual(footer.counts, COUNTS);
  assert.equal(footer.sha256, 'sha256:0331b06e9595a6115e11ab8712d7d5884a3e89f96b48fc0348350396342ff00b');
  assert.equal(output.sourcePolicies[0].sharing, 'stopped');
  assert.equal(output.tombstones[1].knownType, null);
  assert.equal(output.suppressions[0].explicitReimportAllowed, false);
  const fixedRaw = [
    [380, 'sha256:e58adccfff037a420d6634ece28e51cc544f306871f45a7238c6e2e87a28cc3f'],
    [357, 'sha256:c75f9ec48ec178af6f10bfa22907417e79b0e45bb4cd4ac00e50b16a248d41e1'],
    [557, 'sha256:87bc00ed3b441a2c5626223c2fe28019086bf28a799bdd0594bd284bec6eeec2'],
  ];
  for (let index = 0; index < 3; index++) {
    const record = output.records[index];
    assert.deepEqual(record.identity, INVENTORY.records[index].identity);
    assert.equal(record.nativeKeyJson, INVENTORY.records[index].nativeKeyJson);
    assert.equal(record.recordJson, INVENTORY.records[index].recordJson);
    assert.equal(Buffer.byteLength(record.recordJson, 'utf8'), fixedRaw[index][0]);
    assert.equal(sha(record.recordJson), fixedRaw[index][1]);
    assert.equal(record.serializerId, 'health-connect-record'); assert.equal(record.serializerVersion, 1);
    assert.equal(record.dataFamily, 'ordinary'); assert.equal(record.projection, 'raw-only');
  }
  assert.deepEqual(data.inventory(), before);
  result.inputBytes.fill(0); result.footerBytes.fill(0);
  const reread = readPublication(data.dbFile, { initialPreparedToken: token, initialOrdinaryBytes: true });
  assert.notStrictEqual(reread.inputBytes, result.inputBytes);
  assert.notStrictEqual(reread.footerBytes, result.footerBytes);
  assert.deepEqual(reread.publication, authority);
  assert.deepEqual(reread.inputBytes, Buffer.from(ORDINARY_BYTE_INPUT_JSON, 'utf8'));
  assert.deepEqual(reread.footerBytes, Buffer.from(ORDINARY_BYTE_FOOTER_JSON, 'utf8'));
  assert.deepEqual(data.inventory(), before);
  assert.deepEqual(readPublication(data.dbFile), authority);
  assert.deepEqual(readPublication(data.dbFile, {}), authority);
  assert.deepEqual(readPublication(data.dbFile, { initialPreparedToken: token }), authority);
  for (const value of [undefined, false, 0, 1, 'true', null]) {
    assert.deepEqual(readPublication(data.dbFile, { initialPreparedToken: token, initialOrdinaryBytes: value }), authority);
    assert.deepEqual(readPublication(data.dbFile, { initialOrdinaryBytes: value }), authority);
  }
  assert.deepEqual(data.inventory(), before);
  const changed = INVENTORY.records[0].recordJson.replace('43.125', '43.126');
  assert.equal(Buffer.byteLength(changed, 'utf8'), 380);
  assert.equal(sha(changed), 'sha256:44fdc668a9f033c60c708d74f15d51e39ac2a2927de165edeb259f27b39ff920');
  const db = new DatabaseSync(data.dbFile);
  try {
    const update = db.prepare('UPDATE health_records SET record_json=? WHERE tenant_id=? AND source_store_id=? AND record_type=? AND native_record_id=?')
      .run(changed, ...INVENTORY.records[0].identity);
    assert.equal(update.changes, 1);
  } finally { db.close(); }
  const correctedBefore = data.inventory();
  assert.throws(() => readPublication(data.dbFile, { initialPreparedToken: token, initialOrdinaryBytes: true }),
    { status: 503, code: 'storage-unavailable' });
  assert.deepEqual(data.inventory(), correctedBefore);
  const correctedAuthority = readPublication(data.dbFile);
  assert.deepEqual(correctedAuthority, authority);
  assert.deepEqual(data.inventory(), correctedBefore);
  const deleteDb = new DatabaseSync(data.dbFile);
  try {
    const deletion = deleteDb.prepare('DELETE FROM health_records WHERE tenant_id=? AND source_store_id=? AND record_type=? AND native_record_id=?')
      .run(...INVENTORY.records[1].identity); assert.equal(deletion.changes, 1);
  } finally { deleteDb.close(); }
  const deletedBefore = data.inventory();
  assert.deepEqual(readPublication(data.dbFile), correctedAuthority);
  assert.throws(() => readPublication(data.dbFile, { initialPreparedToken: token, initialOrdinaryBytes: true }),
    { status: 503, code: 'storage-unavailable' });
  assert.deepEqual(data.inventory(), deletedBefore);
});

test('SQLBYTES02 refuses missing, copied, foreign-owner and alternate-target tokens before reading', t => {
  const data = setup(t), other = setup(t);
  const token = preparePublication(data.approval, clone(INVENTORY), envelope());
  const published = publishPreparedPublication(token);
  const authority = readPublication(data.dbFile, { initialPreparedToken: token });
  assert.deepEqual(authority, published);
  const before = data.inventory(), otherBefore = other.inventory();
  const missingDbFile = path.join(data.home, 'db', 'missing-native.db');
  assert.equal(fs.existsSync(missingDbFile), false);
  const originalLstat = fs.lstatSync; let readerCalls = 0;
  const lstatMock = t.mock.method(fs, 'lstatSync', function (...args) {
    readerCalls++; return originalLstat.apply(this, args);
  });
  try {
    assert.throws(() => readPublication(data.dbFile, { initialOrdinaryBytes: true }),
      { status: 409, code: 'IMPORT_APPROVAL_REQUIRED' });
    assert.equal(readerCalls, 0);
    assert.throws(() => readPublication(data.dbFile, { initialPreparedToken: { ...token }, initialOrdinaryBytes: true }),
      { status: 409, code: 'IMPORT_APPROVAL_REQUIRED' });
    assert.equal(readerCalls, 0);
    data.setOwner('synthetic-other-owner');
    assert.throws(() => readPublication(data.dbFile, { initialPreparedToken: token, initialOrdinaryBytes: true }),
      { status: 403, code: 'IMPORT_OWNER_MISMATCH' });
    assert.equal(readerCalls, 0); data.setOwner(OWNER);
    assert.throws(() => readPublication(other.dbFile, { initialPreparedToken: token, initialOrdinaryBytes: true }),
      { status: 409, code: 'IMPORT_APPROVAL_REQUIRED' });
    assert.equal(readerCalls, 0);
    assert.throws(() => readPublication(missingDbFile, { initialOrdinaryBytes: true }),
      { status: 409, code: 'IMPORT_APPROVAL_REQUIRED' });
    assert.equal(readerCalls, 0);
  } finally { lstatMock.mock.restore(); data.setOwner(OWNER); }
  assert.deepEqual(data.inventory(), before); assert.deepEqual(other.inventory(), otherBefore);
  assert.equal(fs.existsSync(missingDbFile), false);
  const genuine = readPublication(data.dbFile, { initialPreparedToken: token, initialOrdinaryBytes: true });
  assert.deepEqual(genuine.publication, authority);
  assert.deepEqual(genuine.inputBytes, Buffer.from(ORDINARY_BYTE_INPUT_JSON, 'utf8'));
  assert.deepEqual(genuine.footerBytes, Buffer.from(ORDINARY_BYTE_FOOTER_JSON, 'utf8'));
  assert.deepEqual(data.inventory(), before); assert.deepEqual(other.inventory(), otherBefore);
});


const TYPED_CONTROL_BYTES = require('./helpers/ordinary-typed-controls-golden.cjs');
const TYPED_CONTROL_OPTIONS = Object.freeze({ controlProfileVersion: 2 });
const TYPED_CONTROL_COUNTS = Object.freeze({ sources: 2, records: 3, sourcePolicies: 2,
  tombstones: 1, suppressions: 1, deletionGuards: 2 });
function typedExpectAccepted(operation) {
  let result, failure;
  try { result = operation(); } catch (error) { failure = error; }
  if (failure) {
    assert.equal(failure.status, 400);
    assert.equal(failure.code, 'IMPORT_PUBLICATION_INVALID');
  }
  assert.equal(failure === undefined, true, 'the declared typed-control profile must be accepted');
  return result;
}
function typedControlFooter(inventory) {
  const counts = { sources: inventory.catalog.sources.length, records: inventory.records.length,
    sourcePolicies: inventory.sourcePolicies.length, tombstones: inventory.tombstones.length,
    suppressions: inventory.suppressions.length, deletionGuards: inventory.deletionGuards.length };
  // This digest constructs a valid synthetic input, never an expected product output.
  return Buffer.from(JSON.stringify({ version: 2, counts, sha256: sha(JSON.stringify(inventory)) }));
}

test('TCBYTE01 preserves healthy v1 and accepts typed v2 only through literal numeric opt-in', () => {
  const { encodeOrdinaryHistory, decodeOrdinaryHistory } = require('../lib/import/native-publication');
  const healthy = encodeOrdinaryHistory(INVENTORY);
  assert.deepEqual(healthy.inputBytes, Buffer.from(ORDINARY_BYTE_INPUT_JSON));
  assert.deepEqual(healthy.footerBytes, Buffer.from(ORDINARY_BYTE_FOOTER_JSON));
  assert.deepEqual(decodeOrdinaryHistory(healthy.inputBytes, healthy.footerBytes).inventory, INVENTORY);
  const inventory = JSON.parse(TYPED_CONTROL_BYTES.baseInputJSON);
  for (const value of [undefined, null, false, true, 0, 1, '2', {}]) {
    const options = value === undefined ? undefined : { controlProfileVersion: value };
    assert.throws(() => encodeOrdinaryHistory(inventory, options), invalid);
    assert.throws(() => decodeOrdinaryHistory(Buffer.from(TYPED_CONTROL_BYTES.baseInputJSON),
      Buffer.from(TYPED_CONTROL_BYTES.baseFooterJSON), options), invalid);
  }
  const encoded = typedExpectAccepted(() => encodeOrdinaryHistory(inventory, TYPED_CONTROL_OPTIONS));
  assert.deepEqual(encoded.inputBytes, Buffer.from(TYPED_CONTROL_BYTES.baseInputJSON));
  assert.deepEqual(encoded.footerBytes, Buffer.from(TYPED_CONTROL_BYTES.baseFooterJSON));
  assert.equal(encoded.inputBytes.length, 5140);
  assert.equal(sha(encoded.inputBytes), 'sha256:2760543788ff78a5f009a37c688bd820bd45c4f38ed049af232325d337591a78');
  assert.equal(encoded.footerBytes.length, 201);
  assert.equal(sha(encoded.footerBytes), 'sha256:d8213e7a9dc56f98d9b10a8948e8185f27667d487ca666a62bb3a6e9e076953c');
  assert.equal(JSON.parse(encoded.inputBytes).catalog.version, 2);
  assert.deepEqual(JSON.parse(encoded.footerBytes).counts, TYPED_CONTROL_COUNTS);
});

test('TCBYTE02 decodes fixed typed bytes with exact raw nulls and independently owned outputs', () => {
  const { encodeOrdinaryHistory, decodeOrdinaryHistory } = require('../lib/import/native-publication');
  const input = Buffer.from(TYPED_CONTROL_BYTES.baseInputJSON), footer = Buffer.from(TYPED_CONTROL_BYTES.baseFooterJSON);
  const decoded = typedExpectAccepted(() => decodeOrdinaryHistory(input, footer, TYPED_CONTROL_OPTIONS));
  assert.equal(decoded.inputJSON, TYPED_CONTROL_BYTES.baseInputJSON);
  assert.equal(decoded.envelopeJSON, TYPED_CONTROL_BYTES.baseFooterJSON);
  assert.deepEqual(decoded.envelope.counts, TYPED_CONTROL_COUNTS);
  assert.equal(decoded.inventory.deletionGuards[0].sourceDeleted, 1);
  assert.equal(decoded.inventory.deletionGuards[0].userSuppressed, 1);
  assert.equal(decoded.inventory.deletionGuards[0].footprintJson, null);
  assert.equal(decoded.inventory.deletionGuards[1].sourceStreamKey, null);
  assert.equal(decoded.inventory.deletionGuards[1].sourceSequence, null);
  assert.equal(decoded.inventory.deletionGuards[1].footprintJson, null);
  const raw = [[380, 'sha256:e58adccfff037a420d6634ece28e51cc544f306871f45a7238c6e2e87a28cc3f'],
    [357, 'sha256:c75f9ec48ec178af6f10bfa22907417e79b0e45bb4cd4ac00e50b16a248d41e1'],
    [557, 'sha256:87bc00ed3b441a2c5626223c2fe28019086bf28a799bdd0594bd284bec6eeec2']];
  for (let index = 0; index < 3; index++) {
    const record = decoded.inventory.records[index];
    assert.equal(record.recordJson, INVENTORY.records[index].recordJson);
    assert.deepEqual(record.identity, INVENTORY.records[index].identity);
    assert.equal(Buffer.byteLength(record.recordJson), raw[index][0]); assert.equal(sha(record.recordJson), raw[index][1]);
    assert.equal(record.projection, 'raw-only');
  }
  assert.equal(decoded.inventory.records[1].identity[2], 'BodyWaterMassRecord');
  assert.equal(JSON.parse(decoded.inventory.records[1].recordJson).zoneOffset, null);
  const first = encodeOrdinaryHistory(decoded.inventory, TYPED_CONTROL_OPTIONS);
  const second = encodeOrdinaryHistory(decoded.inventory, TYPED_CONTROL_OPTIONS);
  assert.notStrictEqual(first.inputBytes, second.inputBytes); assert.notStrictEqual(first.footerBytes, second.footerBytes);
  first.inputBytes.fill(0); first.footerBytes.fill(0); input.fill(0); footer.fill(0);
  assert.deepEqual(second.inputBytes, Buffer.from(TYPED_CONTROL_BYTES.baseInputJSON));
  assert.deepEqual(second.footerBytes, Buffer.from(TYPED_CONTROL_BYTES.baseFooterJSON));
  assert.equal(decoded.inputJSON, TYPED_CONTROL_BYTES.baseInputJSON);
  assert.equal(decoded.envelopeJSON, TYPED_CONTROL_BYTES.baseFooterJSON);
});

test('TCBYTE03 keeps same native IDs distinct across source and record-type control domains', () => {
  const { encodeOrdinaryHistory, decodeOrdinaryHistory } = require('../lib/import/native-publication');
  const inventory = JSON.parse(TYPED_CONTROL_BYTES.collisionInputJSON);
  const encoded = typedExpectAccepted(() => encodeOrdinaryHistory(inventory, TYPED_CONTROL_OPTIONS));
  assert.equal(encoded.inputBytes.length, 5994);
  assert.equal(sha(encoded.inputBytes), 'sha256:da32ff40d4d8fdef1d29a01693e5a4375804e90d1e08efcd682770303a8cde37');
  assert.deepEqual(encoded.inputBytes, Buffer.from(TYPED_CONTROL_BYTES.collisionInputJSON));
  assert.deepEqual(encoded.footerBytes, Buffer.from(TYPED_CONTROL_BYTES.collisionFooterJSON));
  const output = decodeOrdinaryHistory(encoded.inputBytes, encoded.footerBytes, TYPED_CONTROL_OPTIONS).inventory;
  assert.deepEqual(output.deletionGuards.map(row => row.identity), [
    [TENANT, ALPHA, 'WeightRecord', 'same-invented-id'],
    [TENANT, ALPHA, 'StepsRecord', 'same-invented-id'],
    [TENANT, BETA, 'WeightRecord', 'same-invented-id']]);
  assert.deepEqual(output.deletionGuards.map(row => [row.sourceDeleted, row.userSuppressed]), [[1, 1], [0, 1], [1, 0]]);
  assert.deepEqual(output.tombstones.map(row => row.sourceSequence), ['7', '9']);
  assert.deepEqual(output, inventory);
});

test('TCBYTE04 preserves genuine footprints and legacy tombstone-only authority at the guard boundary', () => {
  const { encodeOrdinaryHistory, decodeOrdinaryHistory } = require('../lib/import/native-publication');
  const inventory = JSON.parse(TYPED_CONTROL_BYTES.footprintLegacyInputJSON);
  const encoded = typedExpectAccepted(() => encodeOrdinaryHistory(inventory, TYPED_CONTROL_OPTIONS));
  assert.equal(encoded.inputBytes.length, 5631);
  assert.equal(sha(encoded.inputBytes), 'sha256:62bc9e04518ebaa0828fd6d6ffc2224c1e437e8c2aaf0be563089d876e5daa56');
  assert.deepEqual(encoded.inputBytes, Buffer.from(TYPED_CONTROL_BYTES.footprintLegacyInputJSON));
  assert.deepEqual(encoded.footerBytes, Buffer.from(TYPED_CONTROL_BYTES.footprintLegacyFooterJSON));
  const output = decodeOrdinaryHistory(encoded.inputBytes, encoded.footerBytes, TYPED_CONTROL_OPTIONS).inventory;
  assert.equal(output.deletionGuards[0].footprintJson,
    '{"kind":"instant","time":"2026-01-02T03:04:05.123456789Z","zoneOffset":"+11:00:37"}');
  assert.equal(output.deletionGuards.some(row => row.identity[1] === BETA), false);
  assert.equal(output.tombstones[1].identity[1], BETA);
  const boundary = JSON.parse(TYPED_CONTROL_BYTES.baseInputJSON);
  boundary.deletionGuards = Array.from({ length: 10000 }, (_, index) => ({
    identity: [TENANT, ALPHA, 'StepsRecord', 'invented-boundary-' + index], sourceDeleted: 0, userSuppressed: 1,
    sourceStreamKey: null, sourceSequence: null, footprintJson: null }));
  const limit = encodeOrdinaryHistory(boundary, TYPED_CONTROL_OPTIONS);
  assert.equal(JSON.parse(limit.footerBytes).counts.deletionGuards, 10000);
  assert.deepEqual(decodeOrdinaryHistory(limit.inputBytes, limit.footerBytes, TYPED_CONTROL_OPTIONS).inventory, boundary);
});

test('TCBYTE05 refuses malformed identity flags provenance bounds duplicates and ambiguous old controls', () => {
  const { encodeOrdinaryHistory, decodeOrdinaryHistory } = require('../lib/import/native-publication');
  const cases = [
    ['missing guards', value => { delete value.deletionGuards; }],
    ['unknown family', value => { value.extraFamily = []; }],
    ['foreign tenant', value => { value.tombstones[0].identity[0] = '55555555-5555-4555-8555-555555555555'; }],
    ['unknown source', value => { value.tombstones[0].identity[1] = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'; }],
    ['null native type', value => { value.tombstones[0].identity[2] = null; }],
    ['invalid native type', value => { value.tombstones[0].identity[2] = 'weight record'; }],
    ['empty native ID', value => { value.tombstones[0].identity[3] = ''; }],
    ['duplicate tombstone', value => { value.tombstones.push(clone(value.tombstones[0])); }],
    ['duplicate guard', value => { value.deletionGuards.push(clone(value.deletionGuards[0])); }],
    ['neither flag', value => { value.deletionGuards[1].userSuppressed = 0; }],
    ['boolean source flag', value => { value.deletionGuards[0].sourceDeleted = true; }],
    ['string user flag', value => { value.deletionGuards[0].userSuppressed = '1'; }],
    ['source without provenance', value => { value.deletionGuards[0].sourceStreamKey = null; }],
    ['source without sequence', value => { value.deletionGuards[0].sourceSequence = null; }],
    ['user-only source provenance', value => { value.deletionGuards[1].sourceStreamKey = value.tombstones[0].sourceStreamKey; }],
    ['zero sequence', value => { value.tombstones[0].sourceSequence = '0'; }],
    ['leading-zero sequence', value => { value.tombstones[0].sourceSequence = '07'; }],
    ['numeric sequence', value => { value.tombstones[0].sourceSequence = 7; }],
    ['overflow sequence', value => { value.tombstones[0].sourceSequence = '9223372036854775808'; }],
    ['noncanonical source key', value => { value.tombstones[0].sourceStreamKey = ' ' + value.tombstones[0].sourceStreamKey; }],
    ['short source key', value => { value.tombstones[0].sourceStreamKey = '["one","two","three"]'; }],
    ['mismatched source-key type', value => { value.tombstones[0].sourceStreamKey = value.tombstones[0].sourceStreamKey.replace('WeightRecord', 'StepsRecord'); }],
    ['mismatched source-key source', value => { value.tombstones[0].sourceStreamKey = value.tombstones[0].sourceStreamKey.replace(ALPHA, BETA); }],
    ['source-key generation', value => { const key = JSON.parse(value.tombstones[0].sourceStreamKey); key[5] = '-1'; value.tombstones[0].sourceStreamKey = JSON.stringify(key); }],
    ['overbound source component', value => { const key = JSON.parse(value.tombstones[0].sourceStreamKey); key[1] = 'x'.repeat(257); value.tombstones[0].sourceStreamKey = JSON.stringify(key); }],
    ['conflicting saved source provenance', value => { value.deletionGuards[0].sourceSequence = '8'; }],
    ['invalid footprint', value => { value.deletionGuards[0].footprintJson = '{}'; }],
    ['overbound footprint', value => { value.deletionGuards[0].footprintJson = ' '.repeat(2049); }],
    ['opaque old null control', value => { value.tombstones[0] = clone(INVENTORY.tombstones[1]); }],
    ['invented type alias', value => { value.tombstones[0].nativeKind = 'Steps'; }],
  ];
  for (const [name, mutate] of cases) {
    const inventory = JSON.parse(TYPED_CONTROL_BYTES.baseInputJSON); mutate(inventory);
    assert.throws(() => encodeOrdinaryHistory(inventory, TYPED_CONTROL_OPTIONS), invalid, name);
    if (Array.isArray(inventory.deletionGuards)) {
      assert.throws(() => decodeOrdinaryHistory(Buffer.from(JSON.stringify(inventory)),
        typedControlFooter(inventory), TYPED_CONTROL_OPTIONS), invalid, name);
    }
  }
  const overbound = JSON.parse(TYPED_CONTROL_BYTES.baseInputJSON);
  overbound.deletionGuards = Array.from({ length: 10001 }, (_, index) => ({
    identity: [TENANT, ALPHA, 'StepsRecord', 'invented-overbound-' + index], sourceDeleted: 0, userSuppressed: 1,
    sourceStreamKey: null, sourceSequence: null, footprintJson: null }));
  assert.throws(() => encodeOrdinaryHistory(overbound, TYPED_CONTROL_OPTIONS), invalid);
  assert.throws(() => decodeOrdinaryHistory(Buffer.from(JSON.stringify(overbound)), typedControlFooter(overbound), TYPED_CONTROL_OPTIONS), invalid);
});

test('TCBYTE06 checks original digest before payload parsing and leaves default apply unsupported', t => {
  const { encodeOrdinaryHistory, decodeOrdinaryHistory } = require('../lib/import/native-publication');
  const input = Buffer.from(TYPED_CONTROL_BYTES.baseInputJSON), footer = Buffer.from(TYPED_CONTROL_BYTES.baseFooterJSON);
  const changed = TYPED_CONTROL_BYTES.baseInputJSON.replace('"sourceSequence":"7"', '"sourceSequence":"8"');
  assert.notEqual(changed, TYPED_CONTROL_BYTES.baseInputJSON);
  const originalParse = JSON.parse; let changedPayloadParses = 0;
  const parseMock = t.mock.method(JSON, 'parse', function (text, ...args) {
    if (text === changed) changedPayloadParses++;
    return originalParse.call(this, text, ...args);
  });
  try { assert.throws(() => decodeOrdinaryHistory(Buffer.from(changed), footer, TYPED_CONTROL_OPTIONS), invalid); }
  finally { parseMock.mock.restore(); }
  assert.equal(changedPayloadParses, 0);
  const drift = JSON.parse(TYPED_CONTROL_BYTES.baseFooterJSON); drift.counts.deletionGuards = 1;
  assert.throws(() => decodeOrdinaryHistory(input, Buffer.from(JSON.stringify(drift)), TYPED_CONTROL_OPTIONS), invalid);
  const missingGuards = JSON.parse(TYPED_CONTROL_BYTES.baseInputJSON); delete missingGuards.deletionGuards;
  const missingGuardsInput = Buffer.from(JSON.stringify(missingGuards));
  const missingGuardsFooter = Buffer.from('{"version":2,"counts":{"sources":2,"records":3,"sourcePolicies":2,"tombstones":1,"suppressions":1,"deletionGuards":0},"sha256":"sha256:233061573cb9f4c11c179ce0e437aadabcede4818a3f9b80ccbd6bb14ac6da51"}');
  assert.equal(missingGuardsInput.byteLength, 4436);
  assert.equal(sha(missingGuardsInput), 'sha256:233061573cb9f4c11c179ce0e437aadabcede4818a3f9b80ccbd6bb14ac6da51');
  assert.throws(() => decodeOrdinaryHistory(missingGuardsInput, missingGuardsFooter, TYPED_CONTROL_OPTIONS), invalid);
  assert.throws(() => decodeOrdinaryHistory(Buffer.from([0xc3, 0x28]), footer, TYPED_CONTROL_OPTIONS), invalid);
  assert.throws(() => decodeOrdinaryHistory(input, Buffer.from([0xc3, 0x28]), TYPED_CONTROL_OPTIONS), invalid);
  assert.throws(() => decodeOrdinaryHistory(Buffer.alloc(16777217), footer, TYPED_CONTROL_OPTIONS), invalid);
  assert.throws(() => decodeOrdinaryHistory(input, Buffer.alloc(16777217), TYPED_CONTROL_OPTIONS), invalid);
  const huge = JSON.parse(TYPED_CONTROL_BYTES.baseInputJSON); huge.records[0].label = 'x'.repeat(16777217);
  assert.throws(() => encodeOrdinaryHistory(huge, TYPED_CONTROL_OPTIONS), invalid);
  assert.deepEqual(input, Buffer.from(TYPED_CONTROL_BYTES.baseInputJSON));
  assert.deepEqual(footer, Buffer.from(TYPED_CONTROL_BYTES.baseFooterJSON));
  const data = setup(t), before = data.inventory();
  assert.throws(() => preparePublication(data.approval, input, footer), invalid);
  assert.throws(() => preparePublication(data.approval, JSON.parse(TYPED_CONTROL_BYTES.baseInputJSON), JSON.parse(TYPED_CONTROL_BYTES.baseFooterJSON)), invalid);
  assert.throws(() => preparePublication({ ...data.approval }, input, footer), { status: 409, code: 'IMPORT_APPROVAL_REQUIRED' });
  assert.deepEqual(data.inventory(), before);
});


const SQL_CONTROL_BYTES = require('./helpers/ordinary-sql-controls-golden.cjs');
const SQL_CONTROL_CASES = JSON.parse(SQL_CONTROL_BYTES.casesJSON);
const SQL_CONTROL_LIMIT = JSON.parse(SQL_CONTROL_BYTES.limitSeedJSON);
const SQL_CONTROL_ESCAPE = JSON.parse(SQL_CONTROL_BYTES.escapedSeedJSON);
const storageInvalid = { status: 503, code: 'storage-unavailable' };
function controlRead(data, changes = {}) {
  return readPublication(data.dbFile, { initialPreparedToken: data.token,
    initialTypedControls: true, controlProfileVersion: 2, ...changes });
}
function writeControlRows(db, tombstones, guards) {
  const tomb = db.prepare('INSERT INTO health_tombstones VALUES (?,?,?,?,?,?)');
  for (const row of tombstones) tomb.run(row.tenant_id, row.source_store_id, row.record_type,
    row.native_record_id, row.stream_key, row.sequence);
  if (guards !== null) {
    const guard = db.prepare('INSERT INTO health_deletion_guards VALUES (?,?,?,?,?,?,?,?,?)');
    for (const row of guards) guard.run(row.tenant_id, row.source_store_id, row.record_type,
      row.native_record_id, row.source_deleted, row.user_suppressed,
      row.source_stream_key, row.source_sequence, row.footprint_json);
  }
}
function rowsForGuards(controls) {
  return controls.map(row => ({ tenant_id: row.identity[0], source_store_id: row.identity[1],
    record_type: row.identity[2], native_record_id: row.identity[3], source_deleted: row.sourceDeleted,
    user_suppressed: row.userSuppressed, source_stream_key: row.sourceStreamKey,
    source_sequence: row.sourceSequence, footprint_json: row.footprintJson }));
}
function rowsForTombs(controls) {
  return controls.map(row => ({ tenant_id: row.identity[0], source_store_id: row.identity[1],
    record_type: row.identity[2], native_record_id: row.identity[3],
    stream_key: row.sourceStreamKey, sequence: row.sourceSequence }));
}
function userGuardLimit(count = 10000) {
  return Array.from({ length: count }, (_, index) => ({
    identity: [SQL_CONTROL_LIMIT.tenant, SQL_CONTROL_LIMIT.source, 'StepsRecord',
      SQL_CONTROL_LIMIT.guardPrefix + String(index).padStart(5, '0')],
    sourceDeleted: 0, userSuppressed: 1, sourceStreamKey: null, sourceSequence: null, footprintJson: null }));
}
function sourceTombLimit(count = 10000) {
  return Array.from({ length: count }, (_, index) => ({
    identity: [SQL_CONTROL_LIMIT.tenant, SQL_CONTROL_LIMIT.source, 'WeightRecord',
      SQL_CONTROL_LIMIT.tombPrefix + String(index).padStart(5, '0')],
    sourceStreamKey: SQL_CONTROL_LIMIT.tombStream, sourceSequence: String(index + 1) }));
}
function escapedGuardInput() {
  const seed = SQL_CONTROL_ESCAPE, quoted = '"'.repeat(seed.keyQuotes);
  const key = JSON.stringify([seed.tenant, quoted, seed.source, quoted, seed.recordType, '3', quoted]);
  return Array.from({ length: seed.count }, (_, index) => ({
    identity: [seed.tenant, seed.source, seed.recordType, '"'.repeat(seed.idQuotes) + String(index).padStart(seed.width, '0')],
    sourceDeleted: 1, userSuppressed: 0, sourceStreamKey: key, sourceSequence: String(index + 1), footprintJson: null }));
}
function controlFixture(t, index = 0) {
  const data = setup(t), token = preparePublication(data.approval, clone(INVENTORY), envelope());
  publishPreparedPublication(token);
  const fixture = clone(SQL_CONTROL_CASES[index]), db = new DatabaseSync(data.dbFile);
  try {
    if (fixture.nativeSchemaVersion === 2) {
      const { markerV2, guardV2 } = require('../lib/health-connect/schema');
      db.exec(guardV2); db.exec('DROP TABLE health_schema_version'); db.exec(markerV2);
      db.exec('INSERT INTO health_schema_version VALUES (2)');
    }
    writeControlRows(db, fixture.actualSQLTombstoneRows, fixture.actualSQLGuardRows);
  } finally { db.close(); }
  return { ...data, token, fixture };
}
function healthyControlBytes(data) {
  const healthy = readPublication(data.dbFile, { initialPreparedToken: data.token, initialOrdinaryBytes: true });
  assert.deepEqual(healthy.inputBytes, Buffer.from(ORDINARY_BYTE_INPUT_JSON));
  assert.deepEqual(healthy.footerBytes, Buffer.from(ORDINARY_BYTE_FOOTER_JSON));
  const raw = JSON.parse(healthy.inputBytes).records;
  for (let index = 0; index < 3; index++) {
    assert.equal(raw[index].recordJson, INVENTORY.records[index].recordJson);
    assert.equal(Buffer.byteLength(raw[index].recordJson), [380, 357, 557][index]);
    assert.equal(sha(raw[index].recordJson), INVENTORY.records[index].expectedRecordDigest);
  }
  return healthy.publication;
}
function assertControlOutput(data, expected) {
  const output = controlRead(data);
  assert.deepEqual(output.controls, expected, 'the owned SQL snapshot must expose every declared typed control');
  assert.deepEqual(Object.keys(output).sort(), ['controls', 'publication']);
  return output;
}
function replaceControlFamilies(db, tombstones, guards) {
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM health_tombstones');
    if (guards !== null) db.exec('DELETE FROM health_deletion_guards');
    writeControlRows(db, rowsForTombs(tombstones), guards === null ? null : rowsForGuards(guards));
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

test('SQLCTRL01 returns owned typed SQL collisions in one coherent read-only snapshot', t => {
  const data = controlFixture(t), before = data.inventory(), authority = healthyControlBytes(data);
  const expected = data.fixture.independentExpectedControls;
  const first = assertControlOutput(data, expected);
  assert.deepEqual(first.publication, authority); assert.deepEqual(data.inventory(), before);
  const second = assertControlOutput(data, expected);
  assert.notStrictEqual(first.controls, second.controls);
  assert.notStrictEqual(first.controls.tombstones[0].identity, second.controls.tombstones[0].identity);
  if (!Object.isFrozen(first.controls.tombstones[0].identity)) first.controls.tombstones[0].identity[0] = 'local-invented-mutation';
  assert.deepEqual(second.controls, expected); assert.deepEqual(data.inventory(), before);
  const originalExec = DatabaseSync.prototype.exec, originalPrepare = DatabaseSync.prototype.prepare;
  const active = new Set(); let headerHandle, actualControlReads = 0;
  const execMock = t.mock.method(DatabaseSync.prototype, 'exec', function (sql, ...args) {
    const result = originalExec.call(this, sql, ...args);
    if (sql === 'BEGIN') active.add(this);
    if (sql === 'COMMIT' || sql === 'ROLLBACK') active.delete(this);
    return result;
  });
  const prepareMock = t.mock.method(DatabaseSync.prototype, 'prepare', function (sql, ...args) {
    if (sql === 'SELECT * FROM health_restore_publication') headerHandle = this;
    if (/FROM\s+(?:main\.)?"?health_(?:tombstones|deletion_guards)\b/i.test(sql) && !/^SELECT 1 FROM /i.test(sql)) {
      assert.strictEqual(this, headerHandle); assert.equal(active.has(this), true); actualControlReads++;
    }
    return originalPrepare.call(this, sql, ...args);
  });
  try { assertControlOutput(data, expected); assert.ok(actualControlReads >= 2); }
  finally { prepareMock.mock.restore(); execMock.mock.restore(); }
  assert.deepEqual(data.inventory(), before);
  const unicode = controlFixture(t, 3), unicodeControls = JSON.parse(SQL_CONTROL_BYTES.unicodeControlsJSON);
  const unicodeDb = new DatabaseSync(unicode.dbFile);
  try { replaceControlFamilies(unicodeDb, [], unicodeControls.deletionGuards.slice().reverse()); }
  finally { unicodeDb.close(); }
  const unicodeBefore = unicode.inventory(); assertControlOutput(unicode, unicodeControls);
  assert.deepEqual(unicode.inventory(), unicodeBefore);
  const coherent = controlFixture(t), writer = new DatabaseSync(coherent.dbFile);
  try { assert.equal(writer.prepare('PRAGMA journal_mode=WAL').get().journal_mode, 'wal'); }
  finally { writer.close(); }
  const coherentBefore = coherent.inventory(); let changedDuringSnapshot = false;
  const coherenceMock = t.mock.method(DatabaseSync.prototype, 'prepare', function (sql, ...args) {
    if (!changedDuringSnapshot && sql === 'SELECT * FROM health_restore_publication') {
      changedDuringSnapshot = true;
      const change = new DatabaseSync(coherent.dbFile);
      try {
        assert.equal(change.prepare('UPDATE health_deletion_guards SET user_suppressed=0 WHERE tenant_id=? AND source_store_id=? AND record_type=? AND native_record_id=?')
          .run(TENANT, ALPHA, 'WeightRecord', 'same-invented-id').changes, 1);
      } finally { change.close(); }
    }
    return originalPrepare.call(this, sql, ...args);
  });
  try { assertControlOutput(coherent, expected); assert.equal(changedDuringSnapshot, true); }
  finally { coherenceMock.mock.restore(); }
  const expectedAfter = clone(coherentBefore);
  expectedAfter.database.rows.health_deletion_guards = coherent.fixture.actualSQLGuardRows.map(row => {
    const copied = { ...row };
    if (copied.source_store_id === ALPHA && copied.record_type === 'WeightRecord') copied.user_suppressed = 0;
    return JSON.stringify(copied);
  }).sort();
  assert.deepEqual(coherent.inventory(), expectedAfter);
});

test('SQLCTRL02 preserves exact nullable footprints and source tombstones without synthesizing guards', t => {
  const data = controlFixture(t, 1), before = data.inventory(), authority = healthyControlBytes(data);
  const output = assertControlOutput(data, data.fixture.independentExpectedControls);
  assert.deepEqual(output.publication, authority);
  assert.equal(output.controls.deletionGuards[0].footprintJson, null);
  assert.equal(output.controls.deletionGuards[1].footprintJson, '{"kind":"instant","time":"2026-01-02T03:04:05.123456789Z","zoneOffset":"+11:00:37"}');
  assert.equal(output.controls.deletionGuards.some(row => row.identity[1] === BETA), false);
  assert.equal(output.controls.tombstones[1].identity[1], BETA); assert.deepEqual(data.inventory(), before);
});

test('SQLCTRL03 extracts genuine native-v1 tombstones and accepts the declared 10000 tombstone boundary', t => {
  const data = controlFixture(t, 2), before = data.inventory(), authority = healthyControlBytes(data);
  const output = assertControlOutput(data, data.fixture.independentExpectedControls);
  assert.deepEqual(output.publication, authority); assert.deepEqual(data.inventory(), before);
  const expected = { tombstones: sourceTombLimit(), deletionGuards: [] }, db = new DatabaseSync(data.dbFile);
  try { replaceControlFamilies(db, expected.tombstones, null); } finally { db.close(); }
  assert.equal(Buffer.byteLength(JSON.stringify(expected)), 4138930);
  assert.equal(sha(JSON.stringify(expected)), 'sha256:86da0f928ba8ec48ab28ecf547ad61b7d6417b749f228c3038cde5b0bf15e6a7');
  const boundaryBefore = data.inventory(); assertControlOutput(data, expected); assert.deepEqual(data.inventory(), boundaryBefore);
});

test('SQLCTRL04 distinguishes present empty native-v2 families and accepts the declared 10000 guard boundary', t => {
  const data = controlFixture(t, 3), before = data.inventory(), authority = healthyControlBytes(data);
  const output = assertControlOutput(data, data.fixture.independentExpectedControls);
  assert.deepEqual(output.publication, authority); assert.deepEqual(data.inventory(), before);
  const expected = { tombstones: [], deletionGuards: userGuardLimit() }, db = new DatabaseSync(data.dbFile);
  try { replaceControlFamilies(db, [], expected.deletionGuards); } finally { db.close(); }
  assert.equal(Buffer.byteLength(JSON.stringify(expected)), 2370036);
  assert.equal(sha(JSON.stringify(expected)), 'sha256:a305e79567169ff616ce26245fff762485498aae3c52834d93571dda88f92ecf');
  const boundaryBefore = data.inventory(); assertControlOutput(data, expected); assert.deepEqual(data.inventory(), boundaryBefore);
});

test('SQLCTRL05 refuses all 17 independently declared SQL data faults without mutating the selected snapshot', t => {
  const faults = [
    ['missing required v2 guard table', db => db.exec('DROP TABLE health_deletion_guards')],
    ['guard view substitution', db => { db.exec('DROP TABLE health_deletion_guards'); db.exec('CREATE VIEW health_deletion_guards AS SELECT 1 AS incompatible'); }],
    ['foreign tenant', db => db.prepare('UPDATE health_tombstones SET tenant_id=?,stream_key=replace(stream_key,?,?) WHERE source_store_id=?')
      .run('55555555-5555-4555-8555-555555555555', TENANT, '55555555-5555-4555-8555-555555555555', ALPHA)],
    ['unowned source', db => db.prepare('UPDATE health_tombstones SET source_store_id=?,stream_key=replace(stream_key,?,?) WHERE source_store_id=?')
      .run('cccccccc-cccc-4ccc-8ccc-cccccccccccc', ALPHA, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', ALPHA)],
    ['invalid identity', db => db.exec("UPDATE health_tombstones SET native_record_id='' WHERE source_store_id='" + ALPHA + "'")],
    ['identity/provenance mismatch', db => db.prepare('UPDATE health_tombstones SET stream_key=replace(stream_key,?,?) WHERE source_store_id=?').run('WeightRecord', 'StepsRecord', ALPHA)],
    ['noncanonical stream key', db => db.exec("UPDATE health_tombstones SET stream_key=' '||stream_key")],
    ['invalid source sequence', db => db.exec("UPDATE health_tombstones SET sequence='07'")],
    ['source flag without provenance', db => { db.exec('PRAGMA ignore_check_constraints=ON'); db.exec('UPDATE health_deletion_guards SET source_sequence=NULL WHERE source_deleted=1'); }],
    ['user-only carries source provenance', db => { db.exec('PRAGMA ignore_check_constraints=ON'); db.prepare('UPDATE health_deletion_guards SET source_stream_key=? WHERE source_deleted=0').run('invented-unsupported-key'); }],
    ['invalid stored flags', db => { db.exec('PRAGMA ignore_check_constraints=ON'); db.exec('UPDATE health_deletion_guards SET source_deleted=2 WHERE source_deleted=1'); }],
    ['invalid footprint grammar', db => db.exec("UPDATE health_deletion_guards SET footprint_json='{}'")],
    ['conflicting source provenance', db => db.exec("UPDATE health_deletion_guards SET source_sequence='8' WHERE source_sequence='7'")],
    ['guard count 10001', db => replaceControlFamilies(db, [], userGuardLimit(10001))],
    ['escaped fragment over 16MiB', db => {
      const guards = escapedGuardInput(), fragment = JSON.stringify({ tombstones: [], deletionGuards: guards });
      assert.equal(Buffer.byteLength(fragment), 17602929); assert.equal(sha(fragment), 'sha256:9d584f30ac4b1995c16cf7252235efe1155579f84373d9c13431968ac522e97b');
      const storedTextBytes = guards.reduce((sum, row) => sum + row.identity.reduce((n, field) => n + Buffer.byteLength(field), 0)
        + Buffer.byteLength(row.sourceStreamKey) + Buffer.byteLength(row.sourceSequence), 0);
      assert.equal(storedTextBytes, 8935893); assert.ok(storedTextBytes < 16777216);
      replaceControlFamilies(db, [], guards);
    }],
    ['stored metadata digest before parse', db => db.prepare('UPDATE health_restore_publication SET metadata_json=?').run('{')],
    ['same-byte-length raw corruption', db => {
      const changed = INVENTORY.records[0].recordJson.replace('43.125', '43.126');
      assert.equal(Buffer.byteLength(changed), 380); assert.equal(sha(changed), 'sha256:44fdc668a9f033c60c708d74f15d51e39ac2a2927de165edeb259f27b39ff920');
      db.prepare('UPDATE health_records SET record_json=? WHERE tenant_id=? AND source_store_id=? AND record_type=? AND native_record_id=?').run(changed, ...INVENTORY.records[0].identity);
    }],
  ];
  const variants = [
    ['empty native identity', faults[4][1]],
    ['invalid native type', db => db.prepare('UPDATE health_tombstones SET record_type=?,stream_key=replace(stream_key,?,?) WHERE source_store_id=?').run('weight record', 'WeightRecord', 'weight record', ALPHA)],
    ['zero sequence', db => db.exec("UPDATE health_tombstones SET sequence='0'")],
    ['overflow sequence', db => db.exec("UPDATE health_tombstones SET sequence='9223372036854775808'")],
    ['nonstring stored sequence', db => db.prepare('UPDATE health_tombstones SET sequence=?').run(Buffer.from('7'))],
    ['both guard flags zero', db => { db.exec('PRAGMA ignore_check_constraints=ON'); db.exec('UPDATE health_deletion_guards SET user_suppressed=0 WHERE source_deleted=0'); }],
    ['nonnull footprint overbound', db => { db.exec('PRAGMA ignore_check_constraints=ON'); db.prepare('UPDATE health_deletion_guards SET footprint_json=?').run(' '.repeat(2049) + '{"kind":"instant","time":"2026-01-02T03:04:05Z","zoneOffset":null}'); }],
    ['tombstone count 10001', db => replaceControlFamilies(db, sourceTombLimit(10001), [])],
  ];
  assert.equal(faults.length, 17);
  for (const [name, mutate] of [...faults, ...variants]) {
    const data = controlFixture(t); healthyControlBytes(data);
    const db = new DatabaseSync(data.dbFile);
    try { mutate(db); } finally { db.close(); }
    const before = data.inventory(); let badMetadataParses = 0, parseMock;
    if (name === 'stored metadata digest before parse') {
      const originalParse = JSON.parse;
      parseMock = t.mock.method(JSON, 'parse', function (text, ...args) {
        if (text === '{') badMetadataParses++;
        return originalParse.call(this, text, ...args);
      });
    }
    try { assert.throws(() => controlRead(data), storageInvalid, name); }
    finally { parseMock?.mock.restore(); }
    if (name === 'stored metadata digest before parse') assert.equal(badMetadataParses, 0);
    assert.deepEqual(data.inventory(), before, name);
  }
});

test('SQLCTRL06 preserves owner precedence before filesystem access and rechecks ownership during the snapshot', t => {
  const data = controlFixture(t), other = controlFixture(t), before = data.inventory(), otherBefore = other.inventory();
  healthyControlBytes(data);
  const originalLstat = fs.lstatSync; let filesystemReads = 0;
  const lstatMock = t.mock.method(fs, 'lstatSync', function (...args) {
    filesystemReads++; return originalLstat.apply(this, args);
  });
  try {
    assert.throws(() => readPublication(data.dbFile, { initialPreparedToken: { ...data.token }, initialTypedControls: true, controlProfileVersion: 2 }), { status: 409, code: 'IMPORT_APPROVAL_REQUIRED' });
    assert.equal(filesystemReads, 0);
    assert.throws(() => readPublication(other.dbFile, { initialPreparedToken: data.token, initialTypedControls: true, controlProfileVersion: 2 }), { status: 409, code: 'IMPORT_APPROVAL_REQUIRED' });
    assert.equal(filesystemReads, 0); data.setOwner('synthetic-other-owner');
    assert.throws(() => controlRead(data, { controlProfileVersion: '2' }), { status: 403, code: 'IMPORT_OWNER_MISMATCH' });
    assert.equal(filesystemReads, 0); data.setOwner(OWNER);
    assert.throws(() => readPublication(data.dbFile, { initialTypedControls: true, controlProfileVersion: 2 }), { status: 409, code: 'IMPORT_APPROVAL_REQUIRED' });
    assert.equal(filesystemReads, 0);
  } finally { lstatMock.mock.restore(); data.setOwner(OWNER); }
  const originalExec = DatabaseSync.prototype.exec; let changedInsideSnapshot = false;
  const execMock = t.mock.method(DatabaseSync.prototype, 'exec', function (sql, ...args) {
    const result = originalExec.call(this, sql, ...args);
    if (sql === 'BEGIN') { changedInsideSnapshot = true; data.setOwner('synthetic-other-owner'); }
    return result;
  });
  try { assert.throws(() => controlRead(data), { status: 403, code: 'IMPORT_OWNER_MISMATCH' }); assert.equal(changedInsideSnapshot, true); }
  finally { execMock.mock.restore(); data.setOwner(OWNER); }
  assert.deepEqual(data.inventory(), before); assert.deepEqual(other.inventory(), otherBefore);
});

test('SQLCTRL07 rejects incompatible literal modes before SQL and preserves every non-true default mode', t => {
  const data = controlFixture(t), before = data.inventory(), authority = healthyControlBytes(data);
  const originalLstat = fs.lstatSync; let filesystemReads = 0;
  const lstatMock = t.mock.method(fs, 'lstatSync', function (...args) {
    filesystemReads++; return originalLstat.apply(this, args);
  });
  try {
    for (const version of [undefined, null, false, true, 0, 1, '2', {}]) {
      assert.throws(() => controlRead(data, { controlProfileVersion: version }), invalid);
      assert.equal(filesystemReads, 0);
    }
    assert.throws(() => controlRead(data, { initialOrdinaryBytes: true }), invalid);
    assert.equal(filesystemReads, 0);
  } finally { lstatMock.mock.restore(); }
  for (const flag of [undefined, null, false, 0, 1, 'true', {}]) {
    assert.deepEqual(readPublication(data.dbFile, { initialPreparedToken: data.token, initialTypedControls: flag, controlProfileVersion: 2 }), authority);
    const ordinary = readPublication(data.dbFile, { initialPreparedToken: data.token, initialTypedControls: flag, controlProfileVersion: 2, initialOrdinaryBytes: true });
    assert.deepEqual(ordinary.publication, authority);
    assert.deepEqual(ordinary.inputBytes, Buffer.from(ORDINARY_BYTE_INPUT_JSON)); assert.deepEqual(ordinary.footerBytes, Buffer.from(ORDINARY_BYTE_FOOTER_JSON));
  }
  assert.deepEqual(readPublication(data.dbFile), authority); assert.deepEqual(data.inventory(), before);
});


const SQL_TEXT_FIXED = JSON.parse("{\"malformedNativeHex\":\"696E76656E7465642D6E61746976652DC328\",\"malformedStreamHex\":\"5B2231313131313131312D313131312D343131312D383131312D313131313131313131313131222C22696E76656E7465642D696E7374616E63652DC328222C2261616161616161612D616161612D346161612D386161612D616161616161616161616161222C2233333333333333332D333333332D343333332D383333332D333333333333333333333333222C225765696768745265636F7264222C2233222C2234343434343434342D343434342D343434342D383434342D343434343434343434343434225D\",\"positiveStreamKey\":\"[\\\"11111111-1111-4111-8111-111111111111\\\",\\\"invented-instance-\\ue000\\ud800\\udc00\\\",\\\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\\\",\\\"33333333-3333-4333-8333-333333333333\\\",\\\"WeightRecord\\\",\\\"3\\\",\\\"44444444-4444-4444-8444-444444444444\\\"]\",\"unicodeGuards\":[{\"identity\":[\"11111111-1111-4111-8111-111111111111\",\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\",\"StepsRecord\",\"\\ue000\"],\"sourceDeleted\":0,\"userSuppressed\":1,\"sourceStreamKey\":null,\"sourceSequence\":null,\"footprintJson\":null},{\"identity\":[\"11111111-1111-4111-8111-111111111111\",\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\",\"StepsRecord\",\"\\ud800\\udc00\"],\"sourceDeleted\":0,\"userSuppressed\":1,\"sourceStreamKey\":null,\"sourceSequence\":null,\"footprintJson\":null}],\"positiveControls\":{\"tombstones\":[{\"identity\":[\"11111111-1111-4111-8111-111111111111\",\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\",\"WeightRecord\",\"same-invented-id\"],\"sourceStreamKey\":\"[\\\"11111111-1111-4111-8111-111111111111\\\",\\\"invented-instance-\\ue000\\ud800\\udc00\\\",\\\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\\\",\\\"33333333-3333-4333-8333-333333333333\\\",\\\"WeightRecord\\\",\\\"3\\\",\\\"44444444-4444-4444-8444-444444444444\\\"]\",\"sourceSequence\":\"7\"},{\"identity\":[\"11111111-1111-4111-8111-111111111111\",\"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb\",\"WeightRecord\",\"same-invented-id\"],\"sourceStreamKey\":\"[\\\"11111111-1111-4111-8111-111111111111\\\",\\\"22222222-2222-4222-8222-222222222222\\\",\\\"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb\\\",\\\"33333333-3333-4333-8333-333333333333\\\",\\\"WeightRecord\\\",\\\"3\\\",\\\"44444444-4444-4444-8444-444444444444\\\"]\",\"sourceSequence\":\"9\"}],\"deletionGuards\":[{\"identity\":[\"11111111-1111-4111-8111-111111111111\",\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\",\"StepsRecord\",\"same-invented-id\"],\"sourceDeleted\":0,\"userSuppressed\":1,\"sourceStreamKey\":null,\"sourceSequence\":null,\"footprintJson\":null},{\"identity\":[\"11111111-1111-4111-8111-111111111111\",\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\",\"StepsRecord\",\"\\ue000\"],\"sourceDeleted\":0,\"userSuppressed\":1,\"sourceStreamKey\":null,\"sourceSequence\":null,\"footprintJson\":null},{\"identity\":[\"11111111-1111-4111-8111-111111111111\",\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\",\"StepsRecord\",\"\\ud800\\udc00\"],\"sourceDeleted\":0,\"userSuppressed\":1,\"sourceStreamKey\":null,\"sourceSequence\":null,\"footprintJson\":null},{\"identity\":[\"11111111-1111-4111-8111-111111111111\",\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\",\"WeightRecord\",\"same-invented-id\"],\"sourceDeleted\":1,\"userSuppressed\":1,\"sourceStreamKey\":\"[\\\"11111111-1111-4111-8111-111111111111\\\",\\\"invented-instance-\\ue000\\ud800\\udc00\\\",\\\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\\\",\\\"33333333-3333-4333-8333-333333333333\\\",\\\"WeightRecord\\\",\\\"3\\\",\\\"44444444-4444-4444-8444-444444444444\\\"]\",\"sourceSequence\":\"7\",\"footprintJson\":null},{\"identity\":[\"11111111-1111-4111-8111-111111111111\",\"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb\",\"WeightRecord\",\"same-invented-id\"],\"sourceDeleted\":1,\"userSuppressed\":0,\"sourceStreamKey\":\"[\\\"11111111-1111-4111-8111-111111111111\\\",\\\"22222222-2222-4222-8222-222222222222\\\",\\\"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb\\\",\\\"33333333-3333-4333-8333-333333333333\\\",\\\"WeightRecord\\\",\\\"3\\\",\\\"44444444-4444-4444-8444-444444444444\\\"]\",\"sourceSequence\":\"9\",\"footprintJson\":null}]},\"encodingWitnesses\":[{\"encoding\":\"UTF-16le\",\"unicodeNativeIDHex\":[\"00E0\",\"00D800DC\"],\"positiveStreamHex\":\"5B002200310031003100310031003100310031002D0031003100310031002D0034003100310031002D0038003100310031002D0031003100310031003100310031003100310031003100310022002C00220069006E00760065006E007400650064002D0069006E007300740061006E00630065002D0000E000D800DC22002C002200610061006100610061006100610061002D0061006100610061002D0034006100610061002D0038006100610061002D0061006100610061006100610061006100610061006100610022002C002200330033003300330033003300330033002D0033003300330033002D0034003300330033002D0038003300330033002D0033003300330033003300330033003300330033003300330022002C0022005700650069006700680074005200650063006F007200640022002C002200330022002C002200340034003400340034003400340034002D0034003400340034002D0034003400340034002D0038003400340034002D0034003400340034003400340034003400340034003400340022005D00\"},{\"encoding\":\"UTF-16be\",\"unicodeNativeIDHex\":[\"E000\",\"D800DC00\"],\"positiveStreamHex\":\"005B002200310031003100310031003100310031002D0031003100310031002D0034003100310031002D0038003100310031002D0031003100310031003100310031003100310031003100310022002C00220069006E00760065006E007400650064002D0069006E007300740061006E00630065002DE000D800DC000022002C002200610061006100610061006100610061002D0061006100610061002D0034006100610061002D0038006100610061002D0061006100610061006100610061006100610061006100610022002C002200330033003300330033003300330033002D0033003300330033002D0034003300330033002D0038003300330033002D0033003300330033003300330033003300330033003300330022002C0022005700650069006700680074005200650063006F007200640022002C002200330022002C002200340034003400340034003400340034002D0034003400340034002D0034003400340034002D0038003400340034002D0034003400340034003400340034003400340034003400340022005D\"}]}");

function controlTextWitness(dbFile) {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const encoding = db.prepare('PRAGMA encoding').get().encoding;
    const tomb = db.prepare('SELECT typeof(native_record_id) AS nativeType, hex(CAST(native_record_id AS BLOB)) AS nativeHex, '
      + 'typeof(stream_key) AS keyType, hex(CAST(stream_key AS BLOB)) AS keyHex FROM health_tombstones '
      + 'WHERE tenant_id=? AND source_store_id=? AND record_type=?').get(TENANT, ALPHA, 'WeightRecord');
    const guard = db.prepare('SELECT typeof(source_stream_key) AS keyType, hex(CAST(source_stream_key AS BLOB)) AS keyHex '
      + 'FROM health_deletion_guards WHERE tenant_id=? AND source_store_id=? AND record_type=?')
      .get(TENANT, ALPHA, 'WeightRecord');
    return { encoding, tomb, guard };
  } finally { db.close(); }
}

test('SQLTEXT01 rejects malformed stored TEXT before native identity or historical stream validation', t => {
  for (const kind of ['native identity', 'opaque historical stream component']) {
    const data = controlFixture(t); healthyControlBytes(data);
    const db = new DatabaseSync(data.dbFile);
    try {
      assert.equal(db.prepare('PRAGMA encoding').get().encoding, 'UTF-8');
      if (kind === 'native identity') {
        assert.equal(db.prepare('UPDATE health_tombstones SET native_record_id=CAST(? AS TEXT) '
          + 'WHERE tenant_id=? AND source_store_id=? AND record_type=? AND native_record_id=?')
          .run(Buffer.from(SQL_TEXT_FIXED.malformedNativeHex, 'hex'), TENANT, ALPHA, 'WeightRecord', 'same-invented-id').changes, 1);
      } else {
        const bytes = Buffer.from(SQL_TEXT_FIXED.malformedStreamHex, 'hex');
        assert.equal(db.prepare('UPDATE health_tombstones SET stream_key=CAST(? AS TEXT) '
          + 'WHERE tenant_id=? AND source_store_id=? AND record_type=? AND native_record_id=?')
          .run(bytes, TENANT, ALPHA, 'WeightRecord', 'same-invented-id').changes, 1);
        assert.equal(db.prepare('UPDATE health_deletion_guards SET source_stream_key=CAST(? AS TEXT) '
          + 'WHERE tenant_id=? AND source_store_id=? AND record_type=? AND native_record_id=?')
          .run(bytes, TENANT, ALPHA, 'WeightRecord', 'same-invented-id').changes, 1);
      }
    } finally { db.close(); }
    const stored = controlTextWitness(data.dbFile), before = data.inventory();
    assert.equal(stored.encoding, 'UTF-8'); assert.equal(stored.tomb.nativeType, 'text');
    assert.equal(stored.tomb.keyType, 'text'); assert.equal(stored.guard.keyType, 'text');
    if (kind === 'native identity') assert.equal(stored.tomb.nativeHex, SQL_TEXT_FIXED.malformedNativeHex);
    else {
      assert.equal(stored.tomb.keyHex, SQL_TEXT_FIXED.malformedStreamHex);
      assert.equal(stored.guard.keyHex, SQL_TEXT_FIXED.malformedStreamHex);
    }
    assert.throws(() => controlRead(data), storageInvalid, kind);
    assert.deepEqual(controlTextWitness(data.dbFile), stored); assert.deepEqual(data.inventory(), before);
  }
});

test('SQLTEXT02 preserves valid UTF-16 native database controls as exact UTF-8 output', t => {
  const originalExec = DatabaseSync.prototype.exec;
  for (const witness of SQL_TEXT_FIXED.encodingWitnesses) {
    let initialized = false, data;
    const encodingMock = t.mock.method(DatabaseSync.prototype, 'exec', function (sql, ...args) {
      if (!initialized && sql === 'CREATE TABLE sentinel (id INTEGER PRIMARY KEY, value TEXT NOT NULL)') {
        originalExec.call(this, "PRAGMA encoding='" + witness.encoding + "'"); initialized = true;
      }
      return originalExec.call(this, sql, ...args);
    });
    try { data = controlFixture(t); } finally { encodingMock.mock.restore(); }
    assert.equal(initialized, true);
    const db = new DatabaseSync(data.dbFile);
    try {
      assert.equal(db.prepare('PRAGMA encoding').get().encoding, witness.encoding);
      assert.equal(db.prepare('UPDATE health_tombstones SET stream_key=? '
        + 'WHERE tenant_id=? AND source_store_id=? AND record_type=? AND native_record_id=?')
        .run(SQL_TEXT_FIXED.positiveStreamKey, TENANT, ALPHA, 'WeightRecord', 'same-invented-id').changes, 1);
      assert.equal(db.prepare('UPDATE health_deletion_guards SET source_stream_key=? '
        + 'WHERE tenant_id=? AND source_store_id=? AND record_type=? AND native_record_id=?')
        .run(SQL_TEXT_FIXED.positiveStreamKey, TENANT, ALPHA, 'WeightRecord', 'same-invented-id').changes, 1);
      writeControlRows(db, [], rowsForGuards(SQL_TEXT_FIXED.unicodeGuards));
      for (let index = 0; index < SQL_TEXT_FIXED.unicodeGuards.length; index++) {
        const identity = SQL_TEXT_FIXED.unicodeGuards[index].identity;
        const row = db.prepare('SELECT typeof(native_record_id) AS storageType, hex(CAST(native_record_id AS BLOB)) AS storageHex '
          + 'FROM health_deletion_guards WHERE tenant_id=? AND source_store_id=? AND record_type=? AND native_record_id=?')
          .get(...identity);
        assert.equal(row.storageType, 'text'); assert.equal(row.storageHex, witness.unicodeNativeIDHex[index]);
      }
    } finally { db.close(); }
    const authority = healthyControlBytes(data), before = data.inventory(), stored = controlTextWitness(data.dbFile);
    assert.equal(stored.encoding, witness.encoding); assert.equal(stored.tomb.keyType, 'text');
    assert.equal(stored.guard.keyType, 'text'); assert.equal(stored.tomb.keyHex, witness.positiveStreamHex);
    assert.equal(stored.guard.keyHex, witness.positiveStreamHex);
    const output = assertControlOutput(data, SQL_TEXT_FIXED.positiveControls);
    assert.deepEqual(output.publication, authority); assert.deepEqual(data.inventory(), before);
    assert.deepEqual(controlTextWitness(data.dbFile), stored);
  }
});


const SQL_TEXT_ALIASES = JSON.parse("[{\"kind\":\"metadata\",\"inputJSON\":\"{\\\"catalog\\\":{\\\"version\\\":1,\\\"logicalTenantId\\\":\\\"11111111-1111-4111-8111-111111111111\\\",\\\"sources\\\":[{\\\"sourceStoreId\\\":\\\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\\\",\\\"provider\\\":\\\"health-connect-native\\\",\\\"policyRef\\\":\\\"r0-policy-alpha\\\"},{\\\"sourceStoreId\\\":\\\"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb\\\",\\\"provider\\\":\\\"health-connect-native\\\",\\\"policyRef\\\":\\\"r0-policy-beta\\\"}]},\\\"records\\\":[{\\\"label\\\":\\\"invented-meta-\\ufffd(\\\",\\\"identity\\\":[\\\"11111111-1111-4111-8111-111111111111\\\",\\\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\\\",\\\"BodyWaterMassRecord\\\",\\\"r0-shared-id\\\"],\\\"recordJson\\\":\\\"{\\\\\\\"time\\\\\\\":\\\\\\\"2026-01-02T03:04:05.123456789Z\\\\\\\",\\\\\\\"zoneOffset\\\\\\\":\\\\\\\"+11:00\\\\\\\",\\\\\\\"mass\\\\\\\":{\\\\\\\"value\\\\\\\":\\\\\\\"43.125\\\\\\\",\\\\\\\"unit\\\\\\\":\\\\\\\"kg\\\\\\\"},\\\\\\\"metadata\\\\\\\":{\\\\\\\"id\\\\\\\":\\\\\\\"r0-shared-id\\\\\\\",\\\\\\\"dataOrigin\\\\\\\":{\\\\\\\"packageName\\\\\\\":\\\\\\\"example.synthetic.alpha\\\\\\\"},\\\\\\\"device\\\\\\\":{\\\\\\\"manufacturer\\\\\\\":\\\\\\\"Synthetic\\\\\\\",\\\\\\\"model\\\\\\\":\\\\\\\"Fixture Alpha\\\\\\\",\\\\\\\"type\\\\\\\":0},\\\\\\\"lastModifiedTime\\\\\\\":\\\\\\\"2026-01-02T03:05:00.000000001Z\\\\\\\",\\\\\\\"clientRecordId\\\\\\\":null,\\\\\\\"clientRecordVersion\\\\\\\":\\\\\\\"2\\\\\\\",\\\\\\\"recordingMethod\\\\\\\":3}}\\\",\\\"nativeKeyJson\\\":\\\"[\\\\\\\"11111111-1111-4111-8111-111111111111\\\\\\\",\\\\\\\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\\\\\\\",\\\\\\\"BodyWaterMassRecord\\\\\\\",\\\\\\\"r0-shared-id\\\\\\\"]\\\",\\\"serializerId\\\":\\\"health-connect-record\\\",\\\"serializerVersion\\\":1,\\\"dataFamily\\\":\\\"ordinary\\\",\\\"projection\\\":\\\"raw-only\\\",\\\"expectedUtf8Bytes\\\":380,\\\"expectedRecordDigest\\\":\\\"sha256:e58adccfff037a420d6634ece28e51cc544f306871f45a7238c6e2e87a28cc3f\\\"},{\\\"label\\\":\\\"beta-body-water\\\",\\\"identity\\\":[\\\"11111111-1111-4111-8111-111111111111\\\",\\\"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb\\\",\\\"BodyWaterMassRecord\\\",\\\"r0-shared-id\\\"],\\\"recordJson\\\":\\\"{\\\\\\\"time\\\\\\\":\\\\\\\"2026-01-02T03:04:05.123456789Z\\\\\\\",\\\\\\\"zoneOffset\\\\\\\":null,\\\\\\\"mass\\\\\\\":{\\\\\\\"value\\\\\\\":\\\\\\\"43.125\\\\\\\",\\\\\\\"unit\\\\\\\":\\\\\\\"kg\\\\\\\"},\\\\\\\"metadata\\\\\\\":{\\\\\\\"id\\\\\\\":\\\\\\\"r0-shared-id\\\\\\\",\\\\\\\"dataOrigin\\\\\\\":{\\\\\\\"packageName\\\\\\\":\\\\\\\"example.synthetic.beta\\\\\\\"},\\\\\\\"device\\\\\\\":{\\\\\\\"manufacturer\\\\\\\":null,\\\\\\\"model\\\\\\\":null,\\\\\\\"type\\\\\\\":0},\\\\\\\"lastModifiedTime\\\\\\\":\\\\\\\"2026-01-02T03:05:00.000000002Z\\\\\\\",\\\\\\\"clientRecordId\\\\\\\":null,\\\\\\\"clientRecordVersion\\\\\\\":\\\\\\\"1\\\\\\\",\\\\\\\"recordingMethod\\\\\\\":0}}\\\",\\\"nativeKeyJson\\\":\\\"[\\\\\\\"11111111-1111-4111-8111-111111111111\\\\\\\",\\\\\\\"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb\\\\\\\",\\\\\\\"BodyWaterMassRecord\\\\\\\",\\\\\\\"r0-shared-id\\\\\\\"]\\\",\\\"serializerId\\\":\\\"health-connect-record\\\",\\\"serializerVersion\\\":1,\\\"dataFamily\\\":\\\"ordinary\\\",\\\"projection\\\":\\\"raw-only\\\",\\\"expectedUtf8Bytes\\\":357,\\\"expectedRecordDigest\\\":\\\"sha256:c75f9ec48ec178af6f10bfa22907417e79b0e45bb4cd4ac00e50b16a248d41e1\\\"},{\\\"label\\\":\\\"alpha-cycling-cadence\\\",\\\"identity\\\":[\\\"11111111-1111-4111-8111-111111111111\\\",\\\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\\\",\\\"CyclingPedalingCadenceRecord\\\",\\\"r0-shared-id\\\"],\\\"recordJson\\\":\\\"{\\\\\\\"startTime\\\\\\\":\\\\\\\"2026-01-02T03:00:00Z\\\\\\\",\\\\\\\"endTime\\\\\\\":\\\\\\\"2026-01-02T03:10:00Z\\\\\\\",\\\\\\\"startZoneOffset\\\\\\\":\\\\\\\"+11:00\\\\\\\",\\\\\\\"endZoneOffset\\\\\\\":\\\\\\\"+11:00\\\\\\\",\\\\\\\"samples\\\\\\\":[{\\\\\\\"time\\\\\\\":\\\\\\\"2026-01-02T03:01:00.000000001Z\\\\\\\",\\\\\\\"revolutionsPerMinute\\\\\\\":\\\\\\\"62.5\\\\\\\"},{\\\\\\\"time\\\\\\\":\\\\\\\"2026-01-02T03:05:00.000000002Z\\\\\\\",\\\\\\\"revolutionsPerMinute\\\\\\\":\\\\\\\"91.25\\\\\\\"}],\\\\\\\"metadata\\\\\\\":{\\\\\\\"id\\\\\\\":\\\\\\\"r0-shared-id\\\\\\\",\\\\\\\"dataOrigin\\\\\\\":{\\\\\\\"packageName\\\\\\\":\\\\\\\"example.synthetic.alpha\\\\\\\"},\\\\\\\"device\\\\\\\":{\\\\\\\"manufacturer\\\\\\\":\\\\\\\"Synthetic\\\\\\\",\\\\\\\"model\\\\\\\":\\\\\\\"Fixture Alpha\\\\\\\",\\\\\\\"type\\\\\\\":0},\\\\\\\"lastModifiedTime\\\\\\\":\\\\\\\"2026-01-02T03:11:00.000000001Z\\\\\\\",\\\\\\\"clientRecordId\\\\\\\":null,\\\\\\\"clientRecordVersion\\\\\\\":\\\\\\\"1\\\\\\\",\\\\\\\"recordingMethod\\\\\\\":3}}\\\",\\\"nativeKeyJson\\\":\\\"[\\\\\\\"11111111-1111-4111-8111-111111111111\\\\\\\",\\\\\\\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\\\\\\\",\\\\\\\"CyclingPedalingCadenceRecord\\\\\\\",\\\\\\\"r0-shared-id\\\\\\\"]\\\",\\\"serializerId\\\":\\\"health-connect-record\\\",\\\"serializerVersion\\\":1,\\\"dataFamily\\\":\\\"ordinary\\\",\\\"projection\\\":\\\"raw-only\\\",\\\"expectedUtf8Bytes\\\":557,\\\"expectedRecordDigest\\\":\\\"sha256:87bc00ed3b441a2c5626223c2fe28019086bf28a799bdd0594bd284bec6eeec2\\\"}],\\\"sourcePolicies\\\":[{\\\"id\\\":\\\"r0-policy-alpha\\\",\\\"sourceStoreId\\\":\\\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\\\",\\\"sharing\\\":\\\"stopped\\\",\\\"retainCommittedHistory\\\":true,\\\"priorGenerationProvenance\\\":\\\"7\\\"},{\\\"id\\\":\\\"r0-policy-beta\\\",\\\"sourceStoreId\\\":\\\"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb\\\",\\\"sharing\\\":\\\"enabled\\\",\\\"retainCommittedHistory\\\":true,\\\"priorGenerationProvenance\\\":\\\"3\\\"}],\\\"tombstones\\\":[{\\\"tenantId\\\":\\\"11111111-1111-4111-8111-111111111111\\\",\\\"sourceStoreId\\\":\\\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\\\",\\\"nativeRecordId\\\":\\\"r0-deleted-known\\\",\\\"knownType\\\":\\\"StepsRecord\\\",\\\"reason\\\":\\\"source-delete\\\"},{\\\"tenantId\\\":\\\"11111111-1111-4111-8111-111111111111\\\",\\\"sourceStoreId\\\":\\\"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb\\\",\\\"nativeRecordId\\\":\\\"r0-deleted-unknown\\\",\\\"knownType\\\":null,\\\"reason\\\":\\\"source-delete\\\"}],\\\"suppressions\\\":[{\\\"sourceStoreId\\\":\\\"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb\\\",\\\"type\\\":\\\"WeightRecord\\\",\\\"startInclusive\\\":\\\"2025-12-01T00:00:00Z\\\",\\\"endExclusive\\\":\\\"2026-01-01T00:00:00Z\\\",\\\"explicitReimportAllowed\\\":false}]}\",\"inputUtf8Bytes\":4421,\"footerJSON\":\"{\\\"version\\\":1,\\\"counts\\\":{\\\"sources\\\":2,\\\"records\\\":3,\\\"sourcePolicies\\\":2,\\\"tombstones\\\":2,\\\"suppressions\\\":1},\\\"sha256\\\":\\\"sha256:110ae0318744388709023dd227827754c4d2d5df1fd455a4dd492999fc2285e7\\\"}\",\"footerUtf8Bytes\":182,\"metadataJSON\":\"{\\\"catalog\\\":{\\\"version\\\":1,\\\"logicalTenantId\\\":\\\"11111111-1111-4111-8111-111111111111\\\",\\\"sources\\\":[{\\\"sourceStoreId\\\":\\\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\\\",\\\"provider\\\":\\\"health-connect-native\\\",\\\"policyRef\\\":\\\"r0-policy-alpha\\\"},{\\\"sourceStoreId\\\":\\\"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb\\\",\\\"provider\\\":\\\"health-connect-native\\\",\\\"policyRef\\\":\\\"r0-policy-beta\\\"}]},\\\"recordDescriptors\\\":[{\\\"label\\\":\\\"invented-meta-\\ufffd(\\\",\\\"identity\\\":[\\\"11111111-1111-4111-8111-111111111111\\\",\\\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\\\",\\\"BodyWaterMassRecord\\\",\\\"r0-shared-id\\\"],\\\"nativeKeyJson\\\":\\\"[\\\\\\\"11111111-1111-4111-8111-111111111111\\\\\\\",\\\\\\\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\\\\\\\",\\\\\\\"BodyWaterMassRecord\\\\\\\",\\\\\\\"r0-shared-id\\\\\\\"]\\\",\\\"serializerId\\\":\\\"health-connect-record\\\",\\\"serializerVersion\\\":1,\\\"dataFamily\\\":\\\"ordinary\\\",\\\"projection\\\":\\\"raw-only\\\",\\\"expectedUtf8Bytes\\\":380,\\\"expectedRecordDigest\\\":\\\"sha256:e58adccfff037a420d6634ece28e51cc544f306871f45a7238c6e2e87a28cc3f\\\"},{\\\"label\\\":\\\"beta-body-water\\\",\\\"identity\\\":[\\\"11111111-1111-4111-8111-111111111111\\\",\\\"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb\\\",\\\"BodyWaterMassRecord\\\",\\\"r0-shared-id\\\"],\\\"nativeKeyJson\\\":\\\"[\\\\\\\"11111111-1111-4111-8111-111111111111\\\\\\\",\\\\\\\"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb\\\\\\\",\\\\\\\"BodyWaterMassRecord\\\\\\\",\\\\\\\"r0-shared-id\\\\\\\"]\\\",\\\"serializerId\\\":\\\"health-connect-record\\\",\\\"serializerVersion\\\":1,\\\"dataFamily\\\":\\\"ordinary\\\",\\\"projection\\\":\\\"raw-only\\\",\\\"expectedUtf8Bytes\\\":357,\\\"expectedRecordDigest\\\":\\\"sha256:c75f9ec48ec178af6f10bfa22907417e79b0e45bb4cd4ac00e50b16a248d41e1\\\"},{\\\"label\\\":\\\"alpha-cycling-cadence\\\",\\\"identity\\\":[\\\"11111111-1111-4111-8111-111111111111\\\",\\\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\\\",\\\"CyclingPedalingCadenceRecord\\\",\\\"r0-shared-id\\\"],\\\"nativeKeyJson\\\":\\\"[\\\\\\\"11111111-1111-4111-8111-111111111111\\\\\\\",\\\\\\\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\\\\\\\",\\\\\\\"CyclingPedalingCadenceRecord\\\\\\\",\\\\\\\"r0-shared-id\\\\\\\"]\\\",\\\"serializerId\\\":\\\"health-connect-record\\\",\\\"serializerVersion\\\":1,\\\"dataFamily\\\":\\\"ordinary\\\",\\\"projection\\\":\\\"raw-only\\\",\\\"expectedUtf8Bytes\\\":557,\\\"expectedRecordDigest\\\":\\\"sha256:87bc00ed3b441a2c5626223c2fe28019086bf28a799bdd0594bd284bec6eeec2\\\"}],\\\"sourcePolicies\\\":[{\\\"id\\\":\\\"r0-policy-alpha\\\",\\\"sourceStoreId\\\":\\\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\\\",\\\"sharing\\\":\\\"stopped\\\",\\\"retainCommittedHistory\\\":true,\\\"priorGenerationProvenance\\\":\\\"7\\\"},{\\\"id\\\":\\\"r0-policy-beta\\\",\\\"sourceStoreId\\\":\\\"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb\\\",\\\"sharing\\\":\\\"enabled\\\",\\\"retainCommittedHistory\\\":true,\\\"priorGenerationProvenance\\\":\\\"3\\\"}],\\\"tombstones\\\":[{\\\"tenantId\\\":\\\"11111111-1111-4111-8111-111111111111\\\",\\\"sourceStoreId\\\":\\\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\\\",\\\"nativeRecordId\\\":\\\"r0-deleted-known\\\",\\\"knownType\\\":\\\"StepsRecord\\\",\\\"reason\\\":\\\"source-delete\\\"},{\\\"tenantId\\\":\\\"11111111-1111-4111-8111-111111111111\\\",\\\"sourceStoreId\\\":\\\"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb\\\",\\\"nativeRecordId\\\":\\\"r0-deleted-unknown\\\",\\\"knownType\\\":null,\\\"reason\\\":\\\"source-delete\\\"}],\\\"suppressions\\\":[{\\\"sourceStoreId\\\":\\\"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb\\\",\\\"type\\\":\\\"WeightRecord\\\",\\\"startInclusive\\\":\\\"2025-12-01T00:00:00Z\\\",\\\"endExclusive\\\":\\\"2026-01-01T00:00:00Z\\\",\\\"explicitReimportAllowed\\\":false}]}\",\"metadataSha\":\"sha256:484f0264f3a1bfc925ffe3d217d1c4ae27092c3c9fe9a1e05409416b73240d3a\",\"rawRecordJSON\":\"{\\\"time\\\":\\\"2026-01-02T03:04:05.123456789Z\\\",\\\"zoneOffset\\\":\\\"+11:00\\\",\\\"mass\\\":{\\\"value\\\":\\\"43.125\\\",\\\"unit\\\":\\\"kg\\\"},\\\"metadata\\\":{\\\"id\\\":\\\"r0-shared-id\\\",\\\"dataOrigin\\\":{\\\"packageName\\\":\\\"example.synthetic.alpha\\\"},\\\"device\\\":{\\\"manufacturer\\\":\\\"Synthetic\\\",\\\"model\\\":\\\"Fixture Alpha\\\",\\\"type\\\":0},\\\"lastModifiedTime\\\":\\\"2026-01-02T03:05:00.000000001Z\\\",\\\"clientRecordId\\\":null,\\\"clientRecordVersion\\\":\\\"2\\\",\\\"recordingMethod\\\":3}}\",\"rawUtf8Bytes\":380,\"rawDigest\":\"sha256:e58adccfff037a420d6634ece28e51cc544f306871f45a7238c6e2e87a28cc3f\",\"logicalText\":\"{\\\"catalog\\\":{\\\"version\\\":1,\\\"logicalTenantId\\\":\\\"11111111-1111-4111-8111-111111111111\\\",\\\"sources\\\":[{\\\"sourceStoreId\\\":\\\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\\\",\\\"provider\\\":\\\"health-connect-native\\\",\\\"policyRef\\\":\\\"r0-policy-alpha\\\"},{\\\"sourceStoreId\\\":\\\"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb\\\",\\\"provider\\\":\\\"health-connect-native\\\",\\\"policyRef\\\":\\\"r0-policy-beta\\\"}]},\\\"recordDescriptors\\\":[{\\\"label\\\":\\\"invented-meta-\\ufffd(\\\",\\\"identity\\\":[\\\"11111111-1111-4111-8111-111111111111\\\",\\\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\\\",\\\"BodyWaterMassRecord\\\",\\\"r0-shared-id\\\"],\\\"nativeKeyJson\\\":\\\"[\\\\\\\"11111111-1111-4111-8111-111111111111\\\\\\\",\\\\\\\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\\\\\\\",\\\\\\\"BodyWaterMassRecord\\\\\\\",\\\\\\\"r0-shared-id\\\\\\\"]\\\",\\\"serializerId\\\":\\\"health-connect-record\\\",\\\"serializerVersion\\\":1,\\\"dataFamily\\\":\\\"ordinary\\\",\\\"projection\\\":\\\"raw-only\\\",\\\"expectedUtf8Bytes\\\":380,\\\"expectedRecordDigest\\\":\\\"sha256:e58adccfff037a420d6634ece28e51cc544f306871f45a7238c6e2e87a28cc3f\\\"},{\\\"label\\\":\\\"beta-body-water\\\",\\\"identity\\\":[\\\"11111111-1111-4111-8111-111111111111\\\",\\\"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb\\\",\\\"BodyWaterMassRecord\\\",\\\"r0-shared-id\\\"],\\\"nativeKeyJson\\\":\\\"[\\\\\\\"11111111-1111-4111-8111-111111111111\\\\\\\",\\\\\\\"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb\\\\\\\",\\\\\\\"BodyWaterMassRecord\\\\\\\",\\\\\\\"r0-shared-id\\\\\\\"]\\\",\\\"serializerId\\\":\\\"health-connect-record\\\",\\\"serializerVersion\\\":1,\\\"dataFamily\\\":\\\"ordinary\\\",\\\"projection\\\":\\\"raw-only\\\",\\\"expectedUtf8Bytes\\\":357,\\\"expectedRecordDigest\\\":\\\"sha256:c75f9ec48ec178af6f10bfa22907417e79b0e45bb4cd4ac00e50b16a248d41e1\\\"},{\\\"label\\\":\\\"alpha-cycling-cadence\\\",\\\"identity\\\":[\\\"11111111-1111-4111-8111-111111111111\\\",\\\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\\\",\\\"CyclingPedalingCadenceRecord\\\",\\\"r0-shared-id\\\"],\\\"nativeKeyJson\\\":\\\"[\\\\\\\"11111111-1111-4111-8111-111111111111\\\\\\\",\\\\\\\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\\\\\\\",\\\\\\\"CyclingPedalingCadenceRecord\\\\\\\",\\\\\\\"r0-shared-id\\\\\\\"]\\\",\\\"serializerId\\\":\\\"health-connect-record\\\",\\\"serializerVersion\\\":1,\\\"dataFamily\\\":\\\"ordinary\\\",\\\"projection\\\":\\\"raw-only\\\",\\\"expectedUtf8Bytes\\\":557,\\\"expectedRecordDigest\\\":\\\"sha256:87bc00ed3b441a2c5626223c2fe28019086bf28a799bdd0594bd284bec6eeec2\\\"}],\\\"sourcePolicies\\\":[{\\\"id\\\":\\\"r0-policy-alpha\\\",\\\"sourceStoreId\\\":\\\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\\\",\\\"sharing\\\":\\\"stopped\\\",\\\"retainCommittedHistory\\\":true,\\\"priorGenerationProvenance\\\":\\\"7\\\"},{\\\"id\\\":\\\"r0-policy-beta\\\",\\\"sourceStoreId\\\":\\\"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb\\\",\\\"sharing\\\":\\\"enabled\\\",\\\"retainCommittedHistory\\\":true,\\\"priorGenerationProvenance\\\":\\\"3\\\"}],\\\"tombstones\\\":[{\\\"tenantId\\\":\\\"11111111-1111-4111-8111-111111111111\\\",\\\"sourceStoreId\\\":\\\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\\\",\\\"nativeRecordId\\\":\\\"r0-deleted-known\\\",\\\"knownType\\\":\\\"StepsRecord\\\",\\\"reason\\\":\\\"source-delete\\\"},{\\\"tenantId\\\":\\\"11111111-1111-4111-8111-111111111111\\\",\\\"sourceStoreId\\\":\\\"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb\\\",\\\"nativeRecordId\\\":\\\"r0-deleted-unknown\\\",\\\"knownType\\\":null,\\\"reason\\\":\\\"source-delete\\\"}],\\\"suppressions\\\":[{\\\"sourceStoreId\\\":\\\"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb\\\",\\\"type\\\":\\\"WeightRecord\\\",\\\"startInclusive\\\":\\\"2025-12-01T00:00:00Z\\\",\\\"endExclusive\\\":\\\"2026-01-01T00:00:00Z\\\",\\\"explicitReimportAllowed\\\":false}]}\",\"legitimatePhysicalHex\":\"7B22636174616C6F67223A7B2276657273696F6E223A312C226C6F676963616C54656E616E744964223A2231313131313131312D313131312D343131312D383131312D313131313131313131313131222C22736F7572636573223A5B7B22736F7572636553746F72654964223A2261616161616161612D616161612D346161612D386161612D616161616161616161616161222C2270726F7669646572223A226865616C74682D636F6E6E6563742D6E6174697665222C22706F6C696379526566223A2272302D706F6C6963792D616C706861227D2C7B22736F7572636553746F72654964223A2262626262626262622D626262622D346262622D386262622D626262626262626262626262222C2270726F7669646572223A226865616C74682D636F6E6E6563742D6E6174697665222C22706F6C696379526566223A2272302D706F6C6963792D62657461227D5D7D2C227265636F726444657363726970746F7273223A5B7B226C6162656C223A22696E76656E7465642D6D6574612DEFBFBD28222C226964656E74697479223A5B2231313131313131312D313131312D343131312D383131312D313131313131313131313131222C2261616161616161612D616161612D346161612D386161612D616161616161616161616161222C22426F647957617465724D6173735265636F7264222C2272302D7368617265642D6964225D2C226E61746976654B65794A736F6E223A225B5C2231313131313131312D313131312D343131312D383131312D3131313131313131313131315C222C5C2261616161616161612D616161612D346161612D386161612D6161616161616161616161615C222C5C22426F647957617465724D6173735265636F72645C222C5C2272302D7368617265642D69645C225D222C2273657269616C697A65724964223A226865616C74682D636F6E6E6563742D7265636F7264222C2273657269616C697A657256657273696F6E223A312C226461746146616D696C79223A226F7264696E617279222C2270726F6A656374696F6E223A227261772D6F6E6C79222C226578706563746564557466384279746573223A3338302C2265787065637465645265636F7264446967657374223A227368613235363A65353861646363666666303337613432306436363334656365323865353163633534346633303638373166343561373233386336653265383761323863633366227D2C7B226C6162656C223A22626574612D626F64792D7761746572222C226964656E74697479223A5B2231313131313131312D313131312D343131312D383131312D313131313131313131313131222C2262626262626262622D626262622D346262622D386262622D626262626262626262626262222C22426F647957617465724D6173735265636F7264222C2272302D7368617265642D6964225D2C226E61746976654B65794A736F6E223A225B5C2231313131313131312D313131312D343131312D383131312D3131313131313131313131315C222C5C2262626262626262622D626262622D346262622D386262622D6262626262626262626262625C222C5C22426F647957617465724D6173735265636F72645C222C5C2272302D7368617265642D69645C225D222C2273657269616C697A65724964223A226865616C74682D636F6E6E6563742D7265636F7264222C2273657269616C697A657256657273696F6E223A312C226461746146616D696C79223A226F7264696E617279222C2270726F6A656374696F6E223A227261772D6F6E6C79222C226578706563746564557466384279746573223A3335372C2265787065637465645265636F7264446967657374223A227368613235363A63373566396563343865633137386166366631306266613232393037343137653739623065343562623463643461633030653530623136613234386434316531227D2C7B226C6162656C223A22616C7068612D6379636C696E672D636164656E6365222C226964656E74697479223A5B2231313131313131312D313131312D343131312D383131312D313131313131313131313131222C2261616161616161612D616161612D346161612D386161612D616161616161616161616161222C224379636C696E67506564616C696E67436164656E63655265636F7264222C2272302D7368617265642D6964225D2C226E61746976654B65794A736F6E223A225B5C2231313131313131312D313131312D343131312D383131312D3131313131313131313131315C222C5C2261616161616161612D616161612D346161612D386161612D6161616161616161616161615C222C5C224379636C696E67506564616C696E67436164656E63655265636F72645C222C5C2272302D7368617265642D69645C225D222C2273657269616C697A65724964223A226865616C74682D636F6E6E6563742D7265636F7264222C2273657269616C697A657256657273696F6E223A312C226461746146616D696C79223A226F7264696E617279222C2270726F6A656374696F6E223A227261772D6F6E6C79222C226578706563746564557466384279746573223A3535372C2265787065637465645265636F7264446967657374223A227368613235363A38376263303065643362343431613263353632363232336332666532383031393038366266323861373939626464303539346264323834626563366565656332227D5D2C22736F75726365506F6C6963696573223A5B7B226964223A2272302D706F6C6963792D616C706861222C22736F7572636553746F72654964223A2261616161616161612D616161612D346161612D386161612D616161616161616161616161222C2273686172696E67223A2273746F70706564222C2272657461696E436F6D6D6974746564486973746F7279223A747275652C227072696F7247656E65726174696F6E50726F76656E616E6365223A2237227D2C7B226964223A2272302D706F6C6963792D62657461222C22736F7572636553746F72654964223A2262626262626262622D626262622D346262622D386262622D626262626262626262626262222C2273686172696E67223A22656E61626C6564222C2272657461696E436F6D6D6974746564486973746F7279223A747275652C227072696F7247656E65726174696F6E50726F76656E616E6365223A2233227D5D2C22746F6D6273746F6E6573223A5B7B2274656E616E744964223A2231313131313131312D313131312D343131312D383131312D313131313131313131313131222C22736F7572636553746F72654964223A2261616161616161612D616161612D346161612D386161612D616161616161616161616161222C226E61746976655265636F72644964223A2272302D64656C657465642D6B6E6F776E222C226B6E6F776E54797065223A2253746570735265636F7264222C22726561736F6E223A22736F757263652D64656C657465227D2C7B2274656E616E744964223A2231313131313131312D313131312D343131312D383131312D313131313131313131313131222C22736F7572636553746F72654964223A2262626262626262622D626262622D346262622D386262622D626262626262626262626262222C226E61746976655265636F72644964223A2272302D64656C657465642D756E6B6E6F776E222C226B6E6F776E54797065223A6E756C6C2C22726561736F6E223A22736F757263652D64656C657465227D5D2C227375707072657373696F6E73223A5B7B22736F7572636553746F72654964223A2262626262626262622D626262622D346262622D386262622D626262626262626262626262222C2274797065223A225765696768745265636F7264222C227374617274496E636C7573697665223A22323032352D31322D30315430303A30303A30305A222C22656E644578636C7573697665223A22323032362D30312D30315430303A30303A30305A222C226578706C696369745265696D706F7274416C6C6F776564223A66616C73657D5D7D\",\"malformedPhysicalHex\":\"7B22636174616C6F67223A7B2276657273696F6E223A312C226C6F676963616C54656E616E744964223A2231313131313131312D313131312D343131312D383131312D313131313131313131313131222C22736F7572636573223A5B7B22736F7572636553746F72654964223A2261616161616161612D616161612D346161612D386161612D616161616161616161616161222C2270726F7669646572223A226865616C74682D636F6E6E6563742D6E6174697665222C22706F6C696379526566223A2272302D706F6C6963792D616C706861227D2C7B22736F7572636553746F72654964223A2262626262626262622D626262622D346262622D386262622D626262626262626262626262222C2270726F7669646572223A226865616C74682D636F6E6E6563742D6E6174697665222C22706F6C696379526566223A2272302D706F6C6963792D62657461227D5D7D2C227265636F726444657363726970746F7273223A5B7B226C6162656C223A22696E76656E7465642D6D6574612DC328222C226964656E74697479223A5B2231313131313131312D313131312D343131312D383131312D313131313131313131313131222C2261616161616161612D616161612D346161612D386161612D616161616161616161616161222C22426F647957617465724D6173735265636F7264222C2272302D7368617265642D6964225D2C226E61746976654B65794A736F6E223A225B5C2231313131313131312D313131312D343131312D383131312D3131313131313131313131315C222C5C2261616161616161612D616161612D346161612D386161612D6161616161616161616161615C222C5C22426F647957617465724D6173735265636F72645C222C5C2272302D7368617265642D69645C225D222C2273657269616C697A65724964223A226865616C74682D636F6E6E6563742D7265636F7264222C2273657269616C697A657256657273696F6E223A312C226461746146616D696C79223A226F7264696E617279222C2270726F6A656374696F6E223A227261772D6F6E6C79222C226578706563746564557466384279746573223A3338302C2265787065637465645265636F7264446967657374223A227368613235363A65353861646363666666303337613432306436363334656365323865353163633534346633303638373166343561373233386336653265383761323863633366227D2C7B226C6162656C223A22626574612D626F64792D7761746572222C226964656E74697479223A5B2231313131313131312D313131312D343131312D383131312D313131313131313131313131222C2262626262626262622D626262622D346262622D386262622D626262626262626262626262222C22426F647957617465724D6173735265636F7264222C2272302D7368617265642D6964225D2C226E61746976654B65794A736F6E223A225B5C2231313131313131312D313131312D343131312D383131312D3131313131313131313131315C222C5C2262626262626262622D626262622D346262622D386262622D6262626262626262626262625C222C5C22426F647957617465724D6173735265636F72645C222C5C2272302D7368617265642D69645C225D222C2273657269616C697A65724964223A226865616C74682D636F6E6E6563742D7265636F7264222C2273657269616C697A657256657273696F6E223A312C226461746146616D696C79223A226F7264696E617279222C2270726F6A656374696F6E223A227261772D6F6E6C79222C226578706563746564557466384279746573223A3335372C2265787065637465645265636F7264446967657374223A227368613235363A63373566396563343865633137386166366631306266613232393037343137653739623065343562623463643461633030653530623136613234386434316531227D2C7B226C6162656C223A22616C7068612D6379636C696E672D636164656E6365222C226964656E74697479223A5B2231313131313131312D313131312D343131312D383131312D313131313131313131313131222C2261616161616161612D616161612D346161612D386161612D616161616161616161616161222C224379636C696E67506564616C696E67436164656E63655265636F7264222C2272302D7368617265642D6964225D2C226E61746976654B65794A736F6E223A225B5C2231313131313131312D313131312D343131312D383131312D3131313131313131313131315C222C5C2261616161616161612D616161612D346161612D386161612D6161616161616161616161615C222C5C224379636C696E67506564616C696E67436164656E63655265636F72645C222C5C2272302D7368617265642D69645C225D222C2273657269616C697A65724964223A226865616C74682D636F6E6E6563742D7265636F7264222C2273657269616C697A657256657273696F6E223A312C226461746146616D696C79223A226F7264696E617279222C2270726F6A656374696F6E223A227261772D6F6E6C79222C226578706563746564557466384279746573223A3535372C2265787065637465645265636F7264446967657374223A227368613235363A38376263303065643362343431613263353632363232336332666532383031393038366266323861373939626464303539346264323834626563366565656332227D5D2C22736F75726365506F6C6963696573223A5B7B226964223A2272302D706F6C6963792D616C706861222C22736F7572636553746F72654964223A2261616161616161612D616161612D346161612D386161612D616161616161616161616161222C2273686172696E67223A2273746F70706564222C2272657461696E436F6D6D6974746564486973746F7279223A747275652C227072696F7247656E65726174696F6E50726F76656E616E6365223A2237227D2C7B226964223A2272302D706F6C6963792D62657461222C22736F7572636553746F72654964223A2262626262626262622D626262622D346262622D386262622D626262626262626262626262222C2273686172696E67223A22656E61626C6564222C2272657461696E436F6D6D6974746564486973746F7279223A747275652C227072696F7247656E65726174696F6E50726F76656E616E6365223A2233227D5D2C22746F6D6273746F6E6573223A5B7B2274656E616E744964223A2231313131313131312D313131312D343131312D383131312D313131313131313131313131222C22736F7572636553746F72654964223A2261616161616161612D616161612D346161612D386161612D616161616161616161616161222C226E61746976655265636F72644964223A2272302D64656C657465642D6B6E6F776E222C226B6E6F776E54797065223A2253746570735265636F7264222C22726561736F6E223A22736F757263652D64656C657465227D2C7B2274656E616E744964223A2231313131313131312D313131312D343131312D383131312D313131313131313131313131222C22736F7572636553746F72654964223A2262626262626262622D626262622D346262622D386262622D626262626262626262626262222C226E61746976655265636F72644964223A2272302D64656C657465642D756E6B6E6F776E222C226B6E6F776E54797065223A6E756C6C2C22726561736F6E223A22736F757263652D64656C657465227D5D2C227375707072657373696F6E73223A5B7B22736F7572636553746F72654964223A2262626262626262622D626262622D346262622D386262622D626262626262626262626262222C2274797065223A225765696768745265636F7264222C227374617274496E636C7573697665223A22323032352D31322D30315430303A30303A30305A222C22656E644578636C7573697665223A22323032362D30312D30315430303A30303A30305A222C226578706C696369745265696D706F7274416C6C6F776564223A66616C73657D5D7D\",\"malformedPhysicalBytes\":2915,\"malformedPhysicalDigest\":\"sha256:50a95b00d9a3eb34f0e7bb3d99387fcb72f6f05b7be9e7e994337f891b21aa6e\",\"identity\":[\"11111111-1111-4111-8111-111111111111\",\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\",\"BodyWaterMassRecord\",\"r0-shared-id\"]},{\"kind\":\"raw\",\"inputJSON\":\"{\\\"catalog\\\":{\\\"version\\\":1,\\\"logicalTenantId\\\":\\\"11111111-1111-4111-8111-111111111111\\\",\\\"sources\\\":[{\\\"sourceStoreId\\\":\\\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\\\",\\\"provider\\\":\\\"health-connect-native\\\",\\\"policyRef\\\":\\\"r0-policy-alpha\\\"},{\\\"sourceStoreId\\\":\\\"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb\\\",\\\"provider\\\":\\\"health-connect-native\\\",\\\"policyRef\\\":\\\"r0-policy-beta\\\"}]},\\\"records\\\":[{\\\"label\\\":\\\"alpha-body-water\\\",\\\"identity\\\":[\\\"11111111-1111-4111-8111-111111111111\\\",\\\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\\\",\\\"BodyWaterMassRecord\\\",\\\"r0-shared-id\\\"],\\\"recordJson\\\":\\\"{\\\\\\\"time\\\\\\\":\\\\\\\"2026-01-02T03:04:05.123456789Z\\\\\\\",\\\\\\\"zoneOffset\\\\\\\":\\\\\\\"+11:00\\\\\\\",\\\\\\\"mass\\\\\\\":{\\\\\\\"value\\\\\\\":\\\\\\\"43.125\\\\\\\",\\\\\\\"unit\\\\\\\":\\\\\\\"kg\\\\\\\"},\\\\\\\"metadata\\\\\\\":{\\\\\\\"id\\\\\\\":\\\\\\\"r0-shared-id\\\\\\\",\\\\\\\"dataOrigin\\\\\\\":{\\\\\\\"packageName\\\\\\\":\\\\\\\"example.synthetic.alpha\\\\\\\"},\\\\\\\"device\\\\\\\":{\\\\\\\"manufacturer\\\\\\\":\\\\\\\"Synthetic\\\\\\\",\\\\\\\"model\\\\\\\":\\\\\\\"Invented \\ufffd(\\\\\\\",\\\\\\\"type\\\\\\\":0},\\\\\\\"lastModifiedTime\\\\\\\":\\\\\\\"2026-01-02T03:05:00.000000001Z\\\\\\\",\\\\\\\"clientRecordId\\\\\\\":null,\\\\\\\"clientRecordVersion\\\\\\\":\\\\\\\"2\\\\\\\",\\\\\\\"recordingMethod\\\\\\\":3}}\\\",\\\"nativeKeyJson\\\":\\\"[\\\\\\\"11111111-1111-4111-8111-111111111111\\\\\\\",\\\\\\\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\\\\\\\",\\\\\\\"BodyWaterMassRecord\\\\\\\",\\\\\\\"r0-shared-id\\\\\\\"]\\\",\\\"serializerId\\\":\\\"health-connect-record\\\",\\\"serializerVersion\\\":1,\\\"dataFamily\\\":\\\"ordinary\\\",\\\"projection\\\":\\\"raw-only\\\",\\\"expectedUtf8Bytes\\\":380,\\\"expectedRecordDigest\\\":\\\"sha256:a02ccafa095f1b4c54b433bb197df86b7916b498586c11cb3334ccfd3507d057\\\"},{\\\"label\\\":\\\"beta-body-water\\\",\\\"identity\\\":[\\\"11111111-1111-4111-8111-111111111111\\\",\\\"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb\\\",\\\"BodyWaterMassRecord\\\",\\\"r0-shared-id\\\"],\\\"recordJson\\\":\\\"{\\\\\\\"time\\\\\\\":\\\\\\\"2026-01-02T03:04:05.123456789Z\\\\\\\",\\\\\\\"zoneOffset\\\\\\\":null,\\\\\\\"mass\\\\\\\":{\\\\\\\"value\\\\\\\":\\\\\\\"43.125\\\\\\\",\\\\\\\"unit\\\\\\\":\\\\\\\"kg\\\\\\\"},\\\\\\\"metadata\\\\\\\":{\\\\\\\"id\\\\\\\":\\\\\\\"r0-shared-id\\\\\\\",\\\\\\\"dataOrigin\\\\\\\":{\\\\\\\"packageName\\\\\\\":\\\\\\\"example.synthetic.beta\\\\\\\"},\\\\\\\"device\\\\\\\":{\\\\\\\"manufacturer\\\\\\\":null,\\\\\\\"model\\\\\\\":null,\\\\\\\"type\\\\\\\":0},\\\\\\\"lastModifiedTime\\\\\\\":\\\\\\\"2026-01-02T03:05:00.000000002Z\\\\\\\",\\\\\\\"clientRecordId\\\\\\\":null,\\\\\\\"clientRecordVersion\\\\\\\":\\\\\\\"1\\\\\\\",\\\\\\\"recordingMethod\\\\\\\":0}}\\\",\\\"nativeKeyJson\\\":\\\"[\\\\\\\"11111111-1111-4111-8111-111111111111\\\\\\\",\\\\\\\"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb\\\\\\\",\\\\\\\"BodyWaterMassRecord\\\\\\\",\\\\\\\"r0-shared-id\\\\\\\"]\\\",\\\"serializerId\\\":\\\"health-connect-record\\\",\\\"serializerVersion\\\":1,\\\"dataFamily\\\":\\\"ordinary\\\",\\\"projection\\\":\\\"raw-only\\\",\\\"expectedUtf8Bytes\\\":357,\\\"expectedRecordDigest\\\":\\\"sha256:c75f9ec48ec178af6f10bfa22907417e79b0e45bb4cd4ac00e50b16a248d41e1\\\"},{\\\"label\\\":\\\"alpha-cycling-cadence\\\",\\\"identity\\\":[\\\"11111111-1111-4111-8111-111111111111\\\",\\\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\\\",\\\"CyclingPedalingCadenceRecord\\\",\\\"r0-shared-id\\\"],\\\"recordJson\\\":\\\"{\\\\\\\"startTime\\\\\\\":\\\\\\\"2026-01-02T03:00:00Z\\\\\\\",\\\\\\\"endTime\\\\\\\":\\\\\\\"2026-01-02T03:10:00Z\\\\\\\",\\\\\\\"startZoneOffset\\\\\\\":\\\\\\\"+11:00\\\\\\\",\\\\\\\"endZoneOffset\\\\\\\":\\\\\\\"+11:00\\\\\\\",\\\\\\\"samples\\\\\\\":[{\\\\\\\"time\\\\\\\":\\\\\\\"2026-01-02T03:01:00.000000001Z\\\\\\\",\\\\\\\"revolutionsPerMinute\\\\\\\":\\\\\\\"62.5\\\\\\\"},{\\\\\\\"time\\\\\\\":\\\\\\\"2026-01-02T03:05:00.000000002Z\\\\\\\",\\\\\\\"revolutionsPerMinute\\\\\\\":\\\\\\\"91.25\\\\\\\"}],\\\\\\\"metadata\\\\\\\":{\\\\\\\"id\\\\\\\":\\\\\\\"r0-shared-id\\\\\\\",\\\\\\\"dataOrigin\\\\\\\":{\\\\\\\"packageName\\\\\\\":\\\\\\\"example.synthetic.alpha\\\\\\\"},\\\\\\\"device\\\\\\\":{\\\\\\\"manufacturer\\\\\\\":\\\\\\\"Synthetic\\\\\\\",\\\\\\\"model\\\\\\\":\\\\\\\"Fixture Alpha\\\\\\\",\\\\\\\"type\\\\\\\":0},\\\\\\\"lastModifiedTime\\\\\\\":\\\\\\\"2026-01-02T03:11:00.000000001Z\\\\\\\",\\\\\\\"clientRecordId\\\\\\\":null,\\\\\\\"clientRecordVersion\\\\\\\":\\\\\\\"1\\\\\\\",\\\\\\\"recordingMethod\\\\\\\":3}}\\\",\\\"nativeKeyJson\\\":\\\"[\\\\\\\"11111111-1111-4111-8111-111111111111\\\\\\\",\\\\\\\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\\\\\\\",\\\\\\\"CyclingPedalingCadenceRecord\\\\\\\",\\\\\\\"r0-shared-id\\\\\\\"]\\\",\\\"serializerId\\\":\\\"health-connect-record\\\",\\\"serializerVersion\\\":1,\\\"dataFamily\\\":\\\"ordinary\\\",\\\"projection\\\":\\\"raw-only\\\",\\\"expectedUtf8Bytes\\\":557,\\\"expectedRecordDigest\\\":\\\"sha256:87bc00ed3b441a2c5626223c2fe28019086bf28a799bdd0594bd284bec6eeec2\\\"}],\\\"sourcePolicies\\\":[{\\\"id\\\":\\\"r0-policy-alpha\\\",\\\"sourceStoreId\\\":\\\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\\\",\\\"sharing\\\":\\\"stopped\\\",\\\"retainCommittedHistory\\\":true,\\\"priorGenerationProvenance\\\":\\\"7\\\"},{\\\"id\\\":\\\"r0-policy-beta\\\",\\\"sourceStoreId\\\":\\\"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb\\\",\\\"sharing\\\":\\\"enabled\\\",\\\"retainCommittedHistory\\\":true,\\\"priorGenerationProvenance\\\":\\\"3\\\"}],\\\"tombstones\\\":[{\\\"tenantId\\\":\\\"11111111-1111-4111-8111-111111111111\\\",\\\"sourceStoreId\\\":\\\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\\\",\\\"nativeRecordId\\\":\\\"r0-deleted-known\\\",\\\"knownType\\\":\\\"StepsRecord\\\",\\\"reason\\\":\\\"source-delete\\\"},{\\\"tenantId\\\":\\\"11111111-1111-4111-8111-111111111111\\\",\\\"sourceStoreId\\\":\\\"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb\\\",\\\"nativeRecordId\\\":\\\"r0-deleted-unknown\\\",\\\"knownType\\\":null,\\\"reason\\\":\\\"source-delete\\\"}],\\\"suppressions\\\":[{\\\"sourceStoreId\\\":\\\"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb\\\",\\\"type\\\":\\\"WeightRecord\\\",\\\"startInclusive\\\":\\\"2025-12-01T00:00:00Z\\\",\\\"endExclusive\\\":\\\"2026-01-01T00:00:00Z\\\",\\\"explicitReimportAllowed\\\":false}]}\",\"inputUtf8Bytes\":4419,\"footerJSON\":\"{\\\"version\\\":1,\\\"counts\\\":{\\\"sources\\\":2,\\\"records\\\":3,\\\"sourcePolicies\\\":2,\\\"tombstones\\\":2,\\\"suppressions\\\":1},\\\"sha256\\\":\\\"sha256:30616aceabeb601f5d5801e29c6c3c3b517720e9c27d1740b457b35c2b707015\\\"}\",\"footerUtf8Bytes\":182,\"metadataJSON\":\"{\\\"catalog\\\":{\\\"version\\\":1,\\\"logicalTenantId\\\":\\\"11111111-1111-4111-8111-111111111111\\\",\\\"sources\\\":[{\\\"sourceStoreId\\\":\\\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\\\",\\\"provider\\\":\\\"health-connect-native\\\",\\\"policyRef\\\":\\\"r0-policy-alpha\\\"},{\\\"sourceStoreId\\\":\\\"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb\\\",\\\"provider\\\":\\\"health-connect-native\\\",\\\"policyRef\\\":\\\"r0-policy-beta\\\"}]},\\\"recordDescriptors\\\":[{\\\"label\\\":\\\"alpha-body-water\\\",\\\"identity\\\":[\\\"11111111-1111-4111-8111-111111111111\\\",\\\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\\\",\\\"BodyWaterMassRecord\\\",\\\"r0-shared-id\\\"],\\\"nativeKeyJson\\\":\\\"[\\\\\\\"11111111-1111-4111-8111-111111111111\\\\\\\",\\\\\\\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\\\\\\\",\\\\\\\"BodyWaterMassRecord\\\\\\\",\\\\\\\"r0-shared-id\\\\\\\"]\\\",\\\"serializerId\\\":\\\"health-connect-record\\\",\\\"serializerVersion\\\":1,\\\"dataFamily\\\":\\\"ordinary\\\",\\\"projection\\\":\\\"raw-only\\\",\\\"expectedUtf8Bytes\\\":380,\\\"expectedRecordDigest\\\":\\\"sha256:a02ccafa095f1b4c54b433bb197df86b7916b498586c11cb3334ccfd3507d057\\\"},{\\\"label\\\":\\\"beta-body-water\\\",\\\"identity\\\":[\\\"11111111-1111-4111-8111-111111111111\\\",\\\"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb\\\",\\\"BodyWaterMassRecord\\\",\\\"r0-shared-id\\\"],\\\"nativeKeyJson\\\":\\\"[\\\\\\\"11111111-1111-4111-8111-111111111111\\\\\\\",\\\\\\\"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb\\\\\\\",\\\\\\\"BodyWaterMassRecord\\\\\\\",\\\\\\\"r0-shared-id\\\\\\\"]\\\",\\\"serializerId\\\":\\\"health-connect-record\\\",\\\"serializerVersion\\\":1,\\\"dataFamily\\\":\\\"ordinary\\\",\\\"projection\\\":\\\"raw-only\\\",\\\"expectedUtf8Bytes\\\":357,\\\"expectedRecordDigest\\\":\\\"sha256:c75f9ec48ec178af6f10bfa22907417e79b0e45bb4cd4ac00e50b16a248d41e1\\\"},{\\\"label\\\":\\\"alpha-cycling-cadence\\\",\\\"identity\\\":[\\\"11111111-1111-4111-8111-111111111111\\\",\\\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\\\",\\\"CyclingPedalingCadenceRecord\\\",\\\"r0-shared-id\\\"],\\\"nativeKeyJson\\\":\\\"[\\\\\\\"11111111-1111-4111-8111-111111111111\\\\\\\",\\\\\\\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\\\\\\\",\\\\\\\"CyclingPedalingCadenceRecord\\\\\\\",\\\\\\\"r0-shared-id\\\\\\\"]\\\",\\\"serializerId\\\":\\\"health-connect-record\\\",\\\"serializerVersion\\\":1,\\\"dataFamily\\\":\\\"ordinary\\\",\\\"projection\\\":\\\"raw-only\\\",\\\"expectedUtf8Bytes\\\":557,\\\"expectedRecordDigest\\\":\\\"sha256:87bc00ed3b441a2c5626223c2fe28019086bf28a799bdd0594bd284bec6eeec2\\\"}],\\\"sourcePolicies\\\":[{\\\"id\\\":\\\"r0-policy-alpha\\\",\\\"sourceStoreId\\\":\\\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\\\",\\\"sharing\\\":\\\"stopped\\\",\\\"retainCommittedHistory\\\":true,\\\"priorGenerationProvenance\\\":\\\"7\\\"},{\\\"id\\\":\\\"r0-policy-beta\\\",\\\"sourceStoreId\\\":\\\"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb\\\",\\\"sharing\\\":\\\"enabled\\\",\\\"retainCommittedHistory\\\":true,\\\"priorGenerationProvenance\\\":\\\"3\\\"}],\\\"tombstones\\\":[{\\\"tenantId\\\":\\\"11111111-1111-4111-8111-111111111111\\\",\\\"sourceStoreId\\\":\\\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\\\",\\\"nativeRecordId\\\":\\\"r0-deleted-known\\\",\\\"knownType\\\":\\\"StepsRecord\\\",\\\"reason\\\":\\\"source-delete\\\"},{\\\"tenantId\\\":\\\"11111111-1111-4111-8111-111111111111\\\",\\\"sourceStoreId\\\":\\\"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb\\\",\\\"nativeRecordId\\\":\\\"r0-deleted-unknown\\\",\\\"knownType\\\":null,\\\"reason\\\":\\\"source-delete\\\"}],\\\"suppressions\\\":[{\\\"sourceStoreId\\\":\\\"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb\\\",\\\"type\\\":\\\"WeightRecord\\\",\\\"startInclusive\\\":\\\"2025-12-01T00:00:00Z\\\",\\\"endExclusive\\\":\\\"2026-01-01T00:00:00Z\\\",\\\"explicitReimportAllowed\\\":false}]}\",\"metadataSha\":\"sha256:16cd1aa54066208fbda02cc816eee3e167ebe5176ef0a7243723122eb7a43ab1\",\"rawRecordJSON\":\"{\\\"time\\\":\\\"2026-01-02T03:04:05.123456789Z\\\",\\\"zoneOffset\\\":\\\"+11:00\\\",\\\"mass\\\":{\\\"value\\\":\\\"43.125\\\",\\\"unit\\\":\\\"kg\\\"},\\\"metadata\\\":{\\\"id\\\":\\\"r0-shared-id\\\",\\\"dataOrigin\\\":{\\\"packageName\\\":\\\"example.synthetic.alpha\\\"},\\\"device\\\":{\\\"manufacturer\\\":\\\"Synthetic\\\",\\\"model\\\":\\\"Invented \\ufffd(\\\",\\\"type\\\":0},\\\"lastModifiedTime\\\":\\\"2026-01-02T03:05:00.000000001Z\\\",\\\"clientRecordId\\\":null,\\\"clientRecordVersion\\\":\\\"2\\\",\\\"recordingMethod\\\":3}}\",\"rawUtf8Bytes\":380,\"rawDigest\":\"sha256:a02ccafa095f1b4c54b433bb197df86b7916b498586c11cb3334ccfd3507d057\",\"logicalText\":\"{\\\"time\\\":\\\"2026-01-02T03:04:05.123456789Z\\\",\\\"zoneOffset\\\":\\\"+11:00\\\",\\\"mass\\\":{\\\"value\\\":\\\"43.125\\\",\\\"unit\\\":\\\"kg\\\"},\\\"metadata\\\":{\\\"id\\\":\\\"r0-shared-id\\\",\\\"dataOrigin\\\":{\\\"packageName\\\":\\\"example.synthetic.alpha\\\"},\\\"device\\\":{\\\"manufacturer\\\":\\\"Synthetic\\\",\\\"model\\\":\\\"Invented \\ufffd(\\\",\\\"type\\\":0},\\\"lastModifiedTime\\\":\\\"2026-01-02T03:05:00.000000001Z\\\",\\\"clientRecordId\\\":null,\\\"clientRecordVersion\\\":\\\"2\\\",\\\"recordingMethod\\\":3}}\",\"legitimatePhysicalHex\":\"7B2274696D65223A22323032362D30312D30325430333A30343A30352E3132333435363738395A222C227A6F6E654F6666736574223A222B31313A3030222C226D617373223A7B2276616C7565223A2234332E313235222C22756E6974223A226B67227D2C226D65746164617461223A7B226964223A2272302D7368617265642D6964222C22646174614F726967696E223A7B227061636B6167654E616D65223A226578616D706C652E73796E7468657469632E616C706861227D2C22646576696365223A7B226D616E756661637475726572223A2253796E746865746963222C226D6F64656C223A22496E76656E74656420EFBFBD28222C2274797065223A307D2C226C6173744D6F64696669656454696D65223A22323032362D30312D30325430333A30353A30302E3030303030303030315A222C22636C69656E745265636F72644964223A6E756C6C2C22636C69656E745265636F726456657273696F6E223A2232222C227265636F7264696E674D6574686F64223A337D7D\",\"malformedPhysicalHex\":\"7B2274696D65223A22323032362D30312D30325430333A30343A30352E3132333435363738395A222C227A6F6E654F6666736574223A222B31313A3030222C226D617373223A7B2276616C7565223A2234332E313235222C22756E6974223A226B67227D2C226D65746164617461223A7B226964223A2272302D7368617265642D6964222C22646174614F726967696E223A7B227061636B6167654E616D65223A226578616D706C652E73796E7468657469632E616C706861227D2C22646576696365223A7B226D616E756661637475726572223A2253796E746865746963222C226D6F64656C223A22496E76656E74656420C328222C2274797065223A307D2C226C6173744D6F64696669656454696D65223A22323032362D30312D30325430333A30353A30302E3030303030303030315A222C22636C69656E745265636F72644964223A6E756C6C2C22636C69656E745265636F726456657273696F6E223A2232222C227265636F7264696E674D6574686F64223A337D7D\",\"malformedPhysicalBytes\":378,\"malformedPhysicalDigest\":\"sha256:f82efb2b507f1bf67655cadcdee14a29ec6d74fc5e742366cde25691b4440aa9\",\"identity\":[\"11111111-1111-4111-8111-111111111111\",\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\",\"BodyWaterMassRecord\",\"r0-shared-id\"]}]");

function aliasTextWitness(dbFile, fixture) {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const encoding = db.prepare('PRAGMA encoding').get().encoding;
    const metadataSha = db.prepare('SELECT metadata_sha256 FROM health_restore_publication').get().metadata_sha256;
    const row = fixture.kind === 'metadata' ? db.prepare('SELECT typeof(metadata_json) AS storageType, '
      + 'hex(CAST(metadata_json AS BLOB)) AS storageHex, metadata_json AS logicalText FROM health_restore_publication').get()
      : db.prepare('SELECT typeof(record_json) AS storageType, hex(CAST(record_json AS BLOB)) AS storageHex, '
        + 'record_json AS logicalText FROM health_records WHERE tenant_id=? AND source_store_id=? AND record_type=? AND native_record_id=?')
        .get(...fixture.identity);
    return { encoding, ...row, metadataSha };
  } finally { db.close(); }
}

test('SQLTEXT03 refuses physical TEXT aliases against independently trusted metadata and raw JSON bytes', t => {
  for (const fixture of SQL_TEXT_ALIASES) {
    const data = setup(t), inventory = JSON.parse(fixture.inputJSON);
    data.token = preparePublication(data.approval, inventory, JSON.parse(fixture.footerJSON));
    publishPreparedPublication(data.token);
    const healthy = readPublication(data.dbFile, { initialPreparedToken: data.token, initialOrdinaryBytes: true });
    assert.deepEqual(healthy.inputBytes, Buffer.from(fixture.inputJSON));
    assert.deepEqual(healthy.footerBytes, Buffer.from(fixture.footerJSON));
    assert.equal(healthy.inputBytes.length, fixture.inputUtf8Bytes); assert.equal(healthy.footerBytes.length, fixture.footerUtf8Bytes);
    assert.equal(healthy.publication.metadataSha256, fixture.metadataSha);
    const raw = JSON.parse(healthy.inputBytes).records[0].recordJson;
    assert.equal(raw, fixture.rawRecordJSON); assert.equal(Buffer.byteLength(raw), fixture.rawUtf8Bytes);
    assert.equal(sha(raw), fixture.rawDigest);
    const original = aliasTextWitness(data.dbFile, fixture);
    assert.equal(original.encoding, 'UTF-8'); assert.equal(original.storageType, 'text');
    assert.equal(original.storageHex, fixture.legitimatePhysicalHex); assert.equal(original.logicalText, fixture.logicalText);
    assert.equal(original.metadataSha, fixture.metadataSha);
    const db = new DatabaseSync(data.dbFile);
    try {
      const bytes = Buffer.from(fixture.malformedPhysicalHex, 'hex');
      if (fixture.kind === 'metadata') {
        assert.equal(db.prepare('UPDATE health_restore_publication SET metadata_json=CAST(? AS TEXT)').run(bytes).changes, 1);
      } else {
        assert.equal(db.prepare('UPDATE health_records SET record_json=CAST(? AS TEXT) '
          + 'WHERE tenant_id=? AND source_store_id=? AND record_type=? AND native_record_id=?')
          .run(bytes, ...fixture.identity).changes, 1);
      }
    } finally { db.close(); }
    const stored = aliasTextWitness(data.dbFile, fixture), before = data.inventory();
    assert.equal(stored.encoding, 'UTF-8'); assert.equal(stored.storageType, 'text');
    assert.equal(stored.storageHex, fixture.malformedPhysicalHex); assert.equal(stored.logicalText, fixture.logicalText);
    assert.equal(stored.metadataSha, fixture.metadataSha);
    assert.equal(Buffer.from(stored.storageHex, 'hex').length, fixture.malformedPhysicalBytes);
    assert.equal(sha(Buffer.from(stored.storageHex, 'hex')), fixture.malformedPhysicalDigest);
    assert.throws(() => controlRead(data), storageInvalid, fixture.kind + ' physical TEXT alias');
    assert.deepEqual(aliasTextWitness(data.dbFile, fixture), stored); assert.deepEqual(data.inventory(), before);
  }
});


test('policy-authority mode requires genuine approval while the ordinary reader remains unchanged', t => {
  const data = setup(t), before = data.inventory();
  assert.equal(readPublication(data.dbFile), null);
  assert.deepEqual(data.inventory(), before);
  assert.throws(() => readPublication(data.dbFile, {
    initialSourcePolicyAuthority: true, controlProfileVersion: 3,
  }), { status: 409, code: 'IMPORT_APPROVAL_REQUIRED' });
  assert.deepEqual(data.inventory(), before);
});
