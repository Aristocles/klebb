// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/api/issue-301-invites-readconfig.test.js
// Regression seed for #301: auth/invites _readConfig swallowed any read or
// parse error and returned {}. A config file that exists but is unreadable
// (EACCES from a uid mismatch in Docker) or malformed (truncated write,
// hand-edit error) was indistinguishable from legitimate first-run state,
// so /setup told the user the invite was invalid with no log line pointing
// at the real cause.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createSandbox, cleanupSandbox } = require('../helpers/sandbox');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const AUTH_DIR = path.resolve(REPO_ROOT, 'auth') + path.sep;
const CONFIG_DIR = path.resolve(REPO_ROOT, 'config') + path.sep;

function freshInvites(sandboxRoot) {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(AUTH_DIR) || key.startsWith(CONFIG_DIR)) {
      delete require.cache[key];
    }
  }
  process.env.HEALTH_HOME = sandboxRoot;
  process.env.HEALTH_HOME_WARNED = '1';
  return require(path.join(REPO_ROOT, 'auth', 'invites.js'));
}

function runCapturing(fn) {
  const orig = process.stderr.write.bind(process.stderr);
  let buf = '';
  process.stderr.write = (chunk) => { buf += String(chunk); return true; };
  let result;
  let error = null;
  try {
    result = fn();
  } catch (err) {
    error = err;
  } finally {
    process.stderr.write = orig;
  }
  return { result, error, stderr: buf };
}

describe('issue #301: auth/invites _readConfig must not swallow non-ENOENT errors', () => {
  test('malformed config.json surfaces an error instead of silently returning []', () => {
    const sandbox = createSandbox();
    try {
      fs.writeFileSync(path.join(sandbox, 'config.json'), '{not valid json');
      const invites = freshInvites(sandbox);
      const { error, stderr } = runCapturing(() => invites.listInvites());
      const surfaced = !!error || /config\.json/i.test(stderr);
      assert.ok(surfaced,
        'malformed config.json must throw or log to stderr; silent [] hides the bug');
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('ENOENT (no config.json) returns [] cleanly with no stderr noise', () => {
    const sandbox = createSandbox();
    try {
      const invites = freshInvites(sandbox);
      const { result, error, stderr } = runCapturing(() => invites.listInvites());
      assert.equal(error, null, 'ENOENT path must not throw');
      assert.deepEqual(result, [], 'first-run with no config.json returns []');
      assert.equal(stderr, '', 'ENOENT path must stay silent');
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('unreadable config.json (EACCES) surfaces instead of silent []', {
    skip: process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0),
  }, () => {
    const sandbox = createSandbox();
    const cfgPath = path.join(sandbox, 'config.json');
    try {
      fs.writeFileSync(cfgPath, '{"auth":{"invites":[]}}');
      fs.chmodSync(cfgPath, 0o000);
      const invites = freshInvites(sandbox);
      const { error, stderr } = runCapturing(() => invites.listInvites());
      const surfaced = !!error || /config\.json/i.test(stderr);
      assert.ok(surfaced,
        'EACCES on config.json must throw or log to stderr; silent [] hides the bug');
    } finally {
      try { fs.chmodSync(cfgPath, 0o600); } catch {}
      cleanupSandbox(sandbox);
    }
  });
});
