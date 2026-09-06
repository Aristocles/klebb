// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/gateway-max-tokens.test.js
// callGateway's max_tokens pass-through (#679): sent only when a caller
// states an integer ceiling, absent otherwise so the chat path keeps the
// gateway's own default.
//
// Pure transport test; no spawnServer in this file.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { callGateway } = require('../lib/gateway');

function startCapture() {
  const bodies = [];
  const server = http.createServer((request, response) => {
    let raw = '';
    request.on('data', c => { raw += c; });
    request.on('end', () => {
      bodies.push(JSON.parse(raw));
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      bodies,
      close: () => new Promise(r => server.close(r)),
    }));
  });
}

describe('#679 callGateway max_tokens pass-through', () => {
  let stub;
  before(async () => { stub = await startCapture(); });
  after(async () => { if (stub) await stub.close(); });

  const call = (extra = {}) => callGateway({
    messages: [{ role: 'user', content: 'hi' }],
    endpointUrl: `http://127.0.0.1:${stub.port}/v1/chat/completions`,
    apiKey: 'k', model: 'm', timeoutMs: 4000,
    ...extra,
  });

  test('an integer ceiling reaches the wire as max_tokens', async () => {
    await call({ maxTokens: 8000 });
    assert.equal(stub.bodies.at(-1).max_tokens, 8000);
  });

  test('no ceiling means no max_tokens key at all', async () => {
    await call();
    assert.equal('max_tokens' in stub.bodies.at(-1), false);
  });

  test('zero and non-integer ceilings are ignored, not sent', async () => {
    await call({ maxTokens: 0 });
    assert.equal('max_tokens' in stub.bodies.at(-1), false);
    await call({ maxTokens: 12.5 });
    assert.equal('max_tokens' in stub.bodies.at(-1), false);
  });
});
