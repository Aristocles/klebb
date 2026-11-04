'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

const AUTH_FILE = require.resolve('../auth/webauthn');

// These tests own the auth seam. SDK and policy collaborators are controlled;
// genuine SQL principal production and private scope capabilities are tested
// separately. Registration still uses the real auth handler and saved files.
function setup(t, { knownPrincipal = true, bootstrap = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'membership-'));
  const credentialsFile = path.join(directory, 'credentials.json');
  const sessionsFile = path.join(directory, 'sessions.json');
  const sessionToken = '1'.repeat(64);
  const initialCredential = {
    id: 'existing-key',
    publicKey: Buffer.from('original public key').toString('base64'),
    counter: 0,
  };
  const verifiedCredential = {
    id: 'added-key',
    publicKey: new Uint8Array(Buffer.from('added public key')),
    counter: 0,
  };
  const initialCredentials = bootstrap ? { users: {} } : {
    users: {
      member: { credentials: [initialCredential] },
      other: { credentials: [{
        id: 'other-key', publicKey: Buffer.from('other public key').toString('base64'), counter: 0,
      }] },
    },
  };
  fs.writeFileSync(credentialsFile, JSON.stringify(initialCredentials));
  fs.writeFileSync(sessionsFile, JSON.stringify(bootstrap ? {} : {
    [sessionToken]: {
      created: Date.now(), lastSeen: Date.now(),
      userId: 'member', credentialId: initialCredential.id,
    },
  }));

  const context = {
    credentialsFile, sessionsFile, sessionToken, initialCredential, verifiedCredential,
    knownPrincipal, events: [], associations: [], invites: new Map(),
    beforeOptionsReturn: null, beforeAttestationReturn: null,
    attestationVerified: true, bindFailure: false, actor: null, auth: null,
  };
  const failure = (status, code) => Object.assign(new Error(code), { status, code });
  const currentMember = req => {
    const session = context.auth.getSessionRecord(req);
    if (!session) return null;
    const credential = context.auth.loadCredentials().users[session.userId]?.credentials
      ?.find(item => item.id === session.credentialId);
    return credential ? { session, credential } : null;
  };
  const checkActor = (custody, req) => {
    assert.equal(custody, context.actor?.custody);
    const current = currentMember(req);
    if (!current) throw failure(401, 'unauthorised');
    const actor = context.actor;
    if (req.headers.cookie !== actor.cookie ||
        current.session.created !== actor.created ||
        current.session.userId !== actor.userId ||
        current.session.credentialId !== actor.credentialId ||
        current.credential.publicKey !== actor.publicKey) {
      throw failure(403, 'scope-mismatch');
    }
    return current;
  };
  const policy = {
    captureRegistrationActor(req) {
      context.events.push('capture');
      const current = currentMember(req);
      if (!current) return null;
      const custody = Object.freeze({});
      context.actor = {
        custody, cookie: req.headers.cookie, created: current.session.created,
        userId: current.session.userId, credentialId: current.session.credentialId,
        publicKey: current.credential.publicKey,
      };
      return custody;
    },
    verifyRegistrationActor(custody, req) {
      context.events.push('verify');
      checkActor(custody, req);
    },
    bindRegisteredCredential(custody, req, credential) {
      context.events.push('bind');
      checkActor(custody, req);
      const saved = context.auth.loadCredentials().users[context.actor.userId]?.credentials
        ?.find(item => item.id === credential.id);
      assert.ok(saved, 'the verified credential must already be saved');
      assert.equal(saved.publicKey, Buffer.from(credential.publicKey).toString('base64'));
      if (context.bindFailure) throw failure(503, 'storage-unavailable');
      if (context.knownPrincipal) {
        context.associations.push({
          principal: 'established-principal',
          credentialId: credential.id,
          publicKey: saved.publicKey,
        });
      }
    },
  };
  const sdk = {
    async generateRegistrationOptions() {
      context.events.push('options-sdk');
      if (context.beforeOptionsReturn) await context.beforeOptionsReturn();
      return { challenge: 'registration-challenge' };
    },
    async verifyRegistrationResponse() {
      context.events.push('attestation-sdk');
      if (context.beforeAttestationReturn) await context.beforeAttestationReturn();
      return {
        verified: context.attestationVerified,
        registrationInfo: context.attestationVerified ? { credential: verifiedCredential } : undefined,
      };
    },
    async generateAuthenticationOptions() { return { challenge: 'login-challenge' }; },
    async verifyAuthenticationResponse() {
      return { verified: true, authenticationInfo: { newCounter: 1 } };
    },
  };
  const originalLoad = Module._load;
  const originalSetTimeout = global.setTimeout;
  const timers = new Set();
  Module._load = function(request, parent, isMain) {
    if (parent?.filename === AUTH_FILE) {
      if (request === '@simplewebauthn/server') return sdk;
      if (request === '../config/paths') return {
        WEBAUTHN_CREDENTIALS_FILE: credentialsFile,
        WEBAUTHN_SESSIONS_FILE: sessionsFile,
      };
      if (request === '../config/env') return {
        WEBAUTHN_RP_NAME: 'Example', WEBAUTHN_RP_ID: 'example.test',
        WEBAUTHN_ORIGIN: 'https://example.test', KLEBB_DEMO: false, KLEBB_CLOUD: false,
      };
      if (request === './invites') return {
        validateInvite: code => context.invites.get(code) || null,
        consumeInvite: code => context.invites.delete(code),
        recordAuthEvent() {},
      };
      if (request === '../lib/health-connect/source-policy') return policy;
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  global.setTimeout = (callback, delay, ...args) => {
    const timer = originalSetTimeout(callback, delay, ...args);
    if (delay === 120000) {
      timers.add(timer);
      timer.unref();
    }
    return timer;
  };
  t.after(() => {
    Module._load = originalLoad;
    global.setTimeout = originalSetTimeout;
    for (const timer of timers) clearTimeout(timer);
    delete require.cache[AUTH_FILE];
    fs.rmSync(directory, { recursive: true, force: true });
  });
  delete require.cache[AUTH_FILE];
  context.auth = require(AUTH_FILE);

  context.request = async (pathname, payload, token = sessionToken) => {
    const req = new EventEmitter();
    req.method = 'POST';
    req.url = pathname;
    req.headers = {
      host: 'example.test', origin: 'https://example.test',
      cookie: token ? `klebb_session=${token}` : '',
    };
    req.socket = {};
    const response = { status: null, headers: {}, body: null };
    const res = {
      setHeader(name, value) { response.headers[name.toLowerCase()] = value; },
      writeHead(status, headers) {
        response.status = status;
        for (const [name, value] of Object.entries(headers || {})) {
          response.headers[name.toLowerCase()] = value;
        }
      },
      end(body) { response.body = JSON.parse(body); },
    };
    const pending = context.auth.handleAuthRoutes(req, res, pathname);
    queueMicrotask(() => {
      req.emit('data', JSON.stringify(payload));
      req.emit('end');
    });
    await pending;
    return response;
  };
  return context;
}

test('AUTH01: authenticated add-passkey carries custody and binds only the saved verified credential', async t => {
  const context = setup(t);
  const options = await context.request('/auth/register/options', {});
  assert.equal(options.status, 200);
  const result = await context.request('/auth/register/verify', { label: 'member' });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { verified: true, label: 'member' });
  assert.deepEqual(context.associations, [{
    principal: 'established-principal', credentialId: 'added-key',
    publicKey: Buffer.from(context.verifiedCredential.publicKey).toString('base64'),
  }]);
  assert.ok(context.events.indexOf('capture') < context.events.indexOf('options-sdk'));
  assert.ok(context.events.indexOf('verify') > context.events.indexOf('options-sdk'));
  assert.ok(context.events.lastIndexOf('verify') > context.events.indexOf('attestation-sdk'));
  assert.ok(context.events.indexOf('bind') > context.events.lastIndexOf('verify'));
});

test('AUTH02: loss of the issuing session during options generation denies registration', async t => {
  const context = setup(t);
  const before = fs.readFileSync(context.credentialsFile);
  context.beforeOptionsReturn = async () => {
    fs.writeFileSync(context.sessionsFile, '{}');
  };
  const result = await context.request('/auth/register/options', {});
  assert.equal(result.status, 401);
  assert.deepEqual(fs.readFileSync(context.credentialsFile), before);
  assert.deepEqual(context.associations, []);
  assert.equal((await context.request('/auth/register/verify', { label: 'member' })).status, 400);
});

test('AUTH03: credential deletion during attestation refuses before storing a new credential', async t => {
  const context = setup(t);
  assert.equal((await context.request('/auth/register/options', {})).status, 200);
  let afterDeletion;
  context.beforeAttestationReturn = async () => {
    assert.equal(context.auth.deleteCredentialForUser('member', 'existing-key').ok, true);
    afterDeletion = fs.readFileSync(context.credentialsFile);
  };
  const result = await context.request('/auth/register/verify', { label: 'member' });
  assert.equal(result.status, 401);
  assert.deepEqual(fs.readFileSync(context.credentialsFile), afterDeletion);
  assert.deepEqual(context.associations, []);
  assert.equal(result.headers['set-cookie'], undefined);
});

test('AUTH04: another current credential under the same label cannot adopt pending custody', async t => {
  const context = setup(t);
  assert.equal((await context.request('/auth/register/options', {})).status, 200);
  const credentials = context.auth.loadCredentials();
  credentials.users.member.credentials.push({
    id: 'replacement-key', publicKey: Buffer.from('replacement public key').toString('base64'), counter: 0,
  });
  context.auth.saveCredentials(credentials);
  const replacementToken = '2'.repeat(64);
  fs.writeFileSync(context.sessionsFile, JSON.stringify({
    [replacementToken]: {
      created: Date.now(), lastSeen: Date.now(), userId: 'member', credentialId: 'replacement-key',
    },
  }));
  const before = fs.readFileSync(context.credentialsFile);
  const result = await context.request('/auth/register/verify', { label: 'member' }, replacementToken);
  assert.equal(result.status, 403);
  assert.deepEqual(fs.readFileSync(context.credentialsFile), before);
  assert.deepEqual(context.associations, []);
  assert.equal(context.events.includes('attestation-sdk'), false);
});

test('AUTH05: invite registration does not adopt an unrelated authenticated principal', async t => {
  const context = setup(t);
  context.invites.set('sample-invite', { label: 'invited' });
  assert.equal((await context.request('/auth/register/options', { code: 'sample-invite' })).status, 200);
  const result = await context.request('/auth/register/verify', { label: 'invited' });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { verified: true, label: 'invited' });
  assert.equal(context.auth.loadCredentials().users.invited.credentials[0].id, 'added-key');
  assert.equal(context.events.includes('capture'), false);
  assert.equal(context.events.includes('bind'), false);
  assert.deepEqual(context.associations, []);
});

test('AUTH06: self-hosted bootstrap retains registration without adopting policy ownership', async t => {
  const context = setup(t, { bootstrap: true });
  assert.equal((await context.request('/auth/register/options', { label: 'first' }, null)).status, 200);
  const result = await context.request('/auth/register/verify', { label: 'first' }, null);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { verified: true, label: 'first' });
  assert.equal(context.events.includes('capture'), false);
  assert.equal(context.events.includes('bind'), false);
  assert.deepEqual(context.associations, []);
});

test('AUTH07: an authenticated legacy member gains a passkey without invented principal continuity', async t => {
  const context = setup(t, { knownPrincipal: false });
  assert.equal((await context.request('/auth/register/options', {})).status, 200);
  const result = await context.request('/auth/register/verify', { label: 'member' });
  assert.equal(result.status, 200);
  assert.equal(context.auth.loadCredentials().users.member.credentials.length, 2);
  assert.deepEqual(context.associations, []);
});

test('AUTH08: association failure after save retains the credential without a success grant', async t => {
  const context = setup(t);
  assert.equal((await context.request('/auth/register/options', {})).status, 200);
  context.bindFailure = true;
  const result = await context.request('/auth/register/verify', { label: 'member' });
  assert.equal(result.status, 503);
  assert.ok(context.auth.loadCredentials().users.member.credentials.some(item => item.id === 'added-key'));
  assert.deepEqual(context.associations, []);
  assert.equal(result.headers['set-cookie'], undefined);
  const repeated = await context.request('/auth/register/verify', { label: 'member' });
  assert.equal(repeated.status, 400);
  assert.equal(context.events.filter(event => event === 'bind').length, 1);
});

test('AUTH09: failed attestation preserves credentials and never binds policy membership', async t => {
  const context = setup(t);
  assert.equal((await context.request('/auth/register/options', {})).status, 200);
  const before = fs.readFileSync(context.credentialsFile);
  context.attestationVerified = false;
  const result = await context.request('/auth/register/verify', { label: 'member' });
  assert.equal(result.status, 400);
  assert.deepEqual(fs.readFileSync(context.credentialsFile), before);
  assert.equal(context.events.includes('bind'), false);
  assert.deepEqual(context.associations, []);
});
