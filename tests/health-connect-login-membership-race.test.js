// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const { DatabaseSync } = require('node:sqlite');
const AUTH_FILE = require.resolve('../auth/webauthn');

// The real auth handler and saved credential/session lifecycle are exercised.
// Cryptographic verification is controlled; these are not real passkey tests.
function loginFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'login-membership-'));
  const credentialsFile = path.join(directory, 'credentials.json');
  const sessionsFile = path.join(directory, 'sessions.json');
  const policyFile = path.join(directory, 'health-connect-policy.json');
  const historyFile = path.join(directory, 'history.sqlite');
  const selected = { id: 'selected-login-key',
    publicKey: Buffer.from('selected fixture public key').toString('base64'), counter: 0 };
  const survivor = { id: 'surviving-login-key',
    publicKey: Buffer.from('surviving fixture public key').toString('base64'), counter: 7,
    nickname: 'Retained fixture device' };
  const selectedToken = '1'.repeat(64), survivorToken = '2'.repeat(64);
  fs.writeFileSync(credentialsFile, JSON.stringify({ users: {
    member: { credentials: [selected] }, survivor: { credentials: [survivor] },
  } }));
  const now = Date.now();
  fs.writeFileSync(sessionsFile, JSON.stringify({
    [selectedToken]: { userId: 'member', credentialId: selected.id, created: now, lastSeen: now },
    [survivorToken]: { userId: 'survivor', credentialId: survivor.id, created: now, lastSeen: now },
  }));
  // Retained UNKNOWN policy bytes are an immutability witness, not authority.
  fs.writeFileSync(policyFile, JSON.stringify({ version: 2, recoveryRequired: true,
    principals: [], namespaces: [] }));
  const schema = require('../lib/health-connect/schema');
  const db = new DatabaseSync(historyFile);
  try {
    for (const sql of Object.values(schema.nativeTables)) db.exec(sql);
    db.prepare('INSERT INTO health_schema_version(version) VALUES (1)').run();
    const tenant = '11111111-1111-4111-8111-111111111111';
    const source = '22222222-2222-4222-8222-222222222222';
    db.prepare('INSERT INTO health_tombstones VALUES (?,?,?,?,?,?)').run(tenant, source,
      'StepsRecord', 'retained-login-control', JSON.stringify([tenant,
        '33333333-3333-4333-8333-333333333333', source,
        '44444444-4444-4444-8444-444444444444', 'StepsRecord', '3',
        '55555555-5555-4555-8555-555555555555']), '7');
  } finally { db.close(); }
  const retainedPolicy = fs.readFileSync(policyFile);
  const retainedHistory = fs.readFileSync(historyFile);
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const released = new Promise(resolve => { release = resolve; });
  const context = { selected, survivor, selectedToken, survivorToken, credentialsFile,
    sessionsFile, policyFile, historyFile, entered, release, holdVerifier: false,
    verificationCalls: [], events: [], auth: null };
  const sdk = {
    async generateAuthenticationOptions(input) {
      assert.equal(input.userVerification, 'required');
      assert.deepEqual(input.allowCredentials.map(item => item.id), [selected.id, survivor.id]);
      return { challenge: 'literal-login-challenge' };
    },
    async verifyAuthenticationResponse(input) {
      context.verificationCalls.push(input);
      enter(input);
      if (context.holdVerifier) await released;
      return { verified: true, authenticationInfo: { newCounter: 1 } };
    },
  };
  const originalLoad = Module._load, originalSetTimeout = global.setTimeout;
  const timers = new Set();
  Module._load = function(request, parent, isMain) {
    if (parent?.filename === AUTH_FILE) {
      if (request === '@simplewebauthn/server') return sdk;
      if (request === '../config/paths') return {
        WEBAUTHN_CREDENTIALS_FILE: credentialsFile, WEBAUTHN_SESSIONS_FILE: sessionsFile,
        CREDENTIALS_DIR: directory, DB_FILE: historyFile,
      };
      if (request === '../config/env') return {
        WEBAUTHN_RP_NAME: 'Example', WEBAUTHN_RP_ID: 'example.test',
        WEBAUTHN_ORIGIN: 'https://example.test', KLEBB_DEMO: false, KLEBB_CLOUD: false,
      };
      if (request === './invites') return { recordAuthEvent(event) { context.events.push(event); } };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  global.setTimeout = (callback, delay, ...args) => {
    const timer = originalSetTimeout(callback, delay, ...args);
    if (delay === 120000) { timers.add(timer); timer.unref(); }
    return timer;
  };
  t.after(() => {
    context.release();
    Module._load = originalLoad; global.setTimeout = originalSetTimeout;
    for (const timer of timers) clearTimeout(timer);
    delete require.cache[AUTH_FILE];
    fs.rmSync(directory, { recursive: true, force: true });
  });
  delete require.cache[AUTH_FILE];
  context.auth = require(AUTH_FILE);
  context.request = async (pathname, payload = {}) => {
    const req = new EventEmitter();
    req.method = 'POST'; req.url = pathname;
    req.headers = { host: 'example.test', origin: 'https://example.test', cookie: '' };
    req.socket = {};
    const response = { status: null, headers: {}, body: null };
    const res = {
      setHeader(name, value) { response.headers[name.toLowerCase()] = value; },
      writeHead(status, headers) {
        response.status = status;
        for (const [name, value] of Object.entries(headers || {})) response.headers[name.toLowerCase()] = value;
      },
      end(body) { response.body = JSON.parse(body); },
    };
    const work = context.auth.handleAuthRoutes(req, res, pathname);
    queueMicrotask(() => { req.emit('data', JSON.stringify(payload)); req.emit('end'); });
    await work;
    assert.notEqual(response.status, null, 'the existing real auth handler must answer');
    return response;
  };
  context.retention = () => {
    assert.deepEqual(fs.readFileSync(policyFile), retainedPolicy);
    assert.deepEqual(fs.readFileSync(historyFile), retainedHistory);
  };
  return context;
}

test('LOGINMEMBER01 unchanged saved member still verifies and creates exactly one session', async t => {
  const f = loginFixture(t);
  const options = await f.request('/auth/login/options');
  assert.equal(options.status, 200);
  assert.equal(options.body.challenge, 'literal-login-challenge');
  const sessionsBefore = JSON.parse(fs.readFileSync(f.sessionsFile, 'utf8'));
  const response = await f.request('/auth/login/verify', { id: f.selected.id });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { verified: true, label: 'member' });
  assert.equal(f.verificationCalls.length, 1);
  assert.equal(f.verificationCalls[0].credential.id, f.selected.id);
  assert.deepEqual(f.verificationCalls[0].credential.publicKey, Buffer.from(f.selected.publicKey, 'base64'));
  assert.equal(f.verificationCalls[0].expectedChallenge, 'literal-login-challenge');
  assert.equal(typeof response.headers['set-cookie'], 'string');
  const saved = f.auth.loadCredentials();
  assert.equal(saved.users.member.credentials[0].counter, 1);
  assert.equal(typeof saved.users.member.credentials[0].lastUsedAt, 'string');
  assert.deepEqual(saved.users.survivor.credentials, [f.survivor]);
  const sessionsAfter = JSON.parse(fs.readFileSync(f.sessionsFile, 'utf8'));
  const added = Object.keys(sessionsAfter).filter(key => !Object.hasOwn(sessionsBefore, key));
  assert.equal(added.length, 1);
  assert.equal(sessionsAfter[added[0]].userId, 'member');
  assert.equal(sessionsAfter[added[0]].credentialId, f.selected.id);
  for (const key of Object.keys(sessionsBefore)) assert.deepEqual(sessionsAfter[key], sessionsBefore[key]);
  f.retention();
});

test('LOGINMEMBER02 deletion during pending verification cannot resurrect the selected member', async t => {
  const f = loginFixture(t);
  const options = await f.request('/auth/login/options');
  assert.equal(options.status, 200);
  assert.equal(options.body.challenge, 'literal-login-challenge');
  f.holdVerifier = true;
  let pending;
  try {
    pending = f.request('/auth/login/verify', { id: f.selected.id });
    const selectedInput = await f.entered;
    assert.equal(selectedInput.credential.id, f.selected.id);
    assert.deepEqual(selectedInput.credential.publicKey, Buffer.from(f.selected.publicKey, 'base64'));
    assert.equal(selectedInput.credential.counter, 0);
    assert.equal(selectedInput.expectedChallenge, 'literal-login-challenge');
    assert.deepEqual(f.auth.deleteCredentialForUser('member', f.selected.id),
      { ok: true, deletedId: f.selected.id });
    const credentialsAfterDelete = fs.readFileSync(f.credentialsFile);
    const sessionsAfterDelete = fs.readFileSync(f.sessionsFile);
    assert.deepEqual(f.auth.loadCredentials(), { users: { survivor: { credentials: [f.survivor] } } });
    assert.equal(Object.hasOwn(JSON.parse(sessionsAfterDelete), f.selectedToken), false);
    assert.equal(Object.hasOwn(JSON.parse(sessionsAfterDelete), f.survivorToken), true);
    f.release();
    const response = await pending;
    assert.equal(response.status, 400, 'a deleted selected member must refuse after successful pending verification');
    assert.deepEqual(response.body, { error: 'Unknown credential' });
    assert.equal(Object.hasOwn(response.headers, 'set-cookie'), false);
    assert.deepEqual(fs.readFileSync(f.credentialsFile), credentialsAfterDelete,
      'pending login must not restore the stale whole credential store');
    assert.deepEqual(fs.readFileSync(f.sessionsFile), sessionsAfterDelete,
      'pending login must not restore a deleted-member session or create a new session');
    assert.equal(f.events.some(event => event.kind === 'login.success'), false);
    assert.equal(f.verificationCalls.length, 1);
    f.retention();
  } finally {
    f.release();
    if (pending) await pending;
  }
});
