// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { createSandbox, cleanupSandbox, spawnServer, req, fakeAuthState } = require('../helpers/sandbox');

const BASE = '/api/connectors/health-connect';
const ORIGIN = 'https://ordinary-readiness.example.test';
const KEY = 'invented-ordinary-readiness-key-for-isolated-tests';
const ENV = {
  HEALTH_ORIGIN: ORIGIN, HEALTH_RP_ID: 'ordinary-readiness.example.test', SESSION_SECRET: KEY,
  AGENT_API_TOKEN: '', KLEBB_ADMIN_TOKEN: '', KLEBB_CLOUD: '', KLEBB_DEMO: '',
  HEALTH_DATA_DIR: '', HEALTH_REPORTS_DIR: '', HEALTH_AUTO_EXPORT_DIR: '',
  HEALTH_SESSIONS_DIR: '', HEALTH_CREDENTIALS_DIR: '', HEALTH_ARCHIVE_DIR: '',
  HEALTH_CONFIG_PATH: '', HEALTH_DB_DIR: '', HEALTH_DB_FILE: '', HEALTH_CHAT_DIR: '',
  HEALTH_USER_FILE: '', HEALTH_NOTIFICATIONS_STATE_FILE: '', HEALTH_INBOX_DIR: '',
  HEALTH_KEYS_DIR: '', HEALTH_VAPID_FILE: '', HEALTH_PUSH_SUBSCRIPTIONS_FILE: '',
  HEALTH_AUTO_EXPORT_TOKEN: '', NODE_OPTIONS: '',
};
// Independent advertised catalogue: do not derive expected membership from the production Set.
const ORDINARY = [
  'ActiveCaloriesBurnedRecord', 'ActivityIntensityRecord', 'BasalBodyTemperatureRecord',
  'BasalMetabolicRateRecord', 'BloodGlucoseRecord', 'BloodPressureRecord', 'BodyFatRecord',
  'BodyTemperatureRecord', 'BodyWaterMassRecord', 'BoneMassRecord', 'CervicalMucusRecord',
  'CyclingPedalingCadenceRecord', 'DistanceRecord', 'ElevationGainedRecord', 'ExerciseSessionRecord',
  'FloorsClimbedRecord', 'HeartRateRecord', 'HeartRateVariabilityRmssdRecord', 'HeightRecord',
  'HydrationRecord', 'IntermenstrualBleedingRecord', 'LeanBodyMassRecord', 'MenstruationFlowRecord',
  'MenstruationPeriodRecord', 'MindfulnessSessionRecord', 'NutritionRecord', 'OvulationTestRecord',
  'OxygenSaturationRecord', 'PlannedExerciseSessionRecord', 'PowerRecord', 'RespiratoryRateRecord',
  'RestingHeartRateRecord', 'SexualActivityRecord', 'SkinTemperatureRecord', 'SleepSessionRecord',
  'SpeedRecord', 'StepsCadenceRecord', 'StepsRecord', 'TotalCaloriesBurnedRecord', 'Vo2MaxRecord',
  'WeightRecord', 'WheelchairPushesRecord',
];
const BODY = 'BodyWaterMassRecord', WEIGHT = 'WeightRecord', CYCLE = 'CyclingPedalingCadenceRecord';
const digest = value => 'sha256:' + crypto.createHash('sha256').update(value).digest('hex');
const FP = 'sha256:db4912372cd0190c42ec800c11d08841050322e2529813b8d6edaddac9a7b911';
const query = type => JSON.stringify({ recordType: type,
  window: { start: '2026-10-28T00:00:00.000Z', end: '2026-10-29T00:00:00.000Z' }, pageSize: 2 });
const responseError = (result, code, status = 409, version = 2) => {
  assert.equal(result.status, status, result.body);
  assert.deepEqual(result.json, { version, kind: 'error', code, retryable: status === 503 });
};
async function setup() {
  const owner = fakeAuthState('synthetic-ordinary-readiness-member');
  const home = createSandbox({ credentials: owner.credentials, sessions: owner.sessions });
  const f = { owner, home, server: null };
  try { f.server = await spawnServer(home, ENV); return f; }
  catch (error) { cleanupSandbox(home); throw error; }
}
async function close(f) { if (f.server) await f.server.kill(); cleanupSandbox(f.home); }
async function restart(f) {
  await f.server.kill(); f.server = null; f.server = await spawnServer(f.home, ENV);
}
const browser = (f, route, options = {}) => req(f.server.baseUrl, route, {
  cookie: f.owner.cookie, ...options, headers: { Origin: ORIGIN, ...options.headers },
});
async function pair(f, categories = [BODY, WEIGHT, CYCLE]) {
  const auth = await browser(f, '/auth/status');
  assert.equal(auth.status, 200); assert.equal(auth.json.authenticated, true);
  const granted = await browser(f, `${BASE}/pairing-grants`, { method: 'POST',
    body: { categories, name: 'Invented ordinary readiness source' } });
  assert.equal(granted.status, 201, granted.body);
  const paired = await req(f.server.baseUrl, `${BASE}/v1/pairing/exchange`, { method: 'POST',
    body: { version: 1, kind: 'pairing-exchange', tenantId: granted.json.tenantId,
      instanceId: granted.json.instanceId, sourceStoreId: granted.json.sourceStoreId,
      grant: granted.json.grant, installationId: 'invented-ordinary-readiness-installation', categories } });
  assert.equal(paired.status, 200, paired.body);
  const capabilities = await req(f.server.baseUrl, `${BASE}/v1/capabilities`, {
    headers: { Authorization: `Bearer ${paired.json.credential}`, 'Klebb-Health-Protocol': '1' } });
  assert.equal(capabilities.status, 200, capabilities.body);
  assert.equal(capabilities.json.kind, 'capabilities');
  assert.deepEqual(capabilities.json.supportedVersions, [1]);
  assert.deepEqual(capabilities.json.categories, categories);
  for (const type of categories) assert.deepEqual(capabilities.json.streams[type],
    { generation: '1', acknowledgedSequence: '0' });
  return paired.json;
}
const binding = (paired, generation = '1') => ({
  tenantId: paired.tenantId, instanceId: paired.instanceId, sourceStoreId: paired.sourceStoreId,
  installationId: paired.installationId, generation, restoreEpoch: paired.restoreEpoch,
});
const send = (f, paired, type, body, version = '2') => req(f.server.baseUrl,
  `${BASE}/v2/streams/${type}/readiness`, { method: 'POST', body,
    headers: { Authorization: `Bearer ${paired.credential}`, 'Klebb-Health-Protocol': version } });
const status = (f, paired, type, current = binding(paired)) => send(f, paired, type,
  { version: 2, kind: 'readiness-status', recordType: type, binding: current });
function rows(f) {
  const db = new DatabaseSync(path.join(f.home, 'db', 'klebb.db'), { readOnly: true });
  try {
    db.exec('BEGIN');
    const all = table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map(x => ({ ...x }));
    return { state: all('health_source_policy_state'), sources: all('health_source_policy_sources'),
      categories: all('health_source_policy_categories'), native: Object.fromEntries([
        'health_records', 'health_tombstones', 'health_streams', 'health_batch_receipts',
        'health_projection_outbox'].map(table => [table, all(table)])) };
  } finally { db.close(); }
}
const snapshot = f => ({ sql: rows(f),
  catalogue: fs.readFileSync(path.join(f.home, 'credentials', 'health-connect-policy.json')) });
const category = (saved, type) => saved.categories.find(c => c.record_type === type);
const retained = saved => Object.fromEntries(Object.entries(saved.native)
  .filter(([table]) => table !== 'health_projection_outbox'));
const beginBody = (type, current, revision) => ({
  version: 2, kind: 'readiness-begin', recordType: type, binding: current,
  policyRevision: revision, queryJson: query(type), filterDigest: digest(query(type)),
});
async function begin(f, paired, type, current = binding(paired)) {
  const observed = await status(f, paired, type, current);
  assert.equal(observed.status, 200, observed.body);
  const reply = await send(f, paired, type, beginBody(type, current, observed.json.policyRevision));
  assert.equal(reply.status, 200, reply.body);
  assert.equal(reply.json.kind, 'readiness-challenge');
  assert.equal(reply.json.recordType, type);
  assert.equal(reply.json.queryJson, query(type));
  assert.equal(reply.json.filterDigest, digest(query(type)));
  assert.equal(reply.json.acknowledgedSequence, '0');
  return reply.json;
}
function report(challenge) {
  // An invented authenticated report exercises the server boundary, never SDK or device evidence.
  return { version: 2, kind: 'readiness-complete', recordType: challenge.recordType,
    readinessId: challenge.readinessId, binding: challenge.binding,
    policyRevision: challenge.policyRevision, filterDigest: challenge.filterDigest,
    firstPage: { localReadRevision: '1', recordCount: '1', terminalPage: false,
      permissionFingerprintStart: FP, permissionFingerprintEnd: FP, tokenValid: true,
      historyWindowLimited: true, interveningChangeCount: '1', changesHaveMore: true } };
}
async function complete(f, paired, challenge) {
  const reply = await send(f, paired, challenge.recordType, report(challenge));
  assert.equal(reply.status, 200, reply.body);
  assert.deepEqual(reply.json, { version: 2, kind: 'readiness-result', recordType: challenge.recordType,
    binding: challenge.binding, policyRevision: String(BigInt(challenge.policyRevision) + 1n),
    sharing: 'enabled', verification: 'authenticated-companion-report' });
  return reply.json;
}
function bodyFrame(current) {
  const payloadJson = JSON.stringify({ binding: current, recordType: BODY, sequence: '1',
    batchId: 'invented-ready-body-water-batch', changes: [{ operation: 'upsert',
      identity: { tenantId: current.tenantId, sourceStoreId: current.sourceStoreId,
        recordType: BODY, nativeRecordId: 'invented-ready-body-water' },
      dataFamily: 'ordinary', projection: 'raw-only', serializerId: 'health-connect-record',
      serializerVersion: 1, record: { metadata: { id: 'invented-ready-body-water',
        dataOrigin: { packageName: 'org.example.synthetic' }, clientRecordVersion: '1',
        lastModifiedTime: '2026-10-28T03:50:00.123456789Z', recordingMethod: 1 },
        time: '2026-10-28T03:45:00.123456789Z', zoneOffset: '+11:00',
        mass: { value: '43.125', unit: 'kg' } } }] });
  return { version: 1, kind: 'batch', payloadJson, payloadDigest: digest(payloadJson) };
}
const uploadBody = (f, paired, current) => req(f.server.baseUrl, `${BASE}/v1/batches`, {
  method: 'POST', body: bodyFrame(current), headers: { Authorization: `Bearer ${paired.credential}`,
    'Klebb-Health-Protocol': '1', 'Klebb-Health-Generation': current.generation,
    'Klebb-Health-Restore-Epoch': current.restoreEpoch },
});

test('ORDREADY01 genuine BodyWater setup reaches closed-type baseline before first-page activation', async () => {
  const f = await setup();
  try {
    const paired = await pair(f);
    const healthy = await status(f, paired, WEIGHT);
    assert.equal(healthy.status, 200, healthy.body);
    assert.equal(healthy.json.policyRevision, '1');
    assert.equal(healthy.json.sharing, 'stopped'); assert.equal(healthy.json.verification, 'unverified');
    const before = snapshot(f);
    responseError(await uploadBody(f, paired, binding(paired)), 'IMPORT_SOURCE_POLICY_UNKNOWN', 409, 1);
    assert.deepEqual(snapshot(f), before);
    const reply = await send(f, paired, BODY, beginBody(BODY, binding(paired), '1'));
    // Qualify only the existing unsupported-type refusal after genuine authentication/pairing/status.
    assert.ok(reply.status === 200 || (reply.status === 403 && reply.json.code === 'scope-mismatch'),
      reply.body);
    if (reply.status === 403) {
      responseError(reply, 'scope-mismatch', 403);
      assert.deepEqual(snapshot(f), before, 'Unsupported BodyWater readiness has no policy/history effect');
    }
    assert.equal(reply.status, 200, 'The advertised BodyWater category must issue its own challenge');
    const challenge = reply.json;
    assert.equal(challenge.recordType, BODY); assert.deepEqual(challenge.binding, binding(paired, '2'));
    assert.equal(challenge.policyRevision, '2'); assert.equal(challenge.acknowledgedSequence, '0');
    assert.equal(challenge.queryJson, query(BODY)); assert.equal(challenge.filterDigest, digest(query(BODY)));
    await complete(f, paired, challenge);
    const after = rows(f);
    assert.deepEqual(after.native, before.sql.native, 'Readiness cannot advance ACK or write raw history');
    const current = await status(f, paired, BODY, challenge.binding);
    assert.equal(current.status, 200); assert.equal(current.json.recordType, BODY);
    assert.equal(current.json.verification, 'authenticated-companion-report');
    const saved = await uploadBody(f, paired, challenge.binding);
    assert.equal(saved.status, 200, saved.body); assert.equal(saved.json.kind, 'durable-receipt');
    assert.equal(saved.json.sequence, '1');
  } finally { await close(f); }
});

test('ORDREADY02 every independent advertised ordinary category activates only its own stopped generation', async () => {
  assert.equal(ORDINARY.length, 42);
  assert.deepEqual(require('../../config/health-connect-categories.json'), ORDINARY);
  const f = await setup();
  try {
    const paired = await pair(f, ORDINARY);
    for (let index = 0; index < ORDINARY.length; index++) {
      const type = ORDINARY[index], before = rows(f);
      const stopped = await status(f, paired, type);
      assert.equal(stopped.status, 200, stopped.body);
      assert.equal(stopped.json.sharing, 'stopped'); assert.equal(stopped.json.verification, 'unverified');
      assert.equal(stopped.json.policyRevision, String(1 + 2 * index));
      const challenge = await begin(f, paired, type);
      assert.deepEqual(challenge.binding, binding(paired, '2'));
      assert.equal(challenge.policyRevision, String(2 + 2 * index));
      await complete(f, paired, challenge);
      const after = rows(f);
      const expectedSiblings = before.categories.filter(c => c.record_type !== type).map(c =>
        index === 0 ? { ...c, readiness_epoch: null, readiness_installation_id: null,
          readiness_generation: null, readiness_query_digest: null, readiness_report_digest: null,
          readiness_mac: null } : c);
      assert.deepEqual(after.categories.filter(c => c.record_type !== type),
        expectedSiblings, `${type} preserves sibling values; the initial V2 migration adds NULL provenance`);
      assert.deepEqual(after.native, before.native);
      const current = await status(f, paired, type, challenge.binding);
      assert.equal(current.status, 200); assert.equal(current.json.recordType, type);
      assert.equal(current.json.policyRevision, String(3 + 2 * index));
      assert.equal(current.json.sharing, 'enabled');
      assert.equal(current.json.verification, 'authenticated-companion-report');
    }
    const final = rows(f);
    assert.equal(final.categories.length, 42);
    for (const c of final.categories) { assert.equal(c.sharing, 'enabled'); assert.equal(c.generation, '2'); }
    for (const list of Object.values(final.native)) assert.deepEqual(list, []);
  } finally { await close(f); }
});

test('ORDREADY03 mismatched route query report and challenge refuse without consuming genuine authority', async () => {
  const f = await setup();
  try {
    const paired = await pair(f), healthy = await status(f, paired, WEIGHT);
    assert.equal(healthy.status, 200, healthy.body);
    const before = snapshot(f), valid = beginBody(BODY, binding(paired), '1');
    responseError(await send(f, paired, BODY, { ...valid, recordType: WEIGHT }), 'invalid-message', 400);
    const wrongQuery = query(WEIGHT);
    responseError(await send(f, paired, BODY, { ...valid, queryJson: wrongQuery,
      filterDigest: digest(wrongQuery) }), 'invalid-message', 400);
    responseError(await send(f, paired, BODY, { ...valid, filterDigest: digest(wrongQuery) }),
      'digest-mismatch', 400);
    assert.deepEqual(snapshot(f), before);
    const bodyChallenge = await begin(f, paired, BODY);
    const weightChallenge = await begin(f, paired, WEIGHT);
    const held = snapshot(f);
    const changedType = { ...report(bodyChallenge), recordType: WEIGHT };
    responseError(await send(f, paired, BODY, changedType), 'invalid-message', 400);
    responseError(await send(f, paired, WEIGHT, changedType), 'readiness-unverified');
    const changedQuery = { ...report(weightChallenge), filterDigest: digest(query(BODY)) };
    responseError(await send(f, paired, WEIGHT, changedQuery), 'readiness-unverified');
    responseError(await send(f, paired, BODY, report(bodyChallenge)), 'binding-mismatch');
    assert.deepEqual(snapshot(f), held);
    await complete(f, paired, weightChallenge);
    const stopped = await status(f, paired, BODY, bodyChallenge.binding);
    assert.equal(stopped.status, 200); assert.equal(stopped.json.sharing, 'stopped');
    assert.equal(stopped.json.verification, 'unverified');
  } finally { await close(f); }
});

test('ORDREADY04 medical unknown aliases unpaired categories and V1 negotiation refuse beside a genuine control', async () => {
  const f = await setup();
  try {
    const paired = await pair(f), weight = await begin(f, paired, WEIGHT);
    await complete(f, paired, weight);
    const before = snapshot(f);
    for (const type of ['MedicalResource', 'UnknownRecord', 'Weight', 'BoneMassRecord']) {
      responseError(await status(f, paired, type), 'scope-mismatch', 403);
      assert.deepEqual(snapshot(f), before);
    }
    responseError(await send(f, paired, BODY, beginBody(BODY, binding(paired), '3'), '1'),
      'unsupported-version', 400);
    assert.deepEqual(snapshot(f), before);
    const healthy = await status(f, paired, WEIGHT, weight.binding);
    assert.equal(healthy.status, 200); assert.equal(healthy.json.verification, 'authenticated-companion-report');
  } finally { await close(f); }
});

test('ORDREADY05 BodyWater activation and another stopped generation preserve healthy Weight and Cycling siblings', async () => {
  const f = await setup();
  try {
    const paired = await pair(f), weight = await begin(f, paired, WEIGHT);
    await complete(f, paired, weight);
    const cycle = await begin(f, paired, CYCLE); await complete(f, paired, cycle);
    const healthy = rows(f), body = await begin(f, paired, BODY);
    assert.deepEqual(category(rows(f), WEIGHT), category(healthy, WEIGHT));
    assert.deepEqual(category(rows(f), CYCLE), category(healthy, CYCLE));
    await complete(f, paired, body);
    const second = await begin(f, paired, BODY, body.binding);
    assert.deepEqual(second.binding, binding(paired, '3'));
    const pending = snapshot(f);
    responseError(await send(f, paired, BODY, report(body)), 'readiness-unverified');
    assert.deepEqual(snapshot(f), pending);
    for (const [type, challenge] of [[WEIGHT, weight], [CYCLE, cycle]]) {
      assert.deepEqual(category(rows(f), type), category(healthy, type));
      const current = await status(f, paired, type, challenge.binding);
      assert.equal(current.status, 200); assert.equal(current.json.sharing, 'enabled');
      assert.equal(current.json.verification, 'authenticated-companion-report');
    }
    await complete(f, paired, second);
  } finally { await close(f); }
});

test('ORDREADY06 same-key cold BodyWater completion survives then gen2 to gen3 retains real old history', async () => {
  const f = await setup();
  try {
    const paired = await pair(f), first = await begin(f, paired, BODY);
    await complete(f, paired, first);
    const saved = await uploadBody(f, paired, first.binding);
    assert.equal(saved.status, 200, saved.body);
    const history = retained(rows(f));
    await restart(f);
    const current = await status(f, paired, BODY, first.binding);
    assert.equal(current.status, 200); assert.equal(current.json.verification, 'authenticated-companion-report');
    assert.deepEqual(retained(rows(f)), history);
    const second = await begin(f, paired, BODY, first.binding);
    assert.deepEqual(second.binding, binding(paired, '3'));
    assert.deepEqual(retained(rows(f)), history);
    const stopped = await status(f, paired, BODY, second.binding);
    assert.equal(stopped.status, 200); assert.equal(stopped.json.sharing, 'stopped');
    assert.equal(stopped.json.verification, 'unverified');
    await complete(f, paired, second);
    assert.deepEqual(retained(rows(f)), history);
  } finally { await close(f); }
});

test('ORDREADY07 cold restart invalidates a BodyWater challenge without activating or changing its stopped rows', async () => {
  const f = await setup();
  try {
    const paired = await pair(f), challenge = await begin(f, paired, BODY);
    const before = snapshot(f);
    await restart(f);
    responseError(await send(f, paired, BODY, report(challenge)), 'readiness-unverified');
    assert.deepEqual(snapshot(f), before);
    const stopped = await status(f, paired, BODY, challenge.binding);
    assert.equal(stopped.status, 200); assert.equal(stopped.json.sharing, 'stopped');
    assert.equal(stopped.json.verification, 'unverified');
    const current = await begin(f, paired, BODY, challenge.binding);
    assert.deepEqual(current.binding, binding(paired, '3'));
    await complete(f, paired, current);
  } finally { await close(f); }
});

test('ORDREADY08 genuine Weight proof copied into BodyWater cannot authenticate another category', async () => {
  const f = await setup();
  try {
    const paired = await pair(f), weight = await begin(f, paired, WEIGHT);
    await complete(f, paired, weight);
    const body = await begin(f, paired, BODY); await complete(f, paired, body);
    const healthy = rows(f);
    assert.equal((await status(f, paired, BODY, body.binding)).json.verification,
      'authenticated-companion-report');
    const db = new DatabaseSync(path.join(f.home, 'db', 'klebb.db'));
    try { db.prepare('UPDATE health_source_policy_categories SET readiness_mac=? WHERE record_type=?')
      .run(category(healthy, WEIGHT).readiness_mac, BODY); } finally { db.close(); }
    await restart(f);
    const observed = await status(f, paired, BODY, body.binding);
    assert.equal(observed.status, 200); assert.equal(observed.json.sharing, 'enabled');
    assert.equal(observed.json.verification, 'unverified');
    const before = snapshot(f);
    responseError(await uploadBody(f, paired, body.binding), 'IMPORT_SOURCE_POLICY_VERIFIER_REQUIRED', 409, 1);
    assert.deepEqual(snapshot(f), before);
    assert.deepEqual(category(rows(f), WEIGHT), category(healthy, WEIGHT));
    const sibling = await status(f, paired, WEIGHT, weight.binding);
    assert.equal(sibling.status, 200); assert.equal(sibling.json.verification, 'authenticated-companion-report');
  } finally { await close(f); }
});
