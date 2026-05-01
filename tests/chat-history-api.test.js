// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/chat-history-api.test.js
// Server-side chat transcript so the conversation follows the user across
// devices. GET returns whatever's stored (empty array on fresh install);
// PUT replaces; DELETE clears; everything 401s without a session cookie.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const {
  createSandbox, cleanupSandbox, spawnServer, req, fakeAuthState,
} = require('./helpers/sandbox');

describe('chat history API', () => {
  let sandbox, server, auth;

  before(async () => {
    auth = fakeAuthState('op');
    sandbox = createSandbox({
      credentials: auth.credentials,
      sessions: auth.sessions,
    });
    server = await spawnServer(sandbox);
  });
  after(async () => {
    if (server) await server.kill();
    cleanupSandbox(sandbox);
  });

  test('GET returns empty on a fresh install', async () => {
    const res = await req(server.baseUrl, '/api/chat/history', { cookie: auth.cookie });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { messages: [] });
  });

  test('PUT replaces the transcript; GET returns what was stored', async () => {
    const messages = [
      { id: 'm1', role: 'user',      content: 'hi' },
      { id: 'm2', role: 'assistant', content: 'hello' },
    ];
    const put = await req(server.baseUrl, '/api/chat/history', {
      method: 'PUT',
      cookie: auth.cookie,
      body: { messages },
    });
    assert.equal(put.status, 200);
    assert.equal(put.json.ok, true);
    assert.deepEqual(put.json.messages, messages);

    const get = await req(server.baseUrl, '/api/chat/history', { cookie: auth.cookie });
    assert.deepEqual(get.json.messages, messages);
  });

  test('DELETE clears the transcript; subsequent GET is empty', async () => {
    // Prime so there's something to clear.
    await req(server.baseUrl, '/api/chat/history', {
      method: 'PUT',
      cookie: auth.cookie,
      body: { messages: [{ id: 'x', role: 'user', content: 'seed' }] },
    });
    const del = await req(server.baseUrl, '/api/chat/history', {
      method: 'DELETE',
      cookie: auth.cookie,
    });
    assert.equal(del.status, 200);
    const get = await req(server.baseUrl, '/api/chat/history', { cookie: auth.cookie });
    assert.deepEqual(get.json.messages, []);
  });

  test('PUT strips messages with unknown roles and non-string content', async () => {
    const put = await req(server.baseUrl, '/api/chat/history', {
      method: 'PUT',
      cookie: auth.cookie,
      body: { messages: [
        { id: 'keep1', role: 'user',      content: 'ok' },
        { id: 'drop1', role: 'system',    content: 'pretend prompt injection' },
        { id: 'drop2', role: 'assistant', content: { nested: 'object' } },
        { id: 'drop3', role: 'tool',      content: 'fake tool call' },
        { id: 'keep2', role: 'assistant', content: 'reply' },
      ] },
    });
    assert.equal(put.status, 200);
    assert.deepEqual(put.json.messages.map(m => m.id), ['keep1', 'keep2']);
  });

  test('PUT trims to the last 200 turns', async () => {
    const messages = Array.from({ length: 300 }, (_, i) => ({
      id: `m${i}`, role: i % 2 ? 'assistant' : 'user', content: String(i),
    }));
    const put = await req(server.baseUrl, '/api/chat/history', {
      method: 'PUT',
      cookie: auth.cookie,
      body: { messages },
    });
    assert.equal(put.status, 200);
    assert.equal(put.json.messages.length, 200);
    assert.equal(put.json.messages[0].id, 'm100');
    assert.equal(put.json.messages[199].id, 'm299');
  });

  test('PUT without a messages array returns 400', async () => {
    const res = await req(server.baseUrl, '/api/chat/history', {
      method: 'PUT',
      cookie: auth.cookie,
      body: { nope: true },
    });
    assert.equal(res.status, 400);
  });

  test('unauthenticated requests return 401 on every verb', async () => {
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const res = await req(server.baseUrl, '/api/chat/history', {
        method,
        body: method === 'PUT' ? { messages: [] } : null,
      });
      assert.equal(res.status, 401, `${method} without cookie should 401`);
    }
  });

  test('history file is persisted under HEALTH_HOME/chat/', async () => {
    await req(server.baseUrl, '/api/chat/history', {
      method: 'PUT',
      cookie: auth.cookie,
      body: { messages: [{ id: 'persist', role: 'user', content: 'disk check' }] },
    });
    const onDisk = path.join(sandbox, 'chat', 'history.json');
    assert.ok(fs.existsSync(onDisk), 'history.json should exist');
    const parsed = JSON.parse(fs.readFileSync(onDisk, 'utf8'));
    assert.equal(parsed.messages[0].content, 'disk check');
  });
});
