// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/chat-viewed-card.test.js
// Verifies the chat proxy injects a "Card in focus" block into the system
// prompt when the client passes viewedCardId, and leaves the prompt unchanged
// when it is absent or unknown.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { createSandbox, cleanupSandbox, spawnServer, req } = require('./helpers/sandbox');
const { systemMessageText } = require('../chat/system-prompt');

function makeCard(id, label) {
  return {
    $schema: 'klebb.datafile.v1',
    meta: { id, label, emoji: '⚖️', view: { enabled: true, component: 'generic-card' } },
    description: 'test card',
    data: [{ date: '2026-04-20', kg: 85 }],
  };
}

function startStubGateway() {
  let lastSystemPrompt = null;
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', c => { body += c; });
    request.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        lastSystemPrompt = systemMessageText(parsed.messages?.find(m => m.role === 'system'));
      } catch {}
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ack' } }] }));
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      close: () => new Promise(r => server.close(r)),
      getLastPrompt: () => lastSystemPrompt,
    }));
  });
}

describe('chat proxy: viewed-card immediate context', () => {
  let sandbox, server, gateway;

  before(async () => {
    gateway = await startStubGateway();
    sandbox = createSandbox({ seed: { 'weight.json': makeCard('weight', 'Body Weight') } });
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

  test('injects a Card in focus block when viewedCardId resolves', async () => {
    const res = await req(server.baseUrl, '/api/chat', {
      method: 'POST',
      body: { messages: [{ role: 'user', content: 'change it to 80' }], viewedCardId: 'weight' },
    });
    assert.equal(res.status, 200);
    const sp = gateway.getLastPrompt();
    assert.ok(sp.includes('Card in focus'), 'prompt has the focus header');
    assert.ok(sp.includes('Body Weight'), 'prompt names the focused card label');
    assert.ok(sp.includes('weight'), 'prompt names the focused card id');
  });

  test('omits the block when no viewedCardId is sent', async () => {
    const res = await req(server.baseUrl, '/api/chat', {
      method: 'POST',
      body: { messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.equal(res.status, 200);
    assert.ok(!gateway.getLastPrompt().includes('Card in focus'));
  });

  test('omits the block when viewedCardId is an unknown id (no injection of arbitrary text)', async () => {
    const res = await req(server.baseUrl, '/api/chat', {
      method: 'POST',
      body: { messages: [{ role: 'user', content: 'hi' }], viewedCardId: 'does-not-exist' },
    });
    assert.equal(res.status, 200);
    assert.ok(!gateway.getLastPrompt().includes('Card in focus'));
  });
});
