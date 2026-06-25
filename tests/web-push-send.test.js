// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/web-push-send.test.js
//
// Unit tests for the wire-payload builder and the dispatch path. The
// actual web-push package call is monkey-patched so we never hit a real
// FCM/APNs/Mozilla endpoint.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function freshHome() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klebb-send-'));
  process.env.HEALTH_VAPID_FILE = path.join(root, 'keys', 'vapid.json');
  process.env.HEALTH_PUSH_SUBSCRIPTIONS_FILE = path.join(root, 'push-subscriptions.json');
  process.env.HEALTH_NOTIFICATIONS_STATE_FILE = path.join(root, 'notifications.state.json');
  for (const k of Object.keys(require.cache)) {
    if (k.endsWith('config' + path.sep + 'paths.js')
      || k.includes('lib' + path.sep + 'vapid')
      || k.includes('lib' + path.sep + 'push-subscriptions')
      || k.includes('lib' + path.sep + 'notifications-state')
      || k.includes('lib' + path.sep + 'web-push-send')) {
      delete require.cache[k];
    }
  }
  return { root };
}

const PRIVATE_ITEM = {
  id: 'evening-log',
  label: 'Evening log',
  title: 'Mood',
  body: 'How are you feeling?',
  trigger: { type: 'daily', time: '20:00' },
  privacy: 'private',
};

const PUBLIC_ITEM = { ...PRIVATE_ITEM, id: 'morning-log', privacy: 'public' };

function fakeEvent(item, manifest = { id: 'mood', label: 'Mood', emoji: '🙂' }) {
  return {
    id: 'tick-2026-06-12T08:00',
    slot: '2026-06-12T08:00:00+10:00',
    items: [{
      id: `${manifest.id}#${item.id}`,
      slot: '2026-06-12T08:00:00+10:00',
      item,
      manifest,
    }],
  };
}

test.describe('web-push-send.buildPayload', () => {
  test('private: wire payload carries generic title/body and the real text in realTitle/realBody', () => {
    freshHome();
    const send = require('../lib/web-push-send');
    const payload = send.buildPayload(fakeEvent(PRIVATE_ITEM));
    assert.equal(payload.type, 'single');
    assert.equal(payload.items.length, 1);
    const it = payload.items[0];
    assert.equal(it.title, 'Klebb');
    assert.equal(it.body, 'You have a reminder.');
    assert.equal(it.realTitle, 'Mood');
    assert.equal(it.realBody, 'How are you feeling?');
    assert.equal(it.privacy, 'private');
  });

  test('public: wire payload exposes real title/body verbatim', () => {
    freshHome();
    const send = require('../lib/web-push-send');
    const payload = send.buildPayload(fakeEvent(PUBLIC_ITEM));
    const it = payload.items[0];
    assert.equal(it.title, 'Mood');
    assert.equal(it.body, 'How are you feeling?');
    assert.equal(it.realTitle, null);
    assert.equal(it.realBody, null);
  });

  test('tag is opaque sha256 prefix, never the readable id', () => {
    freshHome();
    const send = require('../lib/web-push-send');
    const payload = send.buildPayload(fakeEvent(PRIVATE_ITEM));
    const tag = payload.items[0].tag;
    assert.match(tag, /^klebb-[a-f0-9]{12}$/);
    assert.ok(!tag.includes('mood'));
    assert.ok(!tag.includes('evening-log'));
  });

  test('multi-item event: type=coalesced and every item carries its own tag', () => {
    freshHome();
    const send = require('../lib/web-push-send');
    const ev = {
      id: 'tick-2026-06-12T08:00',
      slot: '2026-06-12T08:00:00+10:00',
      items: [
        { id: 'mood#a', slot: '2026-06-12T08:00:00+10:00', item: { ...PRIVATE_ITEM, id: 'a' }, manifest: { id: 'mood', label: 'Mood', emoji: null } },
        { id: 'mood#b', slot: '2026-06-12T08:00:00+10:00', item: { ...PRIVATE_ITEM, id: 'b' }, manifest: { id: 'mood', label: 'Mood', emoji: null } },
      ],
    };
    const payload = send.buildPayload(ev);
    assert.equal(payload.type, 'coalesced');
    assert.equal(payload.items.length, 2);
    assert.notEqual(payload.items[0].tag, payload.items[1].tag);
  });

  test('action: open-card with intent yields a same-origin url', () => {
    freshHome();
    const send = require('../lib/web-push-send');
    const item = { ...PRIVATE_ITEM, action: { type: 'open-card', card: 'mood', intent: 'log' } };
    const payload = send.buildPayload(fakeEvent(item));
    assert.equal(payload.items[0].url, '/?card=mood&action=log');
  });

  test('reminders: structured items ride along when surviving/missed_earlier are present', () => {
    freshHome();
    const send = require('../lib/web-push-send');
    const ev = fakeEvent(PRIVATE_ITEM);
    ev.items[0].surviving = [{ name: 'BPC-157', short_name: 'BPC-157' }];
    ev.items[0].missed_earlier = [{ name: 'Ozempic', short_name: 'Ozempic' }];
    const payload = send.buildPayload(ev);
    assert.deepEqual(payload.items[0].reminders, {
      due_now: [{ name: 'BPC-157', short_name: 'BPC-157' }],
      missed_earlier: [{ name: 'Ozempic', short_name: 'Ozempic' }],
    });
  });

  test('reminders: null when both arrays are empty (daily/weekly trigger or empty schedule_due slot)', () => {
    freshHome();
    const send = require('../lib/web-push-send');
    const payload = send.buildPayload(fakeEvent(PRIVATE_ITEM));
    assert.equal(payload.items[0].reminders, null);
  });

  test('reminders: per-item attribution survives coalesced multi-item events', () => {
    freshHome();
    const send = require('../lib/web-push-send');
    const ev = {
      id: 'tick-2026-06-12T20:00',
      slot: '2026-06-12T20:00:00+10:00',
      items: [
        {
          id: 'pep#evening', slot: '2026-06-12T20:00:00+10:00',
          item: { ...PRIVATE_ITEM, id: 'evening' },
          manifest: { id: 'pep', label: 'Injections', emoji: '💉' },
          surviving: [{ name: 'Ozempic', short_name: 'Ozempic' }],
          missed_earlier: [],
        },
        {
          id: 'mood#evening', slot: '2026-06-12T20:00:00+10:00',
          item: { ...PRIVATE_ITEM, id: 'evening' },
          manifest: { id: 'mood', label: 'Mood', emoji: '🙂' },
          surviving: [],
          missed_earlier: [],
        },
      ],
    };
    const payload = send.buildPayload(ev);
    assert.equal(payload.items.length, 2);
    assert.equal(payload.items[0].cardId, 'pep');
    assert.deepEqual(payload.items[0].reminders, {
      due_now: [{ name: 'Ozempic', short_name: 'Ozempic' }],
      missed_earlier: [],
    });
    assert.equal(payload.items[1].cardId, 'mood');
    assert.equal(payload.items[1].reminders, null);
  });
});

test.describe('web-push-send.dispatch (mocked send)', () => {
  test('records a recent_fires entry with sent/failed counts', async () => {
    freshHome();
    const subs = require('../lib/push-subscriptions');
    const stateStore = require('../lib/notifications-state');
    const webpush = require('web-push');
    const send = require('../lib/web-push-send');

    subs.add({ endpoint: 'https://fcm.googleapis.com/x/A', keys: { p256dh: 'p1', auth: 'a1' } });
    subs.add({ endpoint: 'https://web.push.apple.com/x/B', keys: { p256dh: 'p2', auth: 'a2' } });

    // Mock: A succeeds (201), B 410s (subscription unregistered).
    const orig = webpush.sendNotification;
    webpush.sendNotification = async (sub) => {
      if (sub.endpoint.includes('apple')) {
        const e = new Error('410'); e.statusCode = 410; throw e;
      }
      return { statusCode: 201 };
    };

    try {
      await send.dispatch([fakeEvent(PRIVATE_ITEM)]);
    } finally {
      webpush.sendNotification = orig;
    }

    const cur = stateStore.read();
    assert.equal(cur.recent_fires.length, 1);
    const fire = cur.recent_fires[0];
    assert.equal(fire.sent, 1);
    assert.equal(fire.failed, 1);
    // The Apple sub got 410'd -> dead.
    const live = subs.list();
    assert.equal(live.length, 1);
    assert.equal(live[0].endpoint.includes('googleapis'), true);
    const all = subs.list({ includeDead: true });
    const dead = all.find(s => s.endpoint.includes('apple'));
    assert.equal(dead.dead, true);
    assert.equal(dead.lastStatus, 410);
  });

  test('401 from provider also marks dead (VAPID rotation case)', async () => {
    freshHome();
    const subs = require('../lib/push-subscriptions');
    const webpush = require('web-push');
    const send = require('../lib/web-push-send');

    subs.add({ endpoint: 'https://fcm.googleapis.com/x/A', keys: { p256dh: 'p1', auth: 'a1' } });
    const orig = webpush.sendNotification;
    webpush.sendNotification = async () => {
      const e = new Error('401'); e.statusCode = 401; throw e;
    };
    try {
      await send.dispatch([fakeEvent(PRIVATE_ITEM)]);
    } finally {
      webpush.sendNotification = orig;
    }
    const after = subs.list({ includeDead: true })[0];
    assert.equal(after.dead, true);
    assert.equal(after.lastStatus, 401);
  });

  test('dispatch with no live subs is a no-op', async () => {
    freshHome();
    const stateStore = require('../lib/notifications-state');
    const send = require('../lib/web-push-send');
    await send.dispatch([fakeEvent(PRIVATE_ITEM)]);
    assert.equal(stateStore.read().recent_fires.length, 0);
  });
});
