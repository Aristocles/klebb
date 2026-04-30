// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/chat-proxy-reset.test.js
// Regression: if the chat gateway sends a complete response and then RSTs the
// TCP socket, the proxy must still deliver the reply to the client and must
// not crash the server by trying to write a 502 on an already-ended response.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const net = require('net');
const { createSandbox, cleanupSandbox, spawnServer, req } = require('./helpers/sandbox');

function startResetGateway() {
  const body = JSON.stringify({
    choices: [{ message: { role: 'assistant', content: 'ack' } }],
  });
  const server = net.createServer((socket) => {
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk.toString('binary');
      const headerEnd = buf.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const headers = buf.slice(0, headerEnd);
      const m = headers.match(/Content-Length:\s*(\d+)/i);
      const need = m ? parseInt(m[1], 10) : 0;
      const have = Buffer.byteLength(buf.slice(headerEnd + 4), 'binary');
      if (have < need) return;
      const response =
        'HTTP/1.1 200 OK\r\n' +
        'Content-Type: application/json\r\n' +
        `Content-Length: ${Buffer.byteLength(body)}\r\n` +
        'Connection: close\r\n' +
        '\r\n' +
        body;
      socket.write(response, () => {
        // Force a TCP RST after the response bytes are flushed. This is the
        // exact shape observed live: gateway returns 200 + body then the
        // socket is reset, firing 'error' on the client's ClientRequest.
        try { socket.resetAndDestroy(); }
        catch { socket.destroy(); }
      });
    });
    socket.on('error', () => {});
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function makeCard(id) {
  return {
    $schema: 'klebb.datafile.v1',
    meta: { id, label: id, emoji: '.', view: { enabled: true, component: 'generic-card' } },
    description: id,
    data: [],
  };
}

describe('chat proxy survives upstream RST after successful response', () => {
  let sandbox, server, gateway;

  before(async () => {
    gateway = await startResetGateway();
    sandbox = createSandbox({ seed: { 'w.json': makeCard('w') } });
    server = await spawnServer(sandbox, {
      CHAT_GATEWAY_HOST: '127.0.0.1',
      CHAT_GATEWAY_PORT: String(gateway.port),
      CHAT_GATEWAY_TLS: 'false',
      CHAT_GATEWAY_TOKEN: 'stub',
      CHAT_GATEWAY_MODEL: 'stub',
    });
  });
  after(async () => {
    if (server) await server.kill();
    if (gateway) await gateway.close();
    cleanupSandbox(sandbox);
  });

  test('client receives reply and server stays up after upstream RST', async () => {
    const res = await req(server.baseUrl, '/api/chat', {
      method: 'POST',
      body: { messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json?.reply, 'ack');

    // Server is still alive on a follow-up request.
    await new Promise((r) => setTimeout(r, 100));
    const res2 = await req(server.baseUrl, '/api/chat', {
      method: 'POST',
      body: { messages: [{ role: 'user', content: 'again' }] },
    });
    assert.equal(res2.status, 200);
    assert.equal(res2.json?.reply, 'ack');
  });
});
