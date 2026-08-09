// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/chat-gateway-failure-modes.test.js
// Four gateway conditions used to collapse into the single string 'No response'
// (#547): an exhausted allowance, a dead gateway, a timeout and a genuinely
// empty reply all read as the app being broken.
//
// The bug was one layer below where it looked: lib/gateway.js resolved
// JSON.parse(body) without ever reading proxyRes.statusCode, so the 429 the
// whole issue depends on was discarded before /api/chat could see it. These
// tests drive a REAL stub gateway over REAL http through the real transport, so
// they would have failed against the old code for the right reason.
//
// The sharpest guard here is the bare 429: plain rate limiting is NOT an
// exhausted allowance, and reporting it as one sends someone to check their
// billing over a transient blip.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { createSandbox, cleanupSandbox, spawnServer, req } = require('./helpers/sandbox');
const {
  classifyGatewayError, looksLikeBudgetExhaustion, callGateway,
} = require('../lib/gateway');

function makeCard(id) {
  return {
    $schema: 'klebb.datafile.v1',
    meta: { id, label: id, emoji: '.', view: { enabled: true, component: 'generic-card' } },
    description: id,
    data: [],
  };
}

// A stub gateway whose reply is set per test, so one server serves every
// condition. `respond` returns { status, body } or a function for oddities.
function startStubGateway() {
  const state = { status: 200, body: JSON.stringify({ choices: [{ message: { content: 'pong' } }] }), delayMs: 0 };
  const hits = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', c => { body += c; });
    request.on('end', () => {
      hits.push({ url: request.url });
      const send = () => {
        response.writeHead(state.status, { 'Content-Type': 'application/json' });
        response.end(state.body);
      };
      if (state.delayMs) setTimeout(send, state.delayMs);
      else send();
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        hits,
        set(next) { Object.assign(state, next); },
        close: () => new Promise(r => server.close(r)),
      });
    });
  });
}

// The wording the deployed gateway actually uses. Taken from its own source
// (BudgetExceededError carries status 429 with these message templates), not
// invented, so a gateway upgrade that changes the wording fails this test
// rather than silently degrading to the transient message in production.
const REAL_BUDGET_BODIES = [
  JSON.stringify({ error: { message: 'Budget has been exceeded! Key=klebb-eddz Current cost: 12.03, Max budget: 12.0', type: 'budget_exceeded', code: '429' } }),
  JSON.stringify({ error: { message: 'ExceededBudget: User=klebb over budget. Spend=150.2, Budget=150.0', type: 'budget_exceeded', code: '429' } }),
];

describe('#547 lib/gateway classifies causes from the HTTP status', () => {
  let gateway;
  before(async () => { gateway = await startStubGateway(); });
  after(async () => { if (gateway) await gateway.close(); });

  const call = () => callGateway({
    messages: [{ role: 'user', content: 'hi' }],
    endpointUrl: `http://127.0.0.1:${gateway.port}/v1/chat/completions`,
    apiKey: 'k', model: 'm', timeoutMs: 4000,
  });

  test('a 429 WITH a budget marker rejects as gateway_budget', async () => {
    for (const body of REAL_BUDGET_BODIES) {
      gateway.set({ status: 429, body });
      const err = await call().then(() => null, e => e);
      assert.ok(err, 'must reject, not resolve an error body as a reply');
      assert.match(err.message, /^gateway_budget:/, `real gateway wording must be detected: ${body.slice(0, 60)}`);
      assert.equal(classifyGatewayError(err), 'budget');
    }
  });

  test('a BARE 429 is plain rate limiting: transient, NOT budget', async () => {
    // The easiest guard to get backwards, and the most damaging: claiming an
    // allowance ran out when it did not.
    gateway.set({ status: 429, body: JSON.stringify({ error: { message: 'Too many requests. Please retry.', type: 'rate_limit_error' } }) });
    const err = await call().then(() => null, e => e);
    assert.ok(err);
    assert.match(err.message, /^gateway_http_429:/);
    assert.equal(classifyGatewayError(err), 'transient',
      'a 429 without a budget marker must never be reported as an exhausted allowance');
  });

  test('a 503 rejects as an http error and classifies transient', async () => {
    gateway.set({ status: 503, body: JSON.stringify({ error: { message: 'upstream down' } }) });
    const err = await call().then(() => null, e => e);
    assert.match(err.message, /^gateway_http_503:/);
    assert.equal(classifyGatewayError(err), 'transient');
  });

  test('a 401 (bad key) is transient to the user, never budget', async () => {
    // Real wording from the deployed gateway for an unknown key.
    gateway.set({ status: 401, body: JSON.stringify({ error: { message: 'Authentication Error, Invalid proxy server token passed', type: 'token_not_found_in_db', code: '401' } }) });
    const err = await call().then(() => null, e => e);
    assert.match(err.message, /^gateway_http_401:/);
    assert.equal(classifyGatewayError(err), 'transient',
      'a misconfigured key is an operator problem, not the user\'s allowance');
  });

  test('a non-JSON error page does not crash the classifier', async () => {
    gateway.set({ status: 502, body: '<html><body>Bad Gateway</body></html>' });
    const err = await call().then(() => null, e => e);
    assert.match(err.message, /^gateway_http_502:/);
    assert.equal(classifyGatewayError(err), 'transient');
  });

  test('a 200 with unparseable body still rejects as gateway_parse', async () => {
    gateway.set({ status: 200, body: 'not json at all' });
    const err = await call().then(() => null, e => e);
    assert.match(err.message, /^gateway_parse:/);
    assert.equal(classifyGatewayError(err), 'parse');
  });

  test('a 200 with a valid reply still resolves (the negative)', async () => {
    gateway.set({ status: 200, body: JSON.stringify({ choices: [{ message: { content: 'pong' } }] }) });
    const out = await call();
    assert.equal(out.choices[0].message.content, 'pong');
  });

  test('looksLikeBudgetExhaustion requires BOTH a 429 and a marker', () => {
    assert.equal(looksLikeBudgetExhaustion(429, 'Budget has been exceeded!'), true);
    assert.equal(looksLikeBudgetExhaustion(429, 'too many requests'), false, 'bare 429 is not budget');
    assert.equal(looksLikeBudgetExhaustion(500, 'Budget has been exceeded!'), false,
      'a budget word in a 500 body is not an allowance signal');
    assert.equal(looksLikeBudgetExhaustion(200, 'Budget has been exceeded!'), false);
  });
});

describe('#547 /api/chat says something true and distinct per cause', () => {
  let sandbox, server, gateway;

  before(async () => {
    gateway = await startStubGateway();
    sandbox = createSandbox({ seed: { 'w.json': makeCard('w') } });
    server = await spawnServer(sandbox, {
      CHAT_ENDPOINT_URL: `http://127.0.0.1:${gateway.port}/v1/chat/completions`,
      CHAT_API_KEY: 'k',
      CHAT_MODEL: 'm',
    });
  });
  after(async () => {
    if (server) await server.kill();
    if (gateway) await gateway.close();
    cleanupSandbox(sandbox);
  });

  const ask = () => req(server.baseUrl, '/api/chat', {
    method: 'POST', body: { messages: [{ role: 'user', content: 'hi' }] },
  });

  test('exhausted allowance: 429 and an allowance message, not "No response"', async () => {
    gateway.set({ status: 429, body: REAL_BUDGET_BODIES[0] });
    const res = await ask();
    assert.equal(res.status, 429);
    const err = res.json?.error || '';
    assert.match(err, /allowance/i, 'must name the allowance');
    assert.doesNotMatch(err, /No response/i, 'the whole point of #547');
    assert.doesNotMatch(err, /sorry|apolog/i, 'a limit is not something to apologise for');
    // The reset date is deliberately absent: the window is not visible here and
    // a wrong date is worse than none.
    assert.doesNotMatch(err, /\b20\d\d\b|\bJan|\bFeb|\bMar|\bApr|\bMay|\bJun|\bJul|\bAug|\bSep|\bOct|\bNov|\bDec/,
      'must not invent a reset date');
  });

  test('outage: 502 and a transient message, with NO budget claim', async () => {
    gateway.set({ status: 503, body: JSON.stringify({ error: { message: 'upstream down' } }) });
    const res = await ask();
    assert.equal(res.status, 502);
    const err = res.json?.error || '';
    assert.doesNotMatch(err, /allowance|budget|quota/i,
      'an outage reported as exhaustion sends the user to check billing for nothing');
    assert.doesNotMatch(err, /No response/i);
  });

  test('bare 429: transient message, NOT the allowance message', async () => {
    gateway.set({ status: 429, body: JSON.stringify({ error: { message: 'Too many requests' } }) });
    const res = await ask();
    assert.equal(res.status, 502, 'plain rate limiting is a transient fault');
    assert.doesNotMatch(res.json?.error || '', /allowance|budget/i);
  });

  test('empty reply from a healthy gateway: its own distinct message', async () => {
    gateway.set({ status: 200, body: JSON.stringify({ choices: [{ message: { content: '' } }] }) });
    const res = await ask();
    assert.equal(res.status, 200, 'a healthy gateway that said nothing is not an error status');
    const reply = res.json?.reply || '';
    assert.ok(reply.length > 0, 'something must be shown');
    assert.doesNotMatch(reply, /allowance|budget|unavailable/i,
      'an empty reply is not an outage and not an allowance problem');
    assert.notEqual(reply, 'No response');
  });

  test('unreadable 200: parse message, no budget claim', async () => {
    gateway.set({ status: 200, body: 'definitely not json' });
    const res = await ask();
    assert.equal(res.status, 500);
    assert.doesNotMatch(res.json?.error || '', /allowance|budget/i);
  });

  test('the negative: a healthy reply renders none of the above', async () => {
    gateway.set({ status: 200, body: JSON.stringify({ choices: [{ message: { content: 'all good' } }] }) });
    const res = await ask();
    assert.equal(res.status, 200);
    assert.equal(res.json?.reply, 'all good');
    assert.equal(res.json?.error, undefined);
  });
});

// The second consumer. #547's correction requires it change in the same pass:
// a report that degraded to raw text because the allowance ran out is a
// different problem from one that hit a dead gateway.
describe('#547 report comprehension names the same causes', () => {
  const { comprehend } = require('../ingest/comprehend');

  const rejectWith = msg => () => Promise.reject(new Error(msg));

  test('budget exhaustion is named in the reason', async () => {
    const out = await comprehend({
      text: 'Haemoglobin 145 g/L', sourceFormat: 'pdf', configured: true,
      callGatewayFn: rejectWith('gateway_budget: Budget has been exceeded! Key=x'),
    });
    assert.equal(out.status, 'raw');
    assert.match(out.reason, /allowance/i);
    assert.doesNotMatch(out.reason, /unreachable|timed out/i);
  });

  test('a bare 429 degrades as transient, NOT as an allowance problem', async () => {
    const out = await comprehend({
      text: 'Haemoglobin 145 g/L', sourceFormat: 'pdf', configured: true,
      callGatewayFn: rejectWith('gateway_http_429: Too many requests'),
    });
    assert.equal(out.status, 'raw');
    assert.doesNotMatch(out.reason, /allowance/i,
      'plain rate limiting must not be reported as an exhausted allowance');
  });

  test('a 5xx degrades with its own reason', async () => {
    const out = await comprehend({
      text: 'Haemoglobin 145 g/L', sourceFormat: 'pdf', configured: true,
      callGatewayFn: rejectWith('gateway_http_503: upstream down'),
    });
    assert.equal(out.status, 'raw');
    assert.doesNotMatch(out.reason, /allowance/i);
  });

  test('timeout keeps its existing distinct reason (no regression)', async () => {
    const out = await comprehend({
      text: 'Haemoglobin 145 g/L', sourceFormat: 'pdf', configured: true,
      callGatewayFn: rejectWith('gateway_timeout'),
    });
    assert.match(out.reason, /timed out/i);
  });

  test('unreachable keeps its existing distinct reason (no regression)', async () => {
    const out = await comprehend({
      text: 'Haemoglobin 145 g/L', sourceFormat: 'pdf', configured: true,
      callGatewayFn: rejectWith('gateway_unavailable: ECONNREFUSED'),
    });
    assert.match(out.reason, /unreachable/i);
  });
});
