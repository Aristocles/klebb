// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/vapid.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function freshHome() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klebb-vapid-'));
  process.env.HEALTH_VAPID_FILE = path.join(root, 'keys', 'vapid.json');
  for (const k of Object.keys(require.cache)) {
    if (k.endsWith('config' + path.sep + 'paths.js') || k.endsWith('lib' + path.sep + 'vapid.js')) {
      delete require.cache[k];
    }
  }
  return { root, file: process.env.HEALTH_VAPID_FILE };
}

test.describe('lib/vapid', () => {
  test('lazy generation: first call creates the keypair file', () => {
    const { file } = freshHome();
    const vapid = require('../lib/vapid');
    assert.equal(fs.existsSync(file), false);
    const pub = vapid.getPublicKey();
    assert.ok(typeof pub === 'string' && pub.length > 60);
    assert.equal(fs.existsSync(file), true);
    const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(persisted.publicKey, pub);
    assert.ok(typeof persisted.privateKey === 'string' && persisted.privateKey.length > 30);
    assert.match(persisted.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  });

  test('subsequent calls reuse the persisted keypair (no rotation on read)', () => {
    const { file } = freshHome();
    const vapid = require('../lib/vapid');
    const first = vapid.getPublicKey();
    vapid._resetForTests();
    const second = vapid.getPublicKey();
    assert.equal(first, second);
    // File contents unchanged.
    const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(persisted.publicKey, first);
  });

  test('keyId is the 8-char sha256 fingerprint of the public key', () => {
    freshHome();
    const vapid = require('../lib/vapid');
    const crypto = require('node:crypto');
    const expected = crypto.createHash('sha256').update(vapid.getPublicKey()).digest('hex').slice(0, 8);
    assert.equal(vapid.getKeyId(), expected);
  });

  test('deleting the file regenerates on next call (operator rotation path)', () => {
    const { file } = freshHome();
    const vapid = require('../lib/vapid');
    const before = vapid.getPublicKey();
    fs.unlinkSync(file);
    vapid._resetForTests();
    const after = vapid.getPublicKey();
    assert.notEqual(after, before);
  });
});
