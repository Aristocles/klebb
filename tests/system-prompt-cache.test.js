// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/system-prompt-cache.test.js
// The system prompt is sent as cache-marked segments so the gateway can serve
// the stable part of it from cache instead of re-billing it on every step
// (#637). Caching is a PREFIX match, so the ordering is the whole mechanism:
// today's date used to sit second and the card in focus fourth, in front of
// roughly 25 kB of byte-stable catalogue text, which made nearly all of the
// prompt uncacheable.
//
// The sharpest guard in this file is the ORDER PIN in the integration block: it
// asserts a volatile heading cannot appear before a stable one. Without it, a
// future edit that appends a per-request block wherever it is convenient would
// silently switch caching off, and the only visible symptom would be the bill
// going up (cache writes are billed ABOVE uncached input, so a zero hit rate is
// worse than never having tried).

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { createSandbox, cleanupSandbox, spawnServer, req } = require('./helpers/sandbox');
const { buildSystemMessage, flattenSegments } = require('../chat/system-prompt');

const SEG = { static: 'STATIC.', instance: 'INSTANCE.', volatile: 'VOLATILE.' };

function makeCard(id) {
  return {
    $schema: 'klebb.datafile.v1',
    meta: { id, label: id, emoji: '.', view: { enabled: true, component: 'generic-card' } },
    description: id,
    data: [],
  };
}

// Records the request body so the wire format can be asserted rather than
// inferred from behaviour.
function startStubGateway() {
  const seen = [];
  const server = http.createServer((request, response) => {
    let raw = '';
    request.on('data', c => { raw += c; });
    request.on('end', () => {
      try { seen.push(JSON.parse(raw)); } catch { seen.push(null); }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'pong' } }],
      }));
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      seen,
      close: () => new Promise(r => server.close(r)),
    }));
  });
}

describe('buildSystemMessage segments the prompt without changing it', () => {
  test('caching off returns the flat string the gateway always received', () => {
    const msg = buildSystemMessage(SEG, { cache: false });
    assert.equal(msg.role, 'system');
    assert.equal(typeof msg.content, 'string');
    assert.equal(msg.content, 'STATIC.INSTANCE.VOLATILE.');
  });

  test('caching on preserves the exact same text, only regrouped', () => {
    const cached = buildSystemMessage(SEG, { cache: true });
    const flat = buildSystemMessage(SEG, { cache: false });
    assert.ok(Array.isArray(cached.content));
    // The escape hatch must be byte-identical, not merely similar: enabling
    // caching must never change what the model reads.
    assert.equal(cached.content.map(b => b.text).join(''), flat.content);
    assert.equal(cached.content.map(b => b.text).join(''), flattenSegments(SEG));
  });

  test('the volatile segment carries NO breakpoint and comes last', () => {
    const { content } = buildSystemMessage(SEG, { cache: true });
    const last = content[content.length - 1];
    assert.equal(last.text, 'VOLATILE.');
    assert.equal('cache_control' in last, false,
      'marking the volatile block would write a fresh cache entry every request');
  });

  test('adjacent cacheable segments collapse into one block with one breakpoint', () => {
    const { content } = buildSystemMessage(SEG, { cache: true });
    // static + instance are both cacheable and adjacent, so they share a block
    // rather than burning two of the four available breakpoints.
    assert.equal(content.length, 2);
    assert.equal(content[0].text, 'STATIC.INSTANCE.');
    assert.deepEqual(content[0].cache_control, { type: 'ephemeral' });
    const marked = content.filter(b => 'cache_control' in b).length;
    assert.equal(marked, 1);
  });

  test('empty segments are dropped so a breakpoint never lands on nothing', () => {
    // A brand-new instance has no cards and no reports.
    const { content } = buildSystemMessage(
      { static: 'S.', instance: '', volatile: 'V.' }, { cache: true },
    );
    assert.equal(content.length, 2);
    assert.equal(content[0].text, 'S.');
    assert.deepEqual(content[0].cache_control, { type: 'ephemeral' });
    assert.equal(content[1].text, 'V.');
    assert.equal('cache_control' in content[1], false);
  });

  test('a volatile-only prompt produces no breakpoint at all', () => {
    const { content } = buildSystemMessage(
      { static: '', instance: '', volatile: 'V.' }, { cache: true },
    );
    assert.equal(content.length, 1);
    assert.equal('cache_control' in content[0], false);
  });

  test('missing and non-string segments are treated as absent', () => {
    const msg = buildSystemMessage({ static: 'S.', volatile: null }, { cache: false });
    assert.equal(msg.content, 'S.');
  });

  test('one changed byte in the static segment changes the cached prefix', () => {
    // The unit-level stand-in for the live negative control: an unchanged
    // static segment must hash to the same bytes, and a one-byte edit must not.
    const a = buildSystemMessage(SEG, { cache: true }).content[0].text;
    const b = buildSystemMessage(SEG, { cache: true }).content[0].text;
    const c = buildSystemMessage({ ...SEG, static: 'STATIC!' }, { cache: true }).content[0].text;
    assert.equal(a, b);
    assert.notEqual(a, c);
  });
});

describe('#637 the chat payload carries cache breakpoints in the right order', () => {
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

  test('system content is blocks, breakpoint set, volatile block unmarked', async () => {
    const res = await req(server.baseUrl, '/api/chat', {
      method: 'POST', body: { messages: [{ role: 'user', content: 'hi' }], viewedCardId: 'w' },
    });
    assert.equal(res.status, 200);
    const sent = gateway.seen[gateway.seen.length - 1];
    const sys = sent.messages[0];
    assert.equal(sys.role, 'system');
    assert.ok(Array.isArray(sys.content), 'system content must be typed blocks when caching is on');
    assert.ok(sys.content.length >= 2, 'expected a cacheable block plus a volatile tail');
    assert.deepEqual(sys.content[0].cache_control, { type: 'ephemeral' });
    const last = sys.content[sys.content.length - 1];
    assert.equal('cache_control' in last, false);
  });

  test('ORDER PIN: volatile blocks must not precede stable ones', async () => {
    await req(server.baseUrl, '/api/chat', {
      method: 'POST', body: { messages: [{ role: 'user', content: 'hi' }], viewedCardId: 'w' },
    });
    const sent = gateway.seen[gateway.seen.length - 1];
    const sys = sent.messages[0];
    const whole = sys.content.map(b => b.text).join('');

    const today = whole.indexOf("## Today's date");
    const inFocus = whole.indexOf('## Card in focus');
    const categories = whole.indexOf('## Manifest categories');
    const cards = whole.indexOf('## Currently available cards');

    assert.ok(today > -1, 'the date block should still be in the prompt');
    assert.ok(categories > -1, 'the categories block should still be in the prompt');
    assert.ok(cards > -1, 'the card list should still be in the prompt');
    assert.ok(inFocus > -1, 'the focused card should still be in the prompt');

    // The regression this whole change exists to prevent.
    assert.ok(categories < today,
      'a static catalogue must come BEFORE the daily date, or nothing after the date caches');
    assert.ok(cards < today,
      'the per-instance card list must come before the daily date');
    assert.ok(today < inFocus || inFocus > cards,
      'the per-request focused card belongs in the volatile tail');

    // Both volatile headings must live in the final, unmarked block.
    const tail = sys.content[sys.content.length - 1].text;
    assert.ok(tail.includes("## Today's date"), 'the date belongs in the uncached tail');
    assert.ok(tail.includes('## Card in focus'), 'the focused card belongs in the uncached tail');
  });
});

describe('#637 CHAT_PROMPT_CACHE=0 restores the flat string', () => {
  let sandbox, server, gateway;

  before(async () => {
    gateway = await startStubGateway();
    sandbox = createSandbox({ seed: { 'w.json': makeCard('w') } });
    server = await spawnServer(sandbox, {
      CHAT_ENDPOINT_URL: `http://127.0.0.1:${gateway.port}/v1/chat/completions`,
      CHAT_API_KEY: 'k',
      CHAT_MODEL: 'm',
      CHAT_PROMPT_CACHE: '0',
    });
  });
  after(async () => {
    if (server) await server.kill();
    if (gateway) await gateway.close();
    cleanupSandbox(sandbox);
  });

  test('a gateway that cannot take content blocks gets a plain string', async () => {
    const res = await req(server.baseUrl, '/api/chat', {
      method: 'POST', body: { messages: [{ role: 'user', content: 'hi' }], viewedCardId: 'w' },
    });
    assert.equal(res.status, 200);
    const sys = gateway.seen[gateway.seen.length - 1].messages[0];
    assert.equal(typeof sys.content, 'string');
    // Still reordered: the escape hatch is about the payload SHAPE, not about
    // reverting the ordering fix.
    assert.ok(sys.content.indexOf('## Manifest categories') < sys.content.indexOf("## Today's date"));
  });
});
