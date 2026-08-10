// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/chat-tool-use.test.js
// End-to-end coverage of the tool-calling agent loop in /api/chat.
// A scripted stub gateway pops one response per request and captures the
// full outbound body each time, so we can assert:
//   - tool_calls from the first response trigger a follow-up request that
//     contains the assistant's tool_calls message + a {role:"tool"} reply
//   - the tool's result (from registry.createManifest etc.) is the content
//     of that tool-role message
//   - errors from the registry become tool-visible {error:"..."} strings
//     the model can self-correct against
//   - a runaway model is capped at MAX_ITERS iterations
//   - voice mode still JSON-extracts the final text only

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { createSandbox, cleanupSandbox, spawnServer, req, waitFor } = require('./helpers/sandbox');

// Scripted stub gateway. Starts an HTTP server; each POST pops the next
// response from the queue and captures the request body. Exhausted queue
// → 500 so tests fail loudly rather than silently hanging.
function startStubGateway() {
  const responseQueue = [];
  const capturedRequests = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', c => { body += c; });
    request.on('end', () => {
      try { capturedRequests.push(JSON.parse(body)); }
      catch { capturedRequests.push(null); }
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
        getRequests: () => capturedRequests.slice(),
        reset: () => { responseQueue.length = 0; capturedRequests.length = 0; },
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
    choices: [{
      finish_reason: 'stop',
      message: { role: 'assistant', content },
    }],
  };
}

describe('chat proxy tool-calling agent loop', () => {
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

  test('A — happy-path create_manifest tool call', async () => {
    gateway.reset();
    const manifest = {
      $schema: 'klebb.datafile.v1',
      meta: { id: 'tool-test-a', label: 'Tool Test A' },
      data: [],
    };
    gateway.pushResponses([
      toolCallResponse({ name: 'create_manifest', args: { manifest }, id: 'call_a' }),
      stopResponse('Done — created Tool Test A.'),
    ]);

    const res = await req(server.baseUrl, '/api/chat', {
      method: 'POST',
      body: { messages: [{ role: 'user', content: 'Create a Tool Test A card.' }] },
    });

    assert.equal(res.status, 200);
    assert.equal(res.json.reply, 'Done — created Tool Test A.');
    assert.ok(!res.json.error, 'no error on happy path');

    // Stub saw exactly two requests
    const reqs = gateway.getRequests();
    assert.equal(reqs.length, 2, `stub should have seen 2 requests, got ${reqs.length}`);

    // First request carries tools
    assert.ok(Array.isArray(reqs[0].tools), 'first request should include tools');
    assert.ok(reqs[0].tools.some(t => t.function?.name === 'create_manifest'),
      'tools list should include create_manifest');

    // Second request preserves the tool_calls assistant turn AND includes a
    // tool-role message with the registry result.
    const msgs = reqs[1].messages;
    const assistantWithToolCalls = msgs.find(m => m.role === 'assistant' && Array.isArray(m.tool_calls));
    assert.ok(assistantWithToolCalls, 'second request should include the original tool_calls assistant turn');
    assert.equal(assistantWithToolCalls.tool_calls[0].id, 'call_a');

    const toolMsg = msgs.find(m => m.role === 'tool');
    assert.ok(toolMsg, 'second request should include a tool-role message');
    assert.equal(toolMsg.tool_call_id, 'call_a');
    assert.match(toolMsg.content, /"ok":true/);
    assert.match(toolMsg.content, /"id":"tool-test-a"/);

    // Manifest file hit the disk
    const onDisk = path.join(sandbox, 'data', 'tool-test-a.json');
    assert.ok(fs.existsSync(onDisk), 'manifest file should exist on disk');
  });

  test('F — hide_card toggles master meta.enabled to false (see #75)', async () => {
    gateway.reset();
    // Seed a pre-existing card the agent will hide
    const seedPath = path.join(sandbox, 'data', 'tool-test-f.json');
    fs.writeFileSync(seedPath, JSON.stringify({
      $schema: 'klebb.datafile.v1',
      meta: {
        id: 'tool-test-f',
        label: 'Tool Test F',
        view: { enabled: true, component: 'generic-card' },
      },
      data: [],
    }, null, 2));
    // Poll until the registry has actually picked the new file up, rather than
    // sleeping a fixed 350 ms: hide_card below operates by id, so if the reload
    // has not happened yet the tool fails on an unknown card and the whole file
    // aborts. The wait is on a filesystem event, which is quick on an idle
    // machine and not guaranteed under a full parallel run.
    await waitFor(async () => {
      const r = await req(server.baseUrl, '/api/manifests/tool-test-f');
      return r.status === 200;
    }, { what: 'the registry to notice tool-test-f' });

    gateway.pushResponses([
      toolCallResponse({ name: 'hide_card', args: { id: 'tool-test-f' }, id: 'call_f' }),
      stopResponse('Hidden.'),
    ]);

    const res = await req(server.baseUrl, '/api/chat', {
      method: 'POST',
      body: { messages: [{ role: 'user', content: 'Hide tool-test-f.' }] },
    });

    assert.equal(res.status, 200);
    assert.equal(res.json.reply, 'Hidden.');

    const reqs = gateway.getRequests();
    const toolMsg = reqs[1].messages.find(m => m.role === 'tool');
    assert.match(toolMsg.content, /"enabled":false/);

    // File on disk now has meta.enabled: false
    const afterHide = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
    assert.equal(afterHide.meta.enabled, false);

    // Second round: show_card flips it back
    gateway.reset();
    gateway.pushResponses([
      toolCallResponse({ name: 'show_card', args: { id: 'tool-test-f' }, id: 'call_f2' }),
      stopResponse('Back.'),
    ]);
    const res2 = await req(server.baseUrl, '/api/chat', {
      method: 'POST',
      body: { messages: [{ role: 'user', content: 'Show tool-test-f.' }] },
    });
    assert.equal(res2.status, 200);
    const afterShow = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
    assert.equal(afterShow.meta.enabled, true);
  });

  test('B — error feedback on delete of unknown id', async () => {
    gateway.reset();
    gateway.pushResponses([
      toolCallResponse({ name: 'delete_manifest', args: { id: 'does-not-exist' }, id: 'call_b' }),
      stopResponse("That card does not exist — nothing to delete."),
    ]);

    const res = await req(server.baseUrl, '/api/chat', {
      method: 'POST',
      body: { messages: [{ role: 'user', content: 'Delete does-not-exist.' }] },
    });

    assert.equal(res.status, 200);
    assert.equal(res.json.reply, 'That card does not exist — nothing to delete.');
    assert.ok(!res.json.error, 'errors are fed back to the model, not raised to the user');

    const reqs = gateway.getRequests();
    assert.equal(reqs.length, 2);
    const toolMsg = reqs[1].messages.find(m => m.role === 'tool');
    assert.match(toolMsg.content, /"error":"unknown manifest: does-not-exist"/);
  });

  test('C — runaway loop capped at MAX_ITERS (5) with a graceful reply', async () => {
    gateway.reset();
    // Pre-seed the queue with many tool_calls so it never terminates naturally
    for (let i = 0; i < 20; i++) {
      gateway.pushResponse(toolCallResponse({
        name: 'list_manifests',
        args: {},
        id: 'call_loop_' + i,
      }));
    }

    const res = await req(server.baseUrl, '/api/chat', {
      method: 'POST',
      body: { messages: [{ role: 'user', content: 'Spin forever.' }] },
    });

    assert.equal(res.status, 200, 'cap should yield 200, not 500/504');
    assert.ok(typeof res.json.reply === 'string' && res.json.reply.length > 0,
      'cap fallback should produce a non-empty reply');

    const reqs = gateway.getRequests();
    assert.equal(reqs.length, 5, `should stop at MAX_ITERS=5, got ${reqs.length}`);

    // Server remains healthy
    const followup = await req(server.baseUrl, '/healthz', { method: 'GET' });
    assert.equal(followup.status, 200);
  });

  test('E — voice mode JSON extract on final text only', async () => {
    gateway.reset();
    const manifest = {
      $schema: 'klebb.datafile.v1',
      meta: { id: 'tool-test-e', label: 'Tool Test E' },
      data: [],
    };
    gateway.pushResponses([
      toolCallResponse({ name: 'create_manifest', args: { manifest }, id: 'call_e' }),
      stopResponse('{"speak":"Created it.","display":"Created **Tool Test E**."}'),
    ]);

    const res = await req(server.baseUrl, '/api/chat', {
      method: 'POST',
      body: {
        messages: [{ role: 'user', content: 'Create Tool Test E.' }],
        voiceMode: true,
      },
    });

    assert.equal(res.status, 200);
    assert.equal(res.json.reply, 'Created **Tool Test E**.');
    assert.equal(res.json.speak, 'Created it.');
  });
});
