// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/conversations-store.test.js
// The conversations store (#603): SQLite-durable chat transcripts in the
// per-instance database, superseding the single history.json. The caps are
// the contract: 100 conversations pruned by least-recent activity, 200
// messages per conversation, and the same message sanitisation rules the
// legacy history endpoint enforced (plus hasVoice, so a spoken reply keeps
// its player across reloads).

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const conversations = require('../lib/conversations');

describe('#603 conversations store', () => {
  let dir, store;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klebb-convo-'));
    store = conversations.open(path.join(dir, 'klebb.db'));
  });
  afterEach(() => {
    try { store.close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('create + get round-trips title and sanitised messages', () => {
    const created = store.create({
      title: '  Weight setup  ',
      messages: [
        { role: 'user', content: 'hi', junk: 'dropped' },
        { role: 'assistant', content: 'hello', hasVoice: true },
        { role: 'tool', content: 'never persisted' },
        { role: 'assistant', content: 42 },
      ],
    });
    assert.ok(created.id);
    const got = store.get(created.id);
    assert.equal(got.messages.length, 2, 'tool turns and non-string content are dropped');
    assert.equal(got.messages[0].junk, undefined);
    assert.equal(got.messages[1].hasVoice, true);
    assert.ok(got.createdAt && got.updatedAt);
  });

  test('list orders by recency of activity, not creation', async () => {
    const a = store.create({ title: 'a' });
    await new Promise(r => setTimeout(r, 5));
    const b = store.create({ title: 'b' });
    await new Promise(r => setTimeout(r, 5));
    store.setMessages(a.id, [{ role: 'user', content: 'bump' }]);
    const list = store.list();
    assert.deepEqual(list.map(c => c.id), [a.id, b.id], 'touching a conversation moves it up');
    assert.equal(list[0].messageCount, 1);
  });

  test('the 101st conversation prunes the least recent, never itself', () => {
    for (let i = 0; i < conversations.MAX_CONVERSATIONS; i++) store.create({ title: `c${i}` });
    const last = store.create({ title: 'newest' });
    const list = store.list();
    assert.equal(list.length, conversations.MAX_CONVERSATIONS, 'the cap holds');
    assert.ok(store.get(last.id), 'the conversation just created must survive its own prune');
  });

  test('messages cap at the last 200', () => {
    const many = Array.from({ length: 250 }, (_, i) => ({ role: 'user', content: `m${i}` }));
    const c = store.create({});
    store.setMessages(c.id, many);
    const got = store.get(c.id);
    assert.equal(got.messages.length, conversations.MAX_MESSAGES);
    assert.equal(got.messages.at(-1).content, 'm249', 'the newest messages survive');
  });

  test('embellishment chips keep the legacy validation rules', () => {
    const c = store.create({
      messages: [{
        role: 'assistant', content: 'made it',
        followupText: 'Want more?',
        embellishments: [
          { label: 'Add sparkline', prompt: 'add a sparkline' },
          { label: 12, prompt: 'bad' },
          'garbage',
        ],
      }],
    });
    const [msg] = store.get(c.id).messages;
    assert.equal(msg.followupText, 'Want more?');
    assert.deepEqual(msg.embellishments, [{ label: 'Add sparkline', prompt: 'add a sparkline' }]);
  });

  test('appendMessages extends an existing transcript', () => {
    const c = store.create({ messages: [{ role: 'user', content: 'one' }] });
    assert.equal(store.appendMessages(c.id, [{ role: 'assistant', content: 'two' }]), true);
    assert.deepEqual(store.get(c.id).messages.map(m => m.content), ['one', 'two']);
    assert.equal(store.appendMessages('nope', [{ role: 'user', content: 'x' }]), false);
  });

  test('rename trims, caps at 120 chars, and reports unknown ids', () => {
    const c = store.create({});
    assert.equal(store.rename(c.id, '  My chat  '), true);
    assert.equal(store.get(c.id).title, 'My chat');
    assert.equal(store.rename(c.id, 'x'.repeat(300)), true);
    assert.equal(store.get(c.id).title.length, 120);
    assert.equal(store.rename('nope', 'title'), false);
  });

  test('remove and misses', () => {
    const c = store.create({});
    assert.equal(store.remove(c.id), true);
    assert.equal(store.get(c.id), null);
    assert.equal(store.remove(c.id), false);
    assert.equal(store.setMessages('nope', []), false);
  });

  test('data survives close and reopen (durability)', () => {
    const c = store.create({ title: 'keep', messages: [{ role: 'user', content: 'persist me' }] });
    store.close();
    store = conversations.open(path.join(dir, 'klebb.db'));
    const got = store.get(c.id);
    assert.equal(got.title, 'keep');
    assert.equal(got.messages[0].content, 'persist me');
  });

  test('coexists with the card datastore in the same file', () => {
    const datastore = require('../lib/datastore');
    const cards = datastore.open(path.join(dir, 'klebb.db'));
    try {
      cards.setData('weight', [{ date: '2026-08-17', kg: 80 }]);
      const c = store.create({ title: 'both' });
      assert.deepEqual(cards.getData('weight'), [{ date: '2026-08-17', kg: 80 }]);
      assert.ok(store.get(c.id));
    } finally {
      cards.close();
    }
  });
});

describe('#659 conversation search', () => {
  let dir, store;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klebb-convo-search-'));
    store = conversations.open(path.join(dir, 'klebb.db'));
  });
  afterEach(() => {
    try { store.close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const seed = async (rows) => {
    const ids = {};
    for (const [title, messages] of rows) {
      ids[title] = store.create({ title, messages }).id;
      // Recency ties break on id, so keep the inserts a tick apart.
      await new Promise(r => setTimeout(r, 5));
    }
    return ids;
  };

  test('matches titles case-insensitively, newest-first', async () => {
    await seed([['Bloods panel', []], ['sleep NOTES', []], ['Peptide cycle', []]]);
    assert.deepEqual(store.search('BLOODS').map(c => c.title), ['Bloods panel']);
    assert.deepEqual(store.search('notes').map(c => c.title), ['sleep NOTES']);
    const two = store.search('le');
    assert.deepEqual(two.map(c => c.title), ['Peptide cycle', 'sleep NOTES'],
      'results keep list() recency order');
  });

  test('matches message text and returns an excerpt of the hit', async () => {
    await seed([
      ['Bloods panel', [{ role: 'user', content: 'my ferritin came back at 40' }]],
      ['Sleep notes', [{ role: 'assistant', content: 'try magnesium before bed' }]],
    ]);
    const hits = store.search('magnesium');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].title, 'Sleep notes');
    assert.match(hits[0].snippet, /magnesium before bed/);
    assert.equal(hits[0].messageCount, 1, 'search returns list() summaries');
  });

  test('a title-only hit carries no snippet', async () => {
    await seed([['Ferritin', [{ role: 'user', content: 'unrelated body text' }]]]);
    const [hit] = store.search('ferritin');
    assert.equal(hit.snippet, undefined);
  });

  test('the excerpt is one line, windowed and ellipsised', async () => {
    const long = `${'a'.repeat(200)} the\ncreatine\tdose ${'b'.repeat(200)}`;
    await seed([['Long', [{ role: 'user', content: long }]]]);
    const [hit] = store.search('creatine');
    assert.ok(hit.snippet.startsWith('…') && hit.snippet.endsWith('…'), 'windowed both ends');
    assert.ok(!/[\n\t]/.test(hit.snippet), 'newlines and tabs collapse to spaces');
    assert.ok(hit.snippet.length < 120, `stayed short: ${hit.snippet.length}`);
    assert.match(hit.snippet, /the creatine dose/);
  });

  test('a term that only appears in the stored JSON structure finds nothing', async () => {
    await seed([['Plain', [{ role: 'user', content: 'nothing structural here' }]]]);
    // 'role' and 'content' are keys in every persisted message, so a raw scan
    // of the column would match every row.
    assert.deepEqual(store.search('role'), []);
    assert.deepEqual(store.search('content'), []);
  });

  test('regex metacharacters are literal', async () => {
    await seed([['Cat', [{ role: 'user', content: 'cat' }]]]);
    assert.deepEqual(store.search('c.t'), [], 'a dot is not a wildcard');
    assert.deepEqual(store.search('.*'), [], 'a quantifier matches nothing');
    assert.equal(store.search('cat').length, 1);
  });

  test('an empty or blank term is the full list', async () => {
    await seed([['One', []], ['Two', []]]);
    assert.deepEqual(store.search('').map(c => c.title), store.list().map(c => c.title));
    assert.equal(store.search('   ').length, 2);
    assert.equal(store.search(null).length, 2);
    assert.equal(store.search(undefined).length, 2);
  });

  test('an untitled conversation is still findable by its text', async () => {
    store.create({ messages: [{ role: 'user', content: 'log my weight' }] });
    const [hit] = store.search('weight');
    assert.equal(hit.title, null);
    assert.match(hit.snippet, /log my weight/);
  });
});
