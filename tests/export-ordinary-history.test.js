// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const G = require('./helpers/export-native-source-fixture.cjs');
const golden = require('./helpers/ordinary-archive-golden.cjs');

// Fixed independently of the exporter: these are the existing archive literals.
const PAYLOAD = 'data/health-connect/ordinary-history.json';
const FOOTER = 'data/health-connect/ordinary-history-footer.json';
const PROFILE = { version: 1,
  payload: { file: PAYLOAD, bytes: 4419,
    sha256: '0331b06e9595a6115e11ab8712d7d5884a3e89f96b48fc0348350396342ff00b' },
  footer: { file: FOOTER, bytes: 182,
    sha256: '6a29e1acbdc2b06cca969ae35b9acd771717ac69f39fbdcb194104d9e3ef2373' } };
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const inventory = () => JSON.parse(golden.ORDINARY_BYTE_INPUT_JSON);
const sourceState = f => ({ sql: G.sql(f.dbFile), files: G.F.files(f.home) });
function change(f, fn) {
  const db = new DatabaseSync(f.dbFile);
  try { fn(db); } finally { db.close(); }
}
async function publication(f, value = inventory(), footer = JSON.parse(golden.ORDINARY_BYTE_FOOTER_JSON)) {
  await G.withEnv(f, () => {
    G.H.purgeRepoModules();
    const { issueOwnerApproval } = require('../lib/import/owner-approval');
    const { preparePublication, publishPreparedPublication } = require('../lib/import/native-publication');
    const actor = { ownerId: 'synthetic-owner', check: () => 'synthetic-owner' };
    const approval = issueOwnerApproval(actor, { jobId: 'synthetic-ordinary-export',
      treePath: path.join(f.root, 'controlled-input'), targetHome: f.home, selectedDbFile: f.dbFile });
    publishPreparedPublication(preparePublication(approval, value, footer));
  });
  // The normal publisher created a valid initial publication, not operational
  // policy/deletion authority. The source controls remain independently checked.
  const state = G.sql(f.dbFile);
  assert.equal(state.integrity, 'ok');
  assert.equal(G.table(state, 'health_records').rows.length, 3);
  assert.equal(G.table(state, 'health_restore_source_owners').rows.length, 2);
  for (const name of ['health_streams', 'health_batch_receipts',
    'health_projection_outbox', 'health_tombstones']) assert.equal(G.table(state, name).rows.length, 0);
  const meta = JSON.parse(G.table(state, 'health_restore_publication').rows[0].metadata_json);
  for (const family of ['catalog', 'sourcePolicies', 'tombstones', 'suppressions']) {
    assert.deepEqual(meta[family], value[family]);
  }
}
function checkArchive(out) {
  const manifest = JSON.parse(fs.readFileSync(path.join(out, 'klebb-export.json'), 'utf8'));
  assert.equal(manifest.format, 'klebb.export.v1');
  assert.equal(manifest.formatVersion, 2);
  assert.deepEqual(manifest.inventory.ordinaryHistory, PROFILE);
  assert.equal(fs.readFileSync(path.join(out, PAYLOAD), 'utf8'), golden.ORDINARY_BYTE_INPUT_JSON);
  assert.equal(fs.readFileSync(path.join(out, FOOTER), 'utf8'), golden.ORDINARY_BYTE_FOOTER_JSON);
  assert.equal(manifest.inventory.cards.length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'data/weight.json'), 'utf8')).data, G.WEIGHT_ROWS);
  for (const family of ['cards', 'reports', 'other']) for (const entry of manifest.inventory[family]) {
    assert.equal(sha(fs.readFileSync(path.join(out, entry.file))), entry.sha256);
  }
  assert.equal(manifest.inventory.other.some(e => [PAYLOAD, FOOTER].includes(e.file)), false);
  for (const forbidden of ['credentials', 'db', 'sessions', 'keys']) assert.equal(fs.existsSync(path.join(out, forbidden)), false);
  return manifest;
}

test('OEX01: valid persisted publication writes the fixed ordinary archive without changing its source', async () => {
  const f = G.fixture();
  try {
    await publication(f);
    const before = sourceState(f), out = G.output(f), result = G.cli(f, out);
    G.checks([() => assert.ifError(result.error), () => assert.ifError(result.captureError),
      () => assert.equal(result.signal, null), () => assert.equal(result.status, 0, 'valid publication exporter succeeds'),
      () => assert.deepEqual(sourceState(f), before, 'complete SQL/file source inventory is unchanged')]);
    checkArchive(out);
    const { validateTree } = require('../lib/import/validate');
    const readOnly = await validateTree(out, { ordinaryArchiveReadOnly: true });
    assert.equal(readOnly.ok, true, JSON.stringify(readOnly.findings));
    const ordinary = await validateTree(out);
    assert.equal(ordinary.ok, false, 'read-only archive output does not enable import/apply');
    assert.equal(ordinary.findings.some(x => x.code === 'VAL_FORMAT_NEWER'), true);
  } finally { G.F.dispose(f); }
});

async function refused(changeSource, token = 'native-history-source-unavailable', value, footer) {
  const f = G.fixture();
  try {
    await publication(f, value, footer);
    await changeSource(f);
    const before = sourceState(f), out = G.output(f), result = G.cli(f, out);
    G.checks([() => assert.ifError(result.error), () => assert.ifError(result.captureError),
      () => assert.equal(result.signal, null), () => assert.equal(result.status, 2),
      () => assert.equal(result.stderr.includes('error: ' + token), true),
      () => assert.equal(fs.existsSync(out), false, 'source refusal precedes output creation'),
      () => assert.deepEqual(sourceState(f), before),
      () => assert.equal([...G.F.RETAINED_SECRETS, ...inventory().records.map(r => r.recordJson)]
        .some(v => (result.stdout + result.stderr).includes(v)), false, 'no payload or verifier diagnostics')]);
  } finally { G.F.dispose(f); }
}

test('OEX02: missing, changed, extra and non-TEXT native rows cannot become a successful archive', async () => {
  const mutations = [
    db => db.exec("DELETE FROM health_records WHERE record_type='CyclingPedalingCadenceRecord'"),
    db => db.exec("UPDATE health_records SET record_json=replace(record_json,'43.125','43.126')"),
    db => db.exec("INSERT INTO health_records SELECT tenant_id,source_store_id,record_type,'extra-id',serializer_id,serializer_version,data_family,projection,record_json FROM health_records LIMIT 1"),
    db => db.exec('UPDATE health_records SET serializer_version=2'),
    db => db.exec("UPDATE health_records SET record_json=CAST(x'ff' AS TEXT)"),
    db => db.exec("UPDATE health_records SET native_record_id=zeroblob(1048577)"),
    db => db.exec("DELETE FROM health_restore_source_owners WHERE source_store_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'"),
  ];
  for (const mutate of mutations) await refused(f => change(f, mutate));
});

test('OEX03: invalid metadata, envelope, schema and unexpected SQL objects stay refused', async () => {
  const mutations = [
    db => db.exec("UPDATE health_restore_publication SET metadata_sha256='sha256:" + '0'.repeat(64) + "'"),
    db => db.exec("UPDATE health_restore_publication SET envelope_json='{}'"),
    db => db.exec("UPDATE health_restore_publication SET metadata_json=CAST(x'ff' AS TEXT)"),
    db => db.exec('DROP TABLE health_restore_source_owners'),
    db => db.exec('CREATE TABLE health_unknown (data TEXT)'),
    db => db.exec('CREATE TRIGGER unexpected_native_change AFTER INSERT ON health_records BEGIN SELECT 1; END'),
    db => db.exec('CREATE TRIGGER health_unknown_transport AFTER INSERT ON cards BEGIN SELECT 1; END'),
    db => db.exec('CREATE INDEX unexpected_native_index ON health_records(record_type)'),
    db => {
      const row = db.prepare('SELECT metadata_json FROM health_restore_publication').get();
      const altered = row.metadata_json + ' ';
      db.prepare('UPDATE health_restore_publication SET metadata_json=?,metadata_sha256=?')
        .run(altered, 'sha256:' + sha(altered));
    },
    db => {
      const row = db.prepare('SELECT envelope_json FROM health_restore_publication').get();
      const footer = JSON.parse(row.envelope_json); footer.sha256 = 'sha256:' + '0'.repeat(64);
      db.prepare('UPDATE health_restore_publication SET envelope_json=?').run(JSON.stringify(footer));
    },
  ];
  for (const mutate of mutations) await refused(f => change(f, mutate));
});

test('OEX04: operational transport, deletion and credential state cannot be silently omitted', async () => {
  for (const mutate of [
    db => db.exec("INSERT INTO health_streams VALUES('synthetic-stream','StepsRecord','1')"),
    db => db.exec("INSERT INTO health_tombstones VALUES('synthetic-tenant','synthetic-store','StepsRecord','synthetic-id','synthetic-stream','1')"),
  ]) await refused(f => change(f, mutate), 'native-history-export-unsupported');
  await refused(f => {
    const state = { version: 1, tenantId: '22222222-2222-4222-8222-222222222222',
      instanceId: '33333333-3333-4333-8333-333333333333',
      restoreEpoch: '44444444-4444-4444-8444-444444444444',
      grants: [{ marker: 'synthetic-retained-authority' }], connectors: [] };
    fs.mkdirSync(path.dirname(f.authorityFile), { recursive: true });
    fs.writeFileSync(f.authorityFile, JSON.stringify(state));
  }, 'native-history-export-unsupported');
});

test('OEX05: unrecorded original property layouts remain refused against their genuine stored digest', async () => {
  const value = inventory();
  value.records = value.records.map(({ recordJson, ...descriptor }) => ({ ...descriptor, recordJson }));
  const input = JSON.stringify(value);
  const footer = { version: 1, counts: { sources: 2, records: 3, sourcePolicies: 2, tombstones: 2, suppressions: 1 },
    sha256: 'sha256:' + sha(input) };
  await refused(() => {}, 'native-history-source-unavailable', value, footer);
});

test('OEX06: output errors, including a completed manifest write that throws, leave no success manifest', async () => {
  for (const failure of ['payload', 'footer', 'manifest', 'manifest-after-write']) {
    const f = G.fixture();
    try {
      await publication(f);
      const before = sourceState(f), out = G.output(f);
      await G.withEnv(f, () => {
        G.H.purgeRepoModules();
        const { exportTo } = require('../scripts/export-embed');
        const samples = require('../health-auto-export/samples');
        const oldWrite = fs.writeFileSync, oldOpen = fs.openSync;
        const opened = new Map();
        const failFile = failure === 'payload' ? PAYLOAD : failure === 'footer' ? FOOTER : 'klebb-export.json';
        const written = [];
        try {
          fs.openSync = function (file, ...args) {
            const descriptor = oldOpen.call(this, file, ...args);
            opened.set(descriptor, String(file)); return descriptor;
          };
          fs.writeFileSync = function (file, ...args) {
            const name = typeof file === 'number' ? opened.get(file) : String(file);
            written.push(path.relative(out, name).split(path.sep).join('/'));
            const isManifest = ['klebb-export.json', 'klebb-export.json.tmp'].includes(path.basename(name));
            if ((failure === 'manifest' || failure === 'manifest-after-write') && isManifest) {
              if (failure === 'manifest-after-write') oldWrite.call(this, file, ...args);
              throw new Error('synthetic-output-failure');
            }
            if (path.resolve(name) === path.join(out, failFile)) throw new Error('synthetic-output-failure');
            return oldWrite.call(this, file, ...args);
          };
          assert.throws(() => exportTo(out), /synthetic-output-failure/);
          assert.equal(fs.existsSync(path.join(out, 'klebb-export.json')), false);
          if (failure.startsWith('manifest')) assert.match(written.at(-1), /^klebb-export\.json(?:\.tmp)?$/, 'manifest is attempted last');
        } finally {
          fs.writeFileSync = oldWrite; fs.openSync = oldOpen; samples.close();
        }
      });
      assert.deepEqual(sourceState(f), before);
    } finally { G.F.dispose(f); }
  }
});

test('OEX07: header descriptors cannot substitute their own recordJson for changed physical rows', async () => {
  await refused(f => change(f, db => {
    const header = db.prepare('SELECT metadata_json FROM health_restore_publication').get();
    const meta = JSON.parse(header.metadata_json);
    meta.recordDescriptors[0].recordJson = inventory().records[0].recordJson;
    const bytes = JSON.stringify(meta);
    db.prepare('UPDATE health_restore_publication SET metadata_json=?,metadata_sha256=?').run(bytes, 'sha256:' + sha(bytes));
    db.exec("UPDATE health_records SET record_json=replace(record_json,'43.125','43.126')");
  }));
});

test('OEX08: partial legacy and retained or partial HAE state refuse without repairing the source', async () => {
  await refused(f => change(f, db => db.exec('DROP TABLE rows')));
  await refused(f => change(f, db => db.exec('DROP TABLE hae_samples')));
  await refused(f => change(f, db => db.exec("INSERT INTO hae_pushes(received_at,source_file) VALUES('2026-01-01T00:00:00Z',NULL)")),
    'native-history-export-unsupported');
});

test('OEX09: absence of all legacy and HAE tables preserves inline card data and the native source', async () => {
  const f = G.fixture();
  try {
    await publication(f);
    change(f, db => db.exec('DROP TABLE rows; DROP TABLE cards; DROP TABLE schema_version; DROP TABLE hae_samples; DROP TABLE hae_pushes'));
    const cardFile = path.join(f.home, 'data', 'weight.json');
    const card = JSON.parse(fs.readFileSync(cardFile, 'utf8')); card.data = G.WEIGHT_ROWS;
    fs.writeFileSync(cardFile, JSON.stringify(card));
    const before = sourceState(f), out = G.output(f), result = G.cli(f, out);
    G.checks([() => assert.ifError(result.error), () => assert.ifError(result.captureError),
      () => assert.equal(result.status, 0), () => assert.deepEqual(sourceState(f), before)]);
    checkArchive(out);
  } finally { G.F.dispose(f); }
});

test('OEX10: valid UTF-16 publication bytes emit the same independently fixed UTF-8 streams', async () => {
  for (const encoding of ['UTF-16le', 'UTF-16be']) {
    const originalExec = DatabaseSync.prototype.exec;
    let initialized = false, f;
    DatabaseSync.prototype.exec = function (sql, ...args) {
      if (!initialized && sql.includes('CREATE TABLE IF NOT EXISTS schema_version')) {
        originalExec.call(this, "PRAGMA encoding='" + encoding + "'"); initialized = true;
      }
      return originalExec.call(this, sql, ...args);
    };
    try { f = G.fixture(); } finally { DatabaseSync.prototype.exec = originalExec; }
    try {
      assert.equal(initialized, true, 'the actual database was created in the selected encoding');
      await publication(f);
      change(f, db => assert.equal(db.prepare('PRAGMA encoding').get().encoding, encoding));
      const before = sourceState(f), out = G.output(f), result = G.cli(f, out);
      G.checks([() => assert.ifError(result.error), () => assert.ifError(result.captureError),
        () => assert.equal(result.status, 0), () => assert.deepEqual(sourceState(f), before)]);
      checkArchive(out);
    } finally { if (f) G.F.dispose(f); }
  }
});

test('OEX11: NULL legacy keys cannot hide oversized TEXT from the pre-materialization bound', async () => {
  const f = G.fixture();
  try {
    await publication(f);
    change(f, db => db.prepare('INSERT INTO cards(card_id,shape,data_updated_at) VALUES(NULL,?,?)')
      .run('x'.repeat(1048577), '2026-01-01T00:00:00Z'));
    const before = sourceState(f);
    await G.withEnv(f, () => {
      G.H.purgeRepoModules();
      const { readExportableSource } = require('../lib/export/native-source');
      const originalPrepare = DatabaseSync.prototype.prepare;
      let cardRowMaterializations = 0;
      try {
        DatabaseSync.prototype.prepare = function (...args) {
          const statement = originalPrepare.apply(this, args);
          const all = statement.all;
          statement.all = function (...values) {
            const rows = all.apply(this, values);
            if (rows.some(row => ['card_id', 'shape', 'data_updated_at'].every(name => Object.hasOwn(row, name)))) {
              cardRowMaterializations++;
            }
            return rows;
          };
          return statement;
        };
        const control = new DatabaseSync(f.dbFile, { readOnly: true });
        try { control.prepare("SELECT card_id,shape,data_updated_at FROM cards WHERE card_id='weight'").all(); }
        finally { control.close(); }
        assert.equal(cardRowMaterializations, 1, 'independent healthy fetch proves the boundary observer is active');
        cardRowMaterializations = 0;
        assert.throws(() => readExportableSource(f.dbFile, f.authorityFile), /native-history-source-unavailable/);
        assert.equal(cardRowMaterializations, 0, 'invalid oversized source refuses before fetching card TEXT rows');
      } finally { DatabaseSync.prototype.prepare = originalPrepare; }
    });
    assert.deepEqual(sourceState(f), before);
  } finally { G.F.dispose(f); }
});
