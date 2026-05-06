// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/chat-status.test.js
// Verifies GET /api/chat/status returns the configured flag the
// prompts-gallery modal uses to decide whether "Load into chat" or
// "Copy to clipboard" is the primary action.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const { createSandbox, cleanupSandbox, spawnServer, req } = require('./helpers/sandbox');

describe('chat status', () => {
  test('reports configured:false when CHAT_ENDPOINT_URL is unset', async () => {
    const box = createSandbox();
    const srv = await spawnServer(box, {
      CHAT_ENDPOINT_URL: '',
      CHAT_API_KEY: '',
    });
    try {
      const r = await req(srv.baseUrl, '/api/chat/status');
      assert.equal(r.status, 200);
      assert.equal(r.json.configured, false);
    } finally {
      await srv.kill();
      cleanupSandbox(box);
    }
  });

  test('reports configured:true when CHAT_ENDPOINT_URL is set', async () => {
    const box = createSandbox();
    const srv = await spawnServer(box, {
      CHAT_ENDPOINT_URL: 'http://127.0.0.1:1/v1/chat/completions',
      CHAT_API_KEY: 'dummy',
    });
    try {
      const r = await req(srv.baseUrl, '/api/chat/status');
      assert.equal(r.status, 200);
      assert.equal(r.json.configured, true);
    } finally {
      await srv.kill();
      cleanupSandbox(box);
    }
  });
});
