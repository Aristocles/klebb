// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/api/feedback-api.test.js
// POST /api/feedback appends one anonymised JSONL line to data/_meta/feedback.jsonl.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createSandbox, cleanupSandbox, spawnServer, req, fakeAuthState, sessionCookie } = require('../helpers/sandbox');

describe('POST /api/feedback', () => {
  let sandbox, server;
  before(async () => {
    sandbox = createSandbox({ seed: {} });
    server = await spawnServer(sandbox);
  });
  after(async () => { if (server) await server.kill(); cleanupSandbox(sandbox); });

  test('appends one valid JSONL line and returns {logged:true}', async () => {
    const res = await req(server.baseUrl, '/api/feedback', {
      method: 'POST',
      body: { intent: 'wants a heatmap renderer', context: 'no heatmap renderer exists', toolsConsidered: ['create_manifest'] },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.logged, true);

    const file = path.join(sandbox, 'data', '_meta', 'feedback.jsonl');
    assert.ok(fs.existsSync(file), 'feedback.jsonl should be created lazily');
    const raw = fs.readFileSync(file, 'utf8');
    assert.ok(raw.endsWith('\n'), 'line must be newline-terminated');
    const lines = raw.trim().split('\n');
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.intent, 'wants a heatmap renderer');
    assert.ok(parsed.ts, 'line carries a timestamp');
  });

  test('a second post appends, not overwrites', async () => {
    await req(server.baseUrl, '/api/feedback', { method: 'POST', body: { intent: 'wants CSV export' } });
    const file = path.join(sandbox, 'data', '_meta', 'feedback.jsonl');
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[1]).intent, 'wants CSV export');
  });

  test('rejects a missing intent with 400', async () => {
    const res = await req(server.baseUrl, '/api/feedback', { method: 'POST', body: { context: 'x' } });
    assert.equal(res.status, 400);
    assert.ok(res.json.error);
  });

  test('rejects invalid JSON with 400', async () => {
    const res = await req(server.baseUrl, '/api/feedback', {
      method: 'POST', body: '{not json', headers: { 'Content-Type': 'application/json' },
    });
    assert.equal(res.status, 400);
  });
});

// The suite above runs in setup mode (no credentials), which bypasses the
// auth gate entirely. #417's acceptance criterion was auth + origin parity
// with the notification POSTs, so pin both against a registered instance.
describe('POST /api/feedback auth + origin parity (#417)', () => {
  const ALLOWED_ORIGIN = 'https://klebb.example.test';
  let sandbox, server, cookie;

  before(async () => {
    const auth = fakeAuthState();
    sandbox = createSandbox({
      credentials: auth.credentials,
      sessions: auth.sessions,
    });
    cookie = sessionCookie(auth.token);
    server = await spawnServer(sandbox, { HEALTH_ORIGIN: ALLOWED_ORIGIN });
  });
  after(async () => { if (server) await server.kill(); cleanupSandbox(sandbox); });

  test('rejects an unauthenticated post with 401', async () => {
    const res = await req(server.baseUrl, '/api/feedback', {
      method: 'POST',
      body: { intent: 'wants a heatmap renderer' },
    });
    assert.equal(res.status, 401);
  });

  test('REJECTS cross-origin with 403 and writes nothing', async () => {
    const res = await req(server.baseUrl, '/api/feedback', {
      method: 'POST',
      cookie,
      headers: { 'Origin': 'https://attacker.example' },
      body: { intent: 'riding a sibling-subdomain session' },
    });
    assert.equal(res.status, 403);
    assert.match(res.json.error, /origin/);
    const file = path.join(sandbox, 'data', '_meta', 'feedback.jsonl');
    assert.ok(!fs.existsSync(file), 'rejected post must not create the log');
  });

  test('accepts the allowed origin', async () => {
    const res = await req(server.baseUrl, '/api/feedback', {
      method: 'POST',
      cookie,
      headers: { 'Origin': ALLOWED_ORIGIN },
      body: { intent: 'wants a heatmap renderer' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.logged, true);
  });

  test('accepts a same-host post with no Origin header (curl)', async () => {
    const res = await req(server.baseUrl, '/api/feedback', {
      method: 'POST',
      cookie,
      body: { intent: 'operator poking the API directly' },
    });
    assert.equal(res.status, 200);
  });
});
