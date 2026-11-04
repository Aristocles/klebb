// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createSandbox, cleanupSandbox, spawnServer, req, waitFor, fakeAuthState } = require('../helpers/sandbox');
const { run: initializeOriginalNative } = require('../helpers/health-connect-guard-migration-fixture.cjs');
const { open: openDatastore } = require('../../lib/datastore');
const { sourcePolicyTables } = require('../../lib/health-connect/schema');
const ORIGIN = 'https://boundary.example.test';
const BASE = '/api/connectors/health-connect';
const GRANT_BODY = { categories: ['StepsRecord'], name: 'Synthetic stopped boundary source' };
const ENV = {
  HEALTH_ORIGIN: ORIGIN, HEALTH_RP_ID: 'boundary.example.test', AGENT_API_TOKEN: '',
  KLEBB_ADMIN_TOKEN: '', KLEBB_CLOUD: '', KLEBB_DEMO: '', NODE_OPTIONS: '',
  HEALTH_DATA_DIR: '', HEALTH_REPORTS_DIR: '', HEALTH_AUTO_EXPORT_DIR: '',
  HEALTH_SESSIONS_DIR: '', HEALTH_CREDENTIALS_DIR: '', HEALTH_ARCHIVE_DIR: '',
  HEALTH_CONFIG_PATH: '', HEALTH_DB_DIR: '', HEALTH_DB_FILE: '', HEALTH_CHAT_DIR: '',
  HEALTH_USER_FILE: '', HEALTH_NOTIFICATIONS_STATE_FILE: '', HEALTH_INBOX_DIR: '',
  HEALTH_KEYS_DIR: '', HEALTH_VAPID_FILE: '', HEALTH_PUSH_SUBSCRIPTIONS_FILE: '',
  HEALTH_AUTO_EXPORT_TOKEN: '',
};
const NATIVE_TABLES = ['health_schema_version', 'health_records', 'health_tombstones',
  'health_streams', 'health_batch_receipts', 'health_projection_outbox'];
const POLICY_TABLES = ['health_source_policy_categories', 'health_source_policy_sources',
  'health_source_policy_state'];
const LEGACY_TABLES = ['schema_version', 'cards', 'rows'];
const dbFile = home => path.join(home, 'db', 'klebb.db');
const credentialFile = home => path.join(home, 'credentials', 'health-connect.json');
const catalogueFile = home => path.join(home, 'credentials', 'health-connect-policy.json');
const nullableBytes = file => fs.existsSync(file) ? fs.readFileSync(file) : null;
function sqlSnapshot(home) {
  const db = new DatabaseSync(dbFile(home), { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=5000; BEGIN');
    const schema = db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name')
      .all().map(row => ({ ...row }));
    const names = new Set(schema.filter(row => row.type === 'table').map(row => row.name));
    const rows = tables => Object.fromEntries(tables.map(table => [table, names.has(table) ?
      db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map(row => ({ ...row })) : null]));
    const result = { schema, native: rows(NATIVE_TABLES), policy: rows(POLICY_TABLES), legacy: rows(LEGACY_TABLES) };
    db.exec('COMMIT');
    return result;
  } finally { db.close(); }
}
function assertEmptyNative(snapshot) {
  assert.deepEqual(snapshot.native.health_schema_version, [{ version: 1 }]);
  for (const table of NATIVE_TABLES.slice(1)) assert.deepEqual(snapshot.native[table], []);
}
function assertAbsentPolicy(snapshot) {
  assert.deepEqual(snapshot.schema.filter(row => row.type === 'table' && POLICY_TABLES.includes(row.name)), []);
  for (const table of POLICY_TABLES) assert.equal(snapshot.policy[table], null);
}
async function authenticated(server, owner) {
  const response = await req(server.baseUrl, '/auth/status', { cookie: owner.cookie });
  assert.equal(response.status, 200, response.body);
  assert.equal(response.json.authenticated, true);
}
async function healthyStoppedFirstGrant() {
  const owner = fakeAuthState('synthetic-managed-boundary-member');
  const home = createSandbox({ credentials: owner.credentials, sessions: owner.sessions });
  let server;
  try {
    assert.equal(nullableBytes(credentialFile(home)), null);
    assert.equal(nullableBytes(catalogueFile(home)), null);
    server = await spawnServer(home, ENV);
    await authenticated(server, owner);
    const response = await req(server.baseUrl, `${BASE}/pairing-grants`, {
      method: 'POST', cookie: owner.cookie, headers: { Origin: ORIGIN }, body: GRANT_BODY,
    });
    assert.equal(response.status, 201, response.body);
    assert.equal(response.json.version, 1);
    assert.equal(response.json.kind, 'pairing-grant');
    assert.equal(response.json.destination, ORIGIN);
    assert.deepEqual(response.json.categories, ['StepsRecord']);
    assert.equal(typeof response.json.grant, 'string');
    assert.ok(response.json.grant.length > 0);
    const snapshot = sqlSnapshot(home);
    assertEmptyNative(snapshot);
    assert.deepEqual(snapshot.schema.filter(row => row.type === 'table' && POLICY_TABLES.includes(row.name))
      .map(row => row.name).sort(), POLICY_TABLES);
    assert.equal(snapshot.policy.health_source_policy_state.length, 1);
    assert.equal(snapshot.policy.health_source_policy_sources.length, 1);
    const source = snapshot.policy.health_source_policy_sources[0];
    assert.equal(source.source_store_id, response.json.sourceStoreId);
    assert.equal(source.lifecycle, 'active');
    assert.equal(source.knowledge, 'COMPLETE');
    assert.equal(source.retain_committed_history, 1);
    assert.equal(source.category_count, 1);
    assert.deepEqual(snapshot.policy.health_source_policy_categories.map(row => ({
      source: row.source_store_id, type: row.record_type, sharing: row.sharing, generation: row.generation,
    })), [{ source: response.json.sourceStoreId, type: 'StepsRecord', sharing: 'stopped', generation: '1' }]);
    const catalogue = JSON.parse(fs.readFileSync(catalogueFile(home), 'utf8'));
    assert.equal(catalogue.version, 2);
    const principal = catalogue.principals.find(row => row.ownerId === source.owner_id);
    assert.ok(principal);
    assert.ok(principal.members.some(member => member.credentialId === owner.credentialId));
  } finally {
    if (server) await server.kill();
    cleanupSandbox(home);
  }
}

test('first managed grant refuses a policy family appearing across the real paused body and retains all saved state', async () => {
  // This control finishes in its own sandbox before the no-grant race begins.
  await healthyStoppedFirstGrant();
  const owner = fakeAuthState('synthetic-no-grant-boundary-member');
  const home = createSandbox({ credentials: owner.credentials, sessions: owner.sessions });
  const latch = path.join(home, 'admission-midbody-latch.json');
  let server, held;
  try {
    assert.equal(nullableBytes(credentialFile(home)), null);
    assert.equal(nullableBytes(catalogueFile(home)), null);
    // Bootstrap the actual selected datastore, without grant issuance or a policy row.
    const store = openDatastore(dbFile(home));
    try { assert.equal(store.file, dbFile(home)); } finally { store.close(); }
    const initialized = await initializeOriginalNative({ home }, 'default');
    assert.equal(initialized.code, 0, initialized.stderr);
    assert.deepEqual(initialized.json, { ok: true, result: {
      version: 1, guards: false, guardRows: null, metadata: null,
    } });
    const entry = sqlSnapshot(home);
    assertEmptyNative(entry);
    assertAbsentPolicy(entry);
    assert.equal(nullableBytes(credentialFile(home)), null);
    assert.equal(nullableBytes(catalogueFile(home)), null);
    const preload = path.resolve(__dirname, '../helpers/health-connect-midbody-preload.cjs').replaceAll('\\', '/');
    assert.equal(fs.existsSync(latch), false);
    server = await spawnServer(home, { ...ENV, NODE_OPTIONS: `--require "${preload}"`,
      INDEPENDENT_PRODUCT_ROOT: path.resolve(__dirname, '../..'),
      INDEPENDENT_MID_BODY_LATCH: latch, INDEPENDENT_MID_BODY_ACTION: 'admission-observe' });
    await authenticated(server, owner);
    assertAbsentPolicy(sqlSnapshot(home));
    assert.equal(nullableBytes(credentialFile(home)), null);
    assert.equal(nullableBytes(catalogueFile(home)), null);
    const wire = Buffer.from(JSON.stringify(GRANT_BODY));
    const split = Math.floor(wire.length / 2);
    const response = new Promise((resolve, reject) => {
      held = http.request(`${server.baseUrl}${BASE}/pairing-grants`, { method: 'POST',
        headers: { Cookie: owner.cookie, Origin: ORIGIN, 'Content-Type': 'application/json',
          'Content-Length': wire.length } }, result => {
        let body = '';
        result.on('data', chunk => { body += chunk.toString('utf8'); });
        result.on('end', () => {
          try { resolve({ status: result.statusCode, body, json: JSON.parse(body) }); }
          catch (error) { reject(error); }
        });
        result.on('error', reject);
      });
      held.on('error', reject);
      held.setTimeout(15000, () => held.destroy(new Error('bounded held admission timeout')));
      held.write(wire.subarray(0, split));
    });
    void response.catch(() => {});
    await waitFor(() => fs.existsSync(latch), { timeoutMs: 10000, intervalMs: 20,
      what: 'actual admission iterator first chunk' });
    const event = JSON.parse(fs.readFileSync(latch, 'utf8'));
    assert.equal(event.phase, 'admission-iterator-consumed-first-chunk-before-request-end');
    assert.equal(event.action, 'admission-observe');
    assert.ok(event.bytes > 0 && event.bytes < wire.length);
    assert.equal(held.writableEnded, false);
    const atLatch = sqlSnapshot(home);
    assertAbsentPolicy(atLatch);
    assert.deepEqual(atLatch.native, entry.native);
    const v1AtLatch = fs.readFileSync(credentialFile(home));
    const v1 = JSON.parse(v1AtLatch.toString('utf8'));
    assert.equal(v1.version, 1);
    assert.deepEqual(Object.keys(v1).sort(), ['connectors', 'grants', 'instanceId', 'restoreEpoch', 'tenantId', 'version']);
    assert.deepEqual(v1.grants, []);
    assert.deepEqual(v1.connectors, []);
    assert.equal(nullableBytes(catalogueFile(home)), null);
    // Deliberate empty-family appearance is not enrollment or deletion authority.
    const db = new DatabaseSync(dbFile(home));
    try {
      db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
      for (const sql of Object.values(sourcePolicyTables)) db.exec(sql);
      db.exec('COMMIT');
    } finally { db.close(); }
    const before = sqlSnapshot(home);
    assert.deepEqual(before.schema.filter(row => row.type === 'table' && POLICY_TABLES.includes(row.name))
      .map(row => row.name).sort(), POLICY_TABLES);
    for (const table of POLICY_TABLES) assert.deepEqual(before.policy[table], []);
    assert.deepEqual(before.native, atLatch.native);
    assert.deepEqual(before.legacy, atLatch.legacy);
    assert.deepEqual(fs.readFileSync(credentialFile(home)), v1AtLatch);
    const beforeCatalogue = nullableBytes(catalogueFile(home));
    assert.equal(beforeCatalogue, null);
    held.end(wire.subarray(split));
    const result = await response;
    assert.equal(result.status, 409, result.body);
    assert.deepEqual(result.json, { version: 1, kind: 'error',
      code: 'IMPORT_SOURCE_POLICY_VERIFIER_REQUIRED', retryable: false });
    assert.equal(result.json.grant, undefined);
    assert.equal(result.json.credential, undefined);
    assert.deepEqual(fs.readFileSync(credentialFile(home)), v1AtLatch);
    assert.deepEqual(nullableBytes(catalogueFile(home)), beforeCatalogue);
    assert.deepEqual(sqlSnapshot(home), before);
  } finally {
    if (held) held.destroy();
    if (server) await server.kill();
    cleanupSandbox(home);
  }
});
