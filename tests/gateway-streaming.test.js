// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/gateway-streaming.test.js
// lib/gateway's streaming mode (#601): `stream: true` asks the gateway for
// server-sent events, onDelta fires per content fragment, and the resolved
// value is assembled into the exact shape the buffered mode returns, so the
// agent loop cannot tell which transport ran. The typed error contract
// (#547) must hold identically: a budget 429 mid-handshake, an idle stall
// mid-stream, and an unreadable body each keep their classification.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { callGateway, classifyGatewayError } = require('../lib/gateway');

// One stub server, reconfigured per test. Modes:
//   frames:    write each string, then end (SSE happy paths)
//   hold:      write the first frame, then go silent without ending
//   status:    non-2xx with a JSON body
//   raw:       2xx with a verbatim body (gateway that ignored stream:true)
function startStreamStub() {
  const state = { mode: 'frames', frames: [], status: 200, body: '' };
  let held = null;
  const server = http.createServer((request, response) => {
    let reqBody = '';
    request.on('data', c => { reqBody += c; });
    request.on('end', () => {
      if (state.mode === 'status') {
        response.writeHead(state.status, { 'Content-Type': 'application/json' });
        response.end(state.body);
        return;
      }
      if (state.mode === 'raw') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(state.body);
        return;
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (state.mode === 'hold') {
        response.write(state.frames[0] || ': open\n\n');
        held = response;
        return;
      }
      for (const f of state.frames) response.write(f);
      response.end();
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        set(next) { Object.assign(state, next); },
        close: () => new Promise(r => {
          if (held && !held.writableEnded) { try { held.destroy(); } catch {} }
          server.close(r);
        }),
      });
    });
  });
}

const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

describe('#601 gateway streaming mode', () => {
  let stub;
  before(async () => { stub = await startStreamStub(); });
  after(async () => { if (stub) await stub.close(); });

  const call = (extra = {}) => callGateway({
    messages: [{ role: 'user', content: 'hi' }],
    endpointUrl: `http://127.0.0.1:${stub.port}/v1/chat/completions`,
    apiKey: 'k', model: 'm', timeoutMs: 4000, stream: true,
    ...extra,
  });

  test('content fragments assemble and fire onDelta in order', async () => {
    stub.set({
      mode: 'frames',
      frames: [
        sse({ choices: [{ delta: { role: 'assistant', content: 'Hel' } }] }),
        sse({ choices: [{ delta: { content: 'lo' } }] }),
        sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
        'data: [DONE]\n\n',
      ],
    });
    const deltas = [];
    const out = await call({ onDelta: d => deltas.push(d.content) });
    assert.equal(out.choices[0].message.content, 'Hello');
    assert.equal(out.choices[0].finish_reason, 'stop');
    assert.deepEqual(deltas, ['Hel', 'lo']);
    assert.equal(out.choices[0].message.tool_calls, undefined,
      'a pure-content reply must not grow an empty tool_calls array');
  });

  test('tool_call fragments assemble across chunks by index', async () => {
    stub.set({
      mode: 'frames',
      frames: [
        sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'append_row', arguments: '' } }] } }] }),
        sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"id":"we' } }] } }] }),
        sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ight"}' } }] } }] }),
        sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
        'data: [DONE]\n\n',
      ],
    });
    const out = await call();
    const tc = out.choices[0].message.tool_calls[0];
    assert.equal(tc.id, 'call_1');
    assert.equal(tc.function.name, 'append_row');
    assert.equal(tc.function.arguments, '{"id":"weight"}');
    assert.equal(out.choices[0].finish_reason, 'tool_calls');
  });

  test('a budget 429 keeps its classification with stream requested', async () => {
    stub.set({ mode: 'status', status: 429, body: JSON.stringify({ error: { message: 'Budget has been exceeded! Key=k', type: 'budget_exceeded' } }) });
    const err = await call().then(() => null, e => e);
    assert.ok(err, 'must reject');
    assert.match(err.message, /^gateway_budget:/);
    assert.equal(classifyGatewayError(err), 'budget');
  });

  test('an idle stall mid-stream trips the soft timeout', async () => {
    stub.set({
      mode: 'hold',
      frames: [sse({ choices: [{ delta: { content: 'partial ' } }] })],
    });
    const t0 = Date.now();
    const err = await call({ timeoutMs: 400 }).then(() => null, e => e);
    assert.ok(err, 'a stalled stream must reject, not hang');
    assert.equal(err.message, 'gateway_iter_timeout');
    assert.ok(Date.now() - t0 < 4000, 'must trip on the idle timeout, not the hard ceiling');
  });

  test('a gateway that ignores stream:true and answers plain JSON is tolerated', async () => {
    stub.set({ mode: 'raw', body: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'pong' } }] }) });
    const out = await call();
    assert.equal(out.choices[0].message.content, 'pong');
  });

  test('a 2xx stream with no parseable frames rejects as gateway_parse', async () => {
    stub.set({ mode: 'raw', body: 'not json, not sse' });
    const err = await call().then(() => null, e => e);
    assert.match(err.message, /^gateway_parse:/);
    assert.equal(classifyGatewayError(err), 'parse');
  });

  test('the buffered mode is untouched by the streaming plumbing', async () => {
    stub.set({ mode: 'raw', body: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'pong' } }] }) });
    const out = await callGateway({
      messages: [{ role: 'user', content: 'hi' }],
      endpointUrl: `http://127.0.0.1:${stub.port}/v1/chat/completions`,
      apiKey: 'k', model: 'm', timeoutMs: 4000,
    });
    assert.equal(out.choices[0].message.content, 'pong');
  });
});
