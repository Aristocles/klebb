// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const sourceIndex = require('../../lib/health-connect/source-index');
const { fixture, close, first, postBatch, TYPE } =
  require('../helpers/health-connect-source-index-test-fixture.cjs');
const digest = text => 'sha256:' + crypto.createHash('sha256').update(text, 'utf8').digest('hex');
function durable(db) {
  const names = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' "
    + "AND name GLOB 'health_*' ORDER BY name").all().map(row => row.name);
  return names.map(name => {
    assert.match(name, /^health_[a-z_]+$/);
    return [name, db.prepare(`SELECT * FROM "${name}"`).all()];
  });
}
function coverage(binding) {
  const window = { start: '2026-10-28T03:45:00Z', end: '2026-10-28T03:46:00Z' };
  const queryJson = JSON.stringify({ recordType: 'BodyWaterMassRecord', window,
    dataOrigins: ['example.synthetic.producer.one', 'example.synthetic.producer.two'],
    historyStart: '2026-10-01T00:00:00Z',
    features: { history: true, backgroundRead: false } });
  const fingerprint = 'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a';
  return JSON.stringify({ version: 1, kind: 'coverage', binding,
    recordType: 'BodyWaterMassRecord', window, filterDigest: digest(queryJson),
    rawFrontier: '1', status: 'partial', pagesFinished: true,
    permissionsStable: true, tokenValid: true,
    permissionFingerprintStart: fingerprint, permissionFingerprintEnd: fingerprint,
    historyIncludesScope: true, changesBarrierDrained: true, queryJson });
}
test('healthy saved ordinary source begins server custody without changing native history',
  { timeout: 20000 }, async () => {
    const data = await fixture();
    let db;
    try {
      assert.equal(TYPE, 'BodyWaterMassRecord');
      const initial = first(data);
      const admitted = await postBatch(data, initial);
      assert.equal(admitted.status, 200, 'existing authenticated ordinary batch is admitted');
      assert.deepEqual(admitted.json, initial.receipt, 'actual native receipt is independently fixed');
      await data.server.kill();
      db = new DatabaseSync(path.join(data.home, 'db', 'klebb.db'), { readOnly: true });
      db.exec('BEGIN');
      const saved = sourceIndex.savedSource(db, data.binding, data.binding.sourceStoreId);
      assert.equal(saved.complete, true, 'existing source snapshot is healthy before feature assertion');
      assert.equal(saved.records, 2);
      assert.equal(saved.tombstones, 1);
      assert.equal(saved.streams, 1);
      assert.deepEqual(saved.frontiers, [{ binding: data.binding,
        recordType: 'BodyWaterMassRecord', acknowledgedSequence: '1' }]);
      const before = durable(db);
      const result = sourceIndex.savedSource(db, data.binding, data.binding.sourceStoreId,
        { action: 'begin', binding: data.binding, categories: ['BodyWaterMassRecord'],
          coverageJson: coverage(data.binding) });
      // Old code reaches this assertion with healthy saved state but no census.
      assert.equal(result.census?.phase, 'begun', 'accepted scoped membership begins server custody');
      assert.equal(typeof result.census.handle, 'string');
      assert.ok(result.census.handle.length > 0);
      assert.equal(result.census.nativeCompleteness, 'unverified');
      assert.equal(result.census.deletionEligible, false);
      assert.deepEqual(durable(db), before, 'membership does not change any durable native/index table');
      db.exec('COMMIT');
    } finally {
      if (db) db.close();
      await close(data);
    }
  });

// These synthetic membership expectations do not certify a native provider scan.
const { BASE, ORIGIN, req, restart, pair } =
  require('../helpers/health-connect-source-index-test-fixture.cjs');
const copy = value => JSON.parse(JSON.stringify(value));
const STEPS = 'StepsRecord';
const keyFor = (binding, type, id) =>
  JSON.stringify([binding.tenantId, binding.sourceStoreId, type, id]);
const decision = (phase, seen = [], unseen = [], unresolved = []) => ({ phase,
  seenNativeKeys: seen.slice().sort(), unseenNativeKeys: unseen.slice().sort(),
  unresolvedNativeKeys: unresolved.slice().sort(), nativeCompleteness: 'unverified',
  deletionEligible: false });
function claim(binding, { type = TYPE, frontier = '1', status = 'partial', fields = {}, query = {} } = {}) {
  const wire = JSON.parse(coverage(binding));
  const description = { ...JSON.parse(wire.queryJson), recordType: type, ...query };
  Object.assign(wire, { recordType: type, rawFrontier: frontier, status,
    window: description.window, queryJson: JSON.stringify(description) }, fields);
  wire.filterDigest = digest(wire.queryJson);
  return JSON.stringify(wire);
}
function requestFor(entry, action, coverageJson, extra = {}) {
  // This binding represents the existing authenticated server context, not client authority.
  return { action, binding: entry.binding, categories: Object.keys(entry.paired.streams),
    coverageJson, ...extra };
}
function begin(db, entry, options = {}) {
  const result = sourceIndex.savedSource(db, entry.binding, entry.binding.sourceStoreId,
    requestFor(entry, 'begin', claim(entry.binding, options)));
  assert.equal(result.complete, true, 'legitimate saved native state precedes feature assertion');
  assert.equal(result.census?.phase, 'begun', 'old healthy export lacks the membership decision');
  assert.equal(result.census.nativeCompleteness, 'unverified');
  assert.equal(result.census.deletionEligible, false);
  assert.equal(typeof result.census.handle, 'string');
  return result.census.handle;
}
function seal(db, entry, handle, ids, options = {}, tokenReset = false) {
  return sourceIndex.savedSource(db, entry.binding, entry.binding.sourceStoreId,
    requestFor(entry, 'seal', claim(entry.binding, { ...options, status: options.status ?? 'complete' }),
      { handle, seenNativeRecordIds: ids, tokenReset })).census;
}
function unchanged(db, before) { assert.deepEqual(durable(db), before); }
async function admit(data, vector, headers = data.headers) {
  const response = await postBatch(data, vector, headers);
  assert.equal(response.status, 200, 'legitimate authenticated batch admission is a setup prerequisite');
  assert.deepEqual(response.json, vector.receipt, 'actual durable receipt matches independent input');
}
function batch(entry, type, sequence, changes, batchId) {
  const payloadJson = JSON.stringify({ binding: entry.binding, recordType: type,
    sequence, batchId, changes });
  const payloadDigest = digest(payloadJson);
  return { wire: { version: 1, kind: 'batch', payloadJson, payloadDigest },
    receipt: { version: 1, kind: 'durable-receipt', binding: entry.binding,
      recordType: type, sequence, batchId, payloadDigest } };
}
async function categoriesPair(data, categories, installationId) {
  const grant = await req(data.server.baseUrl, `${BASE}/pairing-grants`, {
    method: 'POST', cookie: data.owner.cookie, headers: { Origin: ORIGIN },
    body: { name: 'Synthetic census fixture', categories } });
  assert.equal(grant.status, 201);
  const response = await req(data.server.baseUrl, `${BASE}/v1/pairing/exchange`, {
    method: 'POST', body: { version: 1, kind: 'pairing-exchange',
      tenantId: grant.json.tenantId, instanceId: grant.json.instanceId,
      sourceStoreId: grant.json.sourceStoreId, installationId,
      categories, grant: grant.json.grant } });
  assert.equal(response.status, 200);
  const paired = response.json;
  data.markers.push(grant.json.grant, paired.credential);
  function forType(type) {
    const binding = { tenantId: paired.tenantId, instanceId: paired.instanceId,
      sourceStoreId: paired.sourceStoreId, installationId: paired.installationId,
      generation: paired.streams[type].generation, restoreEpoch: paired.restoreEpoch };
    return { paired, binding, headers: { Authorization: `Bearer ${paired.credential}`,
      'Klebb-Health-Protocol': '1', 'Klebb-Health-Generation': binding.generation,
      'Klebb-Health-Restore-Epoch': binding.restoreEpoch } };
  }
  return { forType };
}
function intervalChange(entry, start = '2026-10-28T03:44:00.000000001Z',
  end = '2026-10-28T03:47:00.000000001Z') {
  return { operation: 'upsert', identity: { tenantId: entry.binding.tenantId,
    sourceStoreId: entry.binding.sourceStoreId, recordType: STEPS, nativeRecordId: 'raw-a' },
    dataFamily: 'ordinary', projection: 'raw-only', serializerId: 'health-connect-record',
    serializerVersion: 1, record: { metadata: { id: 'raw-a',
      dataOrigin: { packageName: 'example.synthetic.producer.one' },
      lastModifiedTime: '2026-10-28T03:50:00.000000001Z', recordingMethod: 1 },
    startTime: start, endTime: end, startZoneOffset: null, endZoneOffset: null, count: '27' } };
}
async function readDb(data) {
  await data.server.kill();
  const db = new DatabaseSync(path.join(data.home, 'db', 'klebb.db'), { readOnly: true });
  db.exec('BEGIN'); return db;
}
function release(db) { if (db) { db.exec('ROLLBACK'); db.close(); } }

test('foreign source and foreign type sharing a raw ID never enter the bound census',
  { timeout: 20000 }, async () => {
    const data = await fixture(); let db;
    try {
      await admit(data, first(data));
      const multi = await categoriesPair(data, [TYPE, STEPS], 'synthetic-census-foreign');
      const target = multi.forType(TYPE); const steps = multi.forType(STEPS);
      await admit(data, first(target), target.headers);
      await admit(data, batch(steps, STEPS, '1', [intervalChange(steps)], 'census-steps-1'), steps.headers);
      db = await readDb(data); const before = durable(db);
      const handle = begin(db, target);
      assert.deepEqual(seal(db, target, handle, ['raw-a']), decision('complete',
        [keyFor(target.binding, TYPE, 'raw-a')], [keyFor(target.binding, TYPE, 'raw-b')]));
      unchanged(db, before);
      assert.equal(sourceIndex.savedSource(db, data.binding, data.binding.sourceStoreId).records, 2);
      assert.equal(sourceIndex.savedSource(db, target.binding, target.binding.sourceStoreId).records, 3);
    } finally { release(db); await close(data); }
  });

test('accepted corrected interval movement leaves the old query without a deletion',
  { timeout: 20000 }, async () => {
    const data = await fixture(); let db;
    try {
      const multi = await categoriesPair(data, [STEPS], 'synthetic-census-interval');
      const target = multi.forType(STEPS);
      await admit(data, batch(target, STEPS, '1', [intervalChange(target)], 'census-interval-1'), target.headers);
      db = await readDb(data); let before = durable(db);
      assert.deepEqual(seal(db, target, begin(db, target, { type: STEPS }), [], { type: STEPS }),
        decision('complete', [], [keyFor(target.binding, STEPS, 'raw-a')]));
      unchanged(db, before); release(db); db = null;
      await restart(data);
      await admit(data, batch(target, STEPS, '2', [intervalChange(target,
        '2026-10-29T03:44:00.000000001Z', '2026-10-29T03:47:00.000000001Z')],
      'census-interval-2'), target.headers);
      db = await readDb(data); before = durable(db);
      assert.deepEqual(seal(db, target, begin(db, target, { type: STEPS, frontier: '2' }), [],
        { type: STEPS, frontier: '2' }), decision('complete'));
      unchanged(db, before);
      const saved = sourceIndex.savedSource(db, target.binding, target.binding.sourceStoreId);
      assert.equal(saved.records, 1); assert.equal(saved.tombstones, 0);
      const raw = db.prepare('SELECT record_json FROM health_records WHERE tenant_id=? AND source_store_id=? AND record_type=? AND native_record_id=?')
        .get(target.binding.tenantId, target.binding.sourceStoreId, STEPS, 'raw-a');
      assert.equal(JSON.parse(raw.record_json).startTime, '2026-10-29T03:44:00.000000001Z');
    } finally { release(db); await close(data); }
  });

test('partial pages, permissions, fingerprints, history and barriers yield no absence authority',
  { timeout: 20000 }, async () => {
    const data = await fixture(); let db;
    try {
      await admit(data, first(data)); db = await readDb(data); const before = durable(db);
      const variants = [ { status: 'partial' }, { fields: { pagesFinished: false } },
        { fields: { permissionsStable: false } }, { fields: { tokenValid: false } },
        { fields: { permissionFingerprintEnd: 'sha256:' + '1'.repeat(64) } },
        { fields: { historyIncludesScope: false } }, { fields: { changesBarrierDrained: false } },
        { query: { historyStart: '2026-10-28T03:45:30Z' } } ];
      for (const options of variants) {
        const handle = begin(db, data, { query: options.query });
        assert.deepEqual(seal(db, data, handle, ['raw-a'], options), decision('incomplete'));
        unchanged(db, before);
      }
    } finally { release(db); await close(data); }
  });

test('stale untrusted bindings, changed custody and malformed saved receipts are refused',
  { timeout: 20000 }, async () => {
    const data = await fixture(); let db;
    try {
      await admit(data, first(data)); db = await readDb(data); let before = durable(db);
      const changes = { generation: '0', restoreEpoch: '55555555-5555-4555-8555-555555555555',
        tenantId: '66666666-6666-4666-8666-666666666666',
        sourceStoreId: '77777777-7777-4777-8777-777777777777' };
      for (const [field, value] of Object.entries(changes)) {
        const handle = begin(db, data);
        const wire = JSON.parse(claim(data.binding, { status: 'complete' }));
        wire.binding = { ...data.binding, [field]: value };
        assert.throws(() => sourceIndex.savedSource(db, data.binding, data.binding.sourceStoreId,
          requestFor(data, 'seal', JSON.stringify(wire), { handle,
            seenNativeRecordIds: ['raw-a'], tokenReset: false })),
        error => error.code === 'binding-mismatch');
        unchanged(db, before);
      }
      for (const options of [ { query: { dataOrigins: ['example.synthetic.producer.one'] } },
        { fields: { permissionFingerprintStart: 'sha256:' + '2'.repeat(64),
          permissionFingerprintEnd: 'sha256:' + '2'.repeat(64) } } ]) {
        const handle = begin(db, data);
        assert.throws(() => seal(db, data, handle, ['raw-a'], options),
          error => error.code === 'binding-mismatch' && error.status === 409);
        unchanged(db, before);
      }
      const stale = begin(db, data); begin(db, data);
      assert.throws(() => seal(db, data, stale, ['raw-a']),
        error => error.code === 'binding-mismatch' && error.status === 409);
      const ahead = begin(db, data);
      assert.throws(() => seal(db, data, ahead, ['raw-a'], { frontier: '2' }),
        error => error.code === 'frontier-lag');
      unchanged(db, before);
      const receiptHandle = begin(db, data); release(db); db = null;
      await restart(data);
      const correction = copy(first(data).payload.changes[0]);
      correction.record.time = '2026-10-29T03:45:00.123456789Z';
      await admit(data, batch(data, TYPE, '2', [correction], 'census-point-correction-2'));
      db = await readDb(data); before = durable(db);
      assert.throws(() => seal(db, data, receiptHandle, ['raw-a'], { frontier: '2' }),
        error => error.code === 'binding-mismatch' && error.status === 409);
      unchanged(db, before);
      release(db); db = null;
      const writer = new DatabaseSync(path.join(data.home, 'db', 'klebb.db'));
      try { writer.prepare('UPDATE health_batch_receipts SET receipt_json=?')
        .run('{}'); } finally { writer.close(); }
      db = new DatabaseSync(path.join(data.home, 'db', 'klebb.db'), { readOnly: true }); db.exec('BEGIN');
      before = durable(db);
      assert.throws(() => sourceIndex.savedSource(db, data.binding, data.binding.sourceStoreId),
        error => error.name === 'ProtocolError' && error.code === 'unsupported-version');
      unchanged(db, before);
    } finally { release(db); await close(data); }
  });

test('token reset makes an otherwise complete census incomplete without a deletion',
  { timeout: 20000 }, async () => {
    const data = await fixture(); let db;
    try {
      await admit(data, first(data)); db = await readDb(data); const before = durable(db);
      assert.deepEqual(seal(db, data, begin(db, data), ['raw-a'], {}, true), decision('incomplete'));
      unchanged(db, before);
    } finally { release(db); await close(data); }
  });

test('initialized true zero and populated complete empty scans stay provisional and write nothing',
  { timeout: 20000 }, async () => {
    const data = await fixture(); let db;
    try {
      // An actual other-source receipt initializes native storage; the empty source has no dummy receipt.
      await admit(data, first(data)); const empty = await pair(data, 'synthetic-census-true-zero');
      db = await readDb(data); const before = durable(db);
      const saved = sourceIndex.savedSource(db, empty.binding, empty.binding.sourceStoreId);
      assert.equal(saved.records, 0); assert.equal(saved.streams, 0); assert.deepEqual(saved.frontiers, []);
      assert.deepEqual(seal(db, empty, begin(db, empty, { frontier: '0' }), [], { frontier: '0' }),
        decision('complete'));
      assert.deepEqual(seal(db, data, begin(db, data), []), decision('complete', [],
        [keyFor(data.binding, TYPE, 'raw-a'), keyFor(data.binding, TYPE, 'raw-b')]));
      unchanged(db, before);
    } finally { release(db); await close(data); }
  });
