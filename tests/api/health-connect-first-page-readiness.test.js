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
const READY = `${BASE}/v2/streams/WeightRecord/readiness`;
const ORIGIN = 'https://readiness.example.test';
const KEY = 'invented-readiness-server-key-for-isolated-tests';
const ENV = {
  HEALTH_ORIGIN: ORIGIN, HEALTH_RP_ID: 'readiness.example.test', SESSION_SECRET: KEY,
  AGENT_API_TOKEN: '', KLEBB_ADMIN_TOKEN: '', KLEBB_CLOUD: '', KLEBB_DEMO: '',
  HEALTH_DATA_DIR: '', HEALTH_REPORTS_DIR: '', HEALTH_AUTO_EXPORT_DIR: '',
  HEALTH_SESSIONS_DIR: '', HEALTH_CREDENTIALS_DIR: '', HEALTH_ARCHIVE_DIR: '',
  HEALTH_CONFIG_PATH: '', HEALTH_DB_DIR: '', HEALTH_DB_FILE: '', HEALTH_CHAT_DIR: '',
  HEALTH_USER_FILE: '', HEALTH_NOTIFICATIONS_STATE_FILE: '', HEALTH_INBOX_DIR: '',
  HEALTH_KEYS_DIR: '', HEALTH_VAPID_FILE: '', HEALTH_PUSH_SUBSCRIPTIONS_FILE: '',
  HEALTH_AUTO_EXPORT_TOKEN: '', NODE_OPTIONS: '',
};
const QUERY = '{"recordType":"WeightRecord","window":{"start":"2026-10-28T00:00:00.000Z",'
  + '"end":"2026-10-29T00:00:00.000Z"},"pageSize":2}';
const digest = value => 'sha256:' + crypto.createHash('sha256').update(value).digest('hex');
const FP = 'sha256:db4912372cd0190c42ec800c11d08841050322e2529813b8d6edaddac9a7b911';
const responseError = (result, status, code, version = 2) => {
  assert.equal(result.status, status, result.body);
  assert.deepEqual(result.json, { version, kind: 'error', code, retryable: status === 503 });
};
async function setup(extraEnv = {}) {
  const owner = fakeAuthState('synthetic-readiness-member');
  const home = createSandbox({ credentials: owner.credentials, sessions: owner.sessions });
  const f = { owner, home, server: null };
  try { f.server = await spawnServer(home, { ...ENV, ...extraEnv }); return f; }
  catch (error) { cleanupSandbox(home); throw error; }
}
async function close(f) { if (f.server) await f.server.kill(); cleanupSandbox(f.home); }
const browser = (f, route, options = {}) => req(f.server.baseUrl, route, {
  cookie: f.owner.cookie, ...options, headers: { Origin: ORIGIN, ...options.headers },
});
async function pair(f) {
  const auth = await browser(f, '/auth/status');
  assert.equal(auth.status, 200); assert.equal(auth.json.authenticated, true);
  const grant = await browser(f, `${BASE}/pairing-grants`, { method: 'POST',
    body: { categories: ['WeightRecord', 'StepsRecord'], name: 'Invented readiness source' } });
  assert.equal(grant.status, 201, grant.body);
  const paired = await req(f.server.baseUrl, `${BASE}/v1/pairing/exchange`, { method: 'POST',
    body: { version: 1, kind: 'pairing-exchange', tenantId: grant.json.tenantId,
      instanceId: grant.json.instanceId, sourceStoreId: grant.json.sourceStoreId,
      grant: grant.json.grant, installationId: 'invented-readiness-installation',
      categories: ['WeightRecord', 'StepsRecord'] } });
  assert.equal(paired.status, 200, paired.body);
  const capabilities = await req(f.server.baseUrl, `${BASE}/v1/capabilities`, {
    headers: { Authorization: `Bearer ${paired.json.credential}`, 'Klebb-Health-Protocol': '1' } });
  assert.equal(capabilities.status, 200, capabilities.body);
  assert.equal(capabilities.json.kind, 'capabilities');
  assert.deepEqual(capabilities.json.supportedVersions, [1]);
  assert.deepEqual(capabilities.json.streams.WeightRecord, { generation: '1', acknowledgedSequence: '0' });
  return paired.json;
}
function binding(paired, generation = '1') {
  return { tenantId: paired.tenantId, instanceId: paired.instanceId,
    sourceStoreId: paired.sourceStoreId, installationId: paired.installationId,
    generation, restoreEpoch: paired.restoreEpoch };
}
const send = (f, paired, body) => req(f.server.baseUrl, READY, { method: 'POST', body,
  headers: { Authorization: `Bearer ${paired.credential}`, 'Klebb-Health-Protocol': '2' } });
const status = (f, paired, current) => send(f, paired,
  { version: 2, kind: 'readiness-status', recordType: 'WeightRecord', binding: current });
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
async function begin(f, paired, current = binding(paired)) {
  const observed = await status(f, paired, current);
  assert.equal(observed.status, 200, observed.body);
  const body = { version: 2, kind: 'readiness-begin', recordType: 'WeightRecord',
    binding: current, policyRevision: observed.json.policyRevision, queryJson: QUERY, filterDigest: digest(QUERY) };
  const before = rows(f);
  const reply = await send(f, paired, body);
  // Qualify the declared missing feature only after genuine authenticated capabilities and bound status.
  assert.ok(reply.status === 200 || (reply.status === 409 &&
    reply.json.code === 'IMPORT_SOURCE_POLICY_VERIFIER_REQUIRED'), reply.body);
  if (reply.status === 409) {
    responseError(reply, 409, 'IMPORT_SOURCE_POLICY_VERIFIER_REQUIRED');
    assert.deepEqual(rows(f), before, 'The declared baseline refusal leaves actual policy and history unchanged');
  }
  assert.equal(reply.status, 200, 'A healthy current stopped scope must issue a genuine readiness challenge');
  return reply.json;
}
function report(challenge) {
  // Invented authenticated companion report exercises the server boundary; no native evidence.
  return { version: 2, kind: 'readiness-complete', recordType: 'WeightRecord',
    readinessId: challenge.readinessId, binding: challenge.binding,
    policyRevision: challenge.policyRevision, filterDigest: challenge.filterDigest,
    firstPage: { localReadRevision: '1', recordCount: '1', terminalPage: false,
      permissionFingerprintStart: FP, permissionFingerprintEnd: FP, tokenValid: true,
      historyWindowLimited: true, interveningChangeCount: '1', changesHaveMore: true } };
}
async function complete(f, paired, challenge) {
  const reply = await send(f, paired, report(challenge));
  assert.equal(reply.status, 200, reply.body);
  assert.deepEqual(reply.json, { version: 2, kind: 'readiness-result', recordType: 'WeightRecord',
    binding: challenge.binding, policyRevision: String(BigInt(challenge.policyRevision) + 1n),
    sharing: 'enabled', verification: 'authenticated-companion-report' });
  return reply.json;
}
function frame(current) {
  const payload = { binding: current, recordType: 'WeightRecord', sequence: '1',
    batchId: 'invented-ready-weight-batch', changes: [{ operation: 'upsert',
      identity: { tenantId: current.tenantId, sourceStoreId: current.sourceStoreId,
        recordType: 'WeightRecord', nativeRecordId: 'invented-ready-weight' },
      dataFamily: 'ordinary', projection: 'raw-only',
      record: { metadata: { id: 'invented-ready-weight',
        dataOrigin: { packageName: 'org.example.synthetic' }, clientRecordVersion: '1',
        lastModifiedTime: '2026-10-28T03:50:00.123456789Z', recordingMethod: 1 },
        time: '2026-10-28T03:45:00.123456789Z', zoneOffset: '+11:00',
        weight: { value: '76.25', unit: 'kg' } },
      serializerId: 'health-connect-record', serializerVersion: 1 }] };
  const payloadJson = JSON.stringify(payload);
  return { version: 1, kind: 'batch', payloadJson, payloadDigest: digest(payloadJson) };
}
const upload = (f, paired, current) => req(f.server.baseUrl, `${BASE}/v1/batches`, { method: 'POST',
  headers: { Authorization: `Bearer ${paired.credential}`, 'Klebb-Health-Protocol': '1',
    'Klebb-Health-Generation': current.generation, 'Klebb-Health-Restore-Epoch': current.restoreEpoch },
  body: frame(current) });
async function restart(f, key = KEY) {
  await f.server.kill(); f.server = null;
  f.server = await spawnServer(f.home, { ...ENV, SESSION_SECRET: key });
}

test('READYAPI01 healthy native credential/status reaches challenge then conditional first-page admission', async () => {
  const f = await setup();
  try {
    const paired = await pair(f);
    const initial = await status(f, paired, binding(paired));
    assert.equal(initial.status, 200, initial.body);
    assert.deepEqual(initial.json, { version: 2, kind: 'readiness-result', recordType: 'WeightRecord',
      binding: binding(paired), policyRevision: '1', sharing: 'stopped', verification: 'unverified' });
    const before = rows(f);
    const refused = await upload(f, paired, binding(paired));
    responseError(refused, 409, 'IMPORT_SOURCE_POLICY_UNKNOWN', 1);
    assert.deepEqual(rows(f), before);
    const challenge = await begin(f, paired);
    assert.equal(challenge.binding.generation, '2');
    assert.equal(challenge.policyRevision, '2');
    assert.equal(challenge.acknowledgedSequence, '0');
    assert.equal(challenge.queryJson, QUERY); assert.equal(challenge.filterDigest, digest(QUERY));
    assert.deepEqual(rows(f).categories.find(c => c.record_type === 'StepsRecord'),
      { ...before.categories.find(c => c.record_type === 'StepsRecord'),
        readiness_epoch: null, readiness_installation_id: null, readiness_generation: null,
        readiness_query_digest: null, readiness_report_digest: null, readiness_mac: null });
    await complete(f, paired, challenge);
    assert.deepEqual(rows(f).native, before.native, 'Completion does not create history, ACK or upload receipts');
    const current = await status(f, paired, challenge.binding);
    assert.equal(current.status, 200); assert.equal(current.json.verification, 'authenticated-companion-report');
    const saved = await upload(f, paired, challenge.binding);
    assert.equal(saved.status, 200, saved.body);
    assert.equal(saved.json.kind, 'durable-receipt'); assert.equal(saved.json.sequence, '1');
  } finally { await close(f); }
});

test('READYAPI02 changed permission report refuses without activation; original valid report still qualifies', async () => {
  const f = await setup();
  try {
    const paired = await pair(f), challenge = await begin(f, paired), before = rows(f);
    const changed = report(challenge);
    changed.firstPage.permissionFingerprintEnd = 'sha256:' + '0'.repeat(64);
    responseError(await send(f, paired, changed), 409, 'readiness-unverified');
    assert.deepEqual(rows(f), before);
    const expired = report(challenge); expired.firstPage.tokenValid = false;
    responseError(await send(f, paired, expired), 409, 'readiness-unverified');
    assert.deepEqual(rows(f), before);
    await complete(f, paired, challenge);
  } finally { await close(f); }
});

test('READYAPI03 consumed challenge refuses replay; exact status and same-key cold reopen retain real completion', async () => {
  const f = await setup();
  try {
    const paired = await pair(f), challenge = await begin(f, paired);
    await complete(f, paired, challenge);
    const before = rows(f);
    responseError(await send(f, paired, report(challenge)), 409, 'readiness-unverified');
    assert.deepEqual(rows(f), before);
    await restart(f);
    const observed = await status(f, paired, challenge.binding);
    assert.equal(observed.status, 200); assert.equal(observed.json.verification, 'authenticated-companion-report');
    assert.deepEqual(rows(f), before);
  } finally { await close(f); }
});

test('READYAPI04 genuine control then matching-shape SQL MAC forgery refuses after cold reopen', async () => {
  const f = await setup();
  try {
    const paired = await pair(f), challenge = await begin(f, paired);
    await complete(f, paired, challenge);
    assert.equal((await status(f, paired, challenge.binding)).json.verification, 'authenticated-companion-report');
    const db = new DatabaseSync(path.join(f.home, 'db', 'klebb.db'));
    try { db.prepare('UPDATE health_source_policy_categories SET readiness_mac=? WHERE record_type=?')
      .run('hmac-sha256:' + '0'.repeat(64), 'WeightRecord'); } finally { db.close(); }
    await restart(f);
    const observed = await status(f, paired, challenge.binding);
    assert.equal(observed.status, 200); assert.equal(observed.json.sharing, 'enabled');
    assert.equal(observed.json.verification, 'unverified');
    const before = rows(f);
    responseError(await upload(f, paired, challenge.binding), 409, 'IMPORT_SOURCE_POLICY_VERIFIER_REQUIRED', 1);
    assert.deepEqual(rows(f), before);
  } finally { await close(f); }
});

test('READYAPI05 rotating actual server key invalidates otherwise genuine SQL provenance', async () => {
  const f = await setup();
  try {
    const paired = await pair(f), challenge = await begin(f, paired);
    await complete(f, paired, challenge);
    await restart(f, 'different-invented-server-key-for-isolated-tests');
    const observed = await status(f, paired, challenge.binding);
    assert.equal(observed.status, 200); assert.equal(observed.json.verification, 'unverified');
    const before = rows(f);
    responseError(await upload(f, paired, challenge.binding), 409, 'IMPORT_SOURCE_POLICY_VERIFIER_REQUIRED', 1);
    assert.deepEqual(rows(f), before);
  } finally { await close(f); }
});

test('READYAPI06 superseding begin fences old binding/report without erasing retained history', async () => {
  const f = await setup();
  try {
    const paired = await pair(f), first = await begin(f, paired);
    await complete(f, paired, first);
    assert.equal((await upload(f, paired, first.binding)).status, 200);
    const retained = value => Object.fromEntries(Object.entries(value.native)
      .filter(([table]) => table !== 'health_projection_outbox'));
    const oldRows = retained(rows(f));
    const second = await begin(f, paired, first.binding);
    assert.equal(second.binding.generation, '3');
    assert.deepEqual(retained(rows(f)), oldRows, 'Old stream sequence and immutable saved history remain exact');
    const stopped = await status(f, paired, second.binding);
    assert.equal(stopped.status, 200); assert.equal(stopped.json.sharing, 'stopped');
    assert.equal(stopped.json.verification, 'unverified');
    responseError(await upload(f, paired, second.binding), 409, 'IMPORT_SOURCE_POLICY_UNKNOWN', 1);
    const before = rows(f);
    responseError(await send(f, paired, report(first)), 409, 'readiness-unverified');
    responseError(await status(f, paired, first.binding), 409, 'binding-mismatch');
    assert.deepEqual(rows(f), before);
    await complete(f, paired, second);
  } finally { await close(f); }
});

test('READYAPI07 real credential revocation refuses pending completion without policy activation', async () => {
  const f = await setup();
  try {
    const paired = await pair(f), challenge = await begin(f, paired), before = rows(f);
    const revoked = await browser(f, `${BASE}/${paired.connectorId}`, { method: 'DELETE' });
    assert.equal(revoked.status, 200, revoked.body);
    responseError(await send(f, paired, report(challenge)), 401, 'revoked');
    assert.deepEqual(rows(f), before);
  } finally { await close(f); }
});

test('READYAPI08 supported empty first-page report still needs challenge and leaves Cloud ACK unchanged', async () => {
  const f = await setup();
  try {
    const paired = await pair(f), challenge = await begin(f, paired);
    const empty = report(challenge);
    empty.firstPage.recordCount = '0'; empty.firstPage.terminalPage = true;
    const reply = await send(f, paired, empty);
    assert.equal(reply.status, 200, reply.body);
    assert.equal(reply.json.verification, 'authenticated-companion-report');
    for (const list of Object.values(rows(f).native)) assert.deepEqual(list, []);
  } finally { await close(f); }
});

test('READYAPI09 stale explicit begin cannot rotate a newer generation or policy revision', async () => {
  const f = await setup();
  try {
    const paired = await pair(f), initial = await status(f, paired, binding(paired));
    const old = { version: 2, kind: 'readiness-begin', recordType: 'WeightRecord',
      binding: binding(paired), policyRevision: initial.json.policyRevision,
      queryJson: QUERY, filterDigest: digest(QUERY) };
    const challenge = await begin(f, paired), before = rows(f);
    responseError(await send(f, paired, old), 409, 'binding-mismatch');
    assert.deepEqual(rows(f), before);
    await complete(f, paired, challenge);
  } finally { await close(f); }
});

test('READYAPI10 real DDL failure after state recreation rolls back schema rows and private projection', async () => {
  const preload = path.resolve(__dirname, '../helpers/health-connect-readiness-migration-fault.cjs');
  const f = await setup();
  try {
    const paired = await pair(f), observed = await status(f, paired, binding(paired));
    const before = rows(f);
    const catalogue = path.join(f.home, 'credentials', 'health-connect-policy.json');
    const beforePrivate = fs.readFileSync(catalogue);
    const marker = path.join(f.home, 'invented-post-ddl-observation.json');
    await f.server.kill(); f.server = null;
    f.server = await spawnServer(f.home, { ...ENV,
      NODE_OPTIONS: `--require=${JSON.stringify(preload)}`,
      INDEPENDENT_READINESS_POST_STATE_DDL_FAILURE: '1',
      INDEPENDENT_READINESS_FAULT_OBSERVATION: marker });
    const refused = await send(f, paired, { version: 2, kind: 'readiness-begin', recordType: 'WeightRecord',
      binding: binding(paired), policyRevision: observed.json.policyRevision,
      queryJson: QUERY, filterDigest: digest(QUERY) });
    responseError(refused, 503, 'storage-unavailable');
    assert.deepEqual(JSON.parse(fs.readFileSync(marker, 'utf8')),
      { afterActualStateCreate: true, categoriesStillAbsent: true });
    assert.deepEqual(rows(f), before);
    assert.ok(fs.readFileSync(catalogue).equals(beforePrivate));
    const db = new DatabaseSync(path.join(f.home, 'db', 'klebb.db'), { readOnly: true });
    try {
      const sql = db.prepare("SELECT sql FROM sqlite_schema WHERE name='health_source_policy_state'").get().sql;
      assert.ok(sql.includes('CHECK (version=1)'));
      assert.equal(db.prepare("SELECT count(*) AS n FROM pragma_table_info('health_source_policy_categories')").get().n, 5);
    } finally { db.close(); }
    const recovered = await status(f, paired, binding(paired));
    assert.equal(recovered.status, 200); assert.equal(recovered.json.verification, 'unverified');
  } finally { await close(f); }
});

test('READYAPI11 installation rebind cannot reuse the genuine prior installation proof', async () => {
  const f = await setup();
  try {
    const paired = await pair(f), challenge = await begin(f, paired);
    await complete(f, paired, challenge);
    const healthy = await status(f, paired, challenge.binding);
    assert.equal(healthy.status, 200); assert.equal(healthy.json.verification, 'authenticated-companion-report');
    const file = path.join(f.home, 'credentials', 'health-connect-policy.json');
    const privateState = JSON.parse(fs.readFileSync(file, 'utf8'));
    const namespace = privateState.namespaces.find(n => n.state.tenantId === paired.tenantId);
    const connector = namespace.state.connectors.find(c => c.id === paired.connectorId);
    connector.installationId = 'invented-replacement-installation';
    fs.writeFileSync(file, JSON.stringify(privateState));
    responseError(await status(f, paired, challenge.binding), 409, 'binding-mismatch');
    const replaced = { ...challenge.binding, installationId: 'invented-replacement-installation' };
    const current = await status(f, paired, replaced);
    assert.equal(current.status, 200); assert.equal(current.json.verification, 'unverified');
    const before = rows(f);
    responseError(await upload(f, paired, replaced), 409, 'IMPORT_SOURCE_POLICY_VERIFIER_REQUIRED', 1);
    assert.deepEqual(rows(f), before);
  } finally { await close(f); }
});

const stopRequest = (current, policyRevision) => ({ version: 2, kind: 'readiness-stop',
  recordType: 'WeightRecord', binding: current, policyRevision });
const retainedNative = value => Object.fromEntries(Object.entries(value.native)
  .filter(([table]) => table !== 'health_projection_outbox'));

test('READYAPI12 typed STOP clears selected proof and preserves enabled sibling and committed history', async () => {
  const f = await setup();
  try {
    const paired = await pair(f), first = await begin(f, paired);
    await complete(f, paired, first);
    const saved = await upload(f, paired, first.binding);
    assert.equal(saved.status, 200, saved.body); assert.equal(saved.json.sequence, '1');
    const sendSteps = body => req(f.server.baseUrl, `${BASE}/v2/streams/StepsRecord/readiness`, {
      method: 'POST', body, headers: { Authorization: `Bearer ${paired.credential}`,
        'Klebb-Health-Protocol': '2' } });
    const stepsQuery = QUERY.replace('WeightRecord', 'StepsRecord');
    const stepsBegin = await sendSteps({ version: 2, kind: 'readiness-begin', recordType: 'StepsRecord',
      binding: binding(paired), policyRevision: '3', queryJson: stepsQuery, filterDigest: digest(stepsQuery) });
    assert.equal(stepsBegin.status, 200, stepsBegin.body);
    assert.equal(stepsBegin.json.binding.generation, '2'); assert.equal(stepsBegin.json.policyRevision, '4');
    const stepsComplete = await sendSteps({ ...report(stepsBegin.json), recordType: 'StepsRecord' });
    assert.equal(stepsComplete.status, 200, stepsComplete.body);
    assert.deepEqual(stepsComplete.json, { version: 2, kind: 'readiness-result', recordType: 'StepsRecord',
      binding: binding(paired, '2'), policyRevision: '5', sharing: 'enabled',
      verification: 'authenticated-companion-report' });
    const before = rows(f);
    assert.equal(before.categories.find(c => c.record_type === 'StepsRecord').sharing, 'enabled');
    const stopped = await send(f, paired, stopRequest(first.binding, '5'));
    // A missing typed action returns 400 on the old source; success must be an actual bound result.
    assert.equal(stopped.status, 200, stopped.body);
    assert.deepEqual(stopped.json, { version: 2, kind: 'readiness-result', recordType: 'WeightRecord',
      binding: binding(paired, '3'), policyRevision: '6', sharing: 'stopped', verification: 'unverified' });
    const after = rows(f);
    assert.deepEqual(after.categories.find(c => c.record_type === 'WeightRecord'), {
      ...before.categories.find(c => c.record_type === 'WeightRecord'), sharing: 'stopped', generation: '3',
      readiness_epoch: null, readiness_installation_id: null, readiness_generation: null,
      readiness_query_digest: null, readiness_report_digest: null, readiness_mac: null });
    assert.deepEqual(after.categories.find(c => c.record_type === 'StepsRecord'),
      before.categories.find(c => c.record_type === 'StepsRecord'));
    assert.deepEqual(after.sources, before.sources);
    assert.deepEqual(after.state, before.state.map(row => ({ ...row, revision: '6' })));
    assert.deepEqual(retainedNative(after), retainedNative(before),
      'STOP preserves committed records, tombstones, stream frontiers and durable receipts');
    const sibling = await sendSteps({ version: 2, kind: 'readiness-status', recordType: 'StepsRecord',
      binding: binding(paired, '2') });
    assert.equal(sibling.status, 200, sibling.body);
    assert.deepEqual(sibling.json, { version: 2, kind: 'readiness-result', recordType: 'StepsRecord',
      binding: binding(paired, '2'), policyRevision: '6', sharing: 'enabled',
      verification: 'authenticated-companion-report' });
    const observed = await status(f, paired, stopped.json.binding);
    assert.equal(observed.status, 200, observed.body); assert.deepEqual(observed.json, stopped.json);
    responseError(await status(f, paired, first.binding), 409, 'binding-mismatch');
    responseError(await upload(f, paired, stopped.json.binding), 409, 'IMPORT_SOURCE_POLICY_UNKNOWN', 1);
    const fresh = await begin(f, paired, stopped.json.binding);
    assert.equal(fresh.binding.generation, '4'); assert.equal(fresh.policyRevision, '7');
    assert.equal(fresh.acknowledgedSequence, '0'); assert.notEqual(fresh.readinessId, first.readinessId);
    const enabled = await complete(f, paired, fresh);
    assert.equal(enabled.policyRevision, '8');
    assert.deepEqual(retainedNative(rows(f)), retainedNative(before),
      'Fresh BEGIN/COMPLETE does not rewrite the earlier generation history or ACK');
  } finally { await close(f); }
});

test('READYAPI13 initially stopped scope and pending BEGIN both rotate on STOP; old COMPLETE cannot enable', async () => {
  const f = await setup();
  try {
    const paired = await pair(f), initial = rows(f);
    const initialStop = await send(f, paired, stopRequest(binding(paired), '1'));
    assert.equal(initialStop.status, 200, initialStop.body);
    assert.deepEqual(initialStop.json, { version: 2, kind: 'readiness-result', recordType: 'WeightRecord',
      binding: binding(paired, '2'), policyRevision: '2', sharing: 'stopped', verification: 'unverified' });
    assert.deepEqual(rows(f).categories.find(c => c.record_type === 'StepsRecord'), {
      ...initial.categories.find(c => c.record_type === 'StepsRecord'), readiness_epoch: null,
      readiness_installation_id: null, readiness_generation: null, readiness_query_digest: null,
      readiness_report_digest: null, readiness_mac: null });
    const pending = await begin(f, paired, initialStop.json.binding);
    assert.equal(pending.binding.generation, '3'); assert.equal(pending.policyRevision, '3');
    const before = rows(f), capturedComplete = report(pending);
    assert.equal(before.categories.find(c => c.record_type === 'WeightRecord').sharing, 'stopped');
    const request = stopRequest(pending.binding, '3');
    const stopped = await send(f, paired, request);
    assert.equal(stopped.status, 200, stopped.body);
    assert.deepEqual(stopped.json, { version: 2, kind: 'readiness-result', recordType: 'WeightRecord',
      binding: binding(paired, '4'), policyRevision: '4', sharing: 'stopped', verification: 'unverified' });
    const after = rows(f);
    assert.deepEqual(after.categories.find(c => c.record_type === 'WeightRecord'), {
      ...before.categories.find(c => c.record_type === 'WeightRecord'), generation: '4' });
    assert.deepEqual(after.categories.find(c => c.record_type === 'StepsRecord'),
      before.categories.find(c => c.record_type === 'StepsRecord'));
    assert.deepEqual(after.sources, before.sources);
    assert.deepEqual(after.state, before.state.map(row => ({ ...row, revision: '4' })));
    assert.deepEqual(after.native, initial.native);
    responseError(await send(f, paired, capturedComplete), 409, 'readiness-unverified');
    assert.deepEqual(rows(f), after, 'Captured pre-stop COMPLETE cannot restore sharing or proof');
    responseError(await send(f, paired, request), 409, 'binding-mismatch');
    assert.deepEqual(rows(f), after, 'Stale STOP cannot rotate a later generation a second time');
    const fresh = await begin(f, paired, stopped.json.binding);
    assert.equal(fresh.binding.generation, '5'); assert.equal(fresh.policyRevision, '5');
    assert.notEqual(fresh.readinessId, pending.readinessId);
    assert.equal(fresh.acknowledgedSequence, '0');
    const enabled = await complete(f, paired, fresh);
    assert.equal(enabled.policyRevision, '6'); assert.deepEqual(rows(f).native, initial.native);
  } finally { await close(f); }
});

test('READYAPI14 closed malformed or stale STOP refuses without retiring a valid pending challenge', async () => {
  const f = await setup();
  try {
    const paired = await pair(f), pending = await begin(f, paired), before = rows(f);
    const current = stopRequest(pending.binding, '2');
    for (const malformed of [
      { ...current, queryJson: QUERY },
      { ...current, policyRevision: '02' },
      { ...current, binding: { ...current.binding, readinessId: pending.readinessId } },
      { ...current, recordType: 'StepsRecord' },
      { ...current, version: 1 },
    ]) {
      responseError(await send(f, paired, malformed), 400, 'invalid-message');
      assert.deepEqual(rows(f), before, 'Malformed STOP leaves actual SQL and history unchanged');
    }
    responseError(await send(f, paired, { ...current, policyRevision: '1' }), 409, 'binding-mismatch');
    responseError(await send(f, paired, stopRequest(binding(paired), '2')), 409, 'binding-mismatch');
    assert.deepEqual(rows(f), before, 'Stale revision or binding cannot stop the current challenge');
    await complete(f, paired, pending);
    assert.deepEqual(rows(f).native, before.native,
      'Refused STOP does not retire the valid pending challenge or manufacture history');
  } finally { await close(f); }
});
