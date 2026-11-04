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
const TYPE = 'BodyWaterMassRecord';
const ORIGIN = 'https://synthetic-custody.example.test';
const ENV = { HEALTH_ORIGIN: ORIGIN, HEALTH_RP_ID: 'synthetic-custody.example.test',
  AGENT_API_TOKEN: '', KLEBB_ADMIN_TOKEN: '', KLEBB_CLOUD: '', KLEBB_DEMO: '',
  HEALTH_DATA_DIR: '', HEALTH_REPORTS_DIR: '', HEALTH_AUTO_EXPORT_DIR: '',
  HEALTH_SESSIONS_DIR: '', HEALTH_CREDENTIALS_DIR: '', HEALTH_ARCHIVE_DIR: '',
  HEALTH_CONFIG_PATH: '', HEALTH_DB_DIR: '', HEALTH_DB_FILE: '', HEALTH_CHAT_DIR: '',
  HEALTH_USER_FILE: '', HEALTH_NOTIFICATIONS_STATE_FILE: '', HEALTH_INBOX_DIR: '',
  HEALTH_KEYS_DIR: '', HEALTH_VAPID_FILE: '', HEALTH_PUSH_SUBSCRIPTIONS_FILE: '',
  HEALTH_AUTO_EXPORT_TOKEN: '', NODE_OPTIONS: '' };
const preload = path.join(__dirname, '../helpers/health-connect-first-family-fault-preload.cjs');
const family = ['health_source_policy_state', 'health_source_policy_sources', 'health_source_policy_categories'];
const native = ['health_records', 'health_tombstones', 'health_streams',
  'health_batch_receipts', 'health_projection_outbox'];
const policyPath = home => path.join(home, 'credentials', 'health-connect-policy.json');
const browser = (f, route, options = {}) => req(f.server.baseUrl, route, {
  cookie: f.owner.cookie, ...options, headers: { Origin: ORIGIN, ...options.headers },
});
function snapshot(home) {
  const db = new DatabaseSync(path.join(home, 'db', 'klebb.db'), { readOnly: true });
  try {
    db.exec('BEGIN');
    const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE " +
      "lower(name) GLOB 'health_source_policy_*' OR lower(tbl_name) GLOB 'health_source_policy_*' " +
      'ORDER BY type,name').all().map(x => ({ ...x }));
    const exists = table => !!db.prepare("SELECT 1 AS present FROM sqlite_schema WHERE type='table' AND name=?")
      .get(table);
    const rows = table => exists(table) ? db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()
      .map(x => ({ ...x })) : [];
    return { schema, policy: Object.fromEntries(family.map(t => [t, rows(t)])),
      native: Object.fromEntries(native.map(t => [t, rows(t)])) };
  } finally { db.close(); }
}
async function setup(operation) {
  const owner = fakeAuthState('synthetic-first-family-member');
  const home = createSandbox({ credentials: owner.credentials, sessions: owner.sessions });
  const userId = Object.keys(owner.credentials.users)[0];
  const registered = owner.credentials.users[userId].credentials.find(c => c.id === owner.credentialId);
  const member = { userId, credentialId: owner.credentialId,
    publicKeySha256: 'sha256:' + crypto.createHash('sha256').update(Buffer.from(registered.publicKey, 'base64')).digest('hex') };
  const marker = path.join(home, 'first-family-fault.json');
  const f = { home, owner, member, marker, server: null };
  try {
    f.server = await spawnServer(home, { ...ENV,
      NODE_OPTIONS: `--require "${preload.replaceAll('\\', '/')}"`,
      INDEPENDENT_BIRTH_FAULT: operation, INDEPENDENT_BIRTH_FAULT_MARKER: marker,
      INDEPENDENT_BIRTH_MEMBER: JSON.stringify(member) });
    const auth = await browser(f, '/auth/status');
    assert.equal(auth.status, 200); assert.equal(auth.json.authenticated, true);
    const list = await browser(f, BASE);
    assert.equal(list.status, 200, list.body); assert.equal(list.json.kind, 'connector-list');
    assert.deepEqual(list.json.connectors, [], 'healthy existing empty-list API before the fault');
    f.legacyBefore = fs.readFileSync(path.join(home, 'credentials', 'health-connect.json'));
    const legacy = JSON.parse(f.legacyBefore);
    assert.deepEqual(legacy.grants, []); assert.deepEqual(legacy.connectors, []);
    assert.equal(fs.existsSync(marker), false, 'startup has not fired the fault');
    assert.equal(fs.existsSync(policyPath(home)), false, 'genuinely absent first-family catalogue');
    assert.deepEqual(snapshot(home).schema, [], 'genuinely absent first SQL policy family');
    return f;
  } catch (failure) { if (f.server) await f.server.kill(); cleanupSandbox(home); throw failure; }
}
async function close(f) { if (f.server) await f.server.kill(); cleanupSandbox(f.home); }
async function requestBirth(f) {
  return browser(f, `${BASE}/pairing-grants`, { method: 'POST',
    body: { categories: [TYPE], name: 'Synthetic first stopped source' } });
}
function refused(response, code) {
  assert.equal(response.status, 503, response.body);
  assert.deepEqual(response.json, { version: 1, kind: 'error', code, retryable: true });
  for (const field of ['grant', 'credential', 'secret', 'acknowledgedSequence']) {
    assert.equal(Object.hasOwn(response.json, field), false, 'no success secret or ACK');
  }
}
function bornBinding(gate, sql, member) {
  assert.equal(gate.version, 2); assert.equal(gate.recoveryRequired, true);
  assert.equal(gate.principals.length, 1); assert.equal(gate.namespaces.length, 1);
  const s = sql.state[0], source = sql.sources[0], category = sql.categories[0];
  assert.equal(sql.state.length, 1); assert.equal(sql.sources.length, 1); assert.equal(sql.categories.length, 1);
  assert.equal(gate.principals[0].ownerId, s.owner_id);
  assert.deepEqual(gate.principals[0].members, [member]);
  assert.notEqual(s.owner_id, member.userId, 'new internal principal, not a reused account label');
  assert.equal(gate.namespaces[0].ownerId, s.owner_id);
  assert.equal(gate.namespaces[0].state.tenantId, s.tenant_id);
  assert.equal(gate.namespaces[0].state.restoreEpoch, s.epoch);
  assert.match(gate.namespaces[0].state.instanceId, /^[a-f0-9-]{36}$/);
  assert.deepEqual(gate.namespaces[0].state.grants, []); assert.deepEqual(gate.namespaces[0].state.connectors, []);
  assert.equal(s.revision, '1'); assert.equal(s.source_count, 1);
  assert.equal(source.owner_id, s.owner_id); assert.equal(source.tenant_id, s.tenant_id);
  assert.equal(source.lifecycle, 'active'); assert.equal(source.knowledge, 'COMPLETE');
  assert.equal(source.retain_committed_history, 1); assert.equal(source.category_count, 1);
  assert.equal(source.reconciled_epoch, null, 'registry completeness does not establish native reconciliation');
  assert.equal(category.tenant_id, s.tenant_id); assert.equal(category.source_store_id, source.source_store_id);
  assert.equal(category.record_type, TYPE); assert.equal(category.sharing, 'stopped'); assert.equal(category.generation, '1');
}

test('FIRST_FAMILY_FAULT01 callback rename failure before COMMIT restores exact family and catalogue absence', async () => {
  const f = await setup('callback-rename-after');
  try {
    const before = snapshot(f.home);
    const response = await requestBirth(f);
    assert.ok(fs.existsSync(f.marker), 'real semantic born-gate rename fault must have fired');
    const evidence = JSON.parse(fs.readFileSync(f.marker, 'utf8'));
    assert.equal(evidence.realRenameReturned, true); assert.equal(evidence.realCommitReturned, false);
    bornBinding(evidence.gateBeforeCOMMIT, evidence.sqlBeforeCOMMIT, f.member);
    refused(response, 'storage-unavailable');
    assert.deepEqual(fs.readFileSync(path.join(f.home, 'credentials', 'health-connect.json')), f.legacyBefore);
    assert.deepEqual(snapshot(f.home), before, 'known rollback preserves exact initial SQL family absence and native rows');
    assert.equal(fs.existsSync(policyPath(f.home)), false, 'no orphan private catalogue after observed rollback');
    assert.deepEqual(fs.readdirSync(path.join(f.home, 'credentials'))
      .filter(n => n.startsWith('health-connect-policy.json')), [], 'no catalogue, lock or temporary orphan');
  } finally { await close(f); }
});

test('FIRST_FAMILY_FAULT02 actual successful COMMIT then throw retains born STOPPED scope and complete recovery gate', async () => {
  const f = await setup('commit-after');
  try {
    const before = snapshot(f.home);
    const response = await requestBirth(f);
    assert.ok(fs.existsSync(f.marker), 'genuine born SQL transaction must reach the COMMIT fault');
    const evidence = JSON.parse(fs.readFileSync(f.marker, 'utf8'));
    assert.equal(evidence.realCommitReturned, true, 'actual native COMMIT returned before injected failure');
    const after = snapshot(f.home);
    assert.equal(after.schema.filter(x => x.type === 'table').length, 3);
    assert.deepEqual(after.policy.health_source_policy_state, evidence.sqlBeforeCOMMIT.state);
    assert.deepEqual(after.policy.health_source_policy_sources, evidence.sqlBeforeCOMMIT.sources);
    assert.deepEqual(after.policy.health_source_policy_categories, evidence.sqlBeforeCOMMIT.categories);
    assert.deepEqual(after.native, before.native, 'no raw history, control, stream, receipt or ACK writes');
    bornBinding(evidence.gateBeforeCOMMIT, evidence.sqlBeforeCOMMIT, f.member);
    const gate = JSON.parse(fs.readFileSync(policyPath(f.home), 'utf8'));
    bornBinding(gate, evidence.sqlBeforeCOMMIT, f.member);
    assert.deepEqual(gate, evidence.gateBeforeCOMMIT, 'retain the actual updated denial gate without inferred rollback');
    refused(response, 'IMPORT_SOURCE_POLICY_RECOVERY_REQUIRED');
    assert.deepEqual(fs.readFileSync(path.join(f.home, 'credentials', 'health-connect.json')), f.legacyBefore);
    const again = await browser(f, BASE);
    refused(again, 'IMPORT_SOURCE_POLICY_RECOVERY_REQUIRED');
    assert.deepEqual(snapshot(f.home), after); assert.deepEqual(JSON.parse(fs.readFileSync(policyPath(f.home), 'utf8')), gate);
  } finally { await close(f); }
});
