// tests/instance-api.test.js
// The /api/instance endpoint exposes branding config (instance name, chat
// agent name, emoji) to the frontend. Ensure it reflects env vars correctly.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const { createSandbox, cleanupSandbox, spawnServer, req } = require('./helpers/sandbox');

describe('GET /api/instance', () => {
  describe('default (no env overrides)', () => {
    let sandbox, server;

    before(async () => {
      sandbox = createSandbox();
      server = await spawnServer(sandbox);
    });
    after(async () => {
      if (server) await server.kill();
      cleanupSandbox(sandbox);
    });

    test('returns 200 in setup mode (no auth required)', async () => {
      const res = await req(server.baseUrl, '/api/instance');
      assert.equal(res.status, 200);
    });

    test('includes instance name', async () => {
      const res = await req(server.baseUrl, '/api/instance');
      assert.ok(res.json.name);
      assert.equal(res.json.name, 'Klebb');
    });

    test('chatAgent name defaults to "Chat"', async () => {
      const res = await req(server.baseUrl, '/api/instance');
      assert.ok(res.json.chatAgent);
      assert.equal(res.json.chatAgent.name, 'Chat');
    });

    test('chatAgent emoji defaults to "💬"', async () => {
      const res = await req(server.baseUrl, '/api/instance');
      assert.equal(res.json.chatAgent.emoji, '💬');
    });
  });

  describe('with env overrides', () => {
    let sandbox, server;

    before(async () => {
      sandbox = createSandbox();
      server = await spawnServer(sandbox, {
        CHAT_AGENT_NAME: 'Hal',
        CHAT_AGENT_EMOJI: '🤖',
        HEALTH_INSTANCE_NAME: 'Custom Dashboard',
      });
    });
    after(async () => {
      if (server) await server.kill();
      cleanupSandbox(sandbox);
    });

    test('instance name reflects HEALTH_INSTANCE_NAME', async () => {
      const res = await req(server.baseUrl, '/api/instance');
      assert.equal(res.json.name, 'Custom Dashboard');
    });

    test('chatAgent.name reflects CHAT_AGENT_NAME', async () => {
      const res = await req(server.baseUrl, '/api/instance');
      assert.equal(res.json.chatAgent.name, 'Hal');
    });

    test('chatAgent.emoji reflects CHAT_AGENT_EMOJI', async () => {
      const res = await req(server.baseUrl, '/api/instance');
      assert.equal(res.json.chatAgent.emoji, '🤖');
    });
  });
});
