// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/meta-category.test.js
// Unit tests for the meta.category contract: enum validation (unknown
// values silently dropped), HAE auto-population on create, and chat
// system-prompt injection.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { createSandbox, cleanupSandbox, spawnServer, req } = require('./helpers/sandbox');
const { systemMessageText } = require('../chat/system-prompt');

const { CATEGORIES, isValidCategory } = require('../config/categories');

describe('isValidCategory', () => {
  test('accepts every canonical category', () => {
    for (const c of CATEGORIES) assert.equal(isValidCategory(c), true);
  });
  test('rejects unknown values', () => {
    assert.equal(isValidCategory('wellness'), false);
    assert.equal(isValidCategory('heart-health'), false);
    assert.equal(isValidCategory('fitness'), false);
    assert.equal(isValidCategory(''), false);
    assert.equal(isValidCategory(null), false);
    assert.equal(isValidCategory(undefined), false);
    assert.equal(isValidCategory(42), false);
  });
});

describe('validateManifestShape: meta.category enum', () => {
  let registry;
  before(() => {
    delete require.cache[require.resolve('../manifests/registry')];
    registry = require('../manifests/registry');
  });

  test('valid category passes through untouched', () => {
    const parsed = registry.validateManifestShape({
      $schema: 'klebb.datafile.v1',
      meta: { id: 'x', label: 'X', category: 'sleep' },
    });
    assert.equal(parsed.meta.category, 'sleep');
  });

  test('unknown category is silently dropped; card still validates', () => {
    const parsed = registry.validateManifestShape({
      $schema: 'klebb.datafile.v1',
      meta: { id: 'x', label: 'X', category: 'wellness' },
    });
    assert.equal(parsed.meta.category, undefined);
  });

  test('absent category stays absent', () => {
    const parsed = registry.validateManifestShape({
      $schema: 'klebb.datafile.v1',
      meta: { id: 'x', label: 'X' },
    });
    assert.equal(parsed.meta.category, undefined);
  });
});

describe('createManifest: auto-populates category from HAE catalogue', () => {
  let sandbox, server;
  const TOKEN = 'meta-cat-token-hex-0123456789abcdef';

  before(async () => {
    sandbox = createSandbox();
    server = await spawnServer(sandbox, { HEALTH_AUTO_EXPORT_TOKEN: TOKEN });
  });
  after(async () => { if (server) await server.kill(); cleanupSandbox(sandbox); });

  test('HAE-backed card with no explicit category gets it from catalogue', async () => {
    const r = await req(server.baseUrl, '/api/manifests', {
      method: 'POST',
      body: {
        $schema: 'klebb.datafile.v1',
        meta: {
          id: 'my-hrv',
          label: 'HRV',
          ingest: { source: 'hae', metric: 'heart_rate_variability' },
          view: { enabled: true, component: 'generic-card',
                  display: { template: '{ms:round(0)}' } },
          writeable: { fromWebapp: false },
        },
        data: [],
      },
    });
    assert.ok(r.status === 200 || r.status === 201,
      `create failed (${r.status}): ${r.body}`);

    const fileContent = JSON.parse(fs.readFileSync(
      path.join(sandbox, 'data', 'my-hrv.json'), 'utf8'));
    assert.equal(fileContent.meta.category, 'recovery');
  });

  test('explicit category wins over catalogue auto-population', async () => {
    const r = await req(server.baseUrl, '/api/manifests', {
      method: 'POST',
      body: {
        $schema: 'klebb.datafile.v1',
        meta: {
          id: 'my-sleep',
          label: 'Sleep',
          category: 'vitals',  // unusual override
          ingest: { source: 'hae', metric: 'sleep_analysis' },
          view: { enabled: true, component: 'generic-card',
                  display: { template: '{hours:round(1)}' } },
          writeable: { fromWebapp: false },
        },
        data: [],
      },
    });
    assert.ok(r.status === 200 || r.status === 201);

    const fileContent = JSON.parse(fs.readFileSync(
      path.join(sandbox, 'data', 'my-sleep.json'), 'utf8'));
    assert.equal(fileContent.meta.category, 'vitals');
  });

  test('non-HAE card with no category stays uncategorised', async () => {
    const r = await req(server.baseUrl, '/api/manifests', {
      method: 'POST',
      body: {
        $schema: 'klebb.datafile.v1',
        meta: {
          id: 'my-notes',
          label: 'Notes',
          view: { enabled: true, component: 'generic-card' },
        },
        data: [],
      },
    });
    assert.ok(r.status === 200 || r.status === 201);

    const fileContent = JSON.parse(fs.readFileSync(
      path.join(sandbox, 'data', 'my-notes.json'), 'utf8'));
    assert.equal(fileContent.meta.category, undefined);
  });
});

describe('chat system prompt: category constraint injection', () => {
  // Reuse the stub-gateway pattern from chat-prompt-cards.test.js.
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

  test('system prompt includes the category constraint block', async () => {
    const res = await req(server.baseUrl, '/api/chat', {
      method: 'POST',
      body: { messages: [{ role: 'user', content: 'hello' }] },
    });
    assert.equal(res.status, 200);
    const prompt = gateway.getLastPrompt();
    assert.ok(prompt);
    assert.match(prompt, /Manifest categories/);
    assert.match(prompt, /meta\.category/);
    for (const c of CATEGORIES) {
      assert.ok(prompt.includes(c),
        `system prompt missing category: ${c}`);
    }
    assert.match(prompt, /silently dropped/);
  });
});
