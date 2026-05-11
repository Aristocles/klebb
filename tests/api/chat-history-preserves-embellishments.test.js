// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/api/chat-history-preserves-embellishments.test.js
// Regression for #191: PUT /api/chat/history must round-trip the
// `embellishments` array and `followupText` string so the CC-
// embellishment chip row (attached to an assistant reply when a
// combination-card is created or modified) survives a page reload /
// chat-widget reopen.
//
// Before the fix, the server filter dropped every field other than
// {id, role, content} on PUT, so the chips were lost even if the
// client had sent them.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const {
  createSandbox,
  cleanupSandbox,
  spawnServer,
  req,
  fakeAuthState,
} = require('../helpers/sandbox');

describe('M2/#191: chat history round-trips embellishments + followupText', () => {
  let sandbox, server, auth;

  before(async () => {
    auth = fakeAuthState('e2e-user');
    sandbox = createSandbox({
      credentials: auth.credentials,
      sessions: auth.sessions,
    });
    server = await spawnServer(sandbox);
  });

  after(async () => {
    if (server) await server.kill();
    cleanupSandbox(sandbox);
  });

  test('PUT then GET preserves embellishments + followupText', async () => {
    const put = await req(server.baseUrl, '/api/chat/history', {
      method: 'PUT',
      cookie: auth.cookie,
      body: {
        messages: [
          { id: 'm1', role: 'user', content: 'switch recovery-overview to rings' },
          {
            id: 'm2',
            role: 'assistant',
            content: 'Done! Recovery Overview is now in rings layout.',
            followupText: 'Want to keep going?',
            embellishments: [
              { label: 'Colour-code the rings', prompt: 'colour-code the rings on recovery-overview' },
              { label: 'Switch back to stack', prompt: 'switch recovery-overview back to stack layout' },
            ],
          },
        ],
      },
    });
    assert.equal(put.status, 200, `PUT failed: ${put.body}`);

    const get = await req(server.baseUrl, '/api/chat/history', {
      cookie: auth.cookie,
    });
    assert.equal(get.status, 200);
    const msgs = get.json.messages;
    assert.equal(msgs.length, 2);

    const assistant = msgs.find(m => m.id === 'm2');
    assert.ok(assistant, 'assistant message present');
    assert.equal(assistant.followupText, 'Want to keep going?');
    assert.ok(Array.isArray(assistant.embellishments), 'embellishments present');
    assert.equal(assistant.embellishments.length, 2);
    assert.equal(assistant.embellishments[0].label, 'Colour-code the rings');
    assert.equal(assistant.embellishments[0].prompt,
      'colour-code the rings on recovery-overview');
  });

  test('PUT with no embellishments fields still round-trips user messages', async () => {
    const put = await req(server.baseUrl, '/api/chat/history', {
      method: 'PUT',
      cookie: auth.cookie,
      body: {
        messages: [
          { id: 'u1', role: 'user', content: 'hi' },
          { id: 'a1', role: 'assistant', content: 'hello' },
        ],
      },
    });
    assert.equal(put.status, 200);
    const get = await req(server.baseUrl, '/api/chat/history', {
      cookie: auth.cookie,
    });
    assert.equal(get.json.messages.length, 2);
    // Absent fields should NOT be forced into the persisted payload
    // (keeps the file tidy and older clients happy).
    const assistant = get.json.messages.find(m => m.id === 'a1');
    assert.ok(!('embellishments' in assistant) || assistant.embellishments === undefined);
  });
});
