// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/api/issue-399.test.js
// Regression seed for #399: chat agent must fail fast with a refusal reply
// when no available tool fits the user's request, instead of letting the
// gateway sit on the call until the 180s hard ceiling fires. We can't
// trigger the model's "fudge it through write_manifest_data" path from a
// stub, but we CAN drive the same outcome: a hanging gateway response
// past the soft per-iter budget. The agent loop must convert that into
// a 200 response carrying the standard refusal copy, not a 504.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { systemMessageText } = require('../../chat/system-prompt');
const {
  createSandbox, cleanupSandbox, spawnServer, req,
} = require('../helpers/sandbox');

// Stub gateway that NEVER replies to the first request and replies
// normally on every subsequent one. Lets us simulate a single iteration
// that runs past the soft cap.
function startHangingGateway() {
  let hangNext = false;
  let firstHeld = null;
  const responseQueue = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', c => { body += c; });
    request.on('end', () => {
      if (hangNext) {
        hangNext = false;
        firstHeld = response;
        return;
      }
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
        close: () => new Promise(r => {
          if (firstHeld && !firstHeld.writableEnded) {
            try { firstHeld.destroy(); } catch {}
          }
          server.close(r);
        }),
        hangNext: () => { hangNext = true; },
        pushResponse: (r) => responseQueue.push(r),
      });
    });
  });
}

describe('#399 chat: iter-timeout returns refusal in <10s, not 504', () => {
  let sandbox, server, gateway;

  before(async () => {
    gateway = await startHangingGateway();
    sandbox = createSandbox();
    server = await spawnServer(sandbox, {
      CHAT_ENDPOINT_URL: `http://127.0.0.1:${gateway.port}/v1/chat/completions`,
      CHAT_API_KEY: 'stub-token',
      CHAT_MODEL: 'stub-model',
      CHAT_ITER_TIMEOUT_MS: '500',
    });
  });
  after(async () => {
    if (server) await server.kill();
    if (gateway) await gateway.close();
    cleanupSandbox(sandbox);
  });

  test('hung first iter -> refusal reply, 200 status, in well under 10s', async () => {
    gateway.hangNext();
    const t0 = Date.now();
    const res = await req(server.baseUrl, '/api/chat', {
      method: 'POST',
      body: { messages: [{ role: 'user', content: 'reorder the rows in peptides' }] },
    });
    const elapsed = Date.now() - t0;
    assert.equal(res.status, 200, 'iter timeout must surface as 200 with a refusal, not 504');
    assert.ok(res.json.reply, 'response must carry a reply field');
    // #600 re-worded this path: a timeout now names its real cause instead
    // of borrowing the no-tool-fits refusal (which taught users a capability
    // was missing). The fail-fast intent of #399 is unchanged.
    assert.match(
      res.json.reply,
      /too long/i,
      'reply should name the timeout'
    );
    assert.doesNotMatch(
      res.json.reply,
      /doesn't fit any of the tools/i,
      'a timeout must not be misdescribed as a capability gap (#600)'
    );
    assert.ok(elapsed < 10000, `must return in <10s; got ${elapsed}ms`);
  });
});

describe('#399 chat: system prompt instructs fail-fast refusal', () => {
  let sandbox, server, gateway, lastPrompt;

  before(async () => {
    lastPrompt = null;
    gateway = await new Promise(resolve => {
      const srv = http.createServer((request, response) => {
        let body = '';
        request.on('data', c => { body += c; });
        request.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            const sys = parsed.messages?.find(m => m.role === 'system');
            lastPrompt = systemMessageText(sys);
          } catch {}
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({
            choices: [{ message: { role: 'assistant', content: 'ack' } }],
          }));
        });
      });
      srv.listen(0, '127.0.0.1', () => resolve({
        port: srv.address().port,
        close: () => new Promise(r => srv.close(r)),
      }));
    });
    sandbox = createSandbox();
    server = await spawnServer(sandbox, {
      CHAT_ENDPOINT_URL: `http://127.0.0.1:${gateway.port}/v1/chat/completions`,
      CHAT_API_KEY: 'stub-token',
      CHAT_MODEL: 'stub-model',
    });
  });
  after(async () => {
    if (server) await server.kill();
    if (gateway) await gateway.close();
    cleanupSandbox(sandbox);
  });

  test('system prompt names the no-tool-fits refusal pattern', async () => {
    const res = await req(server.baseUrl, '/api/chat', {
      method: 'POST',
      body: { messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.equal(res.status, 200);
    assert.ok(lastPrompt, 'stub captured a system prompt');
    assert.ok(
      /When no tool fits/i.test(lastPrompt),
      'prompt must contain the no-tool-fits section header'
    );
    assert.ok(
      /refuse fast/i.test(lastPrompt),
      'prompt must steer toward fast refusal'
    );
    assert.ok(
      /can't do that in one step/i.test(lastPrompt),
      'prompt must include the standard refusal template'
    );
  });
});
