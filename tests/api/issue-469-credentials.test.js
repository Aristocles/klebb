// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/api/issue-469-credentials.test.js
// Regression seed for #469 — the passkey management API. Covers GET
// /api/credentials (scoped list, non-sensitive fields, current-device flag),
// DELETE /api/credentials/:id (by id, last-credential guard, session
// invalidation), and the auth gate on both.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const {
  createSandbox,
  cleanupSandbox,
  spawnServer,
  req,
  sessionCookie,
} = require('../helpers/sandbox');

function cred(id, extra = {}) {
  const now = new Date().toISOString();
  return {
    id,
    publicKey: 'pk-' + id,
    counter: 0,
    deviceType: 'platform',
    nickname: null,
    registeredAt: now,
    lastUsedAt: now,
    ...extra,
  };
}

// Build an auth state where `user` holds two credentials and the session is
// bound to the first (so it is the "current device").
function twoCredState(label = 'user') {
  const token = crypto.randomBytes(32).toString('hex');
  const idA = 'aaa-' + crypto.randomBytes(6).toString('hex');
  const idB = 'bbb-' + crypto.randomBytes(6).toString('hex');
  return {
    idA, idB, token,
    cookie: sessionCookie(token),
    credentials: {
      users: {
        [label]: { credentials: [cred(idA, { nickname: 'Phone' }), cred(idB, { nickname: 'Laptop' })] },
      },
    },
    sessions: {
      [token]: { created: Date.now(), lastSeen: Date.now(), userId: label, credentialId: idA },
    },
  };
}

describe('#469 GET /api/credentials', () => {
  let sandbox, server, auth;

  before(async () => {
    auth = twoCredState();
    sandbox = createSandbox({ credentials: auth.credentials, sessions: auth.sessions });
    server = await spawnServer(sandbox);
  });
  after(async () => {
    if (server) await server.kill();
    if (sandbox) cleanupSandbox(sandbox);
  });

  test('lists the current user credentials with public fields only', async () => {
    const r = await req(server.baseUrl, '/api/credentials', { cookie: auth.cookie });
    assert.equal(r.status, 200);
    assert.equal(r.json.credentials.length, 2);
    const byId = Object.fromEntries(r.json.credentials.map(c => [c.id, c]));
    assert.equal(byId[auth.idA].nickname, 'Phone');
    assert.equal(byId[auth.idB].nickname, 'Laptop');
    for (const c of r.json.credentials) {
      assert.ok('deviceType' in c && 'registeredAt' in c && 'lastUsedAt' in c);
      assert.equal(c.publicKey, undefined, 'must never leak publicKey');
      assert.equal(c.counter, undefined, 'must never leak counter');
    }
  });

  test('flags the session credential as the current device', async () => {
    const r = await req(server.baseUrl, '/api/credentials', { cookie: auth.cookie });
    const current = r.json.credentials.filter(c => c.isCurrentDevice);
    assert.equal(current.length, 1);
    assert.equal(current[0].id, auth.idA);
  });

  test('without a session returns 401', async () => {
    const r = await req(server.baseUrl, '/api/credentials');
    assert.equal(r.status, 401);
  });
});

describe('#469 DELETE /api/credentials/:id', () => {
  let sandbox, server, auth;

  before(async () => {
    auth = twoCredState();
    sandbox = createSandbox({ credentials: auth.credentials, sessions: auth.sessions });
    server = await spawnServer(sandbox);
  });
  after(async () => {
    if (server) await server.kill();
    if (sandbox) cleanupSandbox(sandbox);
  });

  test('without a session returns 401', async () => {
    const r = await req(server.baseUrl, `/api/credentials/${auth.idB}`, { method: 'DELETE' });
    assert.equal(r.status, 401);
  });

  test('unknown id returns 404', async () => {
    const r = await req(server.baseUrl, '/api/credentials/does-not-exist', {
      method: 'DELETE', cookie: auth.cookie,
    });
    assert.equal(r.status, 404);
  });

  test('removes a non-last credential and it disappears from the list', async () => {
    const del = await req(server.baseUrl, `/api/credentials/${auth.idB}`, {
      method: 'DELETE', cookie: auth.cookie,
    });
    assert.equal(del.status, 200);
    assert.equal(del.json.id, auth.idB);

    const list = await req(server.baseUrl, '/api/credentials', { cookie: auth.cookie });
    assert.equal(list.json.credentials.length, 1);
    assert.equal(list.json.credentials[0].id, auth.idA);
  });

  test('refuses to remove the last remaining credential (409)', async () => {
    // Only idA remains after the previous test.
    const r = await req(server.baseUrl, `/api/credentials/${auth.idA}`, {
      method: 'DELETE', cookie: auth.cookie,
    });
    assert.equal(r.status, 409);
    // Still there.
    const list = await req(server.baseUrl, '/api/credentials', { cookie: auth.cookie });
    assert.equal(list.json.credentials.length, 1);
  });
});

describe('#469 DELETE invalidates the removed device session', () => {
  let sandbox, server, auth;

  before(async () => {
    // Two credentials, each with its own live session. Deleting idB while
    // authenticated as idA must kill idB's session.
    const label = 'user';
    const tokenA = crypto.randomBytes(32).toString('hex');
    const tokenB = crypto.randomBytes(32).toString('hex');
    const idA = 'aaa-' + crypto.randomBytes(6).toString('hex');
    const idB = 'bbb-' + crypto.randomBytes(6).toString('hex');
    auth = {
      idA, idB, cookieA: sessionCookie(tokenA), cookieB: sessionCookie(tokenB),
      credentials: { users: { [label]: { credentials: [cred(idA), cred(idB)] } } },
      sessions: {
        [tokenA]: { created: Date.now(), lastSeen: Date.now(), userId: label, credentialId: idA },
        [tokenB]: { created: Date.now(), lastSeen: Date.now(), userId: label, credentialId: idB },
      },
    };
    sandbox = createSandbox({ credentials: auth.credentials, sessions: auth.sessions });
    server = await spawnServer(sandbox);
  });
  after(async () => {
    if (server) await server.kill();
    if (sandbox) cleanupSandbox(sandbox);
  });

  test('idB session is rejected after idB credential is deleted', async () => {
    // idB session works beforehand.
    const before = await req(server.baseUrl, '/api/credentials', { cookie: auth.cookieB });
    assert.equal(before.status, 200);

    const del = await req(server.baseUrl, `/api/credentials/${auth.idB}`, {
      method: 'DELETE', cookie: auth.cookieA,
    });
    assert.equal(del.status, 200);

    // idB session is now invalid.
    const after = await req(server.baseUrl, '/api/credentials', { cookie: auth.cookieB });
    assert.equal(after.status, 401);
    // idA session still works.
    const stillA = await req(server.baseUrl, '/api/credentials', { cookie: auth.cookieA });
    assert.equal(stillA.status, 200);
  });
});
