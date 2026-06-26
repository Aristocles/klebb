// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/content-api.test.js
// Integration tests for GET /api/templates + GET /api/prompts.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const { createSandbox, cleanupSandbox, spawnServer, req } = require('./helpers/sandbox');

describe('content API', () => {
  let sandbox, server;

  before(async () => {
    sandbox = createSandbox();
    server = await spawnServer(sandbox);
  });
  after(async () => {
    if (server) await server.kill();
    cleanupSandbox(sandbox);
  });

  test('GET /api/templates returns the shipped template list', async () => {
    const res = await req(server.baseUrl, '/api/templates');
    assert.equal(res.status, 200);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.ok(Array.isArray(res.json.templates));
    assert.ok(res.json.templates.length >= 10, `expected >= 10 templates, got ${res.json.templates.length}`);
  });

  test('each template row has id, title, summary, category, tags, manifest', async () => {
    const res = await req(server.baseUrl, '/api/templates');
    for (const t of res.json.templates) {
      assert.ok(typeof t.id === 'string' && t.id.length > 0);
      assert.ok(typeof t.title === 'string' && t.title.length > 0);
      assert.ok(typeof t.summary === 'string' && t.summary.length > 0);
      assert.ok(typeof t.category === 'string' && t.category.length > 0);
      assert.ok(Array.isArray(t.tags));
      assert.ok(t.manifest && t.manifest.meta && t.manifest.meta.template);
      assert.equal(t.manifest.meta.template.id, t.id);
    }
  });

  test('POST /api/settings/cards/from-template creates a real card', async () => {
    // Pick a known template and instantiate it.
    const list = await req(server.baseUrl, '/api/templates');
    const tmpl = list.json.templates.find(t => t.id === 'weight') || list.json.templates[0];

    const before = await req(server.baseUrl, '/api/settings/cards');
    const beforeIds = before.json.cards.map(c => c.id);

    const create = await req(server.baseUrl, '/api/settings/cards/from-template', {
      method: 'POST',
      body: { templateId: tmpl.id },
    });
    assert.equal(create.status, 201);
    assert.ok(create.json.id, 'returns the new card id');

    const after = await req(server.baseUrl, '/api/settings/cards');
    const newCard = after.json.cards.find(c => !beforeIds.includes(c.id));
    assert.ok(newCard, 'a new card appeared');
    assert.equal(newCard.id, create.json.id);
  });

  test('a second create from the same template gets a distinct, deduped id', async () => {
    const first = await req(server.baseUrl, '/api/settings/cards/from-template', {
      method: 'POST', body: { templateId: 'mood' },
    });
    assert.equal(first.status, 201);
    const second = await req(server.baseUrl, '/api/settings/cards/from-template', {
      method: 'POST', body: { templateId: 'mood' },
    });
    assert.equal(second.status, 201);
    assert.notEqual(first.json.id, second.json.id);
  });

  test('from-template with a bad/missing templateId is a clean 4xx', async () => {
    const noId = await req(server.baseUrl, '/api/settings/cards/from-template', {
      method: 'POST', body: {},
    });
    assert.equal(noId.status, 400);
    const unknown = await req(server.baseUrl, '/api/settings/cards/from-template', {
      method: 'POST', body: { templateId: 'no-such-template' },
    });
    assert.equal(unknown.status, 404);
  });

  test('GET /api/prompts returns the shipped prompt list', async () => {
    const res = await req(server.baseUrl, '/api/prompts');
    assert.equal(res.status, 200);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.ok(Array.isArray(res.json.prompts));
    assert.ok(res.json.prompts.length >= 6, `expected >= 6 prompts, got ${res.json.prompts.length}`);
  });

  test('each prompt row has id, title, summary, tags, body', async () => {
    const res = await req(server.baseUrl, '/api/prompts');
    for (const p of res.json.prompts) {
      assert.ok(typeof p.id === 'string' && p.id.length > 0);
      assert.ok(typeof p.title === 'string' && p.title.length > 0);
      assert.ok(typeof p.summary === 'string' && p.summary.length > 0);
      assert.ok(Array.isArray(p.tags));
      assert.ok(typeof p.body === 'string' && p.body.length > 20);
    }
  });

  test('prompts include the new-to-klebb meta-prompt', async () => {
    const res = await req(server.baseUrl, '/api/prompts');
    const ids = res.json.prompts.map(p => p.id);
    assert.ok(ids.includes('new-to-klebb'), 'new-to-klebb prompt must be discoverable');
  });

  test('malformed files under templates/ and prompts/ are skipped, response stays 200',
    async (t) => {
      const fs = require('fs');
      const path = require('path');
      const REPO_ROOT = path.resolve(__dirname, '..');
      const badTemplate = path.join(REPO_ROOT, 'templates', '__test_malformed.klebb.json');
      const badPrompt = path.join(REPO_ROOT, 'prompts', '__test_malformed.md');
      fs.writeFileSync(badTemplate, '{ this is not json');
      fs.writeFileSync(badPrompt, 'no frontmatter, just prose');
      t.after(() => {
        try { fs.unlinkSync(badTemplate); } catch {}
        try { fs.unlinkSync(badPrompt); } catch {}
      });

      const tRes = await req(server.baseUrl, '/api/templates');
      assert.equal(tRes.status, 200);
      // bad file should not appear
      const tIds = tRes.json.templates.map(x => x.id);
      assert.ok(!tIds.includes('__test_malformed'),
        'malformed template leaked into the response');

      const pRes = await req(server.baseUrl, '/api/prompts');
      assert.equal(pRes.status, 200);
      const pIds = pRes.json.prompts.map(x => x.id);
      assert.ok(!pIds.includes('__test_malformed'),
        'malformed prompt leaked into the response');
    });

  test('/api/templates and /api/prompts require auth when credentials registered',
    async (t) => {
      // Spin up a second server with credentials registered so the auth gate
      // is actually armed. No session cookie = 401.
      const { fakeAuthState } = require('./helpers/sandbox');
      const auth = fakeAuthState('test');
      const box = createSandbox({
        credentials: auth.credentials,
        sessions: auth.sessions,
      });
      const srv = await spawnServer(box);
      t.after(async () => { await srv.kill(); cleanupSandbox(box); });

      const noAuth = await req(srv.baseUrl, '/api/templates');
      assert.equal(noAuth.status, 401);
      const noAuthP = await req(srv.baseUrl, '/api/prompts');
      assert.equal(noAuthP.status, 401);

      const authed = await req(srv.baseUrl, '/api/templates', { cookie: auth.cookie });
      assert.equal(authed.status, 200);
    });
});
