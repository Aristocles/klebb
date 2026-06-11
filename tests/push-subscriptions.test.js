// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/push-subscriptions.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function freshHome() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klebb-pushsub-'));
  process.env.HEALTH_PUSH_SUBSCRIPTIONS_FILE = path.join(root, 'push-subscriptions.json');
  for (const k of Object.keys(require.cache)) {
    if (k.endsWith('config' + path.sep + 'paths.js') || k.includes('push-subscriptions')) {
      delete require.cache[k];
    }
  }
  return { root };
}

const A = { endpoint: 'https://fcm.googleapis.com/x/A', keys: { p256dh: 'pubA', auth: 'authA' } };
const B = { endpoint: 'https://web.push.apple.com/x/B', keys: { p256dh: 'pubB', auth: 'authB' } };

test.describe('lib/push-subscriptions', () => {
  test('add: new endpoint creates row, returns created=true', () => {
    freshHome();
    const subs = require('../lib/push-subscriptions');
    const r = subs.add(A, { userAgent: 'iPhone', nickname: 'phone' });
    assert.equal(r.created, true);
    assert.equal(subs.list().length, 1);
    assert.equal(subs.list()[0].nickname, 'phone');
  });

  test('add: duplicate endpoint REPLACES keys + clears dead', () => {
    freshHome();
    const subs = require('../lib/push-subscriptions');
    subs.add(A);
    subs.markDead(A.endpoint, 410);
    assert.equal(subs.list({ includeDead: true })[0].dead, true);
    const r = subs.add({ ...A, keys: { p256dh: 'rotated', auth: 'rotatedAuth' } });
    assert.equal(r.created, false);
    const after = subs.list()[0]; // not dead now -> shows in default list
    assert.equal(after.keys.p256dh, 'rotated');
    assert.equal(after.keys.auth, 'rotatedAuth');
    assert.equal(after.dead, false);
  });

  test('rejects missing endpoint or keys', () => {
    freshHome();
    const subs = require('../lib/push-subscriptions');
    assert.throws(() => subs.add({}), e => e.code === 'INVALID_SUB');
    assert.throws(() => subs.add({ endpoint: 'x' }), e => e.code === 'INVALID_SUB');
    assert.throws(() => subs.add({ endpoint: 'x', keys: {} }), e => e.code === 'INVALID_SUB');
  });

  test('markDead: 401/403/404/410 all set dead + deadSince', () => {
    freshHome();
    const subs = require('../lib/push-subscriptions');
    subs.add(A);
    subs.markDead(A.endpoint, 410);
    const dead = subs.list({ includeDead: true })[0];
    assert.equal(dead.dead, true);
    assert.equal(dead.lastStatus, 410);
    assert.match(dead.deadSince, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(subs.list().length, 0); // hidden from active list
  });

  test('heartbeat: known dead endpoint flips alive', () => {
    freshHome();
    const subs = require('../lib/push-subscriptions');
    subs.add(A);
    subs.markDead(A.endpoint, 410);
    const ok = subs.heartbeat(A.endpoint);
    assert.equal(ok, true);
    assert.equal(subs.list()[0].dead, false);
  });

  test('heartbeat: unknown endpoint returns false', () => {
    freshHome();
    const subs = require('../lib/push-subscriptions');
    assert.equal(subs.heartbeat('https://nope/x'), false);
  });

  test('remove: drops the row entirely', () => {
    freshHome();
    const subs = require('../lib/push-subscriptions');
    subs.add(A);
    subs.add(B);
    assert.equal(subs.remove(A.endpoint), 1);
    assert.equal(subs.list().length, 1);
    assert.equal(subs.list()[0].endpoint, B.endpoint);
  });

  test('20-active cap: oldest evicted on overflow', () => {
    freshHome();
    const subs = require('../lib/push-subscriptions');
    for (let i = 0; i < 22; i++) {
      subs.add({
        endpoint: `https://fcm.googleapis.com/x/${i}`,
        keys: { p256dh: 'p' + i, auth: 'a' + i },
      });
    }
    const live = subs.list();
    assert.equal(live.length, 20);
    // The oldest two should be gone.
    assert.equal(live.find(s => s.endpoint.endsWith('/0')), undefined);
    assert.equal(live.find(s => s.endpoint.endsWith('/1')), undefined);
    assert.ok(live.find(s => s.endpoint.endsWith('/21')));
  });

  test('pruneDead: removes subs dead >7 days', () => {
    freshHome();
    const subs = require('../lib/push-subscriptions');
    subs.add(A);
    subs.markDead(A.endpoint, 410);
    // Backdate the deadSince to 8 days ago.
    const file = process.env.HEALTH_PUSH_SUBSCRIPTIONS_FILE;
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    state.subscriptions[0].deadSince = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
    fs.writeFileSync(file, JSON.stringify(state));

    const removed = subs.pruneDead();
    assert.equal(removed, 1);
    assert.equal(subs.list({ includeDead: true }).length, 0);
  });

  test('pruneDead: keeps subs dead <7 days', () => {
    freshHome();
    const subs = require('../lib/push-subscriptions');
    subs.add(A);
    subs.markDead(A.endpoint, 410);
    const removed = subs.pruneDead();
    assert.equal(removed, 0);
    assert.equal(subs.list({ includeDead: true }).length, 1);
  });
});
