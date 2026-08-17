// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/chat-sse-stream.test.js
// The /api/chat streaming contract (#601). `stream: true` switches the
// response to server-sent events: status (loop phase + tool activity),
// token (assistant text fragments), reset (drop provisional text that
// turned out to precede tool calls), reply (the final payload,
// byte-identical in shape to the buffered JSON), error (same classified
// copy and would-have-been status as #547), done. The buffered path must
// be completely unchanged by the same request without the flag.
//
// The stub gateway speaks BOTH transports, keying off the stream flag in
// the request it receives, exactly like a real OpenAI-compatible gateway.

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { createSandbox, cleanupSandbox, spawnServer, req } = require('./helpers/sandbox');

function makeCard(id) {
  return {
    $schema: 'klebb.datafile.v1',
    meta: { id, label: id, emoji: '.', view: { enabled: true, component: 'generic-card' } },
    description: id,
    data: [],
  };
}

// Scripted stub gateway. Each queued spec is one round-trip's answer:
//   { content, finish: 'stop' }                        -> text reply
//   { content?, toolName, toolArgs, finish: 'tool_calls' } -> one tool call
//   { status, body }                                   -> HTTP error
// When the incoming request asked for a stream, the spec is rendered as SSE
// (content split into two fragments to prove reassembly); otherwise as the
// buffered JSON shape.
function startScriptedGateway() {
  const queue = [];
  let calls = 0;
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', c => { body += c; });
    request.on('end', () => {
      calls += 1;
      const wantsStream = (() => {
        try { return JSON.parse(body).stream === true; } catch { return false; }
      })();
      const spec = queue.shift() || { content: 'stub queue exhausted', finish: 'stop' };
      if (spec.status) {
        response.writeHead(spec.status, { 'Content-Type': 'application/json' });
        response.end(spec.body || '{}');
        return;
      }
      const toolCalls = spec.toolName ? [{
        id: `call_${calls}`, type: 'function',
        function: { name: spec.toolName, arguments: JSON.stringify(spec.toolArgs || {}) },
      }] : null;
      if (!wantsStream) {
        const message = { role: 'assistant', content: spec.content || '' };
        if (toolCalls) message.tool_calls = toolCalls;
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ finish_reason: spec.finish, message }] }));
        return;
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const frame = (obj) => response.write(`data: ${JSON.stringify(obj)}\n\n`);
      const content = spec.content || '';
      if (content) {
        const mid = Math.ceil(content.length / 2);
        frame({ choices: [{ delta: { role: 'assistant', content: content.slice(0, mid) } }] });
        frame({ choices: [{ delta: { content: content.slice(mid) } }] });
      }
      if (toolCalls) frame({ choices: [{ delta: { tool_calls: toolCalls.map((tc, i) => ({ index: i, ...tc })) } }] });
      frame({ choices: [{ delta: {}, finish_reason: spec.finish }] });
      response.write('data: [DONE]\n\n');
      response.end();
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

// The whole event stream arrives before `req` resolves (the server ends the
// response after `done`), so events parse straight out of the body text.
function parseSse(text) {
  const events = [];
  for (const frame of text.split('\n\n')) {
    let event = 'message';
    const dataLines = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith(':') || !line.trim()) continue;
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length) events.push({ event, data: JSON.parse(dataLines.join('\n')) });
  }
  return events;
}

describe('#601 /api/chat streams server-sent events', () => {
  let sandbox, server, gateway;

  before(async () => {
    gateway = await startScriptedGateway();
    sandbox = createSandbox({ seed: { 'w.json': makeCard('w') } });
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

  const ask = (body) => req(server.baseUrl, '/api/chat', { method: 'POST', body });

  test('happy path: status, tokens that concatenate to the reply, reply, done', async () => {
    gateway.push({ content: 'Hello there', finish: 'stop' });
    const res = await ask({ messages: [{ role: 'user', content: 'hi' }], stream: true });
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'] || '', /text\/event-stream/);
    const events = parseSse(res.body);
    const names = events.map(e => e.event);
    assert.deepEqual(names, ['status', 'token', 'token', 'reply', 'done']);
    assert.deepEqual(events[0].data, { phase: 'thinking' });
    const tokens = events.filter(e => e.event === 'token').map(e => e.data.text).join('');
    const reply = events.find(e => e.event === 'reply').data;
    assert.equal(tokens, 'Hello there', 'tokens must reassemble to the full text');
    assert.equal(reply.reply, 'Hello there', 'the reply event carries the same payload as buffered JSON');
    assert.equal(reply.capped, undefined);
  });

  test('a tool round-trip surfaces tool activity as status events', async () => {
    gateway.push(
      { toolName: 'list_manifests', toolArgs: {}, finish: 'tool_calls' },
      { content: 'You have one card.', finish: 'stop' },
    );
    const res = await ask({ messages: [{ role: 'user', content: 'what cards?' }], stream: true });
    const events = parseSse(res.body);
    const toolStatus = events.find(e => e.event === 'status' && e.data.phase === 'tool');
    assert.ok(toolStatus, 'tool execution must be visible on the stream');
    assert.equal(toolStatus.data.tool, 'list_manifests');
    assert.equal(events.find(e => e.event === 'reply').data.reply, 'You have one card.');
    assert.equal(events.at(-1).event, 'done');
    assert.equal(gateway.calls, 2);
  });

  test('commentary before tool calls is retracted with a reset event', async () => {
    gateway.push(
      { content: 'Let me check that.', toolName: 'list_manifests', toolArgs: {}, finish: 'tool_calls' },
      { content: 'Done.', finish: 'stop' },
    );
    const res = await ask({ messages: [{ role: 'user', content: 'check' }], stream: true });
    const events = parseSse(res.body);
    const names = events.map(e => e.event);
    const resetIdx = names.indexOf('reset');
    assert.ok(resetIdx !== -1, 'provisional text must be retracted before tool statuses');
    assert.ok(names.slice(0, resetIdx).includes('token'), 'the reset must follow the tokens it retracts');
    assert.equal(events.find(e => e.event === 'reply').data.reply, 'Done.');
  });

  test('voice mode streams no tokens but still shows status and speaks', async () => {
    gateway.push({ content: '{"speak":"One card.","display":"You have **one** card."}', finish: 'stop' });
    const res = await ask({ messages: [{ role: 'user', content: 'cards?' }], stream: true, voiceMode: true });
    const events = parseSse(res.body);
    assert.ok(!events.some(e => e.event === 'token'),
      'a JSON voice envelope must never be streamed as visible tokens');
    assert.ok(events.some(e => e.event === 'status'));
    const reply = events.find(e => e.event === 'reply').data;
    assert.equal(reply.speak, 'One card.');
    assert.equal(reply.reply, 'You have **one** card.');
  });

  test('a mid-turn gateway failure becomes an error event with the #547 copy', async () => {
    gateway.push({ status: 429, body: JSON.stringify({ error: { message: 'Budget has been exceeded! Key=k' } }) });
    const res = await ask({ messages: [{ role: 'user', content: 'hi' }], stream: true });
    assert.equal(res.status, 200, 'the stream is already open; the status rides the error event');
    const events = parseSse(res.body);
    const err = events.find(e => e.event === 'error');
    assert.ok(err, 'failures must be an event, not a dropped connection');
    assert.equal(err.data.status, 429);
    assert.match(err.data.error, /allowance/i);
    assert.equal(events.at(-1).event, 'done', 'the stream still terminates cleanly');
  });

  test('a capped turn carries capped:true on the reply event', async () => {
    for (let i = 0; i < 20; i++) gateway.push({ toolName: 'list_manifests', toolArgs: {}, finish: 'tool_calls' });
    const capped = await spawnServer(sandbox, {
      CHAT_ENDPOINT_URL: `http://127.0.0.1:${gateway.port}/v1/chat/completions`,
      CHAT_API_KEY: 'k', CHAT_MODEL: 'm', CHAT_MAX_TURNS: '2',
    });
    try {
      const res = await req(capped.baseUrl, '/api/chat', {
        method: 'POST', body: { messages: [{ role: 'user', content: 'spin' }], stream: true },
      });
      const reply = parseSse(res.body).find(e => e.event === 'reply').data;
      assert.equal(reply.capped, true);
      assert.match(reply.reply, /keep going/i);
    } finally {
      await capped.kill();
    }
  });

  test('the buffered path is unchanged without the flag', async () => {
    gateway.push({ content: 'plain', finish: 'stop' });
    const res = await ask({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'] || '', /application\/json/);
    assert.equal(res.json.reply, 'plain');
  });
});

describe('#601 demo mode streams its canned reply', () => {
  let sandbox, server, cookie;
  before(async () => {
    sandbox = createSandbox();
    server = await spawnServer(sandbox, { KLEBB_DEMO: '1' });
    const login = await req(server.baseUrl, '/auth/demo-login', { method: 'POST' });
    const setCookie = login.headers['set-cookie'];
    cookie = Array.isArray(setCookie) ? setCookie[0].split(';')[0] : null;
  });
  after(async () => {
    if (server) await server.kill();
    cleanupSandbox(sandbox);
  });

  test('reply + done, no outbound gateway needed', async () => {
    const res = await req(server.baseUrl, '/api/chat', {
      method: 'POST', body: { messages: [{ role: 'user', content: 'hi' }], stream: true }, cookie,
    });
    assert.equal(res.status, 200);
    const events = parseSse(res.body);
    assert.deepEqual(events.map(e => e.event), ['reply', 'done']);
    assert.ok(events[0].data.reply.length > 0);
  });
});
