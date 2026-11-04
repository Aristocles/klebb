// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const os = require('node:os');
const { openZip } = require('../../lib/zip/read');
const { decodeOrdinaryHistory } = require('../../lib/import/native-publication');
const { createSandbox, cleanupSandbox, spawnServer, req, fakeAuthState, waitFor } = require('../helpers/sandbox');
const { writeZip } = require('../../lib/zip/write');
const F = require('../helpers/health-connect-sticky-admission-fixture.cjs');
const baselineExpected = require('../fixtures/health-connect/managed-export-independent-roles.json');
const nativeDisplayExpected = require('../fixtures/health-connect/native-display-normal.expected.json');
const SURVIVORS = Object.freeze([
  Object.freeze({ source: 'alpha', type: 'WeightRecord', id: 'synthetic-weight-normal',
    sequence: '1', generation: '2', batchId: 'managed-roundtrip-WeightRecord-survivor-1',
    utf8Bytes: 365, digest: 'sha256:462176518618281abb74abbac7b8ef059a4f3834eacacb8c950d1035e2e2a1c6',
    recordJson: nativeDisplayExpected.weight.nativeInitial.recordJson,
    policyRevision: '9', cardId: 'weight', metric: 'body_mass', field: 'kg', unit: 'kg',
    rows: [{ date: '2040-02-03', kg: 45.359237 }],
    selectedSources: [{ date: '2040-02-03', source: 'health-connect' }] }),
  Object.freeze({ source: 'beta', type: 'StepsRecord', id: 'synthetic-steps-normal',
    sequence: '1', generation: '2', batchId: 'managed-roundtrip-StepsRecord-survivor-1',
    utf8Bytes: 404, digest: 'sha256:617607da332fa19b5a7f1281e9650ddb7db477de66c8c840ebcf965d32b5cee3',
    recordJson: nativeDisplayExpected.steps.nativeInitial.recordJson,
    policyRevision: '5', cardId: 'steps', metric: 'step_count', field: 'count', unit: 'steps',
    rows: [{ date: '2026-06-01', count: 8123 }, { date: '2040-02-03', count: 1234 }],
    selectedSources: [{ date: '2026-06-01', source: 'hae' },
      { date: '2040-02-03', source: 'health-connect' }] }),
]);
const SURVIVOR_ORIGIN = 'org.example.synthetic.producer';
// Each existing readiness BEGIN/COMPLETE advances revision twice. The two
// extra cycles follow the completed deletion proof; original ACKs stay exact.
const expected = Object.freeze({ ...baselineExpected, readinessCycles: 6,
  categoryCount: 7, rawRecordCount: 5,
  sourceRoles: baselineExpected.sourceRoles.map(row => Object.freeze({ ...row,
    policyRevision: row.role === 'alpha' ? '9' : '5',
    categoryCount: row.role === 'alpha' ? '4' : '3' })),
  categories: [...baselineExpected.categories.map(row => Object.freeze(row.type === 'StepsRecord' ?
    { ...row, sharing: 'enabled', generation: '2' } : { ...row })),
  Object.freeze({ source: 'alpha', type: 'WeightRecord', sharing: 'enabled', generation: '2' })],
});
const digest = bytes => 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex');
const CONTROL = Object.freeze({ type: 'BodyWaterMassRecord', id: 'r0-roundtrip-deleted-sentinel',
  sequence: '2', batchId: 'managed-roundtrip-source-delete-2' });
const USER_CONTROL = Object.freeze({ type: 'StepsRecord', id: 'invented-owner-user-only-guard-01',
  sequence: '1', batchId: 'managed-roundtrip-Steps-user-upsert-1' });
const USER_RECORD_JSON = '{"startTime":"2026-01-02T03:00:00Z","endTime":"2026-01-02T03:10:00Z","startZoneOffset":"+11:00","endZoneOffset":"+11:00","count":"1234","metadata":{"id":"invented-owner-user-only-guard-01","dataOrigin":{"packageName":"example.synthetic.steps"},"device":{"manufacturer":"Synthetic","model":"Fixture Steps","type":0},"lastModifiedTime":"2026-01-02T03:11:00.000000003Z","clientRecordId":null,"clientRecordVersion":"1","recordingMethod":3}}';
const USER_FOOTPRINT_JSON = '{"kind":"interval","startTime":"2026-01-02T03:00:00Z","endTime":"2026-01-02T03:10:00Z","startZoneOffset":"+11:00","endZoneOffset":"+11:00"}';
const HAE_CARD = 'synthetic-managed-hae-steps';
const HAE_INPUT_JSON = '{"data":{"metrics":[{"name":"step_count","units":"count","data":[{"date":"2026-06-01 00:00:00 +1000","qty":8123}]}]}}';
const HAE_INPUT = JSON.parse(HAE_INPUT_JSON);
const HAE_ROWS = [{ date: '2026-06-01', count: 8123 }];

// Keep the actual API zip bytes; the JSON helper converts binary chunks to text.
function downloadExportArchive(data) {
  const agent = new http.Agent({ keepAlive: false });
  return new Promise((resolve, reject) => {
    const fail = error => { agent.destroy(); reject(error); };
    const authenticationStartedAt = Date.now();
    const outgoing = http.get(data.server.baseUrl + '/api/export', {
      agent, headers: { Cookie: data.owner.cookie, Origin: F.ENV.HEALTH_ORIGIN },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', fail);
      response.on('aborted', () => fail(new Error('export response aborted')));
      response.on('end', () => {
        if (!response.complete) return fail(new Error('incomplete export response'));
        const bytes = Buffer.concat(chunks), body = bytes.toString('utf8');
        let json = null;
        try { json = JSON.parse(body); } catch {}
        agent.destroy();
        resolve({ status: response.statusCode, headers: response.headers, bytes, body, json,
          authenticationStartedAt, authenticationFinishedAt: Date.now() });
      });
    });
    outgoing.on('error', fail);
    outgoing.setTimeout(10000, () => outgoing.destroy(new Error('request timeout')));
  });
}

// Capture the fixture inputs before export; archive output never defines membership.
function retainedSourceFiles(data) {
  const files = new Map();
  for (const folder of ['data', 'reports', 'credentials', 'sessions']) {
    const root = path.join(data.home, folder);
    if (!fs.existsSync(root)) continue;
    for (const relative of fs.readdirSync(root, { recursive: true }).sort()) {
      const file = path.join(root, relative);
      if (fs.lstatSync(file).isFile()) {
        files.set(folder + '/' + relative.split(path.sep).join('/'), fs.readFileSync(file));
      }
    }
  }
  const config = path.join(data.home, 'config.json');
  if (fs.existsSync(config)) files.set('config.json', fs.readFileSync(config));
  return files;
}

async function assertManagedArchive(data, response, before, catalogue, retainedFiles) {
  assert.ok(Buffer.isBuffer(response.bytes));
  assert.equal(response.bytes.length, Number(response.headers['content-length']));
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'eh-test-managed-export-'));
  try {
    const archive = path.join(temporary, 'export.zip'), tree = path.join(temporary, 'tree');
    fs.writeFileSync(archive, response.bytes);
    const zip = await openZip(archive);
    let entries;
    try {
      entries = zip.entries();
      const names = entries.map(entry => entry.name);
      assert.equal(new Set(names).size, names.length, 'archive entries are unique');
      assert.equal(names.some(name => /^(credentials|sessions|keys|db)(?:\/|$)/.test(name)), false);
      for (const file of ['klebb-export.json', 'data/health-connect/ordinary-history.json',
        'data/health-connect/ordinary-history-footer.json', 'data/synthetic-sticky-legacy.json']) {
        assert.equal(entries.filter(entry => !entry.isDirectory && entry.name === file).length, 1);
      }
      await zip.extractTo(tree);
    } finally { await zip.close(); }
    const names = new Set(entries.filter(entry => !entry.isDirectory).map(entry => entry.name));
    const bytes = file => fs.readFileSync(path.join(tree, ...file.split('/')));
    const manifest = JSON.parse(bytes('klebb-export.json'));
    assert.equal(manifest.format, 'klebb.export.v1'); assert.equal(manifest.formatVersion, 2);
    const descriptor = manifest.inventory.ordinaryHistory;
    const payloadFile = 'data/health-connect/ordinary-history.json';
    const footerFile = 'data/health-connect/ordinary-history-footer.json';
    const inputBytes = bytes(payloadFile), footerBytes = bytes(footerFile);
    const samplesFile = 'data/auto-export/samples.json';
    assert.equal(names.has(samplesFile), true);
    const samplesBytes = bytes(samplesFile);
    assert.equal(manifest.inventory.samples.file, samplesFile);
    assert.equal(manifest.inventory.samples.pushes, 1);
    assert.equal(manifest.inventory.samples.sha256, digest(samplesBytes).slice(7));
    assert.deepEqual(JSON.parse(samplesBytes.toString('utf8')), { version: 1,
      pushes: [{ receivedAt: data.haeReceivedAt, payload: HAE_INPUT }] });
    assert.equal(JSON.stringify(JSON.parse(samplesBytes).pushes[0].payload), HAE_INPUT_JSON);
    const haeCardFile = 'data/' + HAE_CARD + '.json';
    assert.equal(names.has(haeCardFile), true);
    assert.deepEqual(JSON.parse(bytes(haeCardFile)).data, HAE_ROWS);
    assert.equal(manifest.inventory.cards.filter(card => card.id === HAE_CARD &&
      card.file === haeCardFile && card.rows === 1).length, 1);
    assertOneHAEStored(before, data.haeReceivedAt);
    assert.deepEqual(descriptor, {
      version: 1, controlProfileVersion: 3,
      payload: { file: payloadFile, bytes: inputBytes.length, sha256: digest(inputBytes).slice(7) },
      footer: { file: footerFile, bytes: footerBytes.length, sha256: digest(footerBytes).slice(7) },
    });
    const { inventory, envelope } = decodeOrdinaryHistory(inputBytes, footerBytes,
      { controlProfileVersion: 3 });
    assert.deepEqual(envelope, {
      version: 3, counts: { namespaces: 2, sources: 2, categories: 7, records: 5,
        streams: 6, receipts: 7, projectionOutbox: 7, tombstones: 1,
        deletionGuards: 2, suppressions: 0 }, sha256: digest(inputBytes),
    });
    assert.deepEqual(inventory, JSON.parse(inputBytes.toString('utf8')));
    assert.deepEqual(envelope, JSON.parse(footerBytes.toString('utf8')));
    const ownerRef = catalogue.principals[0].ownerId;
    assert.match(ownerRef, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
    assert.notEqual(ownerRef, catalogue.principals[0].members[0].userId);
    const order = field => (left, right) => left[field] < right[field] ? -1 : left[field] > right[field] ? 1 : 0;
    const namespaces = [], policies = [];
    for (const role of expected.sourceRoles) {
      const binding = data[role.role].binding;
      const source = F.rows(before, 'health_source_policy_sources').find(row =>
        row.tenant_id === binding.tenantId && row.source_store_id === binding.sourceStoreId);
      assert.ok(source); assert.equal(source.owner_id, ownerRef);
      namespaces.push({ tenantId: binding.tenantId, ownerRef, sourceCount: 1,
        sources: [{ sourceStoreId: binding.sourceStoreId, provider: 'health-connect-native',
          policyRef: source.policy_id }] });
      policies.push({ tenantId: binding.tenantId, ownerRef, revision: role.policyRevision,
        sourceCount: 1, sources: [{ sourceStoreId: binding.sourceStoreId, policyId: source.policy_id,
          lifecycle: role.lifecycle, retainCommittedHistory: role.retainCommittedHistory === '1',
          categoryCount: Number(role.categoryCount), categories: expected.categories
            .filter(category => category.source === role.role)
            .map(category => ({ recordType: category.type, sharing: category.sharing,
              generation: category.generation })).sort(order('recordType')) }] });
    }
    namespaces.sort(order('tenantId')); policies.sort(order('tenantId'));
    assert.deepEqual(inventory.catalog, { version: 3, ownerRef, namespaces });
    assert.deepEqual(inventory.sourcePolicies, policies);
    const records = [], streams = [], receipts = [], projectionOutbox = [];
    for (const item of expected.records) {
      const binding = data[item.source].binding;
      const identity = [binding.tenantId, binding.sourceStoreId, item.type, item.id];
      const recordJson = F.bank.recordInventory[item.originalIndex].recordJson;
      assert.equal(Buffer.byteLength(recordJson), item.utf8Bytes);
      assert.equal(digest(Buffer.from(recordJson)), item.digest);
      records.push({ identity, nativeKeyJson: JSON.stringify(identity),
        serializerId: 'health-connect-record', serializerVersion: 1,
        dataFamily: 'ordinary', projection: 'raw-only', expectedUtf8Bytes: item.utf8Bytes,
        expectedRecordDigest: item.digest, recordJson });
      const streamKey = JSON.stringify([binding.tenantId, binding.instanceId, binding.sourceStoreId,
        binding.installationId, item.type, item.generation, binding.restoreEpoch]);
      const receipt = data.original[item.originalIndex].receipt;
      streams.push({ streamKey, recordType: item.type, acknowledgedSequence:
        item.source === 'alpha' && item.type === CONTROL.type ? CONTROL.sequence : item.sequence });
      receipts.push({ streamKey, sequence: item.sequence, batchId: item.batchId,
        payloadDigest: receipt.payloadDigest, receiptJson: JSON.stringify(receipt) });
      projectionOutbox.push({ streamKey, sequence: item.sequence, batchId: item.batchId,
        payloadDigest: receipt.payloadDigest, state: 'queued' });
    }
    const controlKey = F.streamKey(data.alpha, CONTROL.type);
    const controlReceipt = data.controlDelete.receipt;
    receipts.push({ streamKey: controlKey, sequence: CONTROL.sequence, batchId: CONTROL.batchId,
      payloadDigest: controlReceipt.payloadDigest, receiptJson: JSON.stringify(controlReceipt) });
    projectionOutbox.push({ streamKey: controlKey, sequence: CONTROL.sequence,
      batchId: CONTROL.batchId, payloadDigest: controlReceipt.payloadDigest, state: 'queued' });
    const userKey = F.streamKey(data.alpha, USER_CONTROL.type), userReceipt = data.userUpsert.receipt;
    streams.push({ streamKey: userKey, recordType: USER_CONTROL.type, acknowledgedSequence: '1' });
    receipts.push({ streamKey: userKey, sequence: '1', batchId: USER_CONTROL.batchId,
      payloadDigest: userReceipt.payloadDigest, receiptJson: JSON.stringify(userReceipt) });
    projectionOutbox.push({ streamKey: userKey, sequence: '1', batchId: USER_CONTROL.batchId,
      payloadDigest: userReceipt.payloadDigest, state: 'queued' });
    // These two fixed native records are additional to the original bank members.
    for (const item of SURVIVORS) {
      const binding = data[item.source].binding;
      const identity = [binding.tenantId, binding.sourceStoreId, item.type, item.id];
      records.push({ identity, nativeKeyJson: JSON.stringify(identity),
        serializerId: 'health-connect-record', serializerVersion: 1,
        dataFamily: 'ordinary', projection: 'raw-only', expectedUtf8Bytes: item.utf8Bytes,
        expectedRecordDigest: item.digest, recordJson: item.recordJson });
      const streamKey = JSON.stringify([binding.tenantId, binding.instanceId, binding.sourceStoreId,
        binding.installationId, item.type, item.generation, binding.restoreEpoch]);
      const receipt = data.survivors[item.cardId].receipt;
      streams.push({ streamKey, recordType: item.type, acknowledgedSequence: item.sequence });
      receipts.push({ streamKey, sequence: item.sequence, batchId: item.batchId,
        payloadDigest: receipt.payloadDigest, receiptJson: JSON.stringify(receipt) });
      projectionOutbox.push({ streamKey, sequence: item.sequence, batchId: item.batchId,
        payloadDigest: receipt.payloadDigest, state: 'queued' });
    }
    const recordOrder = (left, right) => {
      const a = JSON.stringify(left.identity), b = JSON.stringify(right.identity);
      return a < b ? -1 : a > b ? 1 : 0;
    };
    assert.deepEqual([...inventory.records].sort(recordOrder), records.sort(recordOrder));
    for (const [family, fixed] of [['streams', streams], ['receipts', receipts],
      ['projectionOutbox', projectionOutbox]]) {
      assert.deepEqual(sortStoredRows(inventory[family]), sortStoredRows(fixed));
    }
    const controlledIdentity = [data.alpha.binding.tenantId, data.alpha.binding.sourceStoreId,
      CONTROL.type, CONTROL.id];
    assert.deepEqual(inventory.tombstones, [{ identity: controlledIdentity,
      sourceStreamKey: controlKey, sourceSequence: CONTROL.sequence }]);
    assert.deepEqual(sortStoredRows(inventory.deletionGuards), sortStoredRows([
      { identity: controlledIdentity, sourceDeleted: 1, userSuppressed: 0, sourceStreamKey: controlKey,
        sourceSequence: CONTROL.sequence, footprintJson: null },
      { identity: [data.alpha.binding.tenantId, data.alpha.binding.sourceStoreId,
          USER_CONTROL.type, USER_CONTROL.id], sourceDeleted: 0, userSuppressed: 1,
        sourceStreamKey: null, sourceSequence: null, footprintJson: USER_FOOTPRINT_JSON },
    ]));
    assert.deepEqual(inventory.suppressions, []);
    for (const file of names) {
      const text = bytes(file).toString('utf8');
      F.noAuthority(text, data);
      for (const field of expected.readinessFields) {
        assert.equal(text.includes(JSON.stringify(field)), false, 'private readiness field excluded');
      }
      for (const category of F.rows(before, 'health_source_policy_categories')) {
        for (const field of ['readiness_query_digest', 'readiness_report_digest', 'readiness_mac']) {
          if (category[field] !== null) {
            assert.equal(text.includes(category[field]), false, 'private readiness proof excluded');
          }
        }
      }
    }
    const legacy = JSON.parse(bytes('data/synthetic-sticky-legacy.json'));
    assert.equal(legacy.meta.id, 'synthetic-sticky-legacy');
    assert.deepEqual(legacy.data, [{ date: '2026-10-20', kg: 35.5,
      note: 'preserve sticky admission sentinel' }]);
    assert.equal(manifest.inventory.cards.filter(card => card.id === 'synthetic-sticky-legacy' &&
      card.file === 'data/synthetic-sticky-legacy.json').length, 1);
    for (const [file, original] of retainedFiles) {
      // Portable exports exclude generated top-level card backup files.
      // Every original source file remains covered by the unchanged-file check.
      const generatedCardBackup = /^data\/[^/\\]*\.json\.[^/\\]+\.json$/i.test(file);
      if (file === 'config.json' || (file.startsWith('data/') && !generatedCardBackup) || file.startsWith('reports/')) {
        assert.equal(names.has(file), true, 'existing portable input file retained in archive: ' + file);
      }
      if (file.startsWith('reports/')) assert.ok(bytes(file).equals(original));
    }
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  const afterFiles = retainedSourceFiles(data);
  const sessionFile = 'sessions/webauthn.json';
  assert.ok(retainedFiles.has(sessionFile) && afterFiles.has(sessionFile));
  const beforeSessions = JSON.parse(retainedFiles.get(sessionFile));
  const afterSessions = JSON.parse(afterFiles.get(sessionFile));
  assert.deepEqual(Object.keys(afterSessions).sort(), Object.keys(beforeSessions).sort(),
    'authenticated export preserves the complete session token set');
  const token = data.owner.token;
  assert.ok(Object.hasOwn(beforeSessions, token) && Object.hasOwn(afterSessions, token));
  for (const field of ['created', 'userId', 'credentialId']) {
    assert.equal(afterSessions[token][field], beforeSessions[token][field],
      'authenticated export preserves session identity: ' + field);
  }
  for (const clock of [response.authenticationStartedAt, response.authenticationFinishedAt,
    afterSessions[token].lastSeen]) assert.ok(Number.isSafeInteger(clock));
  assert.ok(response.authenticationStartedAt <= response.authenticationFinishedAt);
  assert.ok(afterSessions[token].lastSeen >= response.authenticationStartedAt
    && afterSessions[token].lastSeen <= response.authenticationFinishedAt,
  'only the valid authenticated session lastSeen is touched within the actual GET window');
  const stableSessions = structuredClone(afterSessions);
  stableSessions[token].lastSeen = beforeSessions[token].lastSeen;
  assert.deepEqual(stableSessions, beforeSessions,
    'every other session field and every unrelated session remains exact');
  const afterWithoutActivityTouch = new Map(afterFiles);
  afterWithoutActivityTouch.set(sessionFile, retainedFiles.get(sessionFile));
  assert.deepEqual(afterWithoutActivityTouch, retainedFiles,
    'export leaves every other original input file byte-exact');
  assert.deepEqual(F.coldRead(data.home).derived, before.derived,
    'export leaves complete derived SQL source history unchanged');
}

// Existing authenticated API setup establishes authority; expected membership
// and raw bytes come from fixed independent fixtures, never exporter output.
test('MOEX01: healthy managed owner export preserves both namespace inventories', async () => {
  const data = await F.fixture({ v2: true, readinessVersion: 2,
    alphaCategories: [...F.TYPES, 'WeightRecord'] });
  try {
    const auth = await F.request(data, '/auth/status', { browser: true });
    assert.equal(auth.status, 200); assert.equal(auth.json.authenticated, true);
    await createSurvivingNativeCards(data);
    await seedOneHAEHistory(data);
    const beforeDelete = F.coldRead(data.home);
    assert.equal(F.identityRows(beforeDelete, 'health_records',
      F.identity(data.alpha, CONTROL.type, CONTROL.id)).length, 0);
    data.controlDelete = F.batch(data.alpha, CONTROL.sequence,
      [F.deletion(data.alpha, CONTROL.type, CONTROL.id)],
      { type: CONTROL.type, id: CONTROL.batchId });
    await F.ack(data, data.alpha, data.controlDelete);
    const afterDelete = F.coldRead(data.home);
    for (const family of ['health_records','cards','rows','hae_pushes','hae_samples',
      'health_source_policy_state','health_source_policy_sources','health_source_policy_categories']) {
      assert.deepEqual(F.rows(afterDelete, family), F.rows(beforeDelete, family),
        'source deletion of the distinct sentinel preserves existing history and policy');
    }
    assertSourceDeletionRows(data, afterDelete);
    await seedAndUserDeleteOneSteps(data);
    await seedSurvivingNativeRecords(data);
    await selectSurvivingNativeCards(data);
    await assertSurvivingNativeViews(data, route => F.request(data, route, { browser: true }));
    assert.equal(data.readiness.length, expected.readinessCycles);
    assert.notEqual(data.alpha.binding.tenantId, data.beta.binding.tenantId);
    assert.notEqual(data.alpha.binding.sourceStoreId, data.beta.binding.sourceStoreId);
    const before = F.coldRead(data.home);
    const retainedFiles = retainedSourceFiles(data);
    assert.deepEqual(before.native.integrity, [{ integrity_check: 'ok' }]);
    const policyFile = path.join(data.home, 'credentials', 'health-connect-policy.json');
    const privateBefore = fs.readFileSync(policyFile);
    const catalogue = JSON.parse(privateBefore);
    assert.equal(catalogue.version, 2); assert.equal(catalogue.principals.length, 1);
    assert.equal(catalogue.namespaces.length, expected.namespaceCount);
    const owner = catalogue.principals[0];
    assert.equal(owner.members.length, 1);
    assert.equal(owner.members[0].userId, 'sticky-fixture-owner');
    assert.equal(owner.members[0].credentialId, data.owner.credentialId);
    const states = F.rows(before, 'health_source_policy_state');
    const sources = F.rows(before, 'health_source_policy_sources');
    const categories = F.rows(before, 'health_source_policy_categories');
    assert.equal(states.length, expected.namespaceCount);
    assert.equal(sources.length, expected.sourceCount);
    assert.equal(categories.length, expected.categoryCount);
    for (const role of expected.sourceRoles) {
      const source = data[role.role], binding = source.binding;
      const namespace = catalogue.namespaces.filter(n => n.state.tenantId === binding.tenantId);
      assert.equal(namespace.length, 1); assert.equal(namespace[0].ownerId, owner.ownerId);
      const state = states.filter(row => row.tenant_id === binding.tenantId);
      assert.equal(state.length, 1); assert.equal(state[0].owner_id, owner.ownerId);
      assert.equal(state[0].version, '2'); assert.equal(state[0].revision, role.policyRevision);
      assert.equal(state[0].knowledge, role.knowledge); assert.equal(state[0].source_count, '1');
      const rows = sources.filter(row => row.tenant_id === binding.tenantId &&
        row.source_store_id === binding.sourceStoreId);
      assert.equal(rows.length, 1); assert.equal(rows[0].owner_id, owner.ownerId);
      assert.equal(rows[0].lifecycle, role.lifecycle); assert.equal(rows[0].knowledge, role.knowledge);
      assert.equal(rows[0].retain_committed_history, role.retainCommittedHistory);
      assert.equal(rows[0].category_count, role.categoryCount);
    }
    for (const item of expected.categories) {
      const binding = data[item.source].binding;
      const selected = categories.filter(row => row.tenant_id === binding.tenantId &&
        row.source_store_id === binding.sourceStoreId && row.record_type === item.type);
      assert.equal(selected.length, 1); const category = selected[0];
      assert.equal(category.sharing, item.sharing); assert.equal(category.generation, item.generation);
      if (item.sharing === 'enabled') {
        assert.equal(category.readiness_epoch, binding.restoreEpoch);
        assert.equal(category.readiness_installation_id, binding.installationId);
        assert.equal(category.readiness_generation, item.generation);
        for (const field of expected.readinessFields) assert.equal(typeof category[field], 'string');
      } else for (const field of expected.readinessFields) assert.equal(category[field], null);
    }
    assert.equal(F.rows(before, 'health_records').length, expected.rawRecordCount);
    assert.equal(F.rows(before, 'health_batch_receipts').length, expected.receiptCount + 4);
    assert.equal(F.rows(before, 'health_streams').length, expected.receiptCount + 3);
    for (const item of expected.records) {
      const source = data[item.source], binding = source.binding;
      const identity = { tenantId: binding.tenantId, sourceStoreId: binding.sourceStoreId,
        recordType: item.type, nativeRecordId: item.id };
      const rows = F.identityRows(before, 'health_records', identity);
      assert.equal(rows.length, 1);
      const original = F.bank.recordInventory[item.originalIndex];
      assert.equal(rows[0].record_json, original.recordJson);
      assert.equal(Buffer.byteLength(rows[0].record_json), item.utf8Bytes);
      assert.equal(digest(Buffer.from(rows[0].record_json)), item.digest);
      const streamKey = JSON.stringify([binding.tenantId, binding.instanceId, binding.sourceStoreId,
        binding.installationId, item.type, item.generation, binding.restoreEpoch]);
      const receipts = F.rows(before, 'health_batch_receipts').filter(row =>
        row.stream_key === streamKey && row.sequence === item.sequence);
      assert.equal(receipts.length, 1); assert.equal(receipts[0].sequence, item.sequence);
      assert.equal(receipts[0].batch_id, item.batchId);
      const receipt = JSON.parse(receipts[0].receipt_json);
      assert.equal(receipt.kind, 'durable-receipt'); assert.equal(receipt.sequence, item.sequence);
      assert.equal(receipt.binding.generation, item.generation); assert.equal(receipt.batchId, item.batchId);
      assert.deepEqual(receipt, data.original[item.originalIndex].receipt);
      const streams = F.rows(before, 'health_streams').filter(row => row.stream_key === streamKey);
      assert.equal(streams.length, 1); assert.equal(streams[0].acknowledged_sequence,
        item.source === 'alpha' && item.type === CONTROL.type ? CONTROL.sequence : item.sequence);
    }
    assertSurvivingNativeRows(data, before);
    F.noAuthority(JSON.stringify(before), data);
    console.log(JSON.stringify({ kind: 'managed-export-healthy-prerequisite', namespaces: 2,
      sources: 2, categories: 7, readinessCycles: 6, rawRecords: 5, seedACKs: 3,
      fixedRawBytes: [380, 357, 557], acceptedControlACKs: 2, survivingNativeACKs: 2,
      survivingNativeRawBytes: [365, 404], streams: 6,
      receipts: 7, tombstones: 1, deletionGuards: 2 }));
    const response = await downloadExportArchive(data);
    const unsupported = response.status === 500 &&
      response.json?.error === 'export failed: native-history-export-unsupported';
    F.noAuthority(response.body, data);
    console.log(JSON.stringify({ kind: 'managed-export-response', status: response.status,
      error: response.json?.error ?? null,
      expectedUnsupported: unsupported, archiveAndRecoveryCredit: false }));
    assert.ok(response.status === 200 || unsupported,
      'Only the fixed managed unsupported refusal qualifies the controlled baseline');
    if (unsupported) assert.deepEqual(response.json,
      { error: 'export failed: native-history-export-unsupported' });
    assert.deepEqual(F.coldRead(data.home).native, before.native,
      'Export leaves the complete managed SQL history and category policy unchanged');
    assert.ok(fs.readFileSync(policyFile).equals(privateBefore),
      'Export leaves genuine principal and credential custody unchanged');
    assert.equal(fs.readdirSync(data.home).some(name => name.startsWith('export-staging.')), false);
    assert.equal(response.status, 200,
      'A healthy managed owner export must retain both independently fixed namespace inventories');
    assert.match(response.headers['content-type'], /^application\/zip(?:;|$)/);
    await assertManagedArchive(data, response, before, catalogue, retainedFiles);
    await assertFreshManagedRoundtrip(data, response, before);
  } finally { await F.close(data); }
});

// Use the browser import route so production owns approval and publication.
function uploadManagedArchive(target, bytes) {
  assert.ok(Buffer.isBuffer(bytes));
  const agent = new http.Agent({ keepAlive: false });
  return new Promise((resolve, reject) => {
    const fail = error => { agent.destroy(); reject(error); };
    const outgoing = http.request(target.server.baseUrl + '/api/import/upload', {
      method: 'POST', agent, headers: { Cookie: target.owner.cookie,
        Origin: F.ENV.HEALTH_ORIGIN, 'Content-Type': 'application/octet-stream',
        'Content-Length': bytes.length },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', fail);
      response.on('aborted', () => fail(new Error('import response aborted')));
      response.on('end', () => {
        try {
          assert.equal(response.complete, true);
          const body = Buffer.concat(chunks).toString('utf8');
          resolve({ status: response.statusCode, body, json: JSON.parse(body) });
        } catch (error) { reject(error); }
        finally { agent.destroy(); }
      });
    });
    outgoing.on('error', fail);
    outgoing.setTimeout(10000, () => outgoing.destroy(new Error('import request timeout')));
    outgoing.end(bytes);
  });
}
function retainedTargetInputs(target) {
  return new Map([...retainedSourceFiles(target)].filter(([file]) =>
    !file.startsWith('sessions/') && file !== 'credentials/webauthn.json'));
}
function sortStoredRows(rows) {
  const key = row => JSON.stringify(Object.keys(row).sort().map(column => [column, row[column]]));
  return [...rows].sort((left, right) => key(left) < key(right) ? -1 : key(left) > key(right) ? 1 : 0);
}
async function archiveFiles(directory, name, bytes) {
  const file = path.join(directory, name + '.zip'), tree = path.join(directory, name);
  fs.writeFileSync(file, bytes);
  const zip = await openZip(file);
  try { await zip.extractTo(tree); } finally { await zip.close(); }
  const files = new Map();
  for (const relative of fs.readdirSync(tree, { recursive: true }).sort()) {
    const full = path.join(tree, relative);
    if (fs.lstatSync(full).isFile()) {
      files.set(relative.split(path.sep).join('/'), fs.readFileSync(full));
    }
  }
  return { tree, files };
}
async function assertFreshManagedRoundtrip(source, exported, originalSQL) {
  const targetOwner = fakeAuthState('managed-archive-target-owner');
  const target = { home: createSandbox({ credentials: targetOwner.credentials,
    sessions: targetOwner.sessions }), owner: targetOwner, server: null };
  assert.notEqual(target.home, source.home);
  assert.notEqual(targetOwner.token, source.owner.token);
  assert.notEqual(targetOwner.credentialId, source.owner.credentialId);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'eh-test-managed-roundtrip-'));
  const targetEnv = { HEALTH_ORIGIN: F.ENV.HEALTH_ORIGIN, HEALTH_RP_ID: F.ENV.HEALTH_RP_ID };
  const browser = (route, options = {}) => req(target.server.baseUrl, route, {
    ...options, cookie: targetOwner.cookie, headers: { Origin: F.ENV.HEALTH_ORIGIN,
      ...(options.headers || {}) },
  });
  const boot = async () => { target.server = await spawnServer(target.home, targetEnv); };
  const stop = async () => { if (target.server) await target.server.kill(); target.server = null; };
  try {
    await F.stop(source);
    const originalInputs = retainedSourceFiles(source);
    const sourceArchive = await archiveFiles(scratch, 'original', exported.bytes);
    const payloadFile = 'data/health-connect/ordinary-history.json';
    const footerFile = 'data/health-connect/ordinary-history-footer.json';
    const originalInput = sourceArchive.files.get(payloadFile);
    const originalFooter = sourceArchive.files.get(footerFile);
    assert.ok(originalInput); assert.ok(originalFooter);
    const archived = JSON.parse(originalInput.toString('utf8'));
    const oldAuthority = new Set();
    for (const stream of archived.streams) {
      const fields = JSON.parse(stream.streamKey);
      oldAuthority.add(fields[1]); oldAuthority.add(fields[6]);
    }
    await boot();
    const auth = await browser('/auth/status');
    assert.equal(auth.status, 200); assert.equal(auth.json.authenticated, true);
    const factoryCards = await browser('/api/manifests');
    assert.equal(factoryCards.status, 200);
    assert.equal(factoryCards.json.entries.some(card => card.id === 'welcome'), true);
    await stop();
    const targetBefore = F.coldRead(target.home), targetInputsBefore = retainedTargetInputs(target);
    assert.equal(F.rows(targetBefore, 'health_records').length, 0);
    const authorityFile = path.join(target.home, 'credentials', 'health-connect.json');
    if (fs.existsSync(authorityFile)) {
      const initialAuthority = JSON.parse(fs.readFileSync(authorityFile, 'utf8'));
      oldAuthority.add(initialAuthority.instanceId); oldAuthority.add(initialAuthority.restoreEpoch);
    }

    // Leave the manifest's required footer descriptor intact while omitting it.
    const incomplete = path.join(scratch, 'incomplete.zip');
    await writeZip(incomplete, [...sourceArchive.files.keys()].filter(name => name !== footerFile)
      .map(name => ({ name, sourcePath: path.join(sourceArchive.tree, ...name.split('/')) })));
    await boot();
    const activityStartedAt = Date.now();
    const badUpload = await uploadManagedArchive(target, fs.readFileSync(incomplete));
    assert.equal(badUpload.status, 200); assert.equal(badUpload.json.ok, true);
    const badStart = await browser('/api/import/start', { method: 'POST', body: {} });
    assert.equal(badStart.status, 200); assert.equal(badStart.json.state, 'failed');
    assert.equal(badStart.json.findings.some(finding => finding.severity === 'refusal'), true);
    const refusedApply = await browser('/api/import/apply', { method: 'POST', body: {} });
    assert.equal(refusedApply.status, 409); assert.equal(refusedApply.json.code, 'BAD_STATE');
    const aborted = await browser('/api/import/abort', { method: 'POST', body: {} });
    assert.equal(aborted.status, 200);
    const activityFinishedAt = Date.now();
    await stop();
    const refusedSQL = F.coldRead(target.home);
    assert.deepEqual(refusedSQL, targetBefore, 'missing required history stream changes no SQL family');
    const targetInputsAfter = retainedTargetInputs(target);
    const activityFile = 'data/_meta/activity.json';
    assert.equal(targetInputsBefore.has(activityFile), false, 'GET API setup records no interaction');
    assert.equal(targetInputsAfter.has(activityFile), true);
    const activity = JSON.parse(targetInputsAfter.get(activityFile).toString('utf8'));
    assert.deepEqual(Object.keys(activity).sort(), ['days', 'lastActiveAt']);
    const activeAt = Date.parse(activity.lastActiveAt);
    assert.equal(Number.isSafeInteger(activeAt) && activeAt >= activityStartedAt &&
      activeAt <= activityFinishedAt, true, 'ordinary activity uses the four-request clock window');
    assert.equal(activity.lastActiveAt, new Date(activeAt).toISOString());
    assert.equal(activity.days !== null && typeof activity.days === 'object' &&
      !Array.isArray(activity.days), true);
    const firstDay = new Date(activityStartedAt).toISOString().slice(0, 10);
    const lastDay = new Date(activityFinishedAt).toISOString().slice(0, 10);
    let interactions = 0;
    for (const [day, count] of Object.entries(activity.days)) {
      assert.match(day, /^\d{4}-\d{2}-\d{2}$/);
      assert.equal(new Date(day + 'T00:00:00.000Z').toISOString().slice(0, 10), day);
      assert.equal(day >= firstDay && day <= lastDay, true);
      assert.equal(Number.isSafeInteger(count) && count > 0 && count <= 4, true);
      interactions += count;
    }
    assert.equal(interactions, 4, 'upload, start, refused apply and abort are authenticated interactions');
    targetInputsAfter.delete(activityFile);
    assert.deepEqual(targetInputsAfter, targetInputsBefore,
      'missing required history stream changes no target card or source bytes');

    await boot();
    const restoreActivityStartedAt = Date.now();
    const uploaded = await uploadManagedArchive(target, exported.bytes);
    assert.equal(uploaded.status, 200); assert.equal(uploaded.json.ok, true);
    assert.equal(uploaded.json.bytes, exported.bytes.length);
    const started = await browser('/api/import/start', { method: 'POST', body: {} });
    assert.equal(started.status, 200); assert.equal(started.json.state, 'awaiting-confirm',
      JSON.stringify(started.json.findings?.map(finding => finding.code)));
    assert.equal(started.json.requiresConfirm, false, 'the independently booted target remains fresh');
    const apply = await browser('/api/import/apply', { method: 'POST', body: {} });
    assert.equal(apply.status, 202);
    const terminal = await waitFor(async () => {
      const status = await browser('/api/import/status');
      assert.equal(status.status, 200);
      return ['done', 'failed'].includes(status.json.state) ? status.json : false;
    }, { what: 'managed archive HTTP apply terminal state' });
    assert.equal(terminal.state, 'done');
    const restoreActivityFinishedAt = Date.now();
    await stop();
    const restoredActivityBytes = retainedTargetInputs(target).get(activityFile);
    assert.ok(restoredActivityBytes);
    const restoredActivity = JSON.parse(restoredActivityBytes.toString('utf8'));
    assert.deepEqual(Object.keys(restoredActivity).sort(), ['days', 'lastActiveAt']);
    const restoredActiveAt = Date.parse(restoredActivity.lastActiveAt);
    assert.equal(Number.isSafeInteger(restoredActiveAt) &&
      restoredActiveAt >= restoreActivityStartedAt &&
      restoredActiveAt <= restoreActivityFinishedAt, true);
    assert.equal(restoredActivity.lastActiveAt, new Date(restoredActiveAt).toISOString());
    assert.equal(restoredActivity.days !== null && typeof restoredActivity.days === 'object' &&
      !Array.isArray(restoredActivity.days), true);
    const restoreFirstDay = new Date(restoreActivityStartedAt).toISOString().slice(0, 10);
    const restoreLastDay = new Date(restoreActivityFinishedAt).toISOString().slice(0, 10);
    for (const day of Object.keys(activity.days)) {
      assert.equal(Object.hasOwn(restoredActivity.days, day), true, 'earlier target interactions remain');
    }
    let restoreInteractions = 0;
    for (const [day, count] of Object.entries(restoredActivity.days)) {
      assert.match(day, /^\d{4}-\d{2}-\d{2}$/);
      assert.equal(new Date(day + 'T00:00:00.000Z').toISOString().slice(0, 10), day);
      const previous = activity.days[day] || 0;
      assert.equal(Number.isSafeInteger(count) && count >= previous && count > 0, true);
      const added = count - previous;
      if (day < restoreFirstDay || day > restoreLastDay) assert.equal(added, 0);
      assert.equal(added <= 3, true);
      restoreInteractions += added;
    }
    assert.equal(restoreInteractions, 3, 'valid upload, start and apply are authenticated interactions');
    const restored = F.coldRead(target.home);
    assert.deepEqual(restored.native.integrity, [{ integrity_check: 'ok' }]);
    for (const family of ['health_records','health_streams','health_batch_receipts',
      'health_projection_outbox','health_tombstones','health_deletion_guards']) {
      assert.deepEqual(sortStoredRows(F.rows(restored, family)),
        sortStoredRows(F.rows(originalSQL, family)), 'original native and transport tuples restored');
    }
    assert.equal(F.rows(restored, 'health_records').length, 5);
    assert.equal(F.rows(restored, 'health_streams').length, 6);
    assert.equal(F.rows(restored, 'health_batch_receipts').length, 7);
    assert.equal(F.rows(restored, 'health_projection_outbox').length, 7);
    assertSurvivingNativeRows(source, restored);
    assertSourceDeletionRows(source, restored);
    assertUserDeletionRows(source, restored);
    assertOneHAEStored(restored, source.haeReceivedAt);
    for (const family of ['hae_pushes','hae_samples']) {
      assert.deepEqual(F.rows(restored, family), F.rows(originalSQL, family),
        'full original HAE payload, metadata, counts, ordering and physical hash survive apply');
    }
    for (const fixed of expected.records) {
      const binding = source[fixed.source].binding;
      const rows = F.rows(restored, 'health_records').filter(row =>
        row.tenant_id === binding.tenantId && row.source_store_id === binding.sourceStoreId &&
        row.record_type === fixed.type && row.native_record_id === fixed.id);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].record_json, F.bank.recordInventory[fixed.originalIndex].recordJson);
      assert.equal(Buffer.byteLength(rows[0].record_json), fixed.utf8Bytes);
      assert.equal(digest(Buffer.from(rows[0].record_json)), fixed.digest);
    }
    const headers = F.rows(restored, 'health_restore_publication');
    assert.equal(headers.length, 1);
    const header = headers[0];
    const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
    assert.match(header.instance_id, uuid); assert.match(header.restore_epoch, uuid);
    assert.notEqual(header.instance_id, header.restore_epoch);
    assert.equal(oldAuthority.has(header.instance_id), false);
    assert.equal(oldAuthority.has(header.restore_epoch), false);
    const targetUserId = Object.keys(targetOwner.credentials.users)[0];
    const states = F.rows(restored, 'health_source_policy_state');
    assert.equal(states.length, 2);
    assert.deepEqual(sortStoredRows(states), sortStoredRows(F.rows(originalSQL,
      'health_source_policy_state').map(row => ({ ...row, version: '1',
        owner_id: targetUserId, epoch: header.restore_epoch }))));
    const sources = F.rows(restored, 'health_source_policy_sources');
    assert.equal(sources.length, 2);
    assert.deepEqual(sortStoredRows(sources), sortStoredRows(F.rows(originalSQL,
      'health_source_policy_sources').map(row => ({ ...row, owner_id: targetUserId, reconciled_epoch: null }))));
    const choices = row => Object.fromEntries(Object.entries(row).filter(([key]) =>
      !expected.readinessFields.includes(key)));
    assert.equal(F.rows(restored, 'health_source_policy_categories').length, 7);
    assert.deepEqual(sortStoredRows(F.rows(restored, 'health_source_policy_categories')),
      sortStoredRows(F.rows(originalSQL, 'health_source_policy_categories').map(choices)));
    for (const row of F.rows(restored, 'health_source_policy_categories')) {
      for (const field of expected.readinessFields) assert.equal(Object.hasOwn(row, field), false);
    }
    const owners = F.rows(restored, 'health_restore_source_owners');
    assert.equal(owners.length, 2);
    assert.deepEqual(sortStoredRows(owners), sortStoredRows(expected.sourceRoles.map(role => ({
      tenant_id: source[role.role].binding.tenantId,
      source_store_id: source[role.role].binding.sourceStoreId, owner_id: targetUserId }))));
    assert.equal(fs.existsSync(path.join(target.home, 'credentials', 'health-connect-policy.json')), false,
      'archive cannot install a live principal or readiness catalogue');
    if (fs.existsSync(authorityFile)) {
      const authority = JSON.parse(fs.readFileSync(authorityFile, 'utf8'));
      assert.deepEqual(authority.grants, []); assert.deepEqual(authority.connectors, []);
    }

    let importAuditFile;
    for (const reopen of [1, 2]) {
      await boot();
      const legacy = await browser('/api/manifests/synthetic-sticky-legacy/data');
      assert.equal(legacy.status, 200);
      assert.deepEqual(legacy.json.data, [{ date: '2026-10-20', kg: 35.5,
        note: 'preserve sticky admission sentinel' }]);
      const hae = await browser('/api/manifests/' + HAE_CARD + '/data');
      assert.equal(hae.status, 200); assert.deepEqual(hae.json.data, HAE_ROWS);
      await assertSurvivingNativeViews(source, browser);
      const coldExport = await downloadExportArchive(target);
      assert.equal(coldExport.status, 200);
      assert.match(coldExport.headers['content-type'], /^application\/zip(?:;|$)/);
      await stop();
      assert.deepEqual(F.coldRead(target.home), restored,
        'cold boot and reexport preserve complete restored SQL and physical history');
      const coldArchive = await archiveFiles(scratch, 'cold-' + reopen, coldExport.bytes);
      const addedFiles = [...coldArchive.files.keys()].filter(name => !sourceArchive.files.has(name));
      assert.equal(addedFiles.length, 1, 'only the retained HAE import audit file is added');
      if (reopen === 1) importAuditFile = addedFiles[0];
      assert.equal(addedFiles[0], importAuditFile, 'cold reopening retains the same import audit file');
      assert.match(addedFiles[0], /^data\/auto-export\/samples\.json\.imported-\d{4}-\d{2}-\d{2}T\d{9}Z$/);
      assert.ok(coldArchive.files.get(addedFiles[0]).equals(
        sourceArchive.files.get('data/auto-export/samples.json')),
        'the retained audit file is exactly the original archived HAE payload');
      assert.deepEqual([...coldArchive.files.keys()].filter(name => name !== addedFiles[0]).sort(),
        [...sourceArchive.files.keys()].sort());
      for (const [name, bytes] of sourceArchive.files) {
        if (name === activityFile) assert.ok(coldArchive.files.get(name).equals(restoredActivityBytes),
          'cold reexport preserves the explicitly validated restore interactions');
        else if (name !== 'klebb-export.json') assert.ok(coldArchive.files.get(name).equals(bytes),
          'every original archived history and input file survives cold reexport: ' + name);
      }
      const manifest = JSON.parse(coldArchive.files.get('klebb-export.json').toString('utf8'));
      assert.equal(manifest.formatVersion, 2);
      assert.deepEqual(manifest.inventory.other.filter(row => row.file === importAuditFile),
        [{ file: importAuditFile,
          sha256: digest(sourceArchive.files.get('data/auto-export/samples.json')).slice(7) }]);
      assert.deepEqual(manifest.inventory.ordinaryHistory,
        JSON.parse(sourceArchive.files.get('klebb-export.json').toString('utf8')).inventory.ordinaryHistory);
      assert.ok(coldArchive.files.get(payloadFile).equals(originalInput));
      assert.ok(coldArchive.files.get(footerFile).equals(originalFooter));
      const samplesFile = 'data/auto-export/samples.json';
      const samplesBytes = coldArchive.files.get(samplesFile);
      assert.ok(samplesBytes);
      assert.deepEqual(JSON.parse(samplesBytes), { version: 1,
        pushes: [{ receivedAt: source.haeReceivedAt, payload: HAE_INPUT }] });
      assert.equal(JSON.stringify(JSON.parse(samplesBytes).pushes[0].payload), HAE_INPUT_JSON);
      assert.equal(manifest.inventory.samples.file, samplesFile);
      assert.equal(manifest.inventory.samples.pushes, 1);
      assert.equal(manifest.inventory.samples.sha256, digest(samplesBytes).slice(7));
      assert.deepEqual(JSON.parse(coldArchive.files.get('data/' + HAE_CARD + '.json')).data, HAE_ROWS);
      for (const bytes of coldArchive.files.values()) {
        assert.equal(bytes.toString('utf8').includes(targetOwner.token), false);
        F.noAuthority(bytes.toString('utf8'), source);
      }
    }
    assert.deepEqual(F.coldRead(source.home), originalSQL, 'fresh restore leaves the source SQL exact');
    assert.deepEqual(retainedSourceFiles(source), originalInputs, 'fresh restore leaves source files exact');
  } finally {
    await stop();
    cleanupSandbox(target.home);
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function survivingNativeSelection(data, item) {
  const binding = data[item.source].binding;
  return { tenantId: binding.tenantId, sourceStoreId: binding.sourceStoreId,
    recordType: item.type, switchDate: '2040-02-03', dataOrigin: SURVIVOR_ORIGIN,
    timeZone: 'UTC', mappingVersion: 1 };
}
async function createSurvivingNativeCards(data) {
  for (const item of SURVIVORS) {
    const created = await F.request(data, '/api/manifests', { method: 'POST', browser: true,
      body: { $schema: 'klebb.datafile.v1', meta: { id: item.cardId, label: 'Synthetic recovery metric',
        ingest: { source: 'hae', metric: item.metric },
        view: { enabled: true, component: 'generic-card',
          display: { template: `{${item.field}}`, unit: item.unit } },
        writeable: { fromWebapp: false } }, data: [] } });
    assert.equal(created.status, 201); F.noAuthority(created.body, data);
  }
}
async function seedSurvivingNativeRecords(data) {
  data.survivors = {};
  for (const item of SURVIVORS) {
    assert.equal(Buffer.byteLength(item.recordJson), item.utf8Bytes);
    assert.equal(digest(Buffer.from(item.recordJson)), item.digest);
    const record = JSON.parse(item.recordJson);
    assert.equal(record.metadata.id, item.id);
    assert.equal(record.metadata.dataOrigin.packageName, SURVIVOR_ORIGIN);
    const source = data[item.source];
    const enabled = await F.activateReadiness(data, source, item.type);
    assert.equal(enabled.policyRevision, item.policyRevision);
    assert.equal(enabled.sharing, 'enabled'); assert.equal(enabled.binding.generation, item.generation);
    const vector = F.batch(source, item.sequence, [{ operation: 'upsert',
      identity: F.identity(source, item.type, item.id), dataFamily: 'ordinary', projection: 'raw-only',
      serializerId: 'health-connect-record', serializerVersion: 1, record }],
    { type: item.type, id: item.batchId });
    await F.ack(data, source, vector); data.survivors[item.cardId] = vector;
  }
  await F.restart(data);
  await waitFor(async () => {
    const status = await F.request(data, F.BASE + '/projections/status', { browser: true });
    assert.equal(status.status, 200); F.noAuthority(status.body, data);
    assert.equal(status.json.target, 'source-index-v1');
    if (status.json.sources.length !== 2) return false;
    const alpha = status.json.sources.find(row => row.sourceStoreId === data.alpha.binding.sourceStoreId);
    const beta = status.json.sources.find(row => row.sourceStoreId === data.beta.binding.sourceStoreId);
    return alpha?.state === 'current' && alpha.published?.records === 3 && alpha.published.tombstones === 1 &&
      beta?.state === 'current' && beta.published?.records === 2 && beta.published.tombstones === 0;
  }, { what: 'genuine current source index for both surviving native recovery records' });
  assertSurvivingNativeRows(data, F.coldRead(data.home));
}
async function selectSurvivingNativeCards(data) {
  for (const item of SURVIVORS) {
    const selected = await F.request(data, '/api/manifests/' + item.cardId,
      { method: 'PATCH', browser: true, body: { meta: { healthConnectDisplay:
        survivingNativeSelection(data, item) } } });
    assert.equal(selected.status, 200); F.noAuthority(selected.body, data);
  }
}
function assertSurvivingNativeRows(data, snapshot) {
  for (const item of SURVIVORS) {
    const rows = F.identityRows(snapshot, 'health_records', F.identity(data[item.source], item.type, item.id));
    assert.equal(rows.length, 1); assert.equal(rows[0].record_json, item.recordJson);
    assert.equal(Buffer.byteLength(rows[0].record_json), item.utf8Bytes);
    assert.equal(digest(Buffer.from(rows[0].record_json)), item.digest);
  }
}
async function assertSurvivingNativeViews(data, read) {
  for (const item of SURVIVORS) {
    const route = '/api/manifests/' + item.cardId;
    const served = await read(route + '/data');
    assert.equal(served.status, 200); F.noAuthority(served.body, data);
    assert.deepEqual(served.json.data, item.rows);
    assert.equal(served.json.projection.state, 'saved');
    assert.match(served.json.projection.revision, /^sha256:[a-f0-9]{64}$/);
    assert.deepEqual(served.json.projection.selectedSources, item.selectedSources);
    const full = await read(route);
    assert.equal(full.status, 200); F.noAuthority(full.body, data);
    assert.deepEqual(full.json.data, item.rows);
    assert.deepEqual(full.json.projection, served.json.projection);
    assert.deepEqual(full.json.meta.healthConnectDisplay, survivingNativeSelection(data, item));
  }
  const view = await read('/api/views/view');
  assert.equal(view.status, 200); F.noAuthority(view.body, data);
  for (const item of SURVIVORS) {
    const card = view.json.cards.find(row => row.id === item.cardId);
    assert.ok(card); assert.equal(card.viewConfig.component, 'generic-card');
    assert.equal(card.viewConfig.display.unit, item.unit);
  }
}

function assertSourceDeletionRows(data, snapshot) {
  const b = data.alpha.binding;
  const identity = { tenant_id: b.tenantId, source_store_id: b.sourceStoreId,
    record_type: CONTROL.type, native_record_id: CONTROL.id };
  const streamKey = F.streamKey(data.alpha, CONTROL.type);
  assert.equal(F.identityRows(snapshot, 'health_records',
    F.identity(data.alpha, CONTROL.type, CONTROL.id)).length, 0);
  assert.deepEqual(F.rows(snapshot, 'health_tombstones'), [{ ...identity,
    stream_key: streamKey, sequence: CONTROL.sequence }]);
  assert.deepEqual(F.identityRows(snapshot, 'health_deletion_guards',
    F.identity(data.alpha, CONTROL.type, CONTROL.id)), [{ ...identity,
    source_deleted: '1', user_suppressed: '0', source_stream_key: streamKey,
    source_sequence: CONTROL.sequence, footprint_json: null }]);
  const receipt = data.controlDelete.receipt;
  assert.deepEqual(F.rows(snapshot, 'health_batch_receipts').filter(row =>
    row.stream_key === streamKey && row.sequence === CONTROL.sequence), [{
      stream_key: streamKey, sequence: CONTROL.sequence, batch_id: CONTROL.batchId,
      payload_digest: receipt.payloadDigest, receipt_json: JSON.stringify(receipt) }]);
  assert.deepEqual(F.rows(snapshot, 'health_projection_outbox').filter(row =>
    row.stream_key === streamKey && row.sequence === CONTROL.sequence), [{
      stream_key: streamKey, sequence: CONTROL.sequence, batch_id: CONTROL.batchId,
      payload_digest: receipt.payloadDigest, state: 'queued' }]);
  assert.deepEqual(F.rows(snapshot, 'health_streams').filter(row => row.stream_key === streamKey), [{
    stream_key: streamKey, record_type: CONTROL.type, acknowledged_sequence: CONTROL.sequence }]);
}

async function seedOneHAEHistory(data) {
  assert.equal(Buffer.byteLength(HAE_INPUT_JSON), 117);
  assert.equal(digest(Buffer.from(HAE_INPUT_JSON)),
    'sha256:50833ff06fa4578c2bf10004bfc3beb2f4649d83838df43affdf328b8c67a898');
  const before = F.coldRead(data.home);
  assert.equal(F.rows(before, 'hae_pushes').length, 0);
  assert.equal(F.rows(before, 'hae_samples').length, 0);
  const card = await F.request(data, '/api/manifests', { method: 'POST', browser: true,
    body: { $schema: 'klebb.datafile.v1', meta: { id: HAE_CARD, label: 'Synthetic HAE steps',
      ingest: { source: 'hae', metric: 'step_count' }, writeable: { fromWebapp: false } } } });
  assert.equal(card.status, 201);
  const mint = await F.request(data, '/api/health-auto-export/token',
    { method: 'POST', browser: true, body: {} });
  assert.equal(mint.status, 200); assert.equal(typeof mint.json.token, 'string');
  data.markers.push(mint.json.token);
  const pushed = await F.request(data, '/api/health-auto-export', { method: 'POST',
    headers: { Authorization: 'Bearer ' + mint.json.token }, body: HAE_INPUT_JSON });
  assert.equal(pushed.status, 200);
  const served = await F.request(data, '/api/manifests/' + HAE_CARD + '/data', { browser: true });
  assert.equal(served.status, 200); assert.deepEqual(served.json.data, HAE_ROWS);
  const after = F.coldRead(data.home);
  data.haeReceivedAt = F.rows(after, 'hae_pushes')[0].received_at;
  assertOneHAEStored(after, data.haeReceivedAt);
  for (const family of ['health_records','health_streams','health_batch_receipts',
    'health_projection_outbox','health_tombstones','health_deletion_guards',
    'health_source_policy_state','health_source_policy_sources','health_source_policy_categories']) {
    assert.deepEqual(F.rows(after, family), F.rows(before, family),
      'HAE ingest preserves independently authenticated native raw, transport and policy inventory');
  }
}
function assertOneHAEStored(snapshot, receivedAt) {
  const pushes = F.rows(snapshot, 'hae_pushes'), samples = F.rows(snapshot, 'hae_samples');
  assert.equal(pushes.length, 1); assert.equal(samples.length, 1);
  assert.equal(pushes[0].received_at, receivedAt);
  assert.equal(Number.isFinite(Date.parse(receivedAt)), true);
  const sample = samples[0];
  assert.equal(sample.metric, 'step_count'); assert.equal(sample.metric_meta, '{"units":"count"}');
  assert.equal(sample.sample_date, '2026-06-01');
  assert.equal(sample.doc, '{"date":"2026-06-01 00:00:00 +1000","qty":8123}');
  assert.equal(digest(Buffer.from(sample.doc)),
    'sha256:1a0b58d49490c2458d41f887d39bd3301abffa14272b09811b5b0d8318f2aa60');
  assert.equal(sample.dup_count, '1'); assert.equal(sample.push_ord, '0');
  assert.equal(sample.first_push, '1'); assert.equal(sample.last_push, '1');
  assert.equal(pushes[0].push_seq, '1');
}


function assertUserDeletionRows(data, snapshot) {
  const b = data.alpha.binding, key = F.streamKey(data.alpha, USER_CONTROL.type);
  const id = F.identity(data.alpha, USER_CONTROL.type, USER_CONTROL.id);
  assert.equal(F.rows(snapshot, 'health_deletion_guards').length, 2);
  assert.equal(F.identityRows(snapshot, 'health_records', id).length, 0);
  assert.deepEqual(F.identityRows(snapshot, 'health_tombstones', id), []);
  assert.equal(Buffer.byteLength(USER_FOOTPRINT_JSON), 139);
  assert.deepEqual(F.identityRows(snapshot, 'health_deletion_guards', id), [{
    tenant_id: b.tenantId, source_store_id: b.sourceStoreId,
    record_type: USER_CONTROL.type, native_record_id: USER_CONTROL.id,
    source_deleted: '0', user_suppressed: '1', source_stream_key: null,
    source_sequence: null, footprint_json: USER_FOOTPRINT_JSON,
  }]);
  const receipt = data.userUpsert.receipt;
  assert.deepEqual(F.rows(snapshot, 'health_streams').filter(row => row.stream_key === key), [{
    stream_key: key, record_type: USER_CONTROL.type, acknowledged_sequence: '1',
  }]);
  assert.deepEqual(F.rows(snapshot, 'health_batch_receipts').filter(row => row.stream_key === key), [{
    stream_key: key, sequence: '1', batch_id: USER_CONTROL.batchId,
    payload_digest: receipt.payloadDigest, receipt_json: JSON.stringify(receipt),
  }]);
  assert.deepEqual(F.rows(snapshot, 'health_projection_outbox').filter(row => row.stream_key === key), [{
    stream_key: key, sequence: '1', batch_id: USER_CONTROL.batchId,
    payload_digest: receipt.payloadDigest, state: 'queued',
  }]);
}
async function seedAndUserDeleteOneSteps(data) {
  const prior = F.coldRead(data.home);
  assert.equal(F.identityRows(prior, 'health_records',
    F.identity(data.alpha, USER_CONTROL.type, USER_CONTROL.id)).length, 0);
  const enabled = await F.activateReadiness(data, data.alpha, USER_CONTROL.type);
  assert.equal(enabled.policyRevision, '7'); assert.equal(enabled.sharing, 'enabled');
  assert.equal(enabled.binding.generation, '2');
  assert.equal(Buffer.byteLength(USER_RECORD_JSON), 436);
  assert.equal(digest(Buffer.from(USER_RECORD_JSON)),
    'sha256:754a1712ea5807a28b84c32cfb01b80720b91ec140205aeb40eff057fd9b14ac');
  const change = { operation: 'upsert',
    identity: F.identity(data.alpha, USER_CONTROL.type, USER_CONTROL.id),
    dataFamily: 'ordinary', projection: 'raw-only', serializerId: 'health-connect-record',
    serializerVersion: 1, record: JSON.parse(USER_RECORD_JSON) };
  data.userUpsert = F.batch(data.alpha, '1', [change],
    { type: USER_CONTROL.type, id: USER_CONTROL.batchId });
  await F.ack(data, data.alpha, data.userUpsert);
  // Boot the real producer; it creates its index schema through prepareAttempt.
  await F.restart(data);
  const current = async alphaRecords => waitFor(async () => {
    const status = await F.request(data, F.BASE + '/projections/status', { browser: true });
    assert.equal(status.status, 200); F.noAuthority(status.body, data);
    assert.equal(status.json.target, 'source-index-v1');
    if (status.json.sources.length !== 2) return false;
    const alpha = status.json.sources.find(row => row.sourceStoreId === data.alpha.binding.sourceStoreId);
    const beta = status.json.sources.find(row => row.sourceStoreId === data.beta.binding.sourceStoreId);
    return alpha?.state === 'current' && alpha.published?.records === alphaRecords &&
      alpha.published.tombstones === 1 && beta?.state === 'current' &&
      beta.published?.records === 1 && beta.published.tombstones === 0;
  }, { what: 'genuine current source index before exact-ID user deletion' });
  await current(3);
  const before = F.coldRead(data.home);
  const stored = F.identityRows(before, 'health_records', change.identity);
  assert.equal(stored.length, 1); assert.equal(stored[0].record_json, USER_RECORD_JSON);
  const selected = { sourceStoreId: data.alpha.binding.sourceStoreId,
    identities: [{ recordType: USER_CONTROL.type, nativeRecordId: USER_CONTROL.id }] };
  const preview = await F.request(data, F.BASE + '/deletions/preview',
    { method: 'POST', browser: true, body: selected });
  assert.equal(preview.status, 200); F.noAuthority(preview.body, data);
  assert.match(preview.json.revision, /^sha256:[a-f0-9]{64}$/);
  const effects = { newlyUserSuppressed: 1, removedRecords: 1,
    removedStagedObjects: 0, removedParts: 0, removedPartBytes: 0 };
  assert.deepEqual(preview.json, { version: 1, kind: 'deletion-preview',
    sourceStoreId: selected.sourceStoreId, revision: preview.json.revision,
    identities: [{ recordType: USER_CONTROL.type, nativeRecordId: USER_CONTROL.id,
      sourceDeleted: false, userSuppressed: false, currentRecord: true,
      footprint: JSON.parse(USER_FOOTPRINT_JSON) }], effects });
  assert.deepEqual(F.coldRead(data.home).native, before.native, 'preview is read only');
  const applied = await F.request(data, F.BASE + '/deletions/apply',
    { method: 'POST', browser: true, body: { ...selected, revision: preview.json.revision } });
  assert.equal(applied.status, 200); F.noAuthority(applied.body, data);
  assert.deepEqual(applied.json, { version: 1, kind: 'deletion-result',
    sourceStoreId: selected.sourceStoreId, revision: preview.json.revision,
    effects, projectionQueued: true });
  await F.restart(data); await current(2);
  const deleted = F.coldRead(data.home);
  assertUserDeletionRows(data, deleted); assertSourceDeletionRows(data, deleted);
  for (const family of ['health_records','health_tombstones','health_batch_receipts',
    'health_projection_outbox','health_streams','health_source_policy_state',
    'health_source_policy_sources','health_source_policy_categories','hae_pushes','hae_samples']) {
    const rows = F.rows(before, family);
    assert.deepEqual(F.rows(deleted, family), family === 'health_records' ?
      rows.filter(row => !(row.record_type === USER_CONTROL.type &&
        row.native_record_id === USER_CONTROL.id && row.tenant_id === change.identity.tenantId &&
        row.source_store_id === change.identity.sourceStoreId)) : rows,
    'owner deletion removes only the selected extra raw record and preserves policy/transport/HAE');
  }
  const files = retainedSourceFiles(data);
  const replay = await F.post(data, data.alpha, F.BATCH, data.userUpsert.wire);
  assert.equal(replay.status, 200); assert.deepEqual(replay.json, data.userUpsert.receipt);
  const retry = F.batch(data.alpha, '2', [change],
    { type: USER_CONTROL.type, id: 'managed-roundtrip-Steps-user-retry-2' });
  const refused = await F.post(data, data.alpha, F.BATCH, retry.wire);
  F.failure(refused, 409, 'deletion-suppressed', data);
  const after = F.coldRead(data.home);
  assert.deepEqual(after.native, deleted.native);
  assert.deepEqual(after.physical, deleted.physical);
  assert.deepEqual(retainedSourceFiles(data), files);
  assertUserDeletionRows(data, after);
}
