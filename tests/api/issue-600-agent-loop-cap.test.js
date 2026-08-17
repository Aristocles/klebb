// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/api/issue-600-agent-loop-cap.test.js
// Multi-step chat requests died at a hardcoded 5-iteration agent-loop cap
// (#600). The prompt's own validate-before-create / read-before-append
// workflow makes a multi-card request cost well over five gateway
// round-trips, so legitimate requests ended with "I wasn't able to finish
// that in one turn" while the gateway logs showed nothing but successes.
//
// The rework: CHAT_MAX_TURNS (default 12) replaces the constant, a
// total-turn deadline (CHAT_TURN_DEADLINE_MS) stops a raised cap stacking
// per-iteration timeouts into a multi-minute silent spinner, capped replies
// carry a machine-readable `capped: true` plus a "keep going" hint the
// user can act on today, and the per-iteration timeout stops claiming the
// request "doesn't fit any of the tools" when the truth is a timeout.
//
// The stub gateway below answers every call with finish_reason
// 'tool_calls' (a cheap real tool, list_manifests) until a configured
// number of round-trips has happened, then finishes with text: the shape
// of a genuine multi-step turn, driven over real HTTP through the real
// transport and the real tool dispatcher.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { createSandbox, cleanupSandbox, spawnServer, req } = require('../helpers/sandbox');

function makeCard(id) {
  return {
    $schema: 'klebb.datafile.v1',
    meta: { id, label: id, emoji: '.', view: { enabled: true, component: 'generic-card' } },
    description: id,
    data: [],
  };
}

function startAgentStubGateway() {
  const state = { stepsNeeded: 1, delayMs: 0, toolContent: '' };
  let hits = 0;
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', c => { body += c; });
    request.on('end', () => {
      hits += 1;
      const n = hits;
      const send = () => {
        const payload = n >= state.stepsNeeded
          ? { choices: [{ finish_reason: 'stop', message: { content: 'all done' } }] }
          : {
              choices: [{
                finish_reason: 'tool_calls',
                message: {
                  content: state.toolContent,
                  tool_calls: [{
                    id: `call_${n}`,
                    type: 'function',
                    function: { name: 'list_manifests', arguments: '{}' },
                  }],
                },
              }],
            };
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(payload));
      };
      if (state.delayMs) setTimeout(send, state.delayMs);
      else send();
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        get hits() { return hits; },
        reset(next) { hits = 0; Object.assign(state, next); },
        close: () => new Promise(r => server.close(r)),
      });
    });
  });
}

describe('#600 the agent loop finishes multi-step turns', () => {
  let gateway;
  before(async () => { gateway = await startAgentStubGateway(); });
  after(async () => { if (gateway) await gateway.close(); });

  async function withChatServer(env, fn) {
    const sandbox = createSandbox({ seed: { 'w.json': makeCard('w') } });
    const server = await spawnServer(sandbox, {
      CHAT_ENDPOINT_URL: `http://127.0.0.1:${gateway.port}/v1/chat/completions`,
      CHAT_API_KEY: 'k',
      CHAT_MODEL: 'm',
      ...env,
    });
    try {
      return await fn(server);
    } finally {
      await server.kill();
      cleanupSandbox(sandbox);
    }
  }

  const ask = (server) => req(server.baseUrl, '/api/chat', {
    method: 'POST', body: { messages: [{ role: 'user', content: 'set up my cards' }] },
  });

  test('an 8-round-trip turn completes under the default cap', async () => {
    // Fails on the old code: the hardcoded cap of 5 stopped this turn three
    // round-trips short and answered with the capped fallback.
    gateway.reset({ stepsNeeded: 8 });
    await withChatServer({}, async (server) => {
      const res = await ask(server);
      assert.equal(res.status, 200);
      assert.equal(res.json?.reply, 'all done');
      assert.equal(res.json?.capped, undefined, 'a completed turn is not capped');
      assert.equal(gateway.hits, 8, 'the loop must run all eight round-trips');
    });
  });

  test('CHAT_MAX_TURNS is honoured and a capped reply says so', async () => {
    gateway.reset({ stepsNeeded: 8 });
    await withChatServer({ CHAT_MAX_TURNS: '3' }, async (server) => {
      const res = await ask(server);
      assert.equal(res.status, 200, 'a capped turn is a reply, not an error status');
      assert.equal(gateway.hits, 3, 'the env cap must bound the round-trips');
      assert.equal(res.json?.capped, true, 'the client needs a machine-readable flag');
      assert.match(res.json?.reply || '', /keep going/i,
        'the user must learn they can resume, not just be told to re-ask');
    });
  });

  test('a capped turn with partial progress keeps the progress text', async () => {
    gateway.reset({ stepsNeeded: 8, toolContent: 'Logged your weight.' });
    await withChatServer({ CHAT_MAX_TURNS: '2' }, async (server) => {
      const res = await ask(server);
      assert.equal(res.status, 200);
      assert.equal(res.json?.capped, true);
      assert.match(res.json?.reply || '', /^Logged your weight\./,
        'work already done must not be replaced by a generic failure line');
      assert.match(res.json?.reply || '', /keep going/i);
    });
  });

  test('the turn deadline stops the loop with a capped reply, not a timeout error', async () => {
    gateway.reset({ stepsNeeded: 8, delayMs: 300 });
    await withChatServer({ CHAT_TURN_DEADLINE_MS: '400' }, async (server) => {
      const res = await ask(server);
      assert.equal(res.status, 200,
        'running out of turn budget is a capped reply, never a 5xx');
      assert.equal(res.json?.capped, true);
      assert.ok(gateway.hits <= 2, `the deadline must stop new round-trips (saw ${gateway.hits})`);
      assert.match(res.json?.reply || '', /keep going/i);
    });
  });

  test('a per-step timeout is reported as a timeout, not as "no tool fits"', async () => {
    gateway.reset({ stepsNeeded: 8, delayMs: 800 });
    await withChatServer({ CHAT_ITER_TIMEOUT_MS: '200' }, async (server) => {
      const res = await ask(server);
      assert.equal(res.status, 200);
      const reply = res.json?.reply || '';
      assert.doesNotMatch(reply, /doesn't fit any of the tools/i,
        'a timeout misdescribed as a capability gap teaches users the feature is missing');
      assert.match(reply, /too long/i, 'the reply must name the real cause');
    });
  });
});
