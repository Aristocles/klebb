// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { createSandbox, cleanupSandbox, spawnServer, fakeAuthState } = require('../helpers/sandbox');
const ORIGIN = 'https://boundary.example.test';
function post(server, cookie, payload) {
  return new Promise((resolve, reject) => {
    const request = http.request(`${server.baseUrl}/api/connectors/health-connect/pairing-grants`, {
      method: 'POST', headers: { Cookie: cookie, Origin: ORIGIN,
        'Content-Type': 'application/json', 'Content-Length': payload.length },
    }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body, json: JSON.parse(body) }));
    });
    request.on('error', reject);
    request.setTimeout(5000, () => request.destroy(new Error('bounded request timed out')));
    request.end(payload);
  });
}
test('management body rejects duplicates, invalid UTF-8 and oversized bytes without issuing grants', async () => {
  const owner = fakeAuthState('boundary-owner');
  const home = createSandbox({ credentials: owner.credentials, sessions: owner.sessions });
  let server;
  try {
    server = await spawnServer(home, {
      HEALTH_ORIGIN: ORIGIN, HEALTH_RP_ID: 'boundary.example.test', AGENT_API_TOKEN: '',
      KLEBB_ADMIN_TOKEN: '', KLEBB_CLOUD: '', KLEBB_DEMO: '', NODE_OPTIONS: '',
      HEALTH_DATA_DIR: '', HEALTH_REPORTS_DIR: '', HEALTH_AUTO_EXPORT_DIR: '',
      HEALTH_SESSIONS_DIR: '', HEALTH_CREDENTIALS_DIR: '', HEALTH_ARCHIVE_DIR: '',
      HEALTH_CONFIG_PATH: '', HEALTH_DB_DIR: '', HEALTH_DB_FILE: '', HEALTH_CHAT_DIR: '',
      HEALTH_USER_FILE: '', HEALTH_NOTIFICATIONS_STATE_FILE: '', HEALTH_INBOX_DIR: '',
      HEALTH_KEYS_DIR: '', HEALTH_VAPID_FILE: '', HEALTH_PUSH_SUBSCRIPTIONS_FILE: '',
      HEALTH_AUTO_EXPORT_TOKEN: '',
    });
    const cases = [
      [Buffer.from('{"categories":["StepsRecord"],"name":"A","\\u006eame":"B"}'), 'invalid-message'],
      [Buffer.from([0xc3, 0x28]), 'invalid-message'],
      [Buffer.from(' '.repeat(16385)), 'limit-exceeded'],
    ];
    for (const [payload, code] of cases) {
      const response = await post(server, owner.cookie, payload);
      assert.equal(response.status, 400);
      assert.equal(response.json.code, code);
      assert.equal(response.json.grant, undefined);
      const state = JSON.parse(fs.readFileSync(path.join(home, 'credentials', 'health-connect.json'), 'utf8'));
      assert.deepEqual(state.grants, []);
      assert.deepEqual(state.connectors, []);
    }
  } finally {
    if (server) await server.kill();
    cleanupSandbox(home);
  }
});


const { req: admissionRequest, waitFor: admissionWaitFor } = require('../helpers/sandbox');
const { DatabaseSync: AdmissionDatabase } = require('node:sqlite');
const { run: initializeOriginalNative } = require('../helpers/health-connect-guard-migration-fixture.cjs');
const admissionFamily = [
  {
    "name": "health_source_policy_state",
    "sql": "CREATE TABLE health_source_policy_state (\n version INTEGER NOT NULL CHECK (version=1),\n tenant_id TEXT NOT NULL,\n owner_id TEXT NOT NULL,\n epoch TEXT NOT NULL,\n revision TEXT NOT NULL CHECK (typeof(revision)='text' AND length(revision) BETWEEN 1 AND 19 AND revision NOT GLOB '*[^0-9]*' AND (revision='0' OR substr(revision,1,1)!='0') AND (length(revision)<19 OR revision<='9223372036854775807')),\n knowledge TEXT NOT NULL CHECK (knowledge IN ('UNKNOWN','COMPLETE')),\n source_count INTEGER NOT NULL CHECK (typeof(source_count)='integer' AND source_count BETWEEN 0 AND 128),\n PRIMARY KEY (tenant_id,owner_id)\n)"
  },
  {
    "name": "health_source_policy_sources",
    "sql": "CREATE TABLE health_source_policy_sources (\n tenant_id TEXT NOT NULL,\n source_store_id TEXT NOT NULL,\n owner_id TEXT NOT NULL,\n policy_id TEXT NOT NULL UNIQUE,\n lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active','retired')),\n knowledge TEXT NOT NULL CHECK (knowledge IN ('UNKNOWN','COMPLETE')),\n retain_committed_history INTEGER NOT NULL CHECK (typeof(retain_committed_history)='integer' AND retain_committed_history IN (0,1)),\n category_count INTEGER NOT NULL CHECK (typeof(category_count)='integer' AND category_count BETWEEN 0 AND 128),\n reconciled_epoch TEXT,\n PRIMARY KEY (tenant_id,source_store_id)\n)"
  },
  {
    "name": "health_source_policy_categories",
    "sql": "CREATE TABLE health_source_policy_categories (\n tenant_id TEXT NOT NULL,\n source_store_id TEXT NOT NULL,\n record_type TEXT NOT NULL,\n sharing TEXT NOT NULL CHECK (sharing IN ('enabled','stopped')),\n generation TEXT NOT NULL CHECK (typeof(generation)='text' AND length(generation) BETWEEN 1 AND 19 AND generation NOT GLOB '*[^0-9]*' AND (generation='0' OR substr(generation,1,1)!='0') AND (length(generation)<19 OR generation<='9223372036854775807')),\n PRIMARY KEY (tenant_id,source_store_id,record_type),\n FOREIGN KEY (tenant_id,source_store_id) REFERENCES health_source_policy_sources (tenant_id,source_store_id)\n)"
  }
];
const admissionBase = '/api/connectors/health-connect';
for (const route of ['pairing-grants', 'v1/pairing/exchange']) {
  test(`managed policy appearing across held ${route} body refuses enrollment without changing saved state`, async () => {
    const owner = fakeAuthState('synthetic-admission-owner');
    const home = createSandbox({ credentials: owner.credentials, sessions: owner.sessions });
    const credentialFile = path.join(home, 'credentials', 'health-connect.json');
    const dbFile = path.join(home, 'db', 'klebb.db');
    const latch = path.join(home, 'admission-midbody-latch.json');
    const env = {
      HEALTH_ORIGIN: ORIGIN, HEALTH_RP_ID: 'boundary.example.test', AGENT_API_TOKEN: '',
      KLEBB_ADMIN_TOKEN: '', KLEBB_CLOUD: '', KLEBB_DEMO: '', NODE_OPTIONS: '',
      HEALTH_DATA_DIR: '', HEALTH_REPORTS_DIR: '', HEALTH_AUTO_EXPORT_DIR: '',
      HEALTH_SESSIONS_DIR: '', HEALTH_CREDENTIALS_DIR: '', HEALTH_ARCHIVE_DIR: '',
      HEALTH_CONFIG_PATH: '', HEALTH_DB_DIR: '', HEALTH_DB_FILE: '', HEALTH_CHAT_DIR: '',
      HEALTH_USER_FILE: '', HEALTH_NOTIFICATIONS_STATE_FILE: '', HEALTH_INBOX_DIR: '',
      HEALTH_KEYS_DIR: '', HEALTH_VAPID_FILE: '', HEALTH_PUSH_SUBSCRIPTIONS_FILE: '',
      HEALTH_AUTO_EXPORT_TOKEN: '',
    };
    const grantBody = { categories: ['StepsRecord'], name: 'Synthetic admission fixture' };
    const exchangeBody = grant => ({ version: 1, kind: 'pairing-exchange',
      tenantId: grant.tenantId, instanceId: grant.instanceId, sourceStoreId: grant.sourceStoreId,
      installationId: 'synthetic-admission-installation', categories: ['StepsRecord'], grant: grant.grant });
    const policySnapshot = () => {
      const db = new AdmissionDatabase(dbFile, { readOnly: true });
      try {
        db.exec('BEGIN');
        const schema = db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='table' " +
          "AND name LIKE 'health_source_policy_%' ORDER BY name").all().map(row => ({ ...row }));
        const rows = Object.fromEntries(admissionFamily.map(({ name }) =>
          [name, db.prepare(`SELECT * FROM ${name}`).all().map(row => ({ ...row }))]));
        db.exec('COMMIT'); return { schema, rows };
      } finally { db.close(); }
    };
    let server, held;
    try {
      server = await spawnServer(home, env);
      const healthy = await post(server, owner.cookie, Buffer.from(JSON.stringify(grantBody)));
      assert.equal(healthy.status, 201); assert.equal(healthy.json.kind, 'pairing-grant');
      const paired = await admissionRequest(server.baseUrl, `${admissionBase}/v1/pairing/exchange`, {
        method: 'POST', body: exchangeBody(healthy.json),
      });
      assert.equal(paired.status, 200); assert.equal(paired.json.kind, 'paired');
      assert.deepEqual(paired.json.categories, ['StepsRecord']);
      const initialized = await initializeOriginalNative({ home }, 'default');
      assert.equal(initialized.code, 0, initialized.stderr);
      assert.deepEqual(initialized.json, { ok: true, result: {
        version: 1, guards: false, guardRows: null, metadata: null,
      } });
      const emptyNative = new AdmissionDatabase(dbFile, { readOnly: true });
      try {
        assert.deepEqual(emptyNative.prepare('SELECT version FROM health_schema_version').all()
          .map(row => ({ ...row })), [{ version: 1 }]);
        for (const name of ['health_records', 'health_tombstones', 'health_streams',
          'health_batch_receipts', 'health_projection_outbox']) {
          assert.equal(emptyNative.prepare(`SELECT COUNT(*) AS count FROM ${name}`).get().count, 0);
        }
      } finally { emptyNative.close(); }
      let input = grantBody;
      if (route === 'v1/pairing/exchange') {
        const fresh = await post(server, owner.cookie, Buffer.from(JSON.stringify(grantBody)));
        assert.equal(fresh.status, 201); input = exchangeBody(fresh.json);
      }
      await server.kill(); server = null;
      const preload = path.resolve(__dirname, '../helpers/health-connect-midbody-preload.cjs').replaceAll('\\', '/');
      assert.equal(fs.existsSync(latch), false);
      server = await spawnServer(home, { ...env, NODE_OPTIONS: `--require "${preload}"`,
        INDEPENDENT_PRODUCT_ROOT: path.resolve(__dirname, '../..'),
        INDEPENDENT_MID_BODY_LATCH: latch, INDEPENDENT_MID_BODY_ACTION: 'admission-observe' });
      const wire = Buffer.from(JSON.stringify(input));
      const split = Math.floor(wire.length / 2);
      const response = new Promise((resolve, reject) => {
        held = http.request(`${server.baseUrl}${admissionBase}/${route}`, { method: 'POST',
          headers: { Cookie: owner.cookie, Origin: ORIGIN, 'Content-Type': 'application/json',
            'Content-Length': wire.length } }, result => {
          let body = '';
          result.on('data', chunk => { body += chunk.toString('utf8'); });
          result.on('end', () => resolve({ status: result.statusCode, body, json: JSON.parse(body) }));
          result.on('error', reject);
        });
        held.on('error', reject);
        held.setTimeout(15000, () => held.destroy(new Error('bounded held admission timeout')));
        held.write(wire.subarray(0, split));
      });
      void response.catch(() => {});
      await admissionWaitFor(() => fs.existsSync(latch), { timeoutMs: 10000, intervalMs: 20,
        what: 'actual admission iterator first chunk' });
      const event = JSON.parse(fs.readFileSync(latch, 'utf8'));
      assert.equal(event.phase, 'admission-iterator-consumed-first-chunk-before-request-end');
      assert.equal(event.action, 'admission-observe');
      assert.ok(event.bytes > 0 && event.bytes < wire.length);
      const db = new AdmissionDatabase(dbFile);
      try {
        db.exec('BEGIN IMMEDIATE');
        for (const { sql } of admissionFamily) db.exec(sql);
        db.exec('COMMIT');
      } finally { db.close(); }
      const beforeCredentials = fs.readFileSync(credentialFile), beforePolicy = policySnapshot();
      assert.equal(beforePolicy.schema.length, 3);
      for (const { name } of admissionFamily) assert.deepEqual(beforePolicy.rows[name], []);
      held.end(wire.subarray(split));
      const result = await response;
      assert.equal(result.status, 409, result.body);
      assert.equal(result.json.code, 'IMPORT_SOURCE_POLICY_VERIFIER_REQUIRED');
      assert.equal(result.json.kind, 'error');
      assert.equal(result.json.grant, undefined); assert.equal(result.json.credential, undefined);
      assert.deepEqual(fs.readFileSync(credentialFile), beforeCredentials);
      assert.deepEqual(policySnapshot(), beforePolicy);
    } finally {
      if (held) held.destroy();
      if (server) await server.kill();
      cleanupSandbox(home);
    }
  });
}
