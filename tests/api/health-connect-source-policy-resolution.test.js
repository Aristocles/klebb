// SPDX-License-Identifier: AGPL-3.0-only
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createSandbox, cleanupSandbox, spawnServer, req, fakeAuthState } =
  require('../helpers/sandbox');
const { nativeTables, sourcePolicyTables } = require('../../lib/health-connect/schema');
const vectors = require('../fixtures/health-connect/durable-history-independent-vectors.json');

const ORIGIN = 'https://policy-resolution.example.test';
const BASE = '/api/connectors/health-connect';
const TYPE = 'BodyWaterMassRecord';
const ENV = {
  HEALTH_ORIGIN: ORIGIN, HEALTH_RP_ID: 'policy-resolution.example.test',
  AGENT_API_TOKEN: '', KLEBB_ADMIN_TOKEN: '', KLEBB_CLOUD: '', KLEBB_DEMO: '',
  HEALTH_DATA_DIR: '', HEALTH_REPORTS_DIR: '', HEALTH_AUTO_EXPORT_DIR: '',
  HEALTH_SESSIONS_DIR: '', HEALTH_CREDENTIALS_DIR: '', HEALTH_ARCHIVE_DIR: '',
  HEALTH_CONFIG_PATH: '', HEALTH_DB_DIR: '', HEALTH_DB_FILE: '', HEALTH_CHAT_DIR: '',
  HEALTH_USER_FILE: '', HEALTH_NOTIFICATIONS_STATE_FILE: '', HEALTH_INBOX_DIR: '',
  HEALTH_KEYS_DIR: '', HEALTH_VAPID_FILE: '', HEALTH_PUSH_SUBSCRIPTIONS_FILE: '',
  HEALTH_AUTO_EXPORT_TOKEN: '', NODE_OPTIONS: '',
};
const legacyFile = home => path.join(home, 'credentials', 'health-connect.json');
const policyFile = home => path.join(home, 'credentials', 'health-connect-policy.json');
const dbFile = home => path.join(home, 'db', 'klebb.db');
const hash = text => 'sha256:' + crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const nativeHeaders = paired => ({
  Authorization: `Bearer ${paired.credential}`, 'Klebb-Health-Protocol': '1',
  'Klebb-Health-Generation': '1', 'Klebb-Health-Restore-Epoch': paired.restoreEpoch,
});

function snapshot(home, names) {
  const db = new DatabaseSync(dbFile(home), { readOnly: true });
  try {
    db.exec('BEGIN');
    const result = Object.fromEntries(names.map(name => [name, db.prepare(
      `SELECT * FROM "${name}" ORDER BY rowid`).all().map(row => ({ ...row }))]));
    db.exec('COMMIT');
    return result;
  } finally { db.close(); }
}
const policySnapshot = home => snapshot(home, Object.keys(sourcePolicyTables));
const historySnapshot = home => snapshot(home, [
  'health_records', 'health_tombstones', 'health_streams',
  'health_batch_receipts', 'health_projection_outbox',
]);

function registerExactPolicyFamily(home) {
  const db = new DatabaseSync(dbFile(home));
  try {
    db.exec('BEGIN IMMEDIATE');
    if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='health_schema_version'").get()) {
      for (const sql of Object.values(nativeTables)) db.exec(sql);
      db.exec('CREATE INDEX health_receipt_sequence_order ON health_batch_receipts '
        + '(stream_key, length(sequence), sequence)');
      db.exec('INSERT INTO health_schema_version (version) VALUES (1)');
    }
    for (const sql of Object.values(sourcePolicyTables)) db.exec(sql);
    db.exec('COMMIT');
  } finally { db.close(); }
}
async function grant(data, actor = data.owner) {
  const result = await req(data.server.baseUrl, `${BASE}/pairing-grants`, {
    method: 'POST', cookie: actor.cookie, headers: { Origin: ORIGIN },
    body: { categories: [TYPE], name: 'Synthetic policy resolver' },
  });
  assert.equal(result.status, 201, result.body);
  assert.equal(result.json.version, 1);
  assert.equal(result.json.kind, 'pairing-grant');
  return result.json;
}
async function exchange(data, approved, installationId) {
  const result = await req(data.server.baseUrl, `${BASE}/v1/pairing/exchange`, {
    method: 'POST', body: { version: 1, kind: 'pairing-exchange',
      tenantId: approved.tenantId, instanceId: approved.instanceId,
      sourceStoreId: approved.sourceStoreId, installationId, categories: [TYPE],
      grant: approved.grant },
  });
  assert.equal(result.status, 200, result.body);
  assert.equal(result.json.kind, 'paired');
  assert.equal(result.json.tenantId, approved.tenantId);
  assert.equal(result.json.instanceId, approved.instanceId);
  assert.equal(result.json.sourceStoreId, approved.sourceStoreId);
  assert.equal(result.json.restoreEpoch, approved.restoreEpoch);
  assert.deepEqual(result.json.streams, {
    [TYPE]: { generation: '1', acknowledgedSequence: '0' },
  });
  return result.json;
}
async function fixture() {
  // Keep the ordinary factory for the unrelated managed fixtures.
  const sandboxModule = require.resolve('../helpers/sandbox');
  const ordinarySandbox = require.cache[sandboxModule];
  assert.ok(ordinarySandbox, 'Ordinary sandbox must already be loaded');
  let producer;
  delete require.cache[sandboxModule];
  try { producer = require('../helpers/legacy-health-producer'); }
  finally { require.cache[sandboxModule] = ordinarySandbox; }
  const owner = fakeAuthState('synthetic-policy-owner');
  const home = producer.createSandbox({ credentials: owner.credentials, sessions: owner.sessions });
  const data = { owner, home, server: null, producer };
  try {
    data.server = await producer.spawnProducerServer(home, ENV);
    const approved = await grant(data);
    data.legacy = await exchange(data, approved, 'synthetic-legacy-installation');
    data.legacyBytes = fs.readFileSync(legacyFile(home));
    await data.server.kill(); data.server = null;
    assert.equal(JSON.parse(data.legacyBytes).version, 1);
    assert.equal(fs.existsSync(policyFile(home)), false);
    registerExactPolicyFamily(home);
    assert.deepEqual(policySnapshot(home), Object.fromEntries(
      Object.keys(sourcePolicyTables).map(name => [name, []])));
    data.server = await producer.spawnCandidateServer(home, ENV);
    return data;
  } catch (error) {
    if (data.server) await data.server.kill();
    producer.cleanupSandbox(home);
    throw error;
  }
}
async function close(data) {
  if (data.server) await data.server.kill();
  cleanupSandbox(data.home);
}
async function forward(data, actor = data.owner) {
  const approved = await grant(data, actor);
  assert.notEqual(approved.tenantId, data.legacy.tenantId);
  assert.notEqual(approved.instanceId, data.legacy.instanceId);
  assert.notEqual(approved.sourceStoreId, data.legacy.sourceStoreId);
  assert.deepEqual(fs.readFileSync(legacyFile(data.home)), data.legacyBytes);
  assert.equal(JSON.parse(fs.readFileSync(policyFile(data.home))).version, 2);
  return exchange(data, approved, 'synthetic-forward-installation');
}
async function capabilities(data, paired, status = 200) {
  const result = await req(data.server.baseUrl, `${BASE}/v1/capabilities`, {
    headers: nativeHeaders(paired),
  });
  assert.equal(result.status, status, result.body);
  if (status === 200) {
    assert.equal(result.json.version, 1);
    assert.equal(result.json.tenantId, paired.tenantId);
    assert.equal(result.json.instanceId, paired.instanceId);
    assert.equal(result.json.restoreEpoch, paired.restoreEpoch);
    assert.equal(result.json.sourceStoreId, paired.sourceStoreId);
  }
  return result;
}


// Fresh managed fixtures are separate from the retained V1 compatibility case.
function readCatalogue(home) {
  const value = JSON.parse(fs.readFileSync(policyFile(home), 'utf8'));
  assert.equal(value.version, 2);
  assert.equal(value.recoveryRequired, false);
  assert.ok(Array.isArray(value.principals));
  assert.ok(Array.isArray(value.namespaces));
  return value;
}
function retainedBefore(data) {
  return { policy: policySnapshot(data.home), history: historySnapshot(data.home),
    catalogue: readCatalogue(data.home),
    credentials: fs.readFileSync(path.join(data.home, 'credentials', 'webauthn.json')),
    legacy: fs.readFileSync(legacyFile(data.home)) };
}
function assertRetained(data, before) {
  const afterPolicy = policySnapshot(data.home), afterCatalogue = readCatalogue(data.home);
  for (const principal of before.catalogue.principals) {
    assert.deepEqual(afterCatalogue.principals.find(item => item.ownerId === principal.ownerId),
      principal);
  }
  for (const namespace of before.catalogue.namespaces) {
    const tenantId = namespace.state.tenantId;
    const after = afterCatalogue.namespaces.find(item => item.state.tenantId === tenantId);
    assert.deepEqual(after, namespace);
    assert.deepEqual(after.state.connectors, namespace.state.connectors);
    for (const [table, rows] of Object.entries(before.policy)) {
      assert.deepEqual(afterPolicy[table].filter(row => row.tenant_id === tenantId),
        rows.filter(row => row.tenant_id === tenantId));
    }
  }
  assert.deepEqual(historySnapshot(data.home), before.history);
  assert.deepEqual(fs.readFileSync(path.join(data.home, 'credentials', 'webauthn.json')),
    before.credentials);
  assert.deepEqual(fs.readFileSync(legacyFile(data.home)), before.legacy);
  assert.deepEqual(before.legacy, data.legacyBytes);
}
function assertFreshStopped(data, paired, actor) {
  const catalogue = readCatalogue(data.home), policy = policySnapshot(data.home);
  const selected = catalogue.namespaces.filter(item => item.state.tenantId === paired.tenantId);
  assert.equal(selected.length, 1);
  const namespace = selected[0];
  assert.equal(namespace.state.version, 1);
  assert.equal(namespace.state.instanceId, paired.instanceId);
  assert.equal(namespace.state.restoreEpoch, paired.restoreEpoch);
  const members = Object.entries(actor.credentials.users).flatMap(([userId, user]) =>
    user.credentials.map(credential => ({ userId, credentialId: credential.id,
      publicKeySha256: 'sha256:' + crypto.createHash('sha256').update(
        Buffer.from(credential.publicKey, 'base64')).digest('hex') })));
  assert.deepEqual(catalogue.principals.find(item => item.ownerId === namespace.ownerId).members,
    members);
  assert.deepEqual(policy.health_source_policy_state.filter(row => row.tenant_id === paired.tenantId),
    [{ version: 1, tenant_id: paired.tenantId, owner_id: namespace.ownerId,
      epoch: paired.restoreEpoch, revision: '1', knowledge: 'COMPLETE', source_count: 1 }]);
  const sources = policy.health_source_policy_sources.filter(row => row.tenant_id === paired.tenantId);
  assert.equal(sources.length, 1);
  assert.match(sources[0].policy_id, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
  assert.deepEqual(sources[0], { tenant_id: paired.tenantId, source_store_id: paired.sourceStoreId,
    owner_id: namespace.ownerId, policy_id: sources[0].policy_id, lifecycle: 'active',
    knowledge: 'COMPLETE', retain_committed_history: 1, category_count: 1, reconciled_epoch: null });
  assert.deepEqual(policy.health_source_policy_categories.filter(row => row.tenant_id === paired.tenantId),
    [{ tenant_id: paired.tenantId, source_store_id: paired.sourceStoreId,
      record_type: TYPE, sharing: 'stopped', generation: '1' }]);
  const connectors = namespace.state.connectors.filter(item => item.id === paired.connectorId);
  assert.equal(connectors.length, 1);
  assert.equal(connectors[0].credentialVerifier, hash(paired.credential));
  assert.equal(connectors[0].ownerId, namespace.ownerId);
  assert.equal(connectors[0].sourceStoreId, paired.sourceStoreId);
  assert.equal(connectors[0].installationId, paired.installationId);
  assert.equal(connectors[0].restoreEpoch, paired.restoreEpoch);
  assert.deepEqual(connectors[0].categories, [TYPE]);
  assert.deepEqual(connectors[0].generations, { [TYPE]: '1' });
  assert.equal(connectors[0].revokedAt, null);
  assert.equal(namespace.state.connectors.length, 1);
  assert.equal(namespace.state.grants.length, 1);
  assert.notEqual(namespace.state.grants[0].consumedAt, null);
}
async function managedFixture() {
  const owner = fakeAuthState('synthetic-policy-owner');
  const home = createSandbox({ credentials: owner.credentials, sessions: owner.sessions });
  const data = { owner, home, server: null };
  try {
    data.server = await spawnServer(home, ENV);
    const initial = await req(data.server.baseUrl, BASE, {
      cookie: owner.cookie, headers: { Origin: ORIGIN },
    });
    assert.equal(initial.status, 200, initial.body);
    assert.equal(initial.json.version, 1);
    assert.equal(initial.json.kind, 'connector-list');
    assert.deepEqual(initial.json.connectors, []);
    data.legacyBytes = fs.readFileSync(legacyFile(home));
    const defaults = JSON.parse(data.legacyBytes);
    assert.deepEqual(Object.keys(defaults).sort(),
      ['version', 'tenantId', 'instanceId', 'restoreEpoch', 'grants', 'connectors'].sort());
    assert.equal(defaults.version, 1);
    for (const field of ['tenantId', 'instanceId', 'restoreEpoch']) {
      assert.match(defaults[field], /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
    }
    assert.deepEqual(defaults.grants, []);
    assert.deepEqual(defaults.connectors, []);
    const approved = await grant(data);
    data.first = await exchange(data, approved, 'synthetic-first-managed-installation');
    assertFreshStopped(data, data.first, owner);
    assert.equal(readCatalogue(home).namespaces.length, 1);
    assert.equal(readCatalogue(home).principals.length, 1);
    for (const rows of Object.values(policySnapshot(home))) assert.equal(rows.length, 1);
    assert.deepEqual(fs.readFileSync(legacyFile(home)), data.legacyBytes);
    const first = retainedBefore(data);
    await capabilities(data, data.first);
    await data.server.kill(); data.server = null;
    data.server = await spawnServer(home, ENV);
    await capabilities(data, data.first);
    assertRetained(data, first);
    return data;
  } catch (error) {
    if (data.server) await data.server.kill();
    cleanupSandbox(home);
    throw error;
  }
}
async function managedForward(data, actor = data.owner) {
  const before = retainedBefore(data);
  const approved = await grant(data, actor);
  assert.notEqual(approved.tenantId, data.first.tenantId);
  assert.notEqual(approved.instanceId, data.first.instanceId);
  assert.notEqual(approved.sourceStoreId, data.first.sourceStoreId);
  const paired = await exchange(data, approved, 'synthetic-forward-installation');
  assertFreshStopped(data, paired, actor);
  assertRetained(data, before);
  assert.equal(readCatalogue(data.home).namespaces.length, before.catalogue.namespaces.length + 1);
  for (const [table, rows] of Object.entries(before.policy)) {
    assert.equal(policySnapshot(data.home)[table].length, rows.length + 1);
  }
  return paired;
}

test('managed forward credentials resolve their own namespace across cold reads without changing v1 defaults', async () => {
  const data = await fixture();
  try {
    const paired = await forward(data);
    const beforePolicy = policySnapshot(data.home);
    assert.equal(beforePolicy.health_source_policy_state.length, 1);
    assert.equal(beforePolicy.health_source_policy_state[0].knowledge, 'COMPLETE');
    assert.equal(beforePolicy.health_source_policy_sources.length, 1);
    assert.equal(beforePolicy.health_source_policy_sources[0].tenant_id, paired.tenantId);
    assert.equal(beforePolicy.health_source_policy_sources[0].source_store_id, paired.sourceStoreId);
    assert.equal(beforePolicy.health_source_policy_categories.length, 1);
    assert.equal(beforePolicy.health_source_policy_categories[0].sharing, 'stopped');
    assert.equal(beforePolicy.health_source_policy_categories[0].generation, '1');
    const sidecarBytes = fs.readFileSync(policyFile(data.home));
    await capabilities(data, data.legacy);
    await capabilities(data, paired);
    await data.server.kill(); data.server = null;
    data.server = await data.producer.spawnCandidateServer(data.home, ENV);
    await capabilities(data, paired);
    const status = await req(data.server.baseUrl, `${BASE}/v1/streams/${TYPE}/status`, {
      headers: nativeHeaders(paired),
    });
    assert.equal(status.status, 200, status.body);
    assert.deepEqual(status.json.binding, {
      tenantId: paired.tenantId, instanceId: paired.instanceId,
      sourceStoreId: paired.sourceStoreId, installationId: paired.installationId,
      generation: '1', restoreEpoch: paired.restoreEpoch,
    });
    assert.equal(status.json.acknowledgedSequence, '0');
    assert.deepEqual(fs.readFileSync(legacyFile(data.home)), data.legacyBytes);
    assert.deepEqual(fs.readFileSync(policyFile(data.home)), sidecarBytes);
    assert.deepEqual(policySnapshot(data.home), beforePolicy);
  } finally {
    if (data.server) await data.server.kill();
    data.producer.cleanupSandbox(data.home);
  }
});

test('a genuinely enrolled stopped scope refuses a valid ordinary batch before any native history change', async () => {
  const data = await managedFixture();
  try {
    const paired = await managedForward(data);
    const binding = { tenantId: paired.tenantId, instanceId: paired.instanceId,
      sourceStoreId: paired.sourceStoreId, installationId: paired.installationId,
      generation: '1', restoreEpoch: paired.restoreEpoch };
    const payload = JSON.parse(vectors.vectors.find(item => item.id === 'initial-raw-only').payloadJson);
    payload.binding = binding;
    for (const change of payload.changes) {
      change.identity.tenantId = binding.tenantId;
      change.identity.sourceStoreId = binding.sourceStoreId;
    }
    const payloadJson = JSON.stringify(payload);
    const beforeHistory = historySnapshot(data.home), beforePolicy = policySnapshot(data.home);
    const result = await req(data.server.baseUrl, `${BASE}/v1/batches`, {
      method: 'POST', headers: nativeHeaders(paired),
      body: { version: 1, kind: 'batch', payloadJson, payloadDigest: hash(payloadJson) },
    });
    assert.equal(result.status, 409, result.body);
    assert.equal(result.json.kind, 'error');
    assert.equal(result.json.receipt, undefined);
    assert.deepEqual(historySnapshot(data.home), beforeHistory);
    assert.deepEqual(policySnapshot(data.home), beforePolicy);
    assert.deepEqual(fs.readFileSync(legacyFile(data.home)), data.legacyBytes);
  } finally { await close(data); }
});

test('a reused account label cannot adopt a removed credential principal or its retained namespace', async () => {
  const data = await managedFixture();
  try {
    const old = await managedForward(data);
    const retained = policySnapshot(data.home);
    const retainedAuthority = retainedBefore(data);
    await data.server.kill(); data.server = null;
    const replacement = fakeAuthState('synthetic-policy-owner');
    fs.writeFileSync(path.join(data.home, 'credentials', 'webauthn.json'),
      JSON.stringify(replacement.credentials), { mode: 0o600 });
    fs.writeFileSync(path.join(data.home, 'sessions', 'webauthn.json'),
      JSON.stringify({ ...data.owner.sessions, ...replacement.sessions }), { mode: 0o600 });
    const afterReplacement = { ...retainedAuthority,
      credentials: fs.readFileSync(path.join(data.home, 'credentials', 'webauthn.json')) };
    data.server = await spawnServer(data.home, ENV);
    const removed = await req(data.server.baseUrl, `${BASE}/pairing-grants`, {
      method: 'POST', cookie: data.owner.cookie, headers: { Origin: ORIGIN },
      body: { categories: [TYPE], name: 'Synthetic removed credential' },
    });
    assert.equal(removed.status, 401, removed.body);
    await capabilities(data, old, 401);
    assertRetained(data, afterReplacement);
    const current = await managedForward(data, replacement);
    assertRetained(data, afterReplacement);
    assert.notEqual(current.tenantId, old.tenantId);
    assert.notEqual(current.sourceStoreId, old.sourceStoreId);
    const after = policySnapshot(data.home);
    for (const [table, rows] of Object.entries(retained)) {
      for (const tenantId of new Set(rows.map(row => row.tenant_id))) {
        assert.deepEqual(after[table].filter(row => row.tenant_id === tenantId),
          rows.filter(row => row.tenant_id === tenantId));
      }
    }
    assert.deepEqual(fs.readFileSync(legacyFile(data.home)), data.legacyBytes);
  } finally { await close(data); }
});

test('connector credential DELETE does not stop, retire, remove or rewrite committed policy', async () => {
  const data = await managedFixture();
  try {
    const paired = await managedForward(data);
    const beforePolicy = policySnapshot(data.home), beforeHistory = historySnapshot(data.home);
    const result = await req(data.server.baseUrl, `${BASE}/${paired.connectorId}`, {
      method: 'DELETE', cookie: data.owner.cookie, headers: { Origin: ORIGIN },
    });
    assert.equal(result.status, 200, result.body);
    assert.deepEqual(result.json, { revoked: true });
    await capabilities(data, paired, 401);
    assert.deepEqual(policySnapshot(data.home), beforePolicy);
    assert.deepEqual(historySnapshot(data.home), beforeHistory);
    assert.deepEqual(fs.readFileSync(legacyFile(data.home)), data.legacyBytes);
  } finally { await close(data); }
});

test('cold malformed v2 catalogue denies resolution without replacing legacy or SQL evidence', async () => {
  const data = await managedFixture();
  try {
    const paired = await managedForward(data);
    await data.server.kill(); data.server = null;
    const broken = Buffer.from('{"version":2,"recoveryRequired":false,"principals":');
    fs.writeFileSync(policyFile(data.home), broken, { mode: 0o600 });
    const beforePolicy = policySnapshot(data.home), beforeHistory = historySnapshot(data.home);
    data.server = await spawnServer(data.home, ENV);
    await capabilities(data, paired, 503);
    assert.deepEqual(fs.readFileSync(policyFile(data.home)), broken);
    assert.deepEqual(fs.readFileSync(legacyFile(data.home)), data.legacyBytes);
    assert.deepEqual(policySnapshot(data.home), beforePolicy);
    assert.deepEqual(historySnapshot(data.home), beforeHistory);
  } finally { await close(data); }
});


for (const [caseName, field, retainedName] of [
  ['retained V1 grant whitespace preserves cold resolution and distinct-member enrolment',
    'grants', ' Retained V1 grant '],
  ['retained V1 connector whitespace preserves cold resolution and distinct-member enrolment',
    'connectors', ' Retained V1 connector '],
]) {
  test(caseName, async () => {
    const data = await fixture();
    try {
      await data.server.kill(); data.server = null;
      const distinct = fakeAuthState('synthetic-forward-member');
      const credentials = JSON.parse(fs.readFileSync(
        path.join(data.home, 'credentials', 'webauthn.json')));
      credentials.users = { ...credentials.users, ...distinct.credentials.users };
      const savedSessions = JSON.parse(fs.readFileSync(
        path.join(data.home, 'sessions', 'webauthn.json')));
      fs.writeFileSync(path.join(data.home, 'credentials', 'webauthn.json'),
        JSON.stringify(credentials), { mode: 0o600 });
      fs.writeFileSync(path.join(data.home, 'sessions', 'webauthn.json'),
        JSON.stringify({ ...savedSessions, ...distinct.sessions }), { mode: 0o600 });
      data.owner = distinct;
      data.server = await data.producer.spawnCandidateServer(data.home, ENV);
      const sibling = await exchange(data, await grant(data), 'synthetic-preserved-sibling');
      assertFreshStopped(data, sibling, distinct);
      const before = retainedBefore(data);
      await data.server.kill(); data.server = null;

      // Change one descriptive field in original-produced, stopped V1 data.
      const state = JSON.parse(data.legacyBytes);
      assert.equal(state.grants.length, 1);
      assert.equal(state.connectors.length, 1);
      const originalName = state[field][0].name;
      state[field][0].name = retainedName;
      const controlled = Buffer.from(JSON.stringify(state));
      const restored = JSON.parse(controlled);
      restored[field][0].name = originalName;
      assert.deepEqual(Buffer.from(JSON.stringify(restored)), data.legacyBytes);
      fs.writeFileSync(legacyFile(data.home), controlled, { mode: 0o600 });
      data.legacyBytes = controlled;
      const expectedRetained = { ...before, legacy: controlled };

      // The pinned original cold reader must accept the exact controlled bytes.
      data.server = await data.producer.spawnProducerServer(data.home, ENV);
      const originalCaps = await capabilities(data, data.legacy);
      assert.deepEqual(originalCaps.json.supportedVersions, [1]);
      assert.deepEqual(originalCaps.json.streams, data.legacy.streams);
      assertRetained(data, expectedRetained);
      await data.server.kill(); data.server = null;
      data.server = await data.producer.spawnCandidateServer(data.home, ENV);
      await capabilities(data, data.legacy);
      await capabilities(data, sibling);
      assertRetained(data, expectedRetained);

      // Before the legacy-only fix this ordinary 201 assertion receives 503.
      const paired = await forward(data);
      assertFreshStopped(data, paired, distinct);
      assertRetained(data, expectedRetained);
      const after = retainedBefore(data);
      await data.server.kill(); data.server = null;
      data.server = await data.producer.spawnCandidateServer(data.home, ENV);
      for (const current of [data.legacy, sibling, paired]) {
        const caps = await capabilities(data, current);
        assert.deepEqual(caps.json.supportedVersions, [1]);
        assert.deepEqual(caps.json.streams, current.streams);
      }
      assertRetained(data, after);
    } finally {
      if (data.server) await data.server.kill();
      data.producer.cleanupSandbox(data.home);
    }
  });
}

for (const [caseName, field, invalidName] of [
  ['managed VERSION2 grant whitespace remains invalid across cold resolution',
    'grants', ' Managed grant '],
  ['managed VERSION2 connector whitespace remains invalid across cold resolution',
    'connectors', ' Managed connector '],
]) {
  test(caseName, async () => {
    const data = await managedFixture();
    try {
      const paired = await managedForward(data);
      await data.server.kill(); data.server = null;
      const catalogue = readCatalogue(data.home);
      const namespace = catalogue.namespaces.find(item => item.state.tenantId === paired.tenantId);
      assert.ok(namespace);
      assert.equal(namespace.state.grants.length, 1);
      assert.equal(namespace.state.connectors.length, 1);
      namespace.state[field][0].name = invalidName;
      const broken = Buffer.from(JSON.stringify(catalogue));
      fs.writeFileSync(policyFile(data.home), broken, { mode: 0o600 });
      const beforePolicy = policySnapshot(data.home), beforeHistory = historySnapshot(data.home);
      const credentials = fs.readFileSync(path.join(data.home, 'credentials', 'webauthn.json'));
      const sessions = fs.readFileSync(path.join(data.home, 'sessions', 'webauthn.json'));
      data.server = await spawnServer(data.home, ENV);
      await capabilities(data, paired, 503);
      assert.deepEqual(fs.readFileSync(policyFile(data.home)), broken);
      assert.deepEqual(fs.readFileSync(legacyFile(data.home)), data.legacyBytes);
      assert.deepEqual(fs.readFileSync(path.join(data.home, 'credentials', 'webauthn.json')), credentials);
      assert.deepEqual(fs.readFileSync(path.join(data.home, 'sessions', 'webauthn.json')), sessions);
      assert.deepEqual(policySnapshot(data.home), beforePolicy);
      assert.deepEqual(historySnapshot(data.home), beforeHistory);
    } finally { await close(data); }
  });
}
