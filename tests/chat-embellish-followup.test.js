// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/chat-embellish-followup.test.js
// Asserts that /api/chat attaches a `followup` block when the agent
// successfully creates or patches a manifest this turn, and does NOT
// attach one when the agent just reads or lists.

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
        pushResponse: (r) => responseQueue.push(r),
        pushResponses: (rs) => rs.forEach(r => responseQueue.push(r)),
        reset: () => { responseQueue.length = 0; },
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

describe('chat /api/chat — embellishment followup', () => {
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

  test('create_manifest attaches followup with embellishments shaped for the client', async () => {
    gateway.reset();
    const manifest = {
      $schema: 'klebb.datafile.v1',
      meta: {
        id: 'embellish-create',
        label: 'Embellish Create',
        view: { enabled: true, component: 'generic-card' },
      },
      data: [],
    };
    gateway.pushResponses([
      toolCallResponse({ name: 'create_manifest', args: { manifest }, id: 'call_a' }),
      stopResponse('Done — created Embellish Create.'),
    ]);

    const res = await req(server.baseUrl, '/api/chat', {
      method: 'POST',
      body: { messages: [{ role: 'user', content: 'Create an Embellish Create card.' }] },
    });

    assert.equal(res.status, 200);
    assert.ok(res.json.followup, 'expected followup block on create');
    assert.equal(typeof res.json.followup.text, 'string');
    assert.ok(Array.isArray(res.json.followup.embellishments));
    assert.ok(res.json.followup.embellishments.length > 0);
    for (const e of res.json.followup.embellishments) {
      assert.equal(typeof e.id, 'string');
      assert.equal(typeof e.label, 'string');
      assert.equal(typeof e.prompt, 'string');
      assert.ok(e.prompt.includes('Embellish Create'), 'chip prompt should mention the card label');
    }
  });

  test('pure read (list_manifests) does not attach a followup', async () => {
    gateway.reset();
    gateway.pushResponses([
      toolCallResponse({ name: 'list_manifests', args: {}, id: 'call_b' }),
      stopResponse('Here are your cards.'),
    ]);

    const res = await req(server.baseUrl, '/api/chat', {
      method: 'POST',
      body: { messages: [{ role: 'user', content: 'List my cards.' }] },
    });

    assert.equal(res.status, 200);
    assert.equal(res.json.followup, undefined, 'followup should be absent for pure reads');
  });

  test('patch_manifest uses the edit-flow intro copy', async () => {
    gateway.reset();
    // First, seed a card we can patch.
    const seed = {
      $schema: 'klebb.datafile.v1',
      meta: {
        id: 'embellish-patch',
        label: 'Embellish Patch',
        view: { enabled: true, component: 'generic-card' },
      },
      data: [],
    };
    gateway.pushResponses([
      toolCallResponse({ name: 'create_manifest', args: { manifest: seed }, id: 'call_c1' }),
      stopResponse('Created.'),
    ]);
    await req(server.baseUrl, '/api/chat', {
      method: 'POST',
      body: { messages: [{ role: 'user', content: 'Create Embellish Patch.' }] },
    });

    // Now patch it — the followup should be in edit flow.
    gateway.reset();
    gateway.pushResponses([
      toolCallResponse({
        name: 'patch_manifest',
        args: { id: 'embellish-patch', patch: { meta: { order: 250 } } },
        id: 'call_c2',
      }),
      stopResponse('Reordered.'),
    ]);
    const res = await req(server.baseUrl, '/api/chat', {
      method: 'POST',
      body: { messages: [{ role: 'user', content: 'Reorder Embellish Patch.' }] },
    });

    assert.equal(res.status, 200);
    assert.ok(res.json.followup, 'patch should attach a followup');
    const { INTRO } = require('../chat/embellish');
    assert.equal(res.json.followup.text, INTRO.edit);
  });
});
