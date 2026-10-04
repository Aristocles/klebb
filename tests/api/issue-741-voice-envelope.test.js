// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/api/issue-741-voice-envelope.test.js
// Voice mode asks for a {"speak","display"} envelope. Models writing a
// multi-line display often put literal newlines inside the string rather
// than \n escapes, which JSON.parse rejects, so the whole envelope fell
// through to the prose fallback: the bubble showed the raw JSON and TTS
// read "speak ... display ..." aloud (#741). The shape below is the one
// seen on a live instance, pretty-printed by the model.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { createSandbox, cleanupSandbox, spawnServer, req } = require('../helpers/sandbox');

function startSequenceGateway() {
  let queue = [];
  const server = http.createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      const content = queue.shift() || 'queue exhausted';
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }],
      }));
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        reset(next) { queue = [...next]; },
        close: () => new Promise(r => server.close(r)),
      });
    });
  });
}

describe('#741: a voice envelope with raw newlines in display', () => {
  let sandbox, server, gateway;

  before(async () => {
    gateway = await startSequenceGateway();
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

  const voiceTurn = () => req(server.baseUrl, '/api/chat', {
    method: 'POST',
    body: { messages: [{ role: 'user', content: 'Is 6 mg ok?' }], voiceMode: true },
  });

  test('unwraps to display for the bubble and speak for TTS, line breaks kept', async () => {
    const display = '**6 mg is high.**\n\nTypical dosing is:\n- 200-300 mcg';
    gateway.reset([`{\n  "speak": "Six milligrams is too high.",\n  "display": "${display}"\n}`]);

    const res = await voiceTurn();

    assert.equal(res.status, 200);
    assert.equal(res.json.reply, display);
    assert.equal(res.json.speak, 'Six milligrams is too high.');
  });

  test('a prose answer that ignored the envelope is still shown and spoken as-is', async () => {
    gateway.reset(['You have three cards.\nAsk me for details.']);

    const res = await voiceTurn();

    assert.equal(res.status, 200);
    assert.equal(res.json.reply, 'You have three cards.\nAsk me for details.');
    assert.equal(res.json.speak, 'You have three cards.\nAsk me for details.');
  });
});
