// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/chat-debug-logs.test.js
// Coverage for env-gated forensic logging on the chat agent loop (#303).
// With HEALTH_DEBUG=1 the /api/chat path emits structured [chat:<reqId>]
// lines: start, per-iter gateway timing, per-tool dispatch, and done.
// With HEALTH_DEBUG unset, no [chat: lines appear (existing error-only
// behaviour is preserved).

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { createSandbox, cleanupSandbox, spawnServer, req } = require('./helpers/sandbox');

function startStubGateway() {
  const responseQueue = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', c => { body += c; });
    request.on('end', () => {
      const next = responseQueue.shift();
      if (!next) {
        response.writeHead(500, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: 'stub queue exhausted' }));
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(next));
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        port,
        close: () => new Promise(r => server.close(r)),
        pushResponses: (rs) => rs.forEach(r => responseQueue.push(r)),
      });
    });
  });
}

function toolCallResponse({ name, args, id = 'call_1' }) {
  return {
    choices: [{
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id,
          type: 'function',
          function: { name, arguments: JSON.stringify(args) },
        }],
      },
    }],
  };
}

function stopResponse(content) {
  return {
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }],
  };
}

// Capture both stdout and stderr from a spawned server. Returns a getter
// that resolves the buffered text, plus a clear() to reset between tests.
function captureOutput(proc) {
  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', c => { stdout += c.toString(); });
  proc.stderr.on('data', c => { stderr += c.toString(); });
  return {
    stdout: () => stdout,
    stderr: () => stderr,
    clear: () => { stdout = ''; stderr = ''; },
    // Wait briefly for any in-flight log writes to flush before reading.
    settle: () => new Promise(r => setTimeout(r, 50)),
  };
}

describe('chat agent-loop debug logging (HEALTH_DEBUG=1)', () => {
  let sandbox, server, gateway, capture;

  before(async () => {
    gateway = await startStubGateway();
    sandbox = createSandbox();
    server = await spawnServer(sandbox, {
      CHAT_ENDPOINT_URL: `http://127.0.0.1:${gateway.port}/v1/chat/completions`,
      CHAT_API_KEY: 'stub-token',
      CHAT_MODEL: 'stub-model',
      HEALTH_DEBUG: '1',
    });
    capture = captureOutput(server.proc);
    capture.clear();
  });
  after(async () => {
    if (server) await server.kill();
    if (gateway) await gateway.close();
    cleanupSandbox(sandbox);
  });

  test('emits start / iter / tool / done lines for a tool-using turn', async () => {
    const manifest = {
      $schema: 'klebb.datafile.v1',
      meta: { id: 'log-test-a', label: 'Log Test A' },
      data: [],
    };
    gateway.pushResponses([
      toolCallResponse({ name: 'create_manifest', args: { manifest }, id: 'call_log_a' }),
      stopResponse('Done.'),
    ]);

    const res = await req(server.baseUrl, '/api/chat', {
      method: 'POST',
      body: { messages: [{ role: 'user', content: 'Create Log Test A.' }] },
    });
    assert.equal(res.status, 200);
    await capture.settle();

    const out = capture.stdout();
    const startMatch = out.match(/\[chat:([0-9a-f]+)\] start turns=1 voice=false/);
    assert.ok(startMatch, `expected [chat:<id>] start line; got:\n${out}`);
    const reqId = startMatch[1];

    const iter0 = new RegExp(`\\[chat:${reqId}\\] iter=0 gw=\\d+ms finish=tool_calls tools=1`);
    assert.match(out, iter0, 'expected iter=0 line with finish=tool_calls tools=1');

    const tool = new RegExp(`\\[chat:${reqId}\\] tool create_manifest id=log-test-a took=\\d+ms ok`);
    assert.match(out, tool, 'expected tool dispatch line with manifest id and ok');

    const iter1 = new RegExp(`\\[chat:${reqId}\\] iter=1 gw=\\d+ms finish=stop tools=0`);
    assert.match(out, iter1, 'expected iter=1 line with finish=stop');

    const done = new RegExp(`\\[chat:${reqId}\\] done total=\\d+ms iters=2 capped=false`);
    assert.match(out, done, 'expected done line with iters=2 capped=false');
  });

  test('does not log message bodies, prompts, or tool args', async () => {
    capture.clear();
    const secret = 'SECRET_PROMPT_TOKEN_X9Q';
    const manifest = {
      $schema: 'klebb.datafile.v1',
      meta: { id: 'log-test-b', label: 'Log Test B' },
      data: [{ note: secret }],
    };
    gateway.pushResponses([
      toolCallResponse({ name: 'create_manifest', args: { manifest }, id: 'call_log_b' }),
      stopResponse('Done with ' + secret),
    ]);

    const res = await req(server.baseUrl, '/api/chat', {
      method: 'POST',
      body: { messages: [{ role: 'user', content: secret + ' please' }] },
    });
    assert.equal(res.status, 200);
    await capture.settle();

    const both = capture.stdout() + capture.stderr();
    assert.ok(!both.includes(secret),
      `log output must not contain prompt/reply bodies; found ${secret} in:\n${both}`);
  });
});

describe('chat agent-loop debug logging (HEALTH_DEBUG unset)', () => {
  let sandbox, server, gateway, capture;

  before(async () => {
    gateway = await startStubGateway();
    sandbox = createSandbox();
    server = await spawnServer(sandbox, {
      CHAT_ENDPOINT_URL: `http://127.0.0.1:${gateway.port}/v1/chat/completions`,
      CHAT_API_KEY: 'stub-token',
      CHAT_MODEL: 'stub-model',
      // HEALTH_DEBUG deliberately omitted
    });
    capture = captureOutput(server.proc);
    capture.clear();
  });
  after(async () => {
    if (server) await server.kill();
    if (gateway) await gateway.close();
    cleanupSandbox(sandbox);
  });

  test('emits no [chat: lines on success path', async () => {
    gateway.pushResponses([stopResponse('Hello.')]);
    const res = await req(server.baseUrl, '/api/chat', {
      method: 'POST',
      body: { messages: [{ role: 'user', content: 'Hi.' }] },
    });
    assert.equal(res.status, 200);
    await capture.settle();

    const both = capture.stdout() + capture.stderr();
    assert.ok(!/\[chat:/.test(both),
      `expected no [chat: lines without HEALTH_DEBUG; got:\n${both}`);
  });
});
