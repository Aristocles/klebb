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

// The TEST-only baseline deliberately uses existing authority and existing native schema only.
// It never imports the new publisher module, so an old-code failure is an identity assertion.
const ROOT = path.resolve(__dirname, '../..');
const { nativeTables } = require('../../lib/health-connect/schema');
const RESTORE_DDL = {
  "health_restore_publication": "CREATE TABLE health_restore_publication (\n  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),\n  version INTEGER NOT NULL CHECK(version = 1), publication_id TEXT NOT NULL,\n  tenant_id TEXT NOT NULL, instance_id TEXT NOT NULL, restore_epoch TEXT NOT NULL,\n  metadata_json TEXT NOT NULL, metadata_sha256 TEXT NOT NULL, envelope_json TEXT NOT NULL)",
  "health_restore_source_owners": "CREATE TABLE health_restore_source_owners (\n  tenant_id TEXT NOT NULL, source_store_id TEXT NOT NULL, owner_id TEXT NOT NULL,\n  PRIMARY KEY (tenant_id, source_store_id))"
};
const INSTANCE = '22222222-2222-4222-8222-222222222222';
const EPOCH = '33333333-3333-4333-8333-333333333333';
function setup(t, { publication = true, owners = true, header = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'restored-boundary-test-'));
  fs.mkdirSync(path.join(home, 'db')); fs.mkdirSync(path.join(home, 'credentials'));
  const dbFile = path.join(home, 'db', 'klebb.db'), credentialFile = path.join(home, 'credentials', 'health-connect.json');
  const db = new DatabaseSync(dbFile);
  try {
    for (const ddl of Object.values(nativeTables)) db.exec(ddl);
    db.exec('INSERT INTO health_schema_version VALUES (1)');
    db.exec('CREATE INDEX health_receipt_sequence_order ON health_batch_receipts (stream_key, length(sequence), sequence)');
    const insert = db.prepare('INSERT INTO health_records VALUES (?,?,?,?,?,?,?,?,?)');
    for (const record of INVENTORY.records) insert.run(...record.identity, record.serializerId,
      record.serializerVersion, record.dataFamily, record.projection, record.recordJson);
    if (publication) db.exec(RESTORE_DDL.health_restore_publication);
    if (owners) {
      db.exec(RESTORE_DDL.health_restore_source_owners);
      for (const sourceStoreId of [ALPHA, BETA]) db.prepare('INSERT INTO health_restore_source_owners VALUES (?,?,?)')
        .run(TENANT, sourceStoreId, OWNER);
    }
    if (publication && header) {
      const raw = JSON.stringify(metadata());
      db.prepare('INSERT INTO health_restore_publication VALUES (?,?,?,?,?,?,?,?,?)').run(1,1,
        '44444444-4444-4444-8444-444444444444',TENANT,INSTANCE,EPOCH,raw,sha(raw),JSON.stringify(envelope()));
    }
  } finally { db.close(); }
  const previous = Object.fromEntries(['HEALTH_HOME','HEALTH_DB_FILE','HEALTH_CREDENTIALS_DIR']
    .map(key => [key, process.env[key]]));
  Object.assign(process.env, { HEALTH_HOME: home, HEALTH_DB_FILE: dbFile, HEALTH_CREDENTIALS_DIR: path.dirname(credentialFile) });
  const purge = () => { for (const key of Object.keys(require.cache)) {
    if (key.startsWith(ROOT + path.sep) && !key.includes(path.sep + 'node_modules' + path.sep)
      && !key.includes(path.sep + 'tests' + path.sep)) delete require.cache[key];
  }};
  purge(); const authority = require('../../lib/health-connect/authority');
  t.after(() => { purge(); for (const [key,value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } fs.rmSync(home, { recursive: true, force: true }); });
  const inventory = () => ({ database: sqlSnapshot(dbFile), credentials: fs.existsSync(credentialFile)
    ? fs.readFileSync(credentialFile).toString('hex') : null,
    credentialNames: fs.readdirSync(path.dirname(credentialFile)).sort() });
  return { home, dbFile, credentialFile, authority, inventory };
}
function emptyCache() {
  return { version:1, tenantId:TENANT, instanceId:INSTANCE, restoreEpoch:EPOCH, grants:[], connectors:[] };
}
function assertRestored(boundary) {
  assert.ok(boundary, 'complete committed publication supplies a cold boundary without a credential cache');
  assert.equal(boundary.tenantId, TENANT); assert.equal(boundary.restoreEpoch, EPOCH);
  assert.deepEqual(boundary.sources, [{ sourceStoreId:ALPHA,ownerId:OWNER },{ sourceStoreId:BETA,ownerId:OWNER }]);
  boundary.check();
}
test('missing credential cache reads committed restored owner identity without initialization or cache creation', t => {
  const data = setup(t), before = data.inventory();
  assertRestored(data.authority.sourceBoundary()); assert.deepEqual(data.inventory(), before);
});
test('valid empty credential cache retains both restored historical owner sources without rewriting', t => {
  const data = setup(t); fs.writeFileSync(data.credentialFile, JSON.stringify(emptyCache()));
  const before = data.inventory(); assertRestored(data.authority.sourceBoundary()); assert.deepEqual(data.inventory(), before);
});
test('genuine optional-family absence preserves the legacy null boundary and retained history', t => {
  const data = setup(t, { publication:false, owners:false, header:false }), before = data.inventory();
  assert.equal(data.authority.sourceBoundary(), null); assert.deepEqual(data.inventory(), before);
});
test('partial publication families, missing complete header and corrupt metadata refuse without initialization', t => {
  for (const options of [{owners:false},{publication:false},{header:false}]) {
    const data = setup(t, options), before = data.inventory();
    assert.throws(() => data.authority.sourceBoundary(), { status:503, code:'storage-unavailable' });
    assert.deepEqual(data.inventory(), before);
  }
  const data = setup(t), db = new DatabaseSync(data.dbFile);
  try { db.exec("UPDATE health_restore_publication SET metadata_sha256='sha256:" + '0'.repeat(64) + "'"); }
  finally { db.close(); }
  const before = data.inventory();
  assert.throws(() => data.authority.sourceBoundary(), { status:503, code:'storage-unavailable' });
  assert.deepEqual(data.inventory(), before);
});
test('matching secret-cache identity cannot reassign a historical restored source to a foreign owner', async t => {
  const data = setup(t), state = emptyCache();
  state.connectors.push({ id:'55555555-5555-4555-8555-555555555555', credentialVerifier:'sha256:'+'1'.repeat(64),
    ownerId:'synthetic-other-owner', installationId:'synthetic-installation', sourceStoreId:ALPHA, restoreEpoch:EPOCH,
    categories:['BodyWaterMassRecord'], generations:{BodyWaterMassRecord:'1'}, name:'Synthetic connector',
    createdAt:'2026-01-01T00:00:00.000Z', revokedAt:null });
  fs.writeFileSync(data.credentialFile, JSON.stringify(state)); const before = data.inventory();
  assert.throws(() => data.authority.sourceBoundary(), { status:503, code:'storage-unavailable' });
  let status, responseBody;
  const response = { writeHead(value) { status = value; }, end(value) { responseBody = JSON.parse(value); } };
  const handled = await data.authority.handleHealthConnect({ method:'GET', headers:{}, resume() {} }, response,
    '/api/connectors/health-connect/v1/capabilities');
  assert.equal(handled, true); assert.equal(status, 503); assert.equal(responseBody.code, 'storage-unavailable');
  assert.deepEqual(data.inventory(), before);
});
test('legitimate later raw update and deletion preserve cold publication identity without original-inventory recertification', t => {
  const data = setup(t); const db = new DatabaseSync(data.dbFile);
  try {
    db.prepare('UPDATE health_records SET record_json=? WHERE source_store_id=? AND record_type=?')
      .run(INVENTORY.records[0].recordJson.replace('43.125','43.126'), ALPHA, 'BodyWaterMassRecord');
    db.prepare('DELETE FROM health_records WHERE source_store_id=?').run(BETA);
  } finally { db.close(); }
  const before = data.inventory(); assertRestored(data.authority.sourceBoundary()); assert.deepEqual(data.inventory(), before);
});
