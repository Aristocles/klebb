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
