// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/conversations-api.test.js
// The /api/conversations HTTP contract (#603): CRUD over the datastore-
// backed conversations, behind the same session gate as the rest of /api.
// The legacy /api/chat/history endpoint must keep working untouched until
// the client cutover.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const { createSandbox, cleanupSandbox, spawnServer, req } = require('./helpers/sandbox');

describe('#603 /api/conversations CRUD', () => {
  let sandbox, server;

  before(async () => {
    sandbox = createSandbox();
    server = await spawnServer(sandbox);
  });
  after(async () => {
    if (server) await server.kill();
    cleanupSandbox(sandbox);
  });

  test('create, list, fetch, rename, replace messages, delete', async () => {
    const created = await req(server.baseUrl, '/api/conversations', {
      method: 'POST', body: { title: 'Weight setup' },
    });
    assert.equal(created.status, 201);
    const id = created.json.conversation.id;
    assert.ok(id, 'create returns an id');
    assert.equal(created.json.conversation.title, 'Weight setup');

    const list = await req(server.baseUrl, '/api/conversations');
    assert.equal(list.status, 200);
    assert.ok(list.json.conversations.some(c => c.id === id));

    const put = await req(server.baseUrl, `/api/conversations/${id}/messages`, {
      method: 'PUT',
      body: {
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'hello', hasVoice: true, junk: 'dropped' },
        ],
      },
    });
    assert.equal(put.status, 200);

    const got = await req(server.baseUrl, `/api/conversations/${id}`);
    assert.equal(got.status, 200);
    assert.equal(got.json.conversation.messages.length, 2);
    assert.equal(got.json.conversation.messages[1].hasVoice, true);
    assert.equal(got.json.conversation.messages[1].junk, undefined, 'sanitisation applies at the API');

    const rename = await req(server.baseUrl, `/api/conversations/${id}`, {
      method: 'PATCH', body: { title: 'Renamed' },
    });
    assert.equal(rename.status, 200);
    const afterRename = await req(server.baseUrl, `/api/conversations/${id}`);
    assert.equal(afterRename.json.conversation.title, 'Renamed');

    const del = await req(server.baseUrl, `/api/conversations/${id}`, { method: 'DELETE' });
    assert.equal(del.status, 200);
    const gone = await req(server.baseUrl, `/api/conversations/${id}`);
    assert.equal(gone.status, 404);
  });

  test('unknown ids are 404s on every verb', async () => {
    for (const call of [
      req(server.baseUrl, '/api/conversations/nope'),
      req(server.baseUrl, '/api/conversations/nope', { method: 'PATCH', body: { title: 't' } }),
      req(server.baseUrl, '/api/conversations/nope', { method: 'DELETE' }),
      req(server.baseUrl, '/api/conversations/nope/messages', { method: 'PUT', body: { messages: [] } }),
    ]) {
      assert.equal((await call).status, 404);
    }
  });

  test('malformed bodies are 400s, not crashes', async () => {
    const badCreate = await req(server.baseUrl, '/api/conversations', {
      method: 'POST', body: 'not json',
    });
    assert.equal(badCreate.status, 400);

    const created = await req(server.baseUrl, '/api/conversations', { method: 'POST' });
    const id = created.json.conversation.id;
    const badPatch = await req(server.baseUrl, `/api/conversations/${id}`, {
      method: 'PATCH', body: { nope: true },
    });
    assert.equal(badPatch.status, 400);
    const badPut = await req(server.baseUrl, `/api/conversations/${id}/messages`, {
      method: 'PUT', body: { messages: 'not an array' },
    });
    assert.equal(badPut.status, 400);
  });

  test('an oversized messages body is refused with 413', async () => {
    const created = await req(server.baseUrl, '/api/conversations', { method: 'POST' });
    const id = created.json.conversation.id;
    const big = 'x'.repeat(600 * 1024);
    const res = await req(server.baseUrl, `/api/conversations/${id}/messages`, {
      method: 'PUT', body: { messages: [{ role: 'user', content: big }] },
    });
    assert.equal(res.status, 413);
  });

  test('POST /api/conversations/search filters on title and message text (#659)', async () => {
    // Start from a known set: earlier tests in this file leave rows behind.
    const before = await req(server.baseUrl, '/api/conversations');
    for (const c of before.json.conversations) {
      await req(server.baseUrl, `/api/conversations/${c.id}`, { method: 'DELETE' });
    }
    await req(server.baseUrl, '/api/conversations', {
      method: 'POST',
      body: { title: 'Bloods panel', messages: [{ role: 'user', content: 'ferritin at 40' }] },
    });
    await req(server.baseUrl, '/api/conversations', {
      method: 'POST',
      body: { title: 'Sleep notes', messages: [{ role: 'assistant', content: 'try magnesium' }] },
    });

    const byText = await req(server.baseUrl, '/api/conversations/search', {
      method: 'POST', body: { q: 'magnesium' },
    });
    assert.equal(byText.status, 200);
    assert.deepEqual(byText.json.conversations.map(c => c.title), ['Sleep notes']);
    assert.match(byText.json.conversations[0].snippet, /magnesium/);

    const byTitle = await req(server.baseUrl, '/api/conversations/search', {
      method: 'POST', body: { q: 'bloods' },
    });
    assert.deepEqual(byTitle.json.conversations.map(c => c.title), ['Bloods panel']);
    assert.equal(byTitle.json.conversations[0].snippet, undefined, 'a title hit has no snippet');

    const none = await req(server.baseUrl, '/api/conversations/search', {
      method: 'POST', body: { q: 'nothing here matches' },
    });
    assert.deepEqual(none.json.conversations, []);

    const all = await req(server.baseUrl, '/api/conversations/search', {
      method: 'POST', body: { q: '' },
    });
    assert.equal(all.json.conversations.length, 2, 'an empty needle is the whole list');
  });

  test('search refuses a malformed body and tolerates a missing one (#659)', async () => {
    const bad = await req(server.baseUrl, '/api/conversations/search', {
      method: 'POST', body: 'not json',
    });
    assert.equal(bad.status, 400);
    const empty = await req(server.baseUrl, '/api/conversations/search', { method: 'POST' });
    assert.equal(empty.status, 200);
    assert.ok(Array.isArray(empty.json.conversations));
    const wrongType = await req(server.baseUrl, '/api/conversations/search', {
      method: 'POST', body: { q: { nope: true } },
    });
    assert.equal(wrongType.status, 200, 'a non-string needle reads as no needle');
  });

  test('the legacy /api/chat/history endpoint is untouched', async () => {
    const put = await req(server.baseUrl, '/api/chat/history', {
      method: 'PUT', body: { messages: [{ role: 'user', content: 'legacy' }] },
    });
    assert.equal(put.status, 200);
    const get = await req(server.baseUrl, '/api/chat/history');
    assert.equal(get.status, 200);
    assert.equal(get.json.messages[0].content, 'legacy');
  });
});
