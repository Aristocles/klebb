// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/chat-prompt-cc-schema.test.js
// Verifies the combination-card schema block reaches the chat agent's
// system prompt, and that the helper names known hallucinations as
// forbidden.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { createSandbox, cleanupSandbox, spawnServer, req } = require('./helpers/sandbox');

const { describeCcSchema } = require('../chat/describe-cc-schema');
const { systemMessageText } = require('../chat/system-prompt');

describe('describeCcSchema (unit)', () => {
  test('names the canonical view.combines + sourceId shape', () => {
    const out = describeCcSchema();
    assert.match(out, /view\.combines/);
    assert.match(out, /sourceId/);
    assert.match(out, /"combination-card"/);
  });

  test('declares "stack" and "rings" as the two layouts', () => {
    const out = describeCcSchema();
    assert.match(out, /"stack"/);
    assert.match(out, /"rings"/);
  });

  test('names the known hallucinations as FORBIDDEN', () => {
    const out = describeCcSchema();
    assert.match(out, /FORBIDDEN/);
    assert.match(out, /view\.slots/);
    assert.match(out, /view\.sources/);
  });

  test('mentions ring-segment, goalDaily, colour for the rings layout', () => {
    const out = describeCcSchema();
    assert.match(out, /ring-segment/);
    assert.match(out, /goalDaily/);
    assert.match(out, /colour/);
  });

  test('mentions goalWeekly for weekly-accumulation rings', () => {
    const out = describeCcSchema();
    assert.match(out, /goalWeekly/);
    assert.match(out, /Mon-Sun|weekly|week containing/i);
  });

  test('tells the agent that data[] on a CC must stay empty', () => {
    const out = describeCcSchema();
    assert.match(out, /empty array|MUST be an empty/i);
  });

  test('documents accessor as an optional combines key with dotted-path support', () => {
    const out = describeCcSchema();
    assert.match(out, /accessor/);
    assert.match(out, /dotted/i);
  });

  test('warns about the shared-row-shape footgun (accessor required when donors share a shape)', () => {
    const out = describeCcSchema();
    assert.match(out, /shared|share the same row shape/i);
    assert.match(out, /sleep_analysis|sleep-analysis/);
  });
});

describe('chat proxy injects CC schema into system prompt', () => {
  let sandbox, server, gateway;

  function startStubGateway() {
    let lastSystemPrompt = null;
    const s = http.createServer((request, response) => {
      let body = '';
      request.on('data', c => { body += c; });
      request.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          const sys = parsed.messages?.find(m => m.role === 'system');
          lastSystemPrompt = systemMessageText(sys);
        } catch {}
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'ack' } }],
        }));
      });
    });
    return new Promise(resolve => {
      s.listen(0, '127.0.0.1', () => {
        resolve({
          port: s.address().port,
          close: () => new Promise(r => s.close(r)),
          getLastPrompt: () => lastSystemPrompt,
        });
      });
    });
  }

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

  test('system prompt contains the CC schema block', async () => {
    const res = await req(server.baseUrl, '/api/chat', {
      method: 'POST',
      body: { messages: [{ role: 'user', content: 'hello' }] },
    });
    assert.equal(res.status, 200);
    const prompt = gateway.getLastPrompt();
    assert.ok(prompt);
    assert.match(prompt, /## Combination cards/);
    assert.match(prompt, /view\.combines/);
    assert.match(prompt, /sourceId/);
    assert.match(prompt, /FORBIDDEN/);
    assert.match(prompt, /view\.slots/);
    assert.match(prompt, /view\.sources/);
  });

  test('system prompt advertises read_doc + the docs catalogue', async () => {
    const res = await req(server.baseUrl, '/api/chat', {
      method: 'POST',
      body: { messages: [{ role: 'user', content: 'hello' }] },
    });
    assert.equal(res.status, 200);
    const prompt = gateway.getLastPrompt();
    assert.ok(prompt);
    assert.match(prompt, /## Available docs/);
    assert.match(prompt, /read_doc/);
    assert.match(prompt, /MANIFEST-SCHEMA\.md/);
    assert.match(prompt, /docs\/CARDS\.md/);
  });

  test('system prompt exposes renderer source as a separate subsection', async () => {
    const res = await req(server.baseUrl, '/api/chat', {
      method: 'POST',
      body: { messages: [{ role: 'user', content: 'hello' }] },
    });
    assert.equal(res.status, 200);
    const prompt = gateway.getLastPrompt();
    assert.ok(prompt);
    assert.match(prompt, /### Documentation/);
    assert.match(prompt, /### Renderer source/);
    assert.match(prompt, /public\/js\/components\/eh-schedule-card\.js/);
    assert.match(prompt, /public\/js\/components\/eh-input-form\.js/);
  });

  test('system prompt tells the agent to verify renderer behaviour from docs first', async () => {
    const res = await req(server.baseUrl, '/api/chat', {
      method: 'POST',
      body: { messages: [{ role: 'user', content: 'hello' }] },
    });
    assert.equal(res.status, 200);
    const prompt = gateway.getLastPrompt();
    assert.ok(prompt);
    assert.match(prompt, /## Verifying renderer behaviour/);
    assert.match(prompt, /Renderer behaviour reference/);
    assert.match(prompt, /reason by analogy/i);
    assert.match(prompt, /can't verify this from the docs/i);
    assert.match(prompt, /Docs first/);
    assert.match(prompt, /Renderer source if the docs leave a gap/);
  });
});
