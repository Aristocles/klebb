// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/chat-endpoint-url.test.js
// Verifies the chat proxy honours CHAT_ENDPOINT_URL as a plain URL: scheme
// picks http vs https, host/port come from the URL, path can be anything
// the operator points at (not just /v1/chat/completions).

const { test, describe, before, after } = require('node:test');
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

function startStubGateway(pathExpected) {
  const hits = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', c => { body += c; });
    request.on('end', () => {
      hits.push({
        url: request.url,
        auth: request.headers.authorization,
        body,
      });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'pong' } }],
      }));
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        close: () => new Promise(r => server.close(r)),
        hits,
        pathExpected,
      });
    });
  });
}

describe('chat endpoint — URL-driven routing', () => {
  let sandbox, server, gateway;

  before(async () => {
    gateway = await startStubGateway();
    sandbox = createSandbox({ seed: { 'w.json': makeCard('w') } });
    // Point at a non-standard path to prove the proxy honours whatever
    // path the operator gave, not a hardcoded /v1/chat/completions.
    server = await spawnServer(sandbox, {
      CHAT_ENDPOINT_URL: `http://127.0.0.1:${gateway.port}/custom/path`,
      CHAT_API_KEY: 'key-xyz',
      CHAT_MODEL: 'my-model',
    });
  });
  after(async () => {
    if (server) await server.kill();
    if (gateway) await gateway.close();
    cleanupSandbox(sandbox);
  });

  test('request lands on the URL path, with the configured model + bearer', async () => {
    const res = await req(server.baseUrl, '/api/chat', {
      method: 'POST',
      body: { messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json?.reply, 'pong');
    assert.equal(gateway.hits.length, 1);
    const hit = gateway.hits[0];
    assert.equal(hit.url, '/custom/path');
    assert.equal(hit.auth, 'Bearer key-xyz');
    const payload = JSON.parse(hit.body);
    assert.equal(payload.model, 'my-model');
  });
});

describe('chat endpoint — unconfigured returns 503', () => {
  let sandbox, server;

  before(async () => {
    sandbox = createSandbox({ seed: { 'w.json': makeCard('w') } });
    server = await spawnServer(sandbox, {
      CHAT_ENDPOINT_URL: '',
      CHAT_API_KEY: '',
      CHAT_MODEL: '',
    });
  });
  after(async () => {
    if (server) await server.kill();
    cleanupSandbox(sandbox);
  });

  test('POST /api/chat returns 503 with a clear error', async () => {
    const res = await req(server.baseUrl, '/api/chat', {
      method: 'POST',
      body: { messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.equal(res.status, 503);
    assert.match(res.json?.error || '', /not configured/i);
  });
});
