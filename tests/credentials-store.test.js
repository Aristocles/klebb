// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/credentials-store.test.js
// Covers the hardened WebAuthn credential store: atomic 0600 writes and the
// last-credential guard (auth/webauthn.js + scripts/revoke.js). See issue #468.

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
    if (key.startsWith(AUTH_DIR) || key.startsWith(CONFIG_DIR)) {
      delete require.cache[key];
    }
  }
  process.env.HEALTH_HOME = sandboxRoot;
  process.env.HEALTH_HOME_WARNED = '1';
  return require(path.join(REPO_ROOT, 'auth', 'webauthn.js'));
}

function credFile(sandbox) {
  return path.join(sandbox, 'credentials', 'webauthn.json');
}

function cred(id) {
  return { id, publicKey: 'pk-' + id, counter: 0, deviceType: 'test', registeredAt: new Date().toISOString() };
}

describe('countCredentials', () => {
  test('sums credentials across all users', () => {
    const sandbox = createSandbox();
    try {
      const wa = freshWebauthn(sandbox);
      assert.equal(wa.countCredentials({ users: {} }), 0);
      assert.equal(wa.countCredentials({ users: { a: { credentials: [cred('1')] } } }), 1);
      assert.equal(
        wa.countCredentials({
          users: { a: { credentials: [cred('1'), cred('2')] }, b: { credentials: [cred('3')] } },
        }),
        3
      );
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('tolerates missing users/credentials keys', () => {
    const sandbox = createSandbox();
    try {
      const wa = freshWebauthn(sandbox);
      assert.equal(wa.countCredentials({}), 0);
      assert.equal(wa.countCredentials({ users: { a: {} } }), 0);
    } finally {
      cleanupSandbox(sandbox);
    }
  });
});

describe('saveCredentials (atomic write)', () => {
  test('writes valid JSON and leaves no .tmp residue', () => {
    const sandbox = createSandbox();
    try {
      const wa = freshWebauthn(sandbox);
      const data = { users: { user: { credentials: [cred('abc')] } } };
      wa.saveCredentials(data);

      const file = credFile(sandbox);
      assert.ok(fs.existsSync(file), 'target file should exist');
      assert.ok(!fs.existsSync(file + '.tmp'), 'no .tmp residue should remain');
      assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), data);
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('round-trips through loadCredentials', () => {
    const sandbox = createSandbox();
    try {
      const wa = freshWebauthn(sandbox);
      const data = { users: { alice: { credentials: [cred('1'), cred('2')] } } };
      wa.saveCredentials(data);
      assert.deepEqual(wa.loadCredentials(), data);
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('overwriting never yields a partial file', () => {
    const sandbox = createSandbox();
    try {
      const wa = freshWebauthn(sandbox);
      // Rewrite repeatedly with shrinking then growing payloads; the atomic
      // rename must always leave a complete, parseable document.
      for (let i = 0; i < 20; i++) {
        const users = {};
        for (let u = 0; u < (i % 5) + 1; u++) {
          users['u' + u] = { credentials: Array.from({ length: i }, (_, k) => cred(`${u}-${k}`)) };
        }
        wa.saveCredentials({ users });
        const parsed = JSON.parse(fs.readFileSync(credFile(sandbox), 'utf8'));
        assert.equal(wa.countCredentials(parsed), ((i % 5) + 1) * i);
      }
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('sets 0600 mode on POSIX', { skip: process.platform === 'win32' }, () => {
    const sandbox = createSandbox();
    try {
      const wa = freshWebauthn(sandbox);
      wa.saveCredentials({ users: { user: { credentials: [cred('x')] } } });
      const mode = fs.statSync(credFile(sandbox)).mode & 0o777;
      assert.equal(mode, 0o600);
    } finally {
      cleanupSandbox(sandbox);
    }
  });
});

describe('scripts/revoke.js last-credential guard', () => {
  function runRevoke(sandbox, label) {
    return execSync(`node ${path.join(REPO_ROOT, 'scripts', 'revoke.js')} --label ${label}`, {
      env: { ...process.env, HEALTH_HOME: sandbox, HEALTH_HOME_WARNED: '1' },
      encoding: 'utf8',
      stdio: 'pipe',
    });
  }

  test('refuses to revoke the only remaining label (exit 3), store untouched', () => {
    const sandbox = createSandbox({
      credentials: { users: { user: { credentials: [cred('only')] } } },
    });
    try {
      let status = 0;
      let stderr = '';
      try {
        runRevoke(sandbox, 'user');
      } catch (e) {
        status = e.status;
        stderr = (e.stderr || '').toString();
      }
      assert.equal(status, 3, 'should exit 3 when guard trips');
      assert.match(stderr, /Refusing to revoke/);
      // Store is intact.
      const after = JSON.parse(fs.readFileSync(credFile(sandbox), 'utf8'));
      assert.ok(after.users.user, 'the sole credential set must survive');
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('allows revoking a non-last label', () => {
    const sandbox = createSandbox({
      credentials: {
        users: { alice: { credentials: [cred('a')] }, bob: { credentials: [cred('b')] } },
      },
    });
    try {
      const out = runRevoke(sandbox, 'alice');
      assert.match(out, /Credentials removed: 1/);
      const after = JSON.parse(fs.readFileSync(credFile(sandbox), 'utf8'));
      assert.equal(after.users.alice, undefined, 'alice removed');
      assert.ok(after.users.bob, 'bob remains');
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('unknown label is a no-op (exit 0, nothing removed)', () => {
    const sandbox = createSandbox({
      credentials: { users: { user: { credentials: [cred('only')] } } },
    });
    try {
      const out = runRevoke(sandbox, 'ghost');
      assert.match(out, /no credentials were found/i);
      const after = JSON.parse(fs.readFileSync(credFile(sandbox), 'utf8'));
      assert.ok(after.users.user, 'existing set untouched');
    } finally {
      cleanupSandbox(sandbox);
    }
  });
});
