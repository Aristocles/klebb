// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const schema = require('../../lib/health-connect/schema');
const { createSandbox, cleanupSandbox, spawnServer, req, waitFor } = require('../helpers/sandbox');

// Only cryptographic verification is controlled. The original server, SDK
// options generator, HTTP routes, credential deletion and saved sessions run.
// These tests do not prove passkey hardware or retained policy ownership.
const VERIFIER_PRELOAD = String.raw`// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const fs = require('node:fs');
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const loaded = originalLoad.call(this, request, parent, isMain);
  if (request !== '@simplewebauthn/server') return loaded;
  return {
    ...loaded,
    async verifyAuthenticationResponse(input) {
      fs.writeFileSync(process.env.AUTH_TEST_VERIFIER_ENTRY, JSON.stringify({
        responseId: input.response.id,
        expectedChallenge: input.expectedChallenge,
        expectedOrigin: input.expectedOrigin,
        expectedRPID: input.expectedRPID,
        credential: {
          id: input.credential.id,
          publicKey: Buffer.from(input.credential.publicKey).toString('base64'),
          counter: input.credential.counter,
        },
      }));
      await new Promise((resolve, reject) => {
        const deadline = Date.now() + 25000;
        const timer = setInterval(() => {
          if (fs.existsSync(process.env.AUTH_TEST_VERIFIER_RELEASE)) {
            clearInterval(timer);
            resolve();
          } else if (Date.now() >= deadline) {
            clearInterval(timer);
            reject(new Error('Controlled verifier was not released'));
          }
        }, 10);
      });
      return { verified: true, authenticationInfo: { newCounter: 1 } };
    },
  };
};
`;

const OWNER = 'fixture-member';
const SELECTED = {
  id: 'selected-api-credential',
  publicKey: Buffer.from('selected fixture public key').toString('base64'),
  counter: 0,
  nickname: 'Selected fixture device',
};
const SURVIVOR = {
  id: 'surviving-api-credential',
  publicKey: Buffer.from('surviving fixture public key').toString('base64'),
  counter: 7,
  nickname: 'Surviving fixture device',
};
const SELECTED_TOKEN = '1'.repeat(64);
const SURVIVOR_TOKEN = '2'.repeat(64);
const TENANT = '11111111-1111-4111-8111-111111111111';
const SOURCE = '22222222-2222-4222-8222-222222222222';
const CONTROL_ID = 'retained-api-login-control';

function readJSON(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function nativeSnapshot(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return Object.fromEntries(Object.keys(schema.nativeTables).map(name => {
      const statement = db.prepare(`SELECT * FROM ${name}`);
      statement.setReadBigInts(true);
      const rows = statement.all();
      const key = row => JSON.stringify(row, (_, value) =>
        typeof value === 'bigint' ? `integer:${value}` : value);
      rows.sort((left, right) => key(left).localeCompare(key(right)));
      return [name, rows];
    }));
  } finally {
    db.close();
  }
}

async function fixture(t) {
  const now = Date.now();
  const directory = createSandbox({
    credentials: { users: { [OWNER]: { credentials: [SELECTED, SURVIVOR] } } },
    sessions: {
      [SELECTED_TOKEN]: { userId: OWNER, credentialId: SELECTED.id, created: now, lastSeen: now },
      [SURVIVOR_TOKEN]: { userId: OWNER, credentialId: SURVIVOR.id, created: now, lastSeen: now },
    },
  });
  let server;
  const releaseFile = path.join(directory, 'verifier-release');
  t.after(async () => {
    fs.writeFileSync(releaseFile, 'release');
    if (server) await server.kill();
    cleanupSandbox(directory);
  });

  const credentialsFile = path.join(directory, 'credentials', 'webauthn.json');
  const sessionsFile = path.join(directory, 'sessions', 'webauthn.json');
  const policyFiles = [
    path.join(directory, 'credentials', 'health-connect.json'),
    path.join(directory, 'credentials', 'health-connect-policy.json'),
  ];
  // UNKNOWN retention witnesses, not established owner or COMPLETE evidence.
  fs.writeFileSync(policyFiles[0], JSON.stringify({ version: 1, tenantId: TENANT, installations: [] }));
  fs.writeFileSync(policyFiles[1], JSON.stringify({
    version: 2, recoveryRequired: true, principals: [], namespaces: [],
  }));
  const originalPolicy = policyFiles.map(file => fs.readFileSync(file));
  const dbFile = path.join(directory, 'db', 'klebb.db');
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);
  try {
    for (const sql of Object.values(schema.nativeTables)) db.exec(sql);
    db.prepare('INSERT INTO health_schema_version(version) VALUES (1)').run();
    db.prepare('INSERT INTO health_tombstones VALUES (?,?,?,?,?,?)').run(
      TENANT, SOURCE, 'StepsRecord', CONTROL_ID,
      JSON.stringify([TENANT, '33333333-3333-4333-8333-333333333333', SOURCE,
        '44444444-4444-4444-8444-444444444444', 'StepsRecord', '3',
        '55555555-5555-4555-8555-555555555555']), '7');
  } finally {
    db.close();
  }

  const entryFile = path.join(directory, 'verifier-entry.json');
  const preloadFile = path.join(directory, 'controlled-verifier.cjs');
  fs.writeFileSync(preloadFile, VERIFIER_PRELOAD);
  server = await spawnServer(directory, {
    NODE_OPTIONS: `--require ${JSON.stringify(preloadFile.replace(/\\/g, '/'))}`,
    AUTH_TEST_VERIFIER_ENTRY: entryFile,
    AUTH_TEST_VERIFIER_RELEASE: releaseFile,
    HEALTH_DB_FILE: dbFile,
    KLEBB_CLOUD: '',
    KLEBB_DEMO: '',
    AGENT_API_TOKEN: '',
  });
  const headers = { Origin: server.baseUrl };
  const management = await req(server.baseUrl, '/api/credentials', {
    cookie: `klebb_session=${SURVIVOR_TOKEN}`, headers,
  });
  assert.equal(management.status, 200, 'the real current-member credential API must be healthy');
  assert.deepEqual(management.json.credentials.map(item => item.id), [SELECTED.id, SURVIVOR.id]);
  assert.equal(management.json.credentials.find(item => item.id === SURVIVOR.id).isCurrentDevice, true);

  const retainedHistory = nativeSnapshot(dbFile);
  const retainedControl = retainedHistory.health_tombstones.find(row => row.native_record_id === CONTROL_ID);
  assert.ok(retainedControl, 'the retained typed native control must exist before the login assertion');
  assert.equal(retainedControl.record_type, 'StepsRecord');
  assert.equal(retainedControl.sequence, '7');
  function retention() {
    for (let index = 0; index < policyFiles.length; index++) {
      assert.deepEqual(fs.readFileSync(policyFiles[index]), originalPolicy[index]);
    }
    assert.deepEqual(nativeSnapshot(dbFile), retainedHistory);
  }
  retention();

  async function beginLogin() {
    const options = await req(server.baseUrl, '/auth/login/options', { method: 'POST', body: {}, headers });
    assert.equal(options.status, 200);
    assert.equal(typeof options.json.challenge, 'string');
    assert.ok(options.json.challenge.length > 0);
    assert.deepEqual(options.json.allowCredentials.map(item => item.id), [SELECTED.id, SURVIVOR.id]);
    const pending = req(server.baseUrl, '/auth/login/verify', {
      method: 'POST', headers, body: { id: SELECTED.id, type: 'public-key', response: {} },
    });
    pending.catch(() => {});
    const entered = await waitFor(() => fs.existsSync(entryFile) && readJSON(entryFile), {
      what: 'the actual login verifier async boundary',
    });
    assert.equal(entered.responseId, SELECTED.id);
    assert.equal(entered.expectedChallenge, options.json.challenge);
    assert.equal(entered.expectedOrigin, server.baseUrl);
    assert.equal(entered.expectedRPID, '127.0.0.1');
    assert.deepEqual(entered.credential, { id: SELECTED.id, publicKey: SELECTED.publicKey, counter: 0 });
    return { pending };
  }
  return {
    directory, credentialsFile, sessionsFile, server, headers, retention, beginLogin,
    release() { fs.writeFileSync(releaseFile, 'release'); },
  };
}

function saveLatestUnrelatedState(f) {
  // Change actual persisted fixture state while the verifier is suspended.
  // This creates no authenticated account or policy-principal claim.
  const latest = readJSON(f.credentialsFile);
  const survivor = latest.users[OWNER].credentials.find(item => item.id === SURVIVOR.id);
  survivor.nickname = 'Latest surviving fixture device';
  survivor.counter = 9;
  latest.users['unrelated-fixture'] = { credentials: [{
    id: 'latest-unrelated-api-credential',
    publicKey: Buffer.from('unrelated fixture public key').toString('base64'),
    counter: 4,
  }] };
  fs.writeFileSync(f.credentialsFile, JSON.stringify(latest, null, 2));
  return latest;
}

test('CURRENTCREDENTIAL_API01 healthy current login preserves latest unrelated saved state', async t => {
  const f = await fixture(t);
  const { pending } = await f.beginLogin();
  const latest = saveLatestUnrelatedState(f);
  const beforeSessions = readJSON(f.sessionsFile);
  f.release();
  const verified = await pending;
  assert.equal(verified.status, 200);
  assert.deepEqual(verified.json, { verified: true, label: OWNER });
  const cookie = verified.headers['set-cookie']?.[0];
  assert.equal(typeof cookie, 'string');
  const token = cookie.match(/klebb_session=([a-f0-9]{64})/)?.[1];
  assert.ok(token);
  const sessions = readJSON(f.sessionsFile);
  assert.equal(Object.keys(sessions).length, Object.keys(beforeSessions).length + 1);
  for (const [existing, record] of Object.entries(beforeSessions)) assert.deepEqual(sessions[existing], record);
  assert.equal(sessions[token].userId, OWNER);
  assert.equal(sessions[token].credentialId, SELECTED.id);
  const actual = readJSON(f.credentialsFile);
  const selected = actual.users[OWNER].credentials.find(item => item.id === SELECTED.id);
  assert.equal(selected.counter, 1);
  assert.equal(typeof selected.lastUsedAt, 'string');
  assert.ok(Number.isFinite(Date.parse(selected.lastUsedAt)));
  latest.users[OWNER].credentials.find(item => item.id === SELECTED.id).counter = 1;
  latest.users[OWNER].credentials.find(item => item.id === SELECTED.id).lastUsedAt = selected.lastUsedAt;
  assert.deepEqual(actual, latest);
  f.retention();
});

test('CURRENTCREDENTIAL_API02 genuine credential DELETE during login refuses resurrection', async t => {
  const f = await fixture(t);
  const { pending } = await f.beginLogin();
  saveLatestUnrelatedState(f);
  const removed = await req(f.server.baseUrl, `/api/credentials/${encodeURIComponent(SELECTED.id)}`, {
    method: 'DELETE', headers: f.headers, cookie: `klebb_session=${SURVIVOR_TOKEN}`,
  });
  assert.equal(removed.status, 200, 'the genuine current-owner DELETE must complete before releasing verification');
  assert.deepEqual(removed.json, { ok: true, id: SELECTED.id });
  const postDelete = readJSON(f.credentialsFile);
  assert.deepEqual(postDelete.users[OWNER].credentials.map(item => item.id), [SURVIVOR.id]);
  assert.equal(postDelete.users[OWNER].credentials[0].counter, 9);
  assert.equal(postDelete.users[OWNER].credentials[0].nickname, 'Latest surviving fixture device');
  assert.ok(postDelete.users['unrelated-fixture']);
  const postDeleteSessions = readJSON(f.sessionsFile);
  assert.equal(postDeleteSessions[SELECTED_TOKEN], undefined);
  assert.equal(postDeleteSessions[SURVIVOR_TOKEN].credentialId, SURVIVOR.id);
  const credentialBytes = fs.readFileSync(f.credentialsFile);
  const sessionBytes = fs.readFileSync(f.sessionsFile);
  f.retention();
  f.release();
  const verified = await pending;
  assert.equal(verified.status, 400);
  assert.deepEqual(verified.json, { error: 'Unknown credential' });
  assert.equal(verified.headers['set-cookie'], undefined);
  assert.deepEqual(fs.readFileSync(f.credentialsFile), credentialBytes);
  assert.deepEqual(fs.readFileSync(f.sessionsFile), sessionBytes);
  f.retention();
});
