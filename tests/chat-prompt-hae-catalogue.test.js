// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/chat-prompt-hae-catalogue.test.js
// Verifies the chat proxy injects the HAE catalogue's row shapes into the
// system prompt so the agent writes display templates matching the data
// the dispatcher actually emits. Mirrors the card-list injection test's
// stub-gateway pattern.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { createSandbox, cleanupSandbox, spawnServer, req } = require('./helpers/sandbox');

function startStubGateway() {
  let lastSystemPrompt = null;
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', c => { body += c; });
    request.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        const sys = parsed.messages?.find(m => m.role === 'system');
        lastSystemPrompt = sys?.content || null;
      } catch {}
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'ack' } }],
      }));
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        port,
        close: () => new Promise(r => server.close(r)),
        getLastPrompt: () => lastSystemPrompt,
      });
    });
  });
}

describe('chat proxy injects HAE catalogue into system prompt', () => {
  let sandbox, server, gateway;

  before(async () => {
    gateway = await startStubGateway();
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

  test('system prompt includes the catalogue block header', async () => {
    const res = await req(server.baseUrl, '/api/chat', {
      method: 'POST',
      body: { messages: [{ role: 'user', content: 'hello' }] },
    });
    assert.equal(res.status, 200);
    const prompt = gateway.getLastPrompt();
    assert.ok(prompt, 'stub gateway did not capture a prompt');
    assert.match(prompt, /Health Auto Export catalogue/);
  });

  test('system prompt lists specific catalogue metrics', async () => {
    await req(server.baseUrl, '/api/chat', {
      method: 'POST',
      body: { messages: [{ role: 'user', content: 'hello' }] },
    });
    const prompt = gateway.getLastPrompt();
    assert.match(prompt, /sleep_analysis/);
    assert.match(prompt, /step_count/);
    assert.match(prompt, /heart_rate_variability/);
    assert.match(prompt, /workouts/);
  });

  test('system prompt carries the "only use catalogue fields" rule', async () => {
    await req(server.baseUrl, '/api/chat', {
      method: 'POST',
      body: { messages: [{ role: 'user', content: 'hello' }] },
    });
    const prompt = gateway.getLastPrompt();
    assert.match(prompt, /only use fields/i);
    assert.match(prompt, /do not invent fields/i);
  });
});
