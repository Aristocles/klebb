// SPDX-License-Identifier: AGPL-3.0-only
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const {
  createSandbox, cleanupSandbox, fakeAuthState, spawnServer: spawnActualServer, req,
} = require('../helpers/sandbox');
const { nativeTables, sourcePolicyTables } = require('../../lib/health-connect/schema');
const fixedClock = require('../fixtures/health-connect/fixed-child-clock-inputs-v1.json');
const fixedClockPreload = path.resolve(__dirname, '../helpers/health-connect-fixed-child-clock-preload.cjs');

const ORIGIN = 'https://policy.example.test';
const BASE = '/api/connectors/health-connect';
const TYPES = ['StepsRecord', 'WeightRecord'];
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ENV = {
  HEALTH_ORIGIN: ORIGIN, HEALTH_RP_ID: 'policy.example.test',
  AGENT_API_TOKEN: '', KLEBB_ADMIN_TOKEN: '', KLEBB_CLOUD: '', KLEBB_DEMO: '',
  HEALTH_DATA_DIR: '', HEALTH_REPORTS_DIR: '', HEALTH_AUTO_EXPORT_DIR: '',
  HEALTH_SESSIONS_DIR: '', HEALTH_CREDENTIALS_DIR: '', HEALTH_ARCHIVE_DIR: '',
  HEALTH_CONFIG_PATH: '', HEALTH_DB_DIR: '', HEALTH_DB_FILE: '', HEALTH_CHAT_DIR: '',
  HEALTH_USER_FILE: '', HEALTH_NOTIFICATIONS_STATE_FILE: '', HEALTH_INBOX_DIR: '',
  HEALTH_KEYS_DIR: '', HEALTH_VAPID_FILE: '', HEALTH_PUSH_SUBSCRIPTIONS_FILE: '',
  HEALTH_AUTO_EXPORT_TOKEN: '',
  INDEPENDENT_FIXED_CHILD_CLOCK: String(fixedClock.base.milliseconds),
  NODE_OPTIONS: `--require=${JSON.stringify(fixedClockPreload)}`,
};

function fixture(createHome = createSandbox) {
  const owner = fakeAuthState('policy-owner');
  owner.sessions[owner.token].created = fixedClock.base.milliseconds;
  owner.sessions[owner.token].lastSeen = fixedClock.base.milliseconds;
  return { owner, home: createHome({
    credentials: owner.credentials, sessions: owner.sessions,
    seed: { 'policy-sentinel.json': {
      $schema: 'klebb.datafile.v1',
      meta: { id: 'policy-sentinel', label: 'Policy sentinel' },
      data: [{ date: '2026-01-02', value: 7 }],
    } },
  }) };
}
const cataloguePath = home => path.join(home, 'credentials', 'health-connect.json');
const databasePath = home => path.join(home, 'db', 'klebb.db');
const grant = (server, owner) => req(server.baseUrl, `${BASE}/pairing-grants`, {
  method: 'POST', cookie: owner.cookie, headers: { Origin: ORIGIN },
  body: { categories: TYPES, name: 'Synthetic source' },
});
async function legacyPair(server, owner) {
  const issued = await grant(server, owner);
  assert.equal(issued.status, 201, issued.body);
  const paired = await req(server.baseUrl, `${BASE}/v1/pairing/exchange`, {
    method: 'POST', body: {
      version: 1, kind: 'pairing-exchange', tenantId: issued.json.tenantId,
      instanceId: issued.json.instanceId, grant: issued.json.grant,
      installationId: 'synthetic-policy-installation',
      sourceStoreId: issued.json.sourceStoreId, categories: TYPES,
    },
  });
  assert.equal(paired.status, 200, paired.body);
  const capabilities = await req(server.baseUrl, `${BASE}/v1/capabilities`, {
    headers: { Authorization: `Bearer ${paired.json.credential}`, 'Klebb-Health-Protocol': '1' },
  });
  assert.equal(capabilities.status, 200, capabilities.body);
  return { issued: issued.json, paired: paired.json };
}
function installExactSchema(home) {
  const db = new DatabaseSync(databasePath(home));
  try {
    db.exec('PRAGMA foreign_keys=ON');
    db.exec('BEGIN IMMEDIATE');
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='table' AND name GLOB 'health_*'").get().n, 0);
    for (const sql of Object.values(nativeTables)) db.exec(sql);
    db.exec('CREATE INDEX health_receipt_sequence_order ON health_batch_receipts (stream_key, length(sequence), sequence)');
    db.prepare('INSERT INTO health_schema_version (version) VALUES (1)').run();
    for (const sql of Object.values(sourcePolicyTables)) db.exec(sql);
    for (const name of Object.keys(sourcePolicyTables)) {
      assert.equal(db.prepare(`SELECT count(*) AS n FROM ${name}`).get().n, 0);
    }
    db.exec('COMMIT');
  } finally { db.close(); }
}

test('POLICYFORWARD01 healthy legacy pairing and admission controls retain version1 authority', async () => {
  // Keep the ordinary factory captured for the unrelated forward fixture.
  // The legacy adapter needs a fresh module instance to observe real spawns.
  const sandboxModule = require.resolve('../helpers/sandbox');
  const ordinarySandbox = require.cache[sandboxModule];
  assert.ok(ordinarySandbox, 'Ordinary sandbox must already be loaded');
  let original;
  delete require.cache[sandboxModule];
  try { original = require('../helpers/legacy-health-producer'); }
  finally { require.cache[sandboxModule] = ordinarySandbox; }
  const f = fixture(original.createSandbox);
  let server;
  try {
    server = await original.spawnProducerServer(f.home, ENV);
    const { issued, paired } = await legacyPair(server, f.owner);
    await server.kill(); server = null;
    server = await original.spawnCandidateServer(f.home, ENV);
    const capabilities = await req(server.baseUrl, `${BASE}/v1/capabilities`, {
      headers: { Authorization: `Bearer ${paired.credential}`, 'Klebb-Health-Protocol': '1' },
    });
    assert.equal(capabilities.status, 200, capabilities.body);
    assert.equal(capabilities.json.kind, 'capabilities');
    assert.equal(capabilities.json.sourceStoreId, paired.sourceStoreId);
    assert.equal(capabilities.json.restoreEpoch, paired.restoreEpoch);
    const state = JSON.parse(fs.readFileSync(cataloguePath(f.home), 'utf8'));
    assert.equal(state.version, 1);
    assert.equal(state.tenantId, issued.tenantId);
    assert.equal(state.connectors[0].sourceStoreId, paired.sourceStoreId);
    assert.equal(state.connectors[0].ownerId, 'policy-owner');
    assert.equal(fs.existsSync(path.join(f.home, 'credentials', 'health-connect-policy.json')), false);
  } finally {
    if (server) await server.kill();
    original.cleanupSandbox(f.home);
  }
});

test('POLICYFORWARD02 genuine forward namespace enrols stopped before grant and preserves old namespace', async () => {
  // This case must also work when selected without the preceding legacy case.
  const sandboxModule = require.resolve('../helpers/sandbox');
  const ordinarySandbox = require.cache[sandboxModule];
  assert.ok(ordinarySandbox, 'Ordinary sandbox must already be loaded');
  let original;
  delete require.cache[sandboxModule];
  try { original = require('../helpers/legacy-health-producer'); }
  finally { require.cache[sandboxModule] = ordinarySandbox; }
  const f = fixture(original.createSandbox);
  let server;
  try {
    server = await original.spawnProducerServer(f.home, ENV);
    const legacy = await legacyPair(server, f.owner);
    const before = fs.readFileSync(cataloguePath(f.home));
    await server.kill();
    server = null;
    installExactSchema(f.home);
    server = await original.spawnCandidateServer(f.home, ENV);
    const forward = await grant(server, f.owner);
    // Existing healthy APIs and an exact recognized schema must reach this
    // behavior assertion. Missing modules or fixture setup do not establish RED.
    assert.equal(forward.status, 201, forward.body);
    assert.equal(forward.json.version, 1);
    assert.equal(forward.json.kind, 'pairing-grant');
    assert.deepEqual(forward.json.categories, TYPES);
    for (const key of ['tenantId', 'instanceId', 'sourceStoreId', 'restoreEpoch']) {
      assert.match(forward.json[key], UUID);
    }
    assert.notEqual(forward.json.tenantId, legacy.issued.tenantId);
    assert.notEqual(forward.json.instanceId, legacy.issued.instanceId);
    assert.notEqual(forward.json.sourceStoreId, legacy.issued.sourceStoreId);
    assert.notEqual(forward.json.restoreEpoch, legacy.issued.restoreEpoch);
    assert.equal(fs.readFileSync(cataloguePath(f.home)).equals(before), true);
    const sidecar = JSON.parse(fs.readFileSync(path.join(f.home, 'credentials', 'health-connect-policy.json'), 'utf8'));
    assert.equal(sidecar.version, 2);
    const db = new DatabaseSync(databasePath(f.home), { readOnly: true });
    try {
      const states = db.prepare('SELECT * FROM health_source_policy_state').all();
      assert.equal(states.length, 1);
      assert.equal(states[0].tenant_id, forward.json.tenantId);
      assert.notEqual(states[0].owner_id, f.owner.sessions[f.owner.token].userId);
      assert.equal(states[0].knowledge, 'COMPLETE');
      assert.equal(states[0].source_count, 1);
      const sources = db.prepare('SELECT * FROM health_source_policy_sources').all();
      assert.equal(sources.length, 1);
      assert.equal(sources[0].tenant_id, forward.json.tenantId);
      assert.equal(sources[0].source_store_id, forward.json.sourceStoreId);
      assert.equal(sources[0].owner_id, states[0].owner_id);
      assert.equal(sources[0].lifecycle, 'active');
      assert.equal(sources[0].knowledge, 'COMPLETE');
      assert.equal(sources[0].retain_committed_history, 1);
      assert.equal(sources[0].category_count, 2);
      assert.equal(sources[0].reconciled_epoch, null);
      assert.deepEqual(db.prepare('SELECT record_type,sharing,generation FROM health_source_policy_categories ORDER BY record_type').all()
        .map(row => ({ ...row })), [
        { record_type: 'StepsRecord', sharing: 'stopped', generation: '1' },
        { record_type: 'WeightRecord', sharing: 'stopped', generation: '1' },
      ]);
      assert.equal(db.prepare('SELECT count(*) AS n FROM health_records').get().n, 0);
      assert.equal(db.prepare('SELECT count(*) AS n FROM health_batch_receipts').get().n, 0);
    } finally { db.close(); }
  } finally {
    if (server) await server.kill();
    original.cleanupSandbox(f.home);
  }
});
