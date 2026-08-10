// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/chat-prompt-cards.test.js
// Verifies the chat proxy injects the current card list into the system prompt
// so the model always knows what cards exist without a separate round-trip.
//
// We don't talk to a real chat gateway — we stub it with a tiny HTTP server
// that captures the request body and echoes the first system message back.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { createSandbox, cleanupSandbox, spawnServer, req, waitFor } = require('./helpers/sandbox');

function makeCard(id, label, description) {
  return {
    $schema: 'klebb.datafile.v1',
    meta: {
      id,
      label,
      emoji: '⚖️',
      view: { enabled: true, component: 'generic-card' },
    },
    description,
    data: [{ date: '2026-04-20', kg: 85 }],
  };
}

// Stub chat gateway that captures the system prompt from the last request
function startStubGateway() {
  let lastSystemPrompt = null;
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', c => { body += c; });
    request.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        const sys = parsed.messages?.find(m => m.role === 'system');
        lastSystemPrompt = sys?.content || null;
      } catch {}
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'ack' } }],
      }));
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        port,
        close: () => new Promise(r => server.close(r)),
        getLastPrompt: () => lastSystemPrompt,
      });
    });
  });
}

describe('chat proxy dynamic card-list injection', () => {
  let sandbox, server, gateway;

  before(async () => {
    gateway = await startStubGateway();
    sandbox = createSandbox({
      seed: {
        'weight.json': makeCard('weight', 'Weight', 'Body weight log, one reading per day'),
        'mood.json':   makeCard('mood',   'Mood',   'Daily mood 1-5'),
      },
    });
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

  test('system prompt lists the current cards', async () => {
    const res = await req(server.baseUrl, '/api/chat', {
      method: 'POST',
      body: { messages: [{ role: 'user', content: 'hi' }], voiceMode: false },
    });
    assert.equal(res.status, 200);
    const sp = gateway.getLastPrompt();
    assert.ok(sp, 'stub captured a system prompt');
    assert.ok(sp.includes('Currently available cards'), 'prompt has the cards header');
    assert.ok(sp.includes('weight'), 'prompt includes weight card id');
    assert.ok(sp.includes('mood'), 'prompt includes mood card id');
    assert.ok(sp.includes('Body weight log'), 'prompt includes weight description');
  });

  test('voice-mode prompt also includes the card list', async () => {
    const res = await req(server.baseUrl, '/api/chat', {
      method: 'POST',
      body: { messages: [{ role: 'user', content: 'hi' }], voiceMode: true },
    });
    assert.equal(res.status, 200);
    const sp = gateway.getLastPrompt();
    assert.ok(sp, 'stub captured a system prompt');
    assert.ok(sp.includes('Currently available cards'));
    assert.ok(sp.includes('weight'));
  });

  test('system prompt injects today\'s absolute date', async () => {
    const res = await req(server.baseUrl, '/api/chat', {
      method: 'POST',
      body: { messages: [{ role: 'user', content: 'hi' }], voiceMode: false },
    });
    assert.equal(res.status, 200);
    const sp = gateway.getLastPrompt();
    assert.ok(sp.includes("Today's date"), 'prompt has the date header');
    const today = new Date().toLocaleDateString('en-CA', { timeZone: process.env.TZ || undefined });
    assert.ok(sp.includes(today), `prompt includes today's ISO date (${today})`);
  });

  test('system prompt teaches schedule-card data.items[] shape', async () => {
    const res = await req(server.baseUrl, '/api/chat', {
      method: 'POST',
      body: { messages: [{ role: 'user', content: 'hi' }], voiceMode: false },
    });
    assert.equal(res.status, 200);
    const sp = gateway.getLastPrompt();
    assert.ok(sp.includes('data.items[]'), 'prompt mentions data.items[] for schedule-card');
    assert.ok(/never in .?meta\.schedule.?/i.test(sp), 'prompt warns against meta.schedule');
  });

  test('system prompt steers event-style logs at generic-card, not list-card', async () => {
    // Regression for #334: the prompt previously described list-card as
    // "persistent chronological list of entries; data is [{date,...}]",
    // which is wrong on both counts and led the agent to pick list-card
    // for per-day event logs (food log, stool log, etc.). The corrected
    // text must (a) NOT call list-card chronological/per-row-dated, and
    // (b) name maxReadingsPerDay or generic-card as the right answer
    // for multi-entry-per-day logging.
    const res = await req(server.baseUrl, '/api/chat', {
      method: 'POST',
      body: { messages: [{ role: 'user', content: 'hi' }], voiceMode: false },
    });
    assert.equal(res.status, 200);
    const sp = gateway.getLastPrompt();
    assert.ok(
      !/list-card[^.\n]*chronological/i.test(sp),
      'prompt must not describe list-card as chronological'
    );
    assert.ok(
      /list-card[\s\S]{0,400}(permanent roster|currently true|NOT per-day)/i.test(sp),
      'prompt must describe list-card as a non-per-day roster'
    );
    assert.ok(
      /maxReadingsPerDay/.test(sp),
      'prompt must mention maxReadingsPerDay as the multi-entry-per-day knob'
    );
  });

  test('system prompt forbids silent embellishments on create', async () => {
    const res = await req(server.baseUrl, '/api/chat', {
      method: 'POST',
      body: { messages: [{ role: 'user', content: 'hi' }], voiceMode: false },
    });
    assert.equal(res.status, 200);
    const sp = gateway.getLastPrompt();
    assert.ok(/embellishments are opt-in/i.test(sp), 'prompt states opt-in rule');
    assert.ok(sp.includes('meta.prompt'), 'prompt names meta.prompt as opt-in');
  });

  test('with zero cards, prompt says "(none yet)"', async () => {
    // Temporarily clear data/ then trigger another request
    const fs = require('fs');
    const path = require('path');
    fs.renameSync(
      path.join(sandbox, 'data', 'weight.json'),
      path.join(sandbox, 'data', '_weight.json.bak')
    );
    fs.renameSync(
      path.join(sandbox, 'data', 'mood.json'),
      path.join(sandbox, 'data', '_mood.json.bak')
    );
    // Poll until fs.watch has actually noticed, rather than sleeping a fixed
    // 500 ms and hoping. The reload is a filesystem event: fast when the machine
    // is idle, not guaranteed under a full parallel run.
    const sp = await waitFor(async () => {
      const r = await req(server.baseUrl, '/api/chat', {
        method: 'POST',
        body: { messages: [{ role: 'user', content: 'hi' }], voiceMode: false },
      });
      assert.equal(r.status, 200);
      const prompt = gateway.getLastPrompt();
      return prompt.includes('(none yet)') ? prompt : null;
    }, { what: 'the reload to drop the removed card from the prompt' });
    assert.ok(sp.includes('(none yet)'));

    // Restore
    fs.renameSync(
      path.join(sandbox, 'data', '_weight.json.bak'),
      path.join(sandbox, 'data', 'weight.json')
    );
    fs.renameSync(
      path.join(sandbox, 'data', '_mood.json.bak'),
      path.join(sandbox, 'data', 'mood.json')
    );
  });
});
