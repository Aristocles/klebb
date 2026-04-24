// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/invite.test.js
// Covers the invite-code lifecycle used by Klebb's multi-user registration
// flow (scripts/invite.js + auth/invites.js + /auth/register/available endpoint).

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { createSandbox, cleanupSandbox, spawnServer, req } = require('./helpers/sandbox');

const REPO_ROOT = path.resolve(__dirname, '..');
const AUTH_DIR = path.resolve(REPO_ROOT, 'auth') + path.sep;
const CONFIG_DIR = path.resolve(REPO_ROOT, 'config') + path.sep;

function freshInvites(sandboxRoot) {
  // Clear require cache for the invites module + its deps so each test gets
  // a clean module view against the current HEALTH_HOME.
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(AUTH_DIR) || key.startsWith(CONFIG_DIR)) {
      delete require.cache[key];
    }
  }
  process.env.HEALTH_HOME = sandboxRoot;
  process.env.HEALTH_HOME_WARNED = '1';
  return require(path.join(REPO_ROOT, 'auth', 'invites.js'));
}

describe('invite module (unit)', () => {
  test('createInvite writes to config.json and returns the code', () => {
    const sandbox = createSandbox();
    try {
      const invites = freshInvites(sandbox);
      const inv = invites.createInvite({ label: 'alice', expiresInDays: 3 });
      assert.ok(inv.code, 'should return a code');
      assert.ok(inv.code.startsWith('alice-'), 'code should embed the label');
      assert.equal(inv.label, 'alice');
      assert.equal(inv.used, false);
      assert.ok(inv.expiresAt, 'should have an expiry');

      const cfg = JSON.parse(fs.readFileSync(path.join(sandbox, 'config.json'), 'utf8'));
      assert.ok(Array.isArray(cfg.auth?.invites));
      assert.equal(cfg.auth.invites.length, 1);
      assert.equal(cfg.auth.invites[0].code, inv.code);
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('validateInvite accepts a fresh code', () => {
    const sandbox = createSandbox();
    try {
      const invites = freshInvites(sandbox);
      const { code } = invites.createInvite({ label: 'alice' });
      const v = invites.validateInvite(code);
      assert.ok(v, 'should return the invite');
      assert.equal(v.label, 'alice');
      assert.equal(v.used, false);
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('validateInvite rejects unknown codes', () => {
    const sandbox = createSandbox();
    try {
      const invites = freshInvites(sandbox);
      const v = invites.validateInvite('nonexistent-zzz');
      assert.equal(v, null);
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('validateInvite rejects expired codes', () => {
    const sandbox = createSandbox();
    try {
      const invites = freshInvites(sandbox);
      const { code } = invites.createInvite({ label: 'bob', expiresInDays: 3 });
      // Hand-edit the config to backdate expiry
      const cfg = JSON.parse(fs.readFileSync(path.join(sandbox, 'config.json'), 'utf8'));
      cfg.auth.invites[0].expiresAt = new Date(Date.now() - 1000 * 60 * 60).toISOString();
      fs.writeFileSync(path.join(sandbox, 'config.json'), JSON.stringify(cfg, null, 2));
      // Re-init to pick up the edit
      const invites2 = freshInvites(sandbox);
      const v = invites2.validateInvite(code);
      assert.equal(v, null, 'expired invite should not validate');
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('consumeInvite marks it used; second consume returns the used invite unchanged', () => {
    const sandbox = createSandbox();
    try {
      const invites = freshInvites(sandbox);
      const { code } = invites.createInvite({ label: 'one-shot' });
      const first = invites.consumeInvite(code);
      assert.ok(first, 'first consume should succeed');
      assert.equal(first.used, true);
      const firstUsedAt = first.usedAt;
      // Second consume returns the invite as-is (used=true). Crucially,
      // validateInvite now treats it as unavailable so register won't re-use it.
      const second = invites.consumeInvite(code);
      assert.ok(second, 'second consume returns the invite snapshot');
      assert.equal(second.used, true);
      assert.equal(second.usedAt, firstUsedAt, 'usedAt should not be overwritten');
      // And validateInvite rejects the now-used code
      assert.equal(invites.validateInvite(code), null, 'used code should no longer validate');
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('listInvites returns everything', () => {
    const sandbox = createSandbox();
    try {
      const invites = freshInvites(sandbox);
      invites.createInvite({ label: 'a' });
      invites.createInvite({ label: 'b' });
      invites.createInvite({ label: 'c' });
      const list = invites.listInvites();
      assert.equal(list.length, 3);
      assert.deepEqual(list.map(i => i.label).sort(), ['a', 'b', 'c']);
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('removeInvite deletes a code from the config', () => {
    const sandbox = createSandbox();
    try {
      const invites = freshInvites(sandbox);
      const { code } = invites.createInvite({ label: 'del' });
      const ok = invites.removeInvite(code);
      assert.equal(ok, true);
      assert.equal(invites.listInvites().length, 0);
      assert.equal(invites.validateInvite(code), null);
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('removeInvite on unknown code returns false', () => {
    const sandbox = createSandbox();
    try {
      const invites = freshInvites(sandbox);
      assert.equal(invites.removeInvite('nope-zzz'), false);
    } finally {
      cleanupSandbox(sandbox);
    }
  });
});

describe('scripts/invite.js CLI', () => {
  test('issues a code when --label is provided', () => {
    const sandbox = createSandbox();
    try {
      const out = execSync(
        `node ${path.join(REPO_ROOT, 'scripts', 'invite.js')} --label testcli`,
        {
          env: { ...process.env, HEALTH_HOME: sandbox, HEALTH_HOME_WARNED: '1' },
          encoding: 'utf8',
        }
      );
      // Output contains a registration URL and the code
      assert.ok(out.includes('testcli-'), 'output should include the code');
      // Config file now has the invite
      const cfg = JSON.parse(fs.readFileSync(path.join(sandbox, 'config.json'), 'utf8'));
      assert.equal(cfg.auth.invites.length, 1);
      assert.equal(cfg.auth.invites[0].label, 'testcli');
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('fails with usage when --label is missing', () => {
    const sandbox = createSandbox();
    try {
      let failed = false;
      try {
        execSync(`node ${path.join(REPO_ROOT, 'scripts', 'invite.js')}`, {
          env: { ...process.env, HEALTH_HOME: sandbox, HEALTH_HOME_WARNED: '1' },
          encoding: 'utf8',
          stdio: 'pipe',
        });
      } catch (e) {
        failed = true;
        assert.notEqual(e.status, 0);
      }
      assert.ok(failed, 'should exit non-zero without --label');
    } finally {
      cleanupSandbox(sandbox);
    }
  });
});

describe('/auth/register/available endpoint', () => {
  let sandbox, server;

  before(async () => {
    sandbox = createSandbox();
    // Seed an invite via the module
    const invites = freshInvites(sandbox);
    const inv = invites.createInvite({ label: 'alice' });
    // Attach to the test for later tests
    global.__testInvite = inv;
    server = await spawnServer(sandbox);
  });
  after(async () => {
    if (server) await server.kill();
    cleanupSandbox(sandbox);
  });

  test('returns available:true with a valid code', async () => {
    const res = await req(server.baseUrl, `/auth/register/available?code=${encodeURIComponent(global.__testInvite.code)}`);
    assert.equal(res.status, 200);
    assert.equal(res.json.available, true);
    assert.equal(res.json.label, 'alice');
  });

  test('returns available:false with invalid code', async () => {
    const res = await req(server.baseUrl, '/auth/register/available?code=nope-zzz');
    assert.equal(res.status, 200);
    assert.equal(res.json.available, false);
    assert.ok(res.json.reason, 'should give a reason');
  });

  test('returns available:true in setup mode (no credentials, no code)', async () => {
    // Fresh sandbox with zero credentials — first user gets bootstrap path
    const res = await req(server.baseUrl, '/auth/register/available');
    assert.equal(res.status, 200);
    assert.equal(res.json.available, true);
  });
});
