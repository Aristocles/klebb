// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/gateway-usage.test.js
// Token and cache counters were discarded on both gateway paths (#636): the
// buffered path parsed them and threw them away, and the streaming assembler
// rebuilt a synthetic response that never carried them at all.
//
// That matters more than ordinary missing telemetry, because prompt-caching
// writes are billed ABOVE uncached input. A caching change that lands with a
// zero hit rate raises the bill, and with no counters the only visible symptom
// is spend going up, which reads as the customer simply using the product more.
//
// Two traps are pinned here, both measured against the real gateways rather
// than assumed:
//
//   1. The two gateways disagree on where cache counters live. One reports them
//      only under prompt_tokens_details; the other also mirrors them at the top
//      level under different names. Code that reads only the top-level pair
//      reports a confident zero on the first gateway.
//   2. Streaming usage arrives in a trailing chunk whose `choices` array is
//      EMPTY. An assembler that guards on the first choice before looking for
//      usage drops every count without erroring.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { readUsage, callGateway, createDeltaAssembler } = require('../lib/gateway');

// Shapes copied from real responses, not invented. Keeping them verbatim is the
// point: a future gateway swap that changes field names should break here.
const GATEWAY_A_ONLY_DETAILS = {
  usage: {
    prompt_tokens: 48617,
    completion_tokens: 5,
    cost: 0.0098004,
    prompt_tokens_details: { cached_tokens: 48602, cache_write_tokens: 0 },
  },
};

const GATEWAY_B_BOTH_PLACES = {
  usage: {
    prompt_tokens: 12815,
    completion_tokens: 5,
    cache_read_input_tokens: 12801,
    cache_creation_input_tokens: 0,
    prompt_tokens_details: { cached_tokens: 12801, cache_creation_tokens: 0 },
  },
};

// A stub gateway that records the request body it was sent, so the wire format
// can be asserted rather than inferred from behaviour.
function startStub() {
  const state = { status: 200, body: '{}', sse: null };
  const seen = [];
  const server = http.createServer((request, response) => {
    let raw = '';
    request.on('data', c => { raw += c; });
    request.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch { /* recorded as null */ }
      seen.push(parsed);
      if (state.sse) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const frame of state.sse) response.write(`data: ${JSON.stringify(frame)}\n\n`);
        response.write('data: [DONE]\n\n');
        response.end();
        return;
      }
      response.writeHead(state.status, { 'Content-Type': 'application/json' });
      response.end(state.body);
    });
  });
  return new Promise(resolve => {
    // Port 0: the harness has been bitten by fixed ports before.
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      seen,
      set(next) { Object.assign(state, next); },
      close: () => new Promise(r => server.close(r)),
    }));
  });
}

describe('readUsage normalises across both gateway shapes', () => {
  test('reads counters when they exist ONLY under prompt_tokens_details', () => {
    const u = readUsage(GATEWAY_A_ONLY_DETAILS);
    assert.equal(u.promptTokens, 48617);
    assert.equal(u.completionTokens, 5);
    // The regression: with a top-level-only reader this is 0, which is
    // indistinguishable from caching being switched off.
    assert.equal(u.cachedTokens, 48602);
    assert.equal(u.cacheWriteTokens, 0);
    assert.equal(u.cost, 0.0098004);
  });

  test('reads counters when mirrored at the top level too', () => {
    const u = readUsage(GATEWAY_B_BOTH_PLACES);
    assert.equal(u.promptTokens, 12815);
    assert.equal(u.cachedTokens, 12801);
    assert.equal(u.cacheWriteTokens, 0);
    // This gateway reports no cost; null rather than 0 so "not reported" and
    // "free" stay distinguishable.
    assert.equal(u.cost, null);
  });

  test('falls back to top-level names when prompt_tokens_details is absent', () => {
    const u = readUsage({
      usage: {
        prompt_tokens: 100,
        cache_read_input_tokens: 90,
        cache_creation_input_tokens: 10,
      },
    });
    assert.equal(u.cachedTokens, 90);
    assert.equal(u.cacheWriteTokens, 10);
  });

  test('cache_creation_tokens is accepted as a write-counter alias', () => {
    const u = readUsage({ usage: { prompt_tokens: 5, prompt_tokens_details: { cache_creation_tokens: 42 } } });
    assert.equal(u.cacheWriteTokens, 42);
  });

  test('a real zero beats the fallback rather than falling through to it', () => {
    // Guards `??` against a regression to `||`. With `||` this reports 999 and
    // would invent a cache hit that never happened.
    const u = readUsage({
      usage: {
        prompt_tokens: 10,
        cache_read_input_tokens: 999,
        prompt_tokens_details: { cached_tokens: 0 },
      },
    });
    assert.equal(u.cachedTokens, 0);
  });

  test('returns null when no usage is reported at all', () => {
    assert.equal(readUsage({ choices: [] }), null);
    assert.equal(readUsage({}), null);
    assert.equal(readUsage(null), null);
    assert.equal(readUsage({ usage: 'nonsense' }), null);
  });

  test('non-numeric counters degrade to 0 rather than undefined or NaN', () => {
    const u = readUsage({ usage: { prompt_tokens: null, completion_tokens: 'x' } });
    assert.equal(u.promptTokens, 0);
    assert.equal(u.completionTokens, 0);
    assert.ok(!Number.isNaN(u.cachedTokens));
  });
});

describe('the streaming assembler captures usage from an empty-choices chunk', () => {
  test('usage on a chunk with choices: [] is kept, not dropped', () => {
    const a = createDeltaAssembler(null);
    a.take({ choices: [{ delta: { content: 'hi' }, finish_reason: null }] });
    a.take({ choices: [{ delta: {}, finish_reason: 'stop' }] });
    // The shape that broke it: no choices at all, usage only.
    a.take({ choices: [], usage: { prompt_tokens: 7, prompt_tokens_details: { cached_tokens: 6 } } });
    const out = a.result();
    assert.equal(out.choices[0].message.content, 'hi');
    assert.equal(out.choices[0].finish_reason, 'stop');
    assert.ok(out.usage, 'usage must survive onto the assembled result');
    assert.equal(readUsage(out).cachedTokens, 6);
  });

  test('result carries no usage key when the gateway reported none', () => {
    const a = createDeltaAssembler(null);
    a.take({ choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }] });
    assert.equal('usage' in a.result(), false);
    assert.equal(readUsage(a.result()), null);
  });
});

describe('callGateway over real http', () => {
  test('buffered: usage survives to the caller', async () => {
    const stub = await startStub();
    try {
      stub.set({
        body: JSON.stringify({
          choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'pong' } }],
          ...GATEWAY_A_ONLY_DETAILS,
        }),
      });
      const res = await callGateway({
        messages: [{ role: 'user', content: 'ping' }],
        endpointUrl: `http://127.0.0.1:${stub.port}/v1/chat/completions`,
        model: 'stub',
        apiKey: 'k',
      });
      assert.equal(readUsage(res).cachedTokens, 48602);
      // Asking for usage is a streaming-only concern; it must not appear here.
      assert.equal('stream_options' in stub.seen[0], false);
      assert.equal('stream' in stub.seen[0], false);
    } finally {
      await stub.close();
    }
  });

  test('streaming: stream_options is sent and trailing usage is returned', async () => {
    const stub = await startStub();
    try {
      stub.set({
        sse: [
          { choices: [{ delta: { role: 'assistant', content: 'po' }, finish_reason: null }] },
          { choices: [{ delta: { content: 'ng' }, finish_reason: 'stop' }] },
          { choices: [], ...GATEWAY_B_BOTH_PLACES },
        ],
      });
      const deltas = [];
      const res = await callGateway({
        messages: [{ role: 'user', content: 'ping' }],
        endpointUrl: `http://127.0.0.1:${stub.port}/v1/chat/completions`,
        model: 'stub',
        apiKey: 'k',
        stream: true,
        onDelta: ({ content }) => deltas.push(content),
      });
      // Without this on the wire the gateway sends no usage block at all, so
      // the assertion below can only pass for the right reason.
      assert.deepEqual(stub.seen[0].stream_options, { include_usage: true });
      assert.equal(deltas.join(''), 'pong');
      assert.equal(res.choices[0].message.content, 'pong');
      assert.equal(readUsage(res).cachedTokens, 12801);
      assert.equal(readUsage(res).promptTokens, 12815);
    } finally {
      await stub.close();
    }
  });

  test('streaming with no usage chunk still resolves normally', async () => {
    const stub = await startStub();
    try {
      stub.set({
        sse: [{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }],
      });
      const res = await callGateway({
        messages: [{ role: 'user', content: 'ping' }],
        endpointUrl: `http://127.0.0.1:${stub.port}/v1/chat/completions`,
        model: 'stub',
        apiKey: 'k',
        stream: true,
      });
      assert.equal(res.choices[0].message.content, 'ok');
      assert.equal(readUsage(res), null);
    } finally {
      await stub.close();
    }
  });
});
