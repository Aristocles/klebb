// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/credential-fields.test.js
// Unit coverage for the credential-management helpers and the field
// backfill migration added in #469: sanitizeNickname, listCredentialsForUser,
// deleteCredentialForUser, and scripts/migrate-credential-fields.js backfill().

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { createSandbox, cleanupSandbox } = require('./helpers/sandbox');

const REPO_ROOT = path.resolve(__dirname, '..');
const AUTH_DIR = path.resolve(REPO_ROOT, 'auth') + path.sep;
const CONFIG_DIR = path.resolve(REPO_ROOT, 'config') + path.sep;

function freshWebauthn(sandboxRoot) {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(AUTH_DIR) || key.startsWith(CONFIG_DIR)) delete require.cache[key];
  }
  process.env.HEALTH_HOME = sandboxRoot;
  process.env.HEALTH_HOME_WARNED = '1';
  return require(path.join(REPO_ROOT, 'auth', 'webauthn.js'));
}

function cred(id, extra = {}) {
  const now = '2026-01-01T00:00:00.000Z';
  return { id, publicKey: 'pk-' + id, counter: 0, deviceType: 'platform', nickname: null, registeredAt: now, lastUsedAt: now, ...extra };
}

describe('sanitizeNickname', () => {
  test('trims, caps at 60, strips control chars, keeps spaces/case', () => {
    const wa = freshWebauthn(createSandbox());
    assert.equal(wa.sanitizeNickname('  Work Laptop  '), 'Work Laptop');
    assert.equal(wa.sanitizeNickname('a'.repeat(80)).length, 60);
    assert.equal(wa.sanitizeNickname('tab\there'), 'tabhere');
  });

  test('empty / non-string becomes null', () => {
    const wa = freshWebauthn(createSandbox());
    assert.equal(wa.sanitizeNickname(''), null);
    assert.equal(wa.sanitizeNickname('   '), null);
    assert.equal(wa.sanitizeNickname(undefined), null);
    assert.equal(wa.sanitizeNickname(42), null);
  });
});

describe('listCredentialsForUser', () => {
  test('returns public fields only and flags the current device', () => {
    const sandbox = createSandbox({
      credentials: { users: { user: { credentials: [cred('a', { nickname: 'Phone' }), cred('b')] } } },
    });
    try {
      const wa = freshWebauthn(sandbox);
      const list = wa.listCredentialsForUser('user', 'a');
      assert.equal(list.length, 2);
      const a = list.find(c => c.id === 'a');
      assert.equal(a.nickname, 'Phone');
      assert.equal(a.isCurrentDevice, true);
      assert.equal(list.find(c => c.id === 'b').isCurrentDevice, false);
      assert.equal(a.publicKey, undefined);
      assert.equal(a.counter, undefined);
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('unknown user returns empty list', () => {
    const sandbox = createSandbox();
    try {
      const wa = freshWebauthn(sandbox);
      assert.deepEqual(wa.listCredentialsForUser('ghost'), []);
    } finally {
      cleanupSandbox(sandbox);
    }
  });
});

describe('deleteCredentialForUser', () => {
  test('removes a non-last credential', () => {
    const sandbox = createSandbox({
      credentials: { users: { user: { credentials: [cred('a'), cred('b')] } } },
    });
    try {
      const wa = freshWebauthn(sandbox);
      const res = wa.deleteCredentialForUser('user', 'b');
      assert.equal(res.ok, true);
      assert.deepEqual(wa.loadCredentials().users.user.credentials.map(c => c.id), ['a']);
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('refuses the last remaining credential', () => {
    const sandbox = createSandbox({
      credentials: { users: { user: { credentials: [cred('only')] } } },
    });
    try {
      const wa = freshWebauthn(sandbox);
      const res = wa.deleteCredentialForUser('user', 'only');
      assert.equal(res.ok, false);
      assert.equal(res.reason, 'last-credential');
      assert.equal(wa.countCredentials(wa.loadCredentials()), 1);
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('drops the user entry when its last credential goes (multi-user store)', () => {
    const sandbox = createSandbox({
      credentials: { users: { alice: { credentials: [cred('a')] }, bob: { credentials: [cred('b')] } } },
    });
    try {
      const wa = freshWebauthn(sandbox);
      const res = wa.deleteCredentialForUser('alice', 'a');
      assert.equal(res.ok, true);
      const after = wa.loadCredentials();
      assert.equal(after.users.alice, undefined, 'empty user entry removed');
      assert.ok(after.users.bob);
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('unknown id returns not-found', () => {
    const sandbox = createSandbox({
      credentials: { users: { user: { credentials: [cred('a'), cred('b')] } } },
    });
    try {
      const wa = freshWebauthn(sandbox);
      assert.equal(wa.deleteCredentialForUser('user', 'zzz').reason, 'not-found');
    } finally {
      cleanupSandbox(sandbox);
    }
  });
});

describe('migrate-credential-fields backfill()', () => {
  const { backfill } = require('../scripts/migrate-credential-fields');

  test('adds nickname:null and lastUsedAt from registeredAt', () => {
    const store = { users: { user: { credentials: [{ id: 'a', publicKey: 'p', counter: 0, deviceType: 'platform', registeredAt: '2026-02-02T00:00:00.000Z' }] } } };
    const { data, changed } = backfill(store);
    assert.equal(changed, 1);
    const c = data.users.user.credentials[0];
    assert.equal(c.nickname, null);
    assert.equal(c.lastUsedAt, '2026-02-02T00:00:00.000Z');
  });

  test('is idempotent: already-migrated credentials are unchanged', () => {
    const store = { users: { user: { credentials: [cred('a', { nickname: 'Phone' })] } } };
    const { changed } = backfill(store);
    assert.equal(changed, 0);
  });

  test('does not mutate the input store', () => {
    const store = { users: { user: { credentials: [{ id: 'a', registeredAt: 'x' }] } } };
    backfill(store);
    assert.equal('nickname' in store.users.user.credentials[0], false);
  });
});

describe('scripts/migrate-credential-fields.js CLI', () => {
  test('dry-run reports but writes nothing; real run backfills + backs up', () => {
    const sandbox = createSandbox({
      credentials: { users: { user: { credentials: [{ id: 'a', publicKey: 'p', counter: 0, deviceType: 'platform', registeredAt: '2026-03-03T00:00:00.000Z' }] } } },
    });
    try {
      const script = path.join(REPO_ROOT, 'scripts', 'migrate-credential-fields.js');
      const env = { ...process.env, HEALTH_HOME: sandbox, HEALTH_HOME_WARNED: '1' };
      const file = path.join(sandbox, 'credentials', 'webauthn.json');

      const dry = execSync(`node ${script} --dry-run`, { env, encoding: 'utf8' });
      assert.match(dry, /Would backfill 1/);
      const afterDry = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal('nickname' in afterDry.users.user.credentials[0], false, 'dry-run writes nothing');

      const real = execSync(`node ${script}`, { env, encoding: 'utf8' });
      assert.match(real, /Backfilled 1/);
      const afterReal = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(afterReal.users.user.credentials[0].nickname, null);
      assert.equal(afterReal.users.user.credentials[0].lastUsedAt, '2026-03-03T00:00:00.000Z');

      // A backup was created.
      const backups = fs.readdirSync(path.join(sandbox, 'credentials')).filter(f => f.includes('.bak-'));
      assert.ok(backups.length >= 1, 'a timestamped backup should exist');

      // Second run is a no-op.
      const again = execSync(`node ${script}`, { env, encoding: 'utf8' });
      assert.match(again, /nothing to do/);
    } finally {
      cleanupSandbox(sandbox);
    }
  });
});
