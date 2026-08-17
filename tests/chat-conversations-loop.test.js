// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/chat-conversations-loop.test.js
// /api/chat with a conversationId (#603): the server owns the transcript.
// The incoming messages are just the new turn, persisted before the loop
// runs (a failed turn still shows the user's message); the loop is fed a
// character-budgeted window over the stored transcript instead of whatever
// the client resent; the shaped reply is appended after the turn; and an
// untitled conversation gets a model-generated title from an async
// side-call that never blocks the turn.

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { createSandbox, cleanupSandbox, spawnServer, req } = require('./helpers/sandbox');

// Scripted stub gateway that also records each request's messages, so the
// context-window assertions can inspect exactly what the loop forwarded.
function startScriptedGateway() {
  const queue = [];
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', c => { body += c; });
    request.on('end', () => {
      try { requests.push(JSON.parse(body)); } catch { requests.push(null); }
      const spec = queue.shift() || { content: 'stub queue exhausted', finish: 'stop' };
      if (spec.status) {
        response.writeHead(spec.status, { 'Content-Type': 'application/json' });
        response.end(spec.body || '{}');
        return;
      }
      const message = { role: 'assistant', content: spec.content || '' };
      if (spec.toolName) {
        message.tool_calls = [{
          id: `call_${requests.length}`, type: 'function',
          function: { name: spec.toolName, arguments: JSON.stringify(spec.toolArgs || {}) },
        }];
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ finish_reason: spec.finish, message }] }));
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        requests,
        get calls() { return requests.length; },
        push(...specs) { queue.push(...specs); },
        reset() { queue.length = 0; requests.length = 0; },
        close: () => new Promise(r => server.close(r)),
      });
    });
  });
}

async function waitFor(fn, { timeout = 4000, interval = 50 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error('waitFor timed out');
    await new Promise(r => setTimeout(r, interval));
  }
}

describe('#603 /api/chat with a conversationId', () => {
  let sandbox, server, gateway;

  before(async () => {
    gateway = await startScriptedGateway();
    sandbox = createSandbox();
    server = await spawnServer(sandbox, {
      CHAT_ENDPOINT_URL: `http://127.0.0.1:${gateway.port}/v1/chat/completions`,
      CHAT_API_KEY: 'k',
      CHAT_MODEL: 'm',
    });
  });
  after(async () => {
    if (server) await server.kill();
    if (gateway) await gateway.close();
    cleanupSandbox(sandbox);
  });
  beforeEach(() => gateway.reset());

  const newConvo = async (body = {}) => {
    const res = await req(server.baseUrl, '/api/conversations', { method: 'POST', body });
    return res.json.conversation;
  };
  const getConvo = async (id) => {
    const res = await req(server.baseUrl, `/api/conversations/${id}`);
    return res.json?.conversation;
  };
  const turn = (conversationId, content, extra = {}) => req(server.baseUrl, '/api/chat', {
    method: 'POST',
    body: { conversationId, messages: [{ role: 'user', content }], ...extra },
  });

  test('both sides of the turn land in the conversation', async () => {
    gateway.push({ content: 'Hello back', finish: 'stop' });
    const convo = await newConvo({ title: 'Fixed title' });
    const res = await turn(convo.id, 'hello');
    assert.equal(res.status, 200);
    assert.equal(res.json.reply, 'Hello back');
    const after = await getConvo(convo.id);
    assert.deepEqual(after.messages.map(m => [m.role, m.content]), [
      ['user', 'hello'],
      ['assistant', 'Hello back'],
    ]);
  });

  test('an untitled conversation gets a model title after the first exchange', async () => {
    gateway.push(
      { content: 'Weight logged.', finish: 'stop' },
      { content: '"Weight tracking"', finish: 'stop' },
    );
    const convo = await newConvo();
    assert.equal(convo.title, null, 'starts untitled, so the wait below is not vacuous');
    const res = await turn(convo.id, 'log my weight as 80kg');
    assert.equal(res.status, 200);
    const title = await waitFor(async () => (await getConvo(convo.id)).title);
    assert.equal(title, 'Weight tracking', 'quotes stripped, model wording kept');
    assert.equal(gateway.calls, 2, 'exactly one side-call beyond the turn');
  });

  test('a titled conversation never triggers the side-call', async () => {
    gateway.push({ content: 'ok', finish: 'stop' });
    const convo = await newConvo({ title: 'Already named' });
    await turn(convo.id, 'hi');
    await new Promise(r => setTimeout(r, 500));
    assert.equal(gateway.calls, 1, 'no title call for a titled conversation');
    assert.equal((await getConvo(convo.id)).title, 'Already named');
  });

  test('the loop gets a windowed transcript, not the whole history', async () => {
    gateway.push({ content: 'ok', finish: 'stop' });
    const convo = await newConvo({ title: 't' });
    const bulk = Array.from({ length: 30 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user',
      content: `msg${i}:` + 'x'.repeat(2000),
    }));
    await req(server.baseUrl, `/api/conversations/${convo.id}/messages`, {
      method: 'PUT', body: { messages: bulk },
    });
    await turn(convo.id, 'newest question');
    const sent = gateway.requests[0].messages;
    const history = sent.filter(m => m.role !== 'system');
    assert.equal(history.at(-1).content, 'newest question', 'the new turn always goes through');
    assert.ok(!history.some(m => m.content.startsWith('msg0:')),
      'the oldest history must be windowed out');
    const chars = history.reduce((n, m) => n + m.content.length, 0);
    assert.ok(chars <= 25000, `forwarded history must respect the budget (got ${chars})`);
    assert.ok(history.length >= 5, 'the window is a budget, not an amputation');
    assert.ok(!history.some(m => 'followupText' in m || 'hasVoice' in m || 'id' in m),
      'stored extras never reach the gateway');
  });

  test('an unknown conversationId is a 404 before any gateway call', async () => {
    const res = await turn('does-not-exist', 'hi');
    assert.equal(res.status, 404);
    assert.equal(gateway.calls, 0);
  });

  test('a failed turn still keeps the user message', async () => {
    gateway.push({ status: 429, body: JSON.stringify({ error: { message: 'Budget has been exceeded! Key=k' } }) });
    const convo = await newConvo({ title: 't' });
    const res = await turn(convo.id, 'doomed question');
    assert.equal(res.status, 429);
    const after = await getConvo(convo.id);
    assert.deepEqual(after.messages.map(m => [m.role, m.content]), [['user', 'doomed question']],
      'the user message survives; no assistant message is invented');
  });

  test('voice replies persist their speak affordance', async () => {
    gateway.push({ content: '{"speak":"Done.","display":"All **done**."}', finish: 'stop' });
    const convo = await newConvo({ title: 't' });
    const res = await turn(convo.id, 'log it', { voiceMode: true });
    assert.equal(res.json.speak, 'Done.');
    const after = await getConvo(convo.id);
    const reply = after.messages.at(-1);
    assert.equal(reply.content, 'All **done**.', 'the display text is what persists');
    assert.equal(reply.hasVoice, true);
  });

  test('a capped reply persists its capped flag for the reload-continue affordance', async () => {
    const cappedServer = await spawnServer(sandbox, {
      CHAT_ENDPOINT_URL: `http://127.0.0.1:${gateway.port}/v1/chat/completions`,
      CHAT_API_KEY: 'k', CHAT_MODEL: 'm', CHAT_MAX_TURNS: '2',
    });
    try {
      for (let i = 0; i < 10; i++) gateway.push({ toolName: 'list_manifests', toolArgs: {}, finish: 'tool_calls' });
      const created = await req(cappedServer.baseUrl, '/api/conversations', { method: 'POST', body: { title: 't' } });
      const id = created.json.conversation.id;
      const res = await req(cappedServer.baseUrl, '/api/chat', {
        method: 'POST', body: { conversationId: id, messages: [{ role: 'user', content: 'spin' }] },
      });
      assert.equal(res.json.capped, true);
      const after = await req(cappedServer.baseUrl, `/api/conversations/${id}`);
      assert.equal(after.json.conversation.messages.at(-1).capped, true);
    } finally {
      await cappedServer.kill();
    }
  });

  test('turns without a conversationId leave the store untouched', async () => {
    gateway.push({ content: 'plain', finish: 'stop' });
    const beforeList = (await req(server.baseUrl, '/api/conversations')).json.conversations.length;
    const res = await req(server.baseUrl, '/api/chat', {
      method: 'POST', body: { messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.equal(res.json.reply, 'plain');
    const afterList = (await req(server.baseUrl, '/api/conversations')).json.conversations.length;
    assert.equal(afterList, beforeList, 'the legacy path must not grow conversations');
  });
});
