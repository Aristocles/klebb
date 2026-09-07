// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/api/issue-699.test.js
//
// Regression seed for #699: the write-date gate and the chat date block
// resolved "today" in the SERVER's timezone, not the user's. The client
// stamps rows with the browser-local date and reports its IANA timezone
// on every session boot (POST /api/user/tz), but findDateAllowanceViolation
// compared against the container clock. A UTC container therefore rejected
// every morning write from a UTC+10 browser as future-dated until 10:00
// local, and the chat agent believed it was still yesterday.
//
// Determinism: the server runs in Pacific/Niue (UTC-11) while the user
// reports Pacific/Kiritimati (UTC+14). Those wall clocks are 25 hours
// apart, so their calendar dates NEVER coincide, whatever the hour this
// suite runs at. Any assertion that the two zones disagree about "today"
// holds at every instant. Both names are canonical IANA zones; the Etc/*
// aliases are NOT in Intl.supportedValuesOf('timeZone') and would be
// rejected by POST /api/user/tz.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {
  createSandbox, cleanupSandbox,
  spawnServer, req,
  fakeAuthState,
} = require('../helpers/sandbox');

const SERVER_TZ = 'Pacific/Niue';      // UTC-11
const USER_TZ = 'Pacific/Kiritimati';  // UTC+14

function todayIn(tz) {
  return new Date().toLocaleDateString('en-CA', { timeZone: tz });
}
function shiftDays(iso, delta) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function todayOnlyCard(id) {
  return {
    $schema: 'klebb.datafile.v1',
    meta: {
      id,
      label: 'Sleep quality',
      view: { enabled: true, component: 'generic-card' },
      writeable: { fromWebapp: true, todayAllowed: true, pastAllowed: false, futureAllowed: false },
    },
    data: [],
  };
}

// Stub chat gateway that captures the system prompt from the last request.
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
      resolve({
        port: server.address().port,
        close: () => new Promise(r => server.close(r)),
        getLastPrompt: () => lastSystemPrompt,
      });
    });
  });
}

describe('issue-699: write gate follows the user timezone (user ahead of server)', () => {
  let sandbox, server, auth, gateway;

  before(async () => {
    gateway = await startStubGateway();
    auth = fakeAuthState();
    sandbox = createSandbox({
      seed: { 'sleep.json': todayOnlyCard('sleep') },
      credentials: auth.credentials,
      sessions: auth.sessions,
    });
    server = await spawnServer(sandbox, {
      TZ: SERVER_TZ,
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

  test('before any tz report, the gate falls back to the server TZ', async () => {
    const res = await req(server.baseUrl, '/api/manifests/sleep/data', {
      method: 'POST',
      cookie: auth.cookie,
      body: { data: [{ date: todayIn(USER_TZ), quality: 4 }] },
    });
    assert.equal(res.status, 403);
    assert.match(res.json.error, /future-dated/);
  });

  test('after the browser reports its tz, a today-local write succeeds', async () => {
    const tzRes = await req(server.baseUrl, '/api/user/tz', {
      method: 'POST',
      cookie: auth.cookie,
      body: { tz: USER_TZ },
    });
    assert.equal(tzRes.status, 200);

    const res = await req(server.baseUrl, '/api/manifests/sleep/data', {
      method: 'POST',
      cookie: auth.cookie,
      body: { data: [{ date: todayIn(USER_TZ), quality: 4 }] },
    });
    assert.equal(res.status, 200, `expected the morning write to pass, got ${res.body}`);
  });

  test('the gate still rejects a genuinely future date in the user tz', async () => {
    const res = await req(server.baseUrl, '/api/manifests/sleep/data', {
      method: 'POST',
      cookie: auth.cookie,
      body: { data: [{ date: todayIn(USER_TZ), quality: 4 }, { date: shiftDays(todayIn(USER_TZ), 7), quality: 5 }] },
    });
    assert.equal(res.status, 403);
    assert.match(res.json.error, /future-dated/);
  });

  test('chat date block reports today in the user tz, not the server tz', async () => {
    const res = await req(server.baseUrl, '/api/chat', {
      method: 'POST',
      cookie: auth.cookie,
      body: { messages: [{ role: 'user', content: 'hi' }], voiceMode: false },
    });
    assert.equal(res.status, 200);
    const sp = gateway.getLastPrompt();
    assert.ok(sp, 'stub captured a system prompt');
    // The lookup table spans +/- days around today so BOTH zones' dates
    // appear in it; only the "Today is <weekday>, <date>." line tells us
    // which zone the block was built in.
    assert.match(sp, new RegExp(`Today is \\w+, ${todayIn(USER_TZ)}\\.`),
      `date block must carry the user-tz date (${todayIn(USER_TZ)})`);
    assert.doesNotMatch(sp, new RegExp(`Today is \\w+, ${todayIn(SERVER_TZ)}\\.`),
      'date block must not carry the server-tz date');
  });

  test('diagnostics surfaces the effective user tz beside the server tz', async () => {
    const res = await req(server.baseUrl, '/api/diagnostics', { cookie: auth.cookie });
    assert.equal(res.status, 200);
    assert.equal(res.json.tz, SERVER_TZ);
    assert.equal(res.json.user_tz, USER_TZ);
  });
});

describe('issue-699: mirror case (user behind the server)', () => {
  let sandbox, server, auth;

  before(async () => {
    auth = fakeAuthState();
    sandbox = createSandbox({
      seed: { 'sleep.json': todayOnlyCard('sleep') },
      credentials: auth.credentials,
      sessions: auth.sessions,
    });
    server = await spawnServer(sandbox, { TZ: USER_TZ });
  });
  after(async () => {
    if (server) await server.kill();
    cleanupSandbox(sandbox);
  });

  test('an evening write from a UTC- browser is not rejected as past-dated', async () => {
    const tzRes = await req(server.baseUrl, '/api/user/tz', {
      method: 'POST',
      cookie: auth.cookie,
      body: { tz: SERVER_TZ },
    });
    assert.equal(tzRes.status, 200);

    const res = await req(server.baseUrl, '/api/manifests/sleep/data', {
      method: 'POST',
      cookie: auth.cookie,
      body: { data: [{ date: todayIn(SERVER_TZ), quality: 3 }] },
    });
    assert.equal(res.status, 200, `expected the evening write to pass, got ${res.body}`);
  });
});
