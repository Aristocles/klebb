// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/health-auto-export.token-store.test.js
// Unit tests for the HAE token store. Drives the module against a
// temp config.json by setting HEALTH_CONFIG_PATH before require().

const { test, describe, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eh-tokstore-'));
const CFG = path.join(tmpDir, 'config.json');
process.env.HEALTH_CONFIG_PATH = CFG;
process.env.HEALTH_HOME = tmpDir;
process.env.HEALTH_HOME_WARNED = '1';

const tokenStore = require('../health-auto-export/token-store');

function writeCfg(obj) {
  fs.writeFileSync(CFG, JSON.stringify(obj, null, 2));
}

function readCfg() {
  return JSON.parse(fs.readFileSync(CFG, 'utf8'));
}

function clearCfg() {
  try { fs.unlinkSync(CFG); } catch {}
}

after(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

describe('getToken', () => {
  beforeEach(() => clearCfg());

  test('returns null when config.json is missing', () => {
    assert.equal(tokenStore.getToken(), null);
  });

  test('returns null when cfg.hae is absent', () => {
    writeCfg({ auth: {} });
    assert.equal(tokenStore.getToken(), null);
  });

  test('returns null when cfg.hae.token is empty', () => {
    writeCfg({ hae: { token: '' } });
    assert.equal(tokenStore.getToken(), null);
  });

  test('returns the stored token', () => {
    writeCfg({ hae: { token: 'abc123' } });
    assert.equal(tokenStore.getToken(), 'abc123');
  });
});

describe('generateToken', () => {
  beforeEach(() => clearCfg());

  test('writes a 64-char hex token and returns it', () => {
    const t = tokenStore.generateToken();
    assert.match(t, /^[a-f0-9]{64}$/);
    assert.equal(tokenStore.getToken(), t);
  });

  test('records lastRegeneratedAt as an ISO timestamp', () => {
    tokenStore.generateToken();
    const ts = tokenStore.getLastRegeneratedAt();
    assert.ok(ts && !Number.isNaN(Date.parse(ts)));
  });

  test('preserves unrelated config sections', () => {
    writeCfg({ auth: { invites: [{ code: 'x' }] } });
    tokenStore.generateToken();
    const cfg = readCfg();
    assert.deepEqual(cfg.auth.invites, [{ code: 'x' }]);
    assert.match(cfg.hae.token, /^[a-f0-9]{64}$/);
  });
});

describe('setToken', () => {
  beforeEach(() => clearCfg());

  test('persists an explicit value', () => {
    tokenStore.setToken('explicit-value');
    assert.equal(tokenStore.getToken(), 'explicit-value');
  });

  test('throws on empty input', () => {
    assert.throws(() => tokenStore.setToken(''), /empty token/);
    assert.throws(() => tokenStore.setToken(null), /empty token/);
  });
});

describe('clearToken', () => {
  beforeEach(() => clearCfg());

  test('removes the token from disk', () => {
    tokenStore.generateToken();
    assert.ok(tokenStore.getToken());
    tokenStore.clearToken();
    assert.equal(tokenStore.getToken(), null);
  });

  test('is a no-op when nothing is stored', () => {
    assert.doesNotThrow(() => tokenStore.clearToken());
    assert.equal(tokenStore.getToken(), null);
  });

  test('preserves unrelated config sections', () => {
    writeCfg({ auth: { invites: [{ code: 'y' }] }, hae: { token: 'old' } });
    tokenStore.clearToken();
    const cfg = readCfg();
    assert.deepEqual(cfg.auth.invites, [{ code: 'y' }]);
    assert.ok(!cfg.hae.token);
  });
});

describe('migrateFromEnvIfNeeded', () => {
  beforeEach(() => clearCfg());

  test('copies env value into config.json when token absent', () => {
    process.env.HEALTH_AUTO_EXPORT_TOKEN = 'env-side-token';
    try {
      const migrated = tokenStore.migrateFromEnvIfNeeded();
      assert.equal(migrated, true);
      assert.equal(tokenStore.getToken(), 'env-side-token');
    } finally {
      delete process.env.HEALTH_AUTO_EXPORT_TOKEN;
    }
  });

  test('no-op when both disk and env have no token', () => {
    delete process.env.HEALTH_AUTO_EXPORT_TOKEN;
    const migrated = tokenStore.migrateFromEnvIfNeeded();
    assert.equal(migrated, false);
    assert.equal(tokenStore.getToken(), null);
  });

  test('no-op when disk already has a token (env ignored)', () => {
    writeCfg({ hae: { token: 'already-on-disk' } });
    process.env.HEALTH_AUTO_EXPORT_TOKEN = 'env-side-different';
    try {
      const migrated = tokenStore.migrateFromEnvIfNeeded();
      assert.equal(migrated, false);
      assert.equal(tokenStore.getToken(), 'already-on-disk');
    } finally {
      delete process.env.HEALTH_AUTO_EXPORT_TOKEN;
    }
  });

  test('idempotent across repeated calls', () => {
    process.env.HEALTH_AUTO_EXPORT_TOKEN = 'sticky';
    try {
      assert.equal(tokenStore.migrateFromEnvIfNeeded(), true);
      assert.equal(tokenStore.migrateFromEnvIfNeeded(), false);
      assert.equal(tokenStore.migrateFromEnvIfNeeded(), false);
      assert.equal(tokenStore.getToken(), 'sticky');
    } finally {
      delete process.env.HEALTH_AUTO_EXPORT_TOKEN;
    }
  });
});

describe('atomic write + 0o600 mode', () => {
  beforeEach(() => clearCfg());

  test('writes config.json with mode 0o600 (POSIX only)',
    { skip: process.platform === 'win32' ? 'POSIX-only file mode semantics' : false },
    () => {
      tokenStore.generateToken();
      const mode = fs.statSync(CFG).mode & 0o777;
      assert.equal(mode, 0o600);
    });

  test('does not leave behind a .tmp file on success', () => {
    tokenStore.generateToken();
    assert.ok(!fs.existsSync(CFG + '.tmp'),
      'tmp file should be renamed away on success');
  });
});
