// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/chat-detached-turns.test.js
// Detached turn execution (#602): a conversation turn is a server-side job
// that survives its client. iOS suspends a backgrounded tab and aborts its
// fetches; the reply must land in the conversation anyway, and a client
// that comes back mid-turn must be able to reattach to the live event
// stream, replaying what it missed by event id. One turn per conversation:
// a concurrent send is refused BEFORE its message is persisted.

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { createSandbox, cleanupSandbox, spawnServer, req } = require('./helpers/sandbox');

function startScriptedGateway() {
  const queue = [];
  let calls = 0;
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', c => { body += c; });
    request.on('end', () => {
      calls += 1;
      const n = calls;
      const spec = queue.shift() || { content: 'stub queue exhausted', finish: 'stop' };
      const send = () => {
        if (spec.status) {
          response.writeHead(spec.status, { 'Content-Type': 'application/json' });
          response.end(spec.body || '{}');
          return;
        }
        const message = { role: 'assistant', content: spec.content || '' };
        if (spec.toolName) {
          message.tool_calls = [{
            id: `call_${n}`, type: 'function',
            function: { name: spec.toolName, arguments: JSON.stringify(spec.toolArgs || {}) },
          }];
        }
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ finish_reason: spec.finish, message }] }));
      };
      if (spec.delayMs) setTimeout(send, spec.delayMs);
      else send();
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        get calls() { return calls; },
        push(...specs) { queue.push(...specs); },
        reset() { queue.length = 0; calls = 0; },
        close: () => new Promise(r => server.close(r)),
      });
    });
  });
}

function parseFrame(frame) {
  let event = 'message';
  let id = null;
  const dataLines = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith(':') || !line.trim()) continue;
    if (line.startsWith('id:')) id = Number.parseInt(line.slice(3).trim(), 10);
    else if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (!dataLines.length) return null;
  return { event, id, data: JSON.parse(dataLines.join('\n')) };
}

// Raw SSE client: collects events as they arrive and can kill the socket
// after N events, which is exactly what a backgrounded phone does.
function sseCollect(baseUrl, path, { method = 'GET', body = null, destroyAfter = null, headers = {} } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (out) => { if (!settled) { settled = true; resolve(out); } };
    const url = new URL(path, baseUrl);
    const r = http.request(url, { method, headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
      if (res.statusCode === 204) return finish({ status: 204, events: [] });
      let buf = '';
      const events = [];
      res.setEncoding('utf8');
      res.on('data', (c) => {
        buf += c;
        let sep;
        while ((sep = buf.indexOf('\n\n')) !== -1) {
          const ev = parseFrame(buf.slice(0, sep));
          buf = buf.slice(sep + 2);
          if (ev) events.push(ev);
          if (destroyAfter && events.length >= destroyAfter) {
            r.destroy();
            return finish({ status: res.statusCode, events, destroyed: true });
          }
        }
      });
      res.on('end', () => finish({ status: res.statusCode, events }));
      res.on('aborted', () => finish({ status: res.statusCode, events, destroyed: true }));
    });
    r.on('error', () => finish({ status: 0, events: [], errored: true }));
    r.setTimeout(15000, () => { r.destroy(); });
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

async function waitFor(fn, { timeout = 6000, interval = 50 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error('waitFor timed out');
    await new Promise(r => setTimeout(r, interval));
  }
}

describe('#602 detached conversation turns', () => {
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

  const newConvo = async () => {
    const res = await req(server.baseUrl, '/api/conversations', { method: 'POST', body: { title: 't' } });
    return res.json.conversation;
  };
  const getConvo = async (id) => (await req(server.baseUrl, `/api/conversations/${id}`)).json?.conversation;

  test('a concurrent send is refused before its message is persisted', async () => {
    gateway.push({ content: 'first done', finish: 'stop', delayMs: 600 });
    const convo = await newConvo();
    const first = req(server.baseUrl, '/api/chat', {
      method: 'POST', body: { conversationId: convo.id, messages: [{ role: 'user', content: 'first' }] },
    });
    await new Promise(r => setTimeout(r, 150));
    const second = await req(server.baseUrl, '/api/chat', {
      method: 'POST', body: { conversationId: convo.id, messages: [{ role: 'user', content: 'second' }] },
    });
    assert.equal(second.status, 409, 'one turn at a time per conversation');
    const firstRes = await first;
    assert.equal(firstRes.status, 200);
    const after = await getConvo(convo.id);
    assert.deepEqual(after.messages.map(m => m.content), ['first', 'first done'],
      'the refused send must leave no trace in the transcript');
  });

  test('a client that dies mid-turn still gets its reply persisted, and can reattach', async () => {
    gateway.push(
      { toolName: 'list_manifests', toolArgs: {}, finish: 'tool_calls', delayMs: 200 },
      { content: 'Survived the disconnect', finish: 'stop', delayMs: 300 },
    );
    const convo = await newConvo();
    const dropped = await sseCollect(server.baseUrl, '/api/chat', {
      method: 'POST',
      body: { conversationId: convo.id, messages: [{ role: 'user', content: 'long job' }], stream: true },
      destroyAfter: 1,
    });
    assert.equal(dropped.destroyed, true, 'the client really did vanish mid-turn');

    await waitFor(async () => {
      const c = await getConvo(convo.id);
      return c.messages.some(m => m.content === 'Survived the disconnect');
    });

    // Within the linger window the finished turn replays in full.
    const replay = await sseCollect(server.baseUrl, `/api/chat/turn/${convo.id}`);
    const names = replay.events.map(e => e.event);
    assert.ok(names.includes('status'), 'missed events replay');
    const reply = replay.events.find(e => e.event === 'reply');
    assert.equal(reply.data.reply, 'Survived the disconnect');
    assert.equal(names.at(-1), 'done');
    const ids = replay.events.map(e => e.id);
    assert.ok(ids.every((v, i) => i === 0 || v > ids[i - 1]), 'event ids are ordered for resume');
  });

  test('reattach with ?after=N replays only what was missed', async () => {
    gateway.push({ content: 'short answer', finish: 'stop' });
    const convo = await newConvo();
    await req(server.baseUrl, '/api/chat', {
      method: 'POST', body: { conversationId: convo.id, messages: [{ role: 'user', content: 'q' }] },
    });
    const full = await sseCollect(server.baseUrl, `/api/chat/turn/${convo.id}`);
    assert.ok(full.events.length >= 3, 'a buffered turn still records its events');
    const cutoff = full.events[0].id;
    const partial = await sseCollect(server.baseUrl, `/api/chat/turn/${convo.id}?after=${cutoff}`);
    assert.ok(partial.events.length < full.events.length, 'the replay honours the cursor');
    assert.ok(partial.events.every(e => e.id > cutoff), 'nothing at or before the cursor repeats');
  });

  test('no turn to attach to answers 204', async () => {
    const res = await sseCollect(server.baseUrl, '/api/chat/turn/never-existed');
    assert.equal(res.status, 204);
    assert.equal(res.events.length, 0);
  });

  test('a buffered conversation turn is live-attachable while it runs', async () => {
    gateway.push({ content: 'buffered but visible', finish: 'stop', delayMs: 500 });
    const convo = await newConvo();
    const turn = req(server.baseUrl, '/api/chat', {
      method: 'POST', body: { conversationId: convo.id, messages: [{ role: 'user', content: 'go' }] },
    });
    await new Promise(r => setTimeout(r, 150));
    const attached = await sseCollect(server.baseUrl, `/api/chat/turn/${convo.id}`);
    const turnRes = await turn;
    assert.equal(turnRes.status, 200);
    assert.equal(attached.events.find(e => e.event === 'reply')?.data.reply, 'buffered but visible',
      'an attached observer sees the buffered turn complete');
    assert.equal(attached.events.at(-1).event, 'done');
  });

  test('DELETE /api/chat/turn stops the loop, keeps the user message, releases the lock', async () => {
    for (let i = 0; i < 20; i++) {
      gateway.push({ toolName: 'list_manifests', toolArgs: {}, finish: 'tool_calls', delayMs: 200 });
    }
    const convo = await newConvo();
    const turn = req(server.baseUrl, '/api/chat', {
      method: 'POST', body: { conversationId: convo.id, messages: [{ role: 'user', content: 'spin' }] },
    });
    await new Promise(r => setTimeout(r, 350));
    const del = await req(server.baseUrl, `/api/chat/turn/${convo.id}`, { method: 'DELETE' });
    assert.equal(del.status, 200);

    const res = await turn;
    assert.equal(res.status, 200);
    assert.equal(res.json.stopped, true, 'a stopped turn says so instead of inventing a reply');

    const callsAtStop = gateway.calls;
    await new Promise(r => setTimeout(r, 500));
    assert.ok(gateway.calls <= callsAtStop + 1,
      `the loop must stop making round-trips after the abort (was ${callsAtStop}, now ${gateway.calls})`);

    const after = await getConvo(convo.id);
    assert.deepEqual(after.messages.map(m => m.role), ['user'],
      'the user message stays; no assistant reply is persisted');

    // Drop the leftover looping specs before the follow-up send, or it
    // consumes them and caps out instead of answering.
    gateway.reset();
    gateway.push({ content: 'fresh', finish: 'stop' });
    const next = await req(server.baseUrl, '/api/chat', {
      method: 'POST', body: { conversationId: convo.id, messages: [{ role: 'user', content: 'again' }] },
    });
    assert.equal(next.status, 200, 'the one-turn lock must release after a stop');
    assert.equal(next.json.reply, 'fresh');
  });

  test('DELETE with no running turn is a 404', async () => {
    const res = await req(server.baseUrl, '/api/chat/turn/nothing-here', { method: 'DELETE' });
    assert.equal(res.status, 404);
  });

  test('turns without a conversation are untouched by concurrency control', async () => {
    gateway.push(
      { content: 'a', finish: 'stop', delayMs: 200 },
      { content: 'b', finish: 'stop', delayMs: 200 },
    );
    const [a, b] = await Promise.all([
      req(server.baseUrl, '/api/chat', { method: 'POST', body: { messages: [{ role: 'user', content: '1' }] } }),
      req(server.baseUrl, '/api/chat', { method: 'POST', body: { messages: [{ role: 'user', content: '2' }] } }),
    ]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.ok(['a', 'b'].includes(a.json.reply) && ['a', 'b'].includes(b.json.reply));
  });
});
