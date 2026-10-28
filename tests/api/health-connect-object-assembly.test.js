// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Outside-product expected actual API cases. Do not execute until #779 is
// merged and the declared independent physical reader/fixtures are registered.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const product = process.env.INDEPENDENT_PRODUCT_ROOT || path.resolve(__dirname, '../..');
const { createSandbox, cleanupSandbox, spawnServer, req, fakeAuthState } =
  require(path.join(product, 'tests/helpers/sandbox'));
const { coldReadNative } =
  require(path.join(product, 'tests/helpers/health-connect-cold-readback.cjs'));
const { coldReadObjects } =
  require(path.join(product, 'tests/helpers/health-connect-object-cold-readback.cjs'));
const { makeObject, verifyOriginalBank, sha, TYPE } = require(
  process.env.INDEPENDENT_PRODUCT_ROOT ?
    path.join(__dirname, '../../independent-object-fixtures.cjs') :
    path.join(product, 'tests/helpers/health-connect-independent-object-fixtures.cjs'));
const BASE = '/api/connectors/health-connect';
const PART = `${BASE}/v1/object-parts`;
const FINAL = `${BASE}/v1/object-finalise`;
const ORIGIN = 'https://assembly.example.test';
const LEGACY = { $schema: 'klebb.datafile.v1',
  meta: { id: 'synthetic-assembly-legacy', label: 'Synthetic assembly legacy' },
  data: [{ date: '2026-10-20', kg: 35.5, note: 'preserve independent legacy row' }] };
const ENV = {
  HEALTH_ORIGIN: ORIGIN, HEALTH_RP_ID: 'assembly.example.test',
  AGENT_API_TOKEN: '', KLEBB_ADMIN_TOKEN: '', KLEBB_CLOUD: '', KLEBB_DEMO: '',
  HEALTH_DATA_DIR: '', HEALTH_REPORTS_DIR: '', HEALTH_AUTO_EXPORT_DIR: '',
  HEALTH_SESSIONS_DIR: '', HEALTH_CREDENTIALS_DIR: '', HEALTH_ARCHIVE_DIR: '',
  HEALTH_CONFIG_PATH: '', HEALTH_DB_DIR: '', HEALTH_DB_FILE: '', HEALTH_CHAT_DIR: '',
  HEALTH_USER_FILE: '', HEALTH_NOTIFICATIONS_STATE_FILE: '', HEALTH_INBOX_DIR: '',
  HEALTH_KEYS_DIR: '', HEALTH_VAPID_FILE: '', HEALTH_PUSH_SUBSCRIPTIONS_FILE: '',
  HEALTH_AUTO_EXPORT_TOKEN: '', HEALTH_CONNECT_STAGING_MAX_BYTES: '', NODE_OPTIONS: '',
};
async function fixture() {
  const owner = fakeAuthState('assembly-owner');
  const home = createSandbox({ credentials: owner.credentials, sessions: owner.sessions,
    seed: { 'synthetic-assembly-legacy.json': LEGACY } });
  let server;
  try {
    server = await spawnServer(home, ENV);
    const data = { home, owner, server, requestPhaseLogs: '' };
    watch(data);
    const grant = await req(server.baseUrl, `${BASE}/pairing-grants`, {
      method: 'POST', cookie: owner.cookie, headers: { Origin: ORIGIN },
      body: { name: 'Synthetic assembly phone', categories: [TYPE] },
    });
    assert.equal(grant.status, 201);
    const exchange = await req(server.baseUrl, `${BASE}/v1/pairing/exchange`, {
      method: 'POST', body: { version: 1, kind: 'pairing-exchange',
        tenantId: grant.json.tenantId, instanceId: grant.json.instanceId,
        sourceStoreId: grant.json.sourceStoreId, installationId: 'synthetic-durable-installation',
        categories: [TYPE], grant: grant.json.grant },
    });
    assert.equal(exchange.status, 200);
    const paired = exchange.json;
    const binding = { tenantId: paired.tenantId, instanceId: paired.instanceId,
      sourceStoreId: paired.sourceStoreId, installationId: paired.installationId,
      generation: paired.streams[TYPE].generation, restoreEpoch: paired.restoreEpoch };
    const headers = { Authorization: `Bearer ${paired.credential}`, 'Klebb-Health-Protocol': '1',
      'Klebb-Health-Generation': binding.generation,
      'Klebb-Health-Restore-Epoch': binding.restoreEpoch };
    const baseline = coldReadNative(home);
    assert.ok(baseline.legacyCards.some(row => row.card_id === LEGACY.meta.id));
    const rows = baseline.legacyRows.filter(row => row.card_id === LEGACY.meta.id);
    assert.equal(rows.length, 1);
    assert.deepEqual(JSON.parse(rows[0].doc), LEGACY.data[0]);
    return Object.assign(data, { binding, headers, paired, baseline,
      markers: [paired.credential, grant.json.grant, owner.token] });
  } catch (error) {
    if (server) await server.kill();
    cleanupSandbox(home);
    throw error;
  }
}
function watch(data) {
  // Existing spawnServer does not expose pre-ready startup output.
  for (const stream of [data.server.proc.stdout, data.server.proc.stderr]) {
    stream.on('data', bytes => { data.requestPhaseLogs += bytes.toString('utf8'); });
  }
}
function noAuthority(text, data) {
  for (const marker of data.markers) {
    assert.equal(typeof marker, 'string');
    assert.ok(marker.length > 20, 'actual-issued authority marker must be nonempty');
    assert.equal(text.includes(marker), false);
  }
}
async function close(data) {
  if (data.server) await data.server.kill();
  try { noAuthority(data.requestPhaseLogs, data); } finally { cleanupSandbox(data.home); }
}
async function restart(data) {
  await data.server.kill();
  data.server = await spawnServer(data.home, ENV);
  watch(data);
}
const post = (data, route, body, headers = data.headers) =>
  req(data.server.baseUrl, route, { method: 'POST', headers, body });
function failure(response, status, code, data) {
  assert.equal(response.status, status);
  assert.equal(response.json.kind, 'error');
  assert.equal(response.json.code, code);
  assert.notEqual(response.json.kind, 'durable-receipt');
  noAuthority(response.body, data);
}
async function refusedWithoutEffects(data, route, body, status, code, headers = data.headers) {
  const nativeBefore = coldReadNative(data.home);
  const objectsBefore = coldReadObjects(data.home);
  failure(await post(data, route, body, headers), status, code, data);
  assert.deepEqual(coldReadNative(data.home), nativeBefore,
    'each individual refusal preserves complete native state before another attack');
  assert.deepEqual(coldReadObjects(data.home), objectsBefore,
    'each individual refusal preserves all physical/capacity state before another attack');
  legacy(nativeBefore, data);
}
function legacy(snapshot, data) {
  assert.deepEqual(snapshot.legacyCards, data.baseline.legacyCards);
  assert.deepEqual(snapshot.legacyRows, data.baseline.legacyRows);
  noAuthority(snapshot.logicalNativeDump, data);
}
function emptyNative(data) {
  const snapshot = coldReadNative(data.home);
  for (const field of ['records', 'tombstoneIds', 'receipts', 'frontiers', 'jobs']) {
    assert.deepEqual(snapshot[field], []);
  }
  legacy(snapshot, data);
}
async function frontier(data, expected) {
  const response = await req(data.server.baseUrl,
    `${BASE}/v1/streams/${TYPE}/status`, { headers: data.headers });
  assert.equal(response.status, 200);
  assert.equal(response.json.acknowledgedSequence, expected);
}
function observedParts(data, object, indices) {
  const snapshot = coldReadObjects(data.home);
  assert.equal(snapshot.objects.length, 1);
  const actual = snapshot.objects[0];
  assert.deepEqual(actual.declaration, object.header);
  assert.equal(actual.reservationBytes, object.header.totalBytes);
  assert.equal(snapshot.aggregateReservedBytes, object.header.totalBytes);
  assert.equal(actual.expiresAt - actual.createdAt, 86400000);
  assert.deepEqual(actual.parts, indices.slice().sort((a, b) => a - b)
    .map(index => object.manifest[index]));
  assert.equal(snapshot.physicalPartCount, indices.length);
  assert.equal(snapshot.physicalPayloadBytes,
    indices.reduce((sum, index) => sum + object.manifest[index].bytes, 0));
  noAuthority(snapshot.compactText, data);
  return snapshot;
}
function purgedParts(data, object) {
  const snapshot = coldReadObjects(data.home);
  assert.deepEqual(snapshot.objects, []);
  assert.equal(snapshot.aggregateReservedBytes, 0);
  assert.equal(snapshot.physicalPartCount, 0);
  assert.equal(snapshot.physicalPayloadBytes, 0);
  assert.deepEqual(snapshot.committedDeclarations,
    [{ declaration: object.header, parts: object.manifest }]);
  assert.equal(snapshot.compactText.includes('P'.repeat(256)), false,
    'compact retry metadata must not archive the record padding');
  assert.equal(snapshot.compactText.includes(object.partFrames[1].partBase64.slice(0, 256)), false);
  noAuthority(snapshot.compactText, data);
  return snapshot;
}
async function stage(data, object, indices = object.manifest.map(part => part.index)) {
  for (const index of indices) {
    const response = await post(data, PART, object.partFrames[index]);
    assert.equal(response.status, 200);
    assert.deepEqual(response.json, object.partReceipts[index]);
    noAuthority(response.body, data);
  }
}
function completeNative(data, object) {
  const snapshot = coldReadNative(data.home);
  assert.deepEqual(snapshot.records, [{ identity: object.payload.changes[0].identity,
    record: object.payload.changes[0].record }]);
  assert.deepEqual(snapshot.tombstoneIds, []);
  assert.deepEqual(snapshot.receipts, [object.receipt]);
  assert.deepEqual(snapshot.frontiers,
    [{ recordType: TYPE, acknowledgedSequence: '1' }]);
  assert.deepEqual(snapshot.jobs, [{ batchId: object.header.batchId, state: 'queued' }]);
  legacy(snapshot, data);
  return snapshot;
}
async function committed(data, object) {
  const response = await post(data, FINAL, object.finalise);
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, object.receipt);
  noAuthority(response.body, data);
}
test('complete object commits exact raw-only payload after physical part proof and leaves only compact retry metadata',
  async () => {
    verifyOriginalBank();
    const data = await fixture();
    try {
      const object = makeObject(data.binding);
      assert.equal(object.bytes.length, 1049872);
      await stage(data, object, [2, 0, 1]);
      observedParts(data, object, [0, 1, 2]);
      emptyNative(data);
      await frontier(data, '0');
      await committed(data, object);
      completeNative(data, object);
      purgedParts(data, object);
      await frontier(data, '1');
    } finally { await close(data); }
  });
test('physical two-of-three interrupted object survives restart without ACK and resumes only with its missing part',
  async () => {
    const data = await fixture();
    try {
      const object = makeObject(data.binding);
      await stage(data, object, [0, 2]);
      observedParts(data, object, [0, 2]);
      await restart(data);
      const before = observedParts(data, object, [0, 2]);
      failure(await post(data, FINAL, object.finalise), 409, 'missing-parts', data);
      assert.deepEqual(coldReadObjects(data.home), before);
      emptyNative(data);
      await frontier(data, '0');
      await stage(data, object, [1]);
      await committed(data, object);
      completeNative(data, object);
      purgedParts(data, object);
    } finally { await close(data); }
  });
test('duplicate part never extends TTL or double-reserves, and changed valid part/declaration cannot replace original physical bytes',
  async () => {
    const data = await fixture();
    try {
      const object = makeObject(data.binding);
      await stage(data, object, [0]);
      const original = observedParts(data, object, [0]);
      await restart(data);
      await stage(data, object, [0]);
      assert.deepEqual(coldReadObjects(data.home), original);
      const changed = Buffer.from(object.pieces[0]);
      changed[changed.length - 1] ^= 1;
      failure(await post(data, PART, { ...object.partFrames[0],
        partBase64: changed.toString('base64'), partDigest: sha(changed) }), 409, 'conflict', data);
      failure(await post(data, PART, { ...object.partFrames[0],
        totalBytes: object.header.totalBytes + 1 }), 409, 'conflict', data);
      assert.deepEqual(coldReadObjects(data.home), original);
      emptyNative(data);
    } finally { await close(data); }
  });
test('initial gap and source/precondition/category/revocation refusals precede all part reservations',
  async () => {
    const data = await fixture();
    try {
      const gap = makeObject(data.binding, { sequence: '2', batchId: 'synthetic-gap-object' });
      await refusedWithoutEffects(data, PART, gap.partFrames[0], 409, 'sequence-gap');
      await refusedWithoutEffects(data, FINAL, gap.finalise, 409, 'sequence-gap');
      const object = makeObject(data.binding);
      const alien = makeObject({ ...data.binding,
        sourceStoreId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
      await refusedWithoutEffects(data, PART, alien.partFrames[0], 400, 'binding-mismatch');
      await refusedWithoutEffects(data, PART, object.partFrames[0], 409, 'binding-mismatch',
        { ...data.headers, 'Klebb-Health-Generation': '2' });
      await refusedWithoutEffects(data, PART, object.partFrames[0], 409, 'binding-mismatch',
        { ...data.headers, 'Klebb-Health-Restore-Epoch': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
      const widened = { ...object.partFrames[0], recordType: 'StepsRecord',
        identity: { ...object.header.identity, recordType: 'StepsRecord' } };
      await refusedWithoutEffects(data, PART, widened, 403, 'scope-mismatch');
      const revoked = await req(data.server.baseUrl, `${BASE}/${data.paired.connectorId}`, {
        method: 'DELETE', cookie: data.owner.cookie, headers: { Origin: ORIGIN },
      });
      assert.equal(revoked.status, 200);
      await refusedWithoutEffects(data, PART, object.partFrames[0], 401, 'revoked');
      assert.deepEqual(coldReadObjects(data.home).objects, []);
      assert.equal(coldReadObjects(data.home).aggregateReservedBytes, 0);
      emptyNative(data);
    } finally { await close(data); }
  });
test('hard declaration and original-frame overflow refuse without allocation; ordinary large batch remains over limit',
  async () => {
    const data = await fixture();
    try {
      const object = makeObject(data.binding);
      await refusedWithoutEffects(data, PART, { ...object.partFrames[0], totalBytes: 67108865 },
        400, 'invalid-message');
      await refusedWithoutEffects(data, PART, { ...object.partFrames[0], partCount: 129 },
        400, 'invalid-message');
      const exactLimitPlusOne = JSON.stringify(object.partFrames[0]);
      const oversized = exactLimitPlusOne +
        ' '.repeat(1048577 - Buffer.byteLength(exactLimitPlusOne, 'utf8'));
      assert.equal(Buffer.byteLength(oversized, 'utf8'), 1048577);
      await refusedWithoutEffects(data, PART, oversized, 400, 'limit-exceeded');
      await refusedWithoutEffects(data, `${BASE}/v1/batches`, { version: 1, kind: 'batch',
        payloadJson: object.payloadJson, payloadDigest: object.header.objectDigest },
      400, 'limit-exceeded');
      assert.deepEqual(coldReadObjects(data.home).objects, []);
      emptyNative(data);
    } finally { await close(data); }
  });
test('complete physical bytes with a false declared whole digest cannot receive a durable receipt',
  async () => {
    const data = await fixture();
    try {
      const object = makeObject(data.binding);
      const wrongDigest = sha(Buffer.from('independently false complete-object digest'));
      object.header.objectDigest = wrongDigest;
      object.finalise.objectDigest = wrongDigest;
      object.partFrames.forEach(frame => { frame.objectDigest = wrongDigest; });
      object.partReceipts.forEach(frame => { frame.objectDigest = wrongDigest; });
      await stage(data, object);
      const before = observedParts(data, object, [0, 1, 2]);
      failure(await post(data, FINAL, object.finalise), 400, 'digest-mismatch', data);
      assert.deepEqual(coldReadObjects(data.home), before);
      emptyNative(data);
    } finally { await close(data); }
  });
test('assembled parser refuses unsupported/multiple/duplicate/numeric-Int64/invalid-UTF8 payloads without dropping fields',
  async () => {
    const variants = [
      { mutatePayload: payload => { payload.changes[0].serializerVersion = 99; } },
      { mutatePayload: payload => {
        const second = structuredClone(payload.changes[0]);
        second.identity.nativeRecordId = 'other-large-record';
        second.record.metadata.id = 'other-large-record';
        payload.changes.push(second);
      } },
      { mutateText: text => text.replace('"sequence":"1"', '"sequence":"1","sequence":"1"') },
      { mutateText: text => text.replace('"clientRecordVersion":"9223372036854775807"',
        '"clientRecordVersion":9223372036854775807') },
      { mutateBytes: bytes => {
        const offset = bytes.indexOf(Buffer.from('P'.repeat(20)));
        assert.ok(offset > 0);
        bytes[offset] = 0xc0;
        return bytes;
      } },
    ];
    for (const variant of variants) {
      const data = await fixture();
      try {
        const object = makeObject(data.binding, variant);
        await stage(data, object);
        const before = observedParts(data, object, object.manifest.map(part => part.index));
        failure(await post(data, FINAL, object.finalise), 400, 'invalid-message', data);
        assert.deepEqual(coldReadObjects(data.home), before);
        emptyNative(data);
      } finally { await close(data); }
    }
  });
test('raw part boundaries may bisect Unicode UTF8 without changing the reconstructed scalar or digest',
  async () => {
    const data = await fixture();
    try {
      const unsplit = makeObject(data.binding, { paddingCount: 128 });
      const omega = unsplit.bytes.indexOf(Buffer.from('\u03a9', 'utf8'));
      assert.ok(omega > 0);
      const object = makeObject(data.binding, { paddingCount: 128, cuts: [omega + 1] });
      assert.equal(object.pieces[0].at(-1), 0xce);
      assert.equal(object.pieces[1][0], 0xa9);
      await stage(data, object);
      await committed(data, object);
      completeNative(data, object);
      purgedParts(data, object);
    } finally { await close(data); }
  });
test('original finalise receipt survives part purge, cold restart and later raw correction/deletion without resurrection',
  async () => {
    for (const operation of ['correction', 'delete']) {
      const data = await fixture();
      try {
        const object = makeObject(data.binding);
        await stage(data, object);
        // req() fully receives the response. This proves received-but-unused
        // result/restart idempotence; actual response loss is the death oracle.
        const receivedButUnused = await post(data, FINAL, object.finalise);
        assert.equal(receivedButUnused.status, 200);
        const first = completeNative(data, object); // Prove first commit before any retry.
        const compact = purgedParts(data, object);
        await restart(data);
        await committed(data, object);
        assert.deepEqual(coldReadNative(data.home), first);
        assert.deepEqual(coldReadObjects(data.home), compact);
        const change = operation === 'delete' ?
          { operation: 'delete', identity: object.header.identity } :
          structuredClone(object.payload.changes[0]);
        if (operation === 'correction') {
          change.record.mass.value = '39.25';
          change.record.extension.padding = 'independent replacement removes original padding';
          change.record.metadata.lastModifiedTime = '2026-10-28T04:00:00.000000001Z';
        }
        const payload = { binding: data.binding, recordType: TYPE, sequence: '2',
          batchId: `synthetic-later-${operation}`, changes: [change] };
        const payloadJson = JSON.stringify(payload);
        const response = await post(data, `${BASE}/v1/batches`, { version: 1, kind: 'batch',
          payloadJson, payloadDigest: sha(Buffer.from(payloadJson, 'utf8')) });
        assert.equal(response.status, 200);
        const later = coldReadNative(data.home);
        assert.deepEqual(later.records, operation === 'delete' ? [] :
          [{ identity: change.identity, record: change.record }]);
        assert.deepEqual(later.tombstoneIds, operation === 'delete' ? ['large-raw-only'] : []);
        assert.equal(later.frontiers[0].acknowledgedSequence, '2');
        assert.equal(later.receipts.length, 2);
        assert.equal(later.jobs.length, 2);
        legacy(later, data);
        await restart(data);
        await committed(data, object);
        assert.deepEqual(coldReadNative(data.home), later);
        assert.deepEqual(coldReadObjects(data.home), compact);
      } finally { await close(data); }
    }
  });
