// tests/chat-prompt-cards.test.js
// Verifies the chat proxy injects the current card list into the system prompt
// so the model always knows what cards exist without a separate round-trip.
//
// We don't talk to a real chat gateway — we stub it with a tiny HTTP server
// that captures the request body and echoes the first system message back.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { createSandbox, cleanupSandbox, spawnServer, req } = require('./helpers/sandbox');

function makeCard(id, label, description) {
  return {
    $schema: 'klebb.datafile.v1',
    meta: {
      id,
      label,
      emoji: '⚖️',
      view: { enabled: true, component: 'generic-card' },
    },
    description,
    data: [{ date: '2026-04-20', kg: 85 }],
  };
}

// Stub chat gateway that captures the system prompt from the last request
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

describe('chat proxy dynamic card-list injection', () => {
  let sandbox, server, gateway;

  before(async () => {
    gateway = await startStubGateway();
    sandbox = createSandbox({
      seed: {
        'weight.json': makeCard('weight', 'Weight', 'Body weight log, one reading per day'),
        'mood.json':   makeCard('mood',   'Mood',   'Daily mood 1-5'),
      },
    });
    server = await spawnServer(sandbox, {
      CHAT_GATEWAY_HOST: '127.0.0.1',
      CHAT_GATEWAY_PORT: String(gateway.port),
      CHAT_GATEWAY_TLS: 'false',
      CHAT_GATEWAY_TOKEN: 'stub-token',
      CHAT_GATEWAY_MODEL: 'stub-model',
    });
  });
  after(async () => {
    if (server) await server.kill();
    if (gateway) await gateway.close();
    cleanupSandbox(sandbox);
  });

  test('system prompt lists the current cards', async () => {
    const res = await req(server.baseUrl, '/api/chat', {
      method: 'POST',
      body: { messages: [{ role: 'user', content: 'hi' }], voiceMode: false },
    });
    assert.equal(res.status, 200);
    const sp = gateway.getLastPrompt();
    assert.ok(sp, 'stub captured a system prompt');
    assert.ok(sp.includes('Currently available cards'), 'prompt has the cards header');
    assert.ok(sp.includes('weight'), 'prompt includes weight card id');
    assert.ok(sp.includes('mood'), 'prompt includes mood card id');
    assert.ok(sp.includes('Body weight log'), 'prompt includes weight description');
  });

  test('voice-mode prompt also includes the card list', async () => {
    const res = await req(server.baseUrl, '/api/chat', {
      method: 'POST',
      body: { messages: [{ role: 'user', content: 'hi' }], voiceMode: true },
    });
    assert.equal(res.status, 200);
    const sp = gateway.getLastPrompt();
    assert.ok(sp, 'stub captured a system prompt');
    assert.ok(sp.includes('Currently available cards'));
    assert.ok(sp.includes('weight'));
  });

  test('with zero cards, prompt says "(none yet)"', async () => {
    // Temporarily clear data/ then trigger another request
    const fs = require('fs');
    const path = require('path');
    fs.renameSync(
      path.join(sandbox, 'data', 'weight.json'),
      path.join(sandbox, 'data', '_weight.json.bak')
    );
    fs.renameSync(
      path.join(sandbox, 'data', 'mood.json'),
      path.join(sandbox, 'data', '_mood.json.bak')
    );
    // Give fs.watch time to catch up
    await new Promise(r => setTimeout(r, 500));

    const res = await req(server.baseUrl, '/api/chat', {
      method: 'POST',
      body: { messages: [{ role: 'user', content: 'hi' }], voiceMode: false },
    });
    assert.equal(res.status, 200);
    const sp = gateway.getLastPrompt();
    assert.ok(sp.includes('(none yet)'));

    // Restore
    fs.renameSync(
      path.join(sandbox, 'data', '_weight.json.bak'),
      path.join(sandbox, 'data', 'weight.json')
    );
    fs.renameSync(
      path.join(sandbox, 'data', '_mood.json.bak'),
      path.join(sandbox, 'data', 'mood.json')
    );
  });
});
