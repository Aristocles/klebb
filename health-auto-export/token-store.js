// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// health-auto-export/token-store.js
//
// Manages the iPhone Health Auto Export bearer token in
// $HEALTH_HOME/config.json under cfg.hae.token. Atomic-write at 0o600,
// matching the auth/invites.js pattern.
//
// Schema:
//   {
//     "hae": {
//       "token": "<64 hex chars>",
//       "lastRegeneratedAt": "2026-05-21T14:02:00.000Z"
//     }
//   }
//
// One-shot env-var migration: on first boot under this code, if
// cfg.hae.token is empty and HEALTH_AUTO_EXPORT_TOKEN is set in env,
// the value is copied into config.json and a deprecation warning is
// logged. After that, the env var is ignored.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PATHS = require('../config/paths');

function _readConfig() {
  try {
    const raw = fs.readFileSync(PATHS.CONFIG_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function _writeConfig(cfg) {
  try { fs.mkdirSync(path.dirname(PATHS.CONFIG_PATH), { recursive: true }); } catch {}
  const tmp = PATHS.CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, PATHS.CONFIG_PATH);
}

function getToken() {
  const cfg = _readConfig();
  const t = cfg && cfg.hae && cfg.hae.token;
  return (typeof t === 'string' && t.length > 0) ? t : null;
}

function getLastRegeneratedAt() {
  const cfg = _readConfig();
  const v = cfg && cfg.hae && cfg.hae.lastRegeneratedAt;
  return (typeof v === 'string' && v.length > 0) ? v : null;
}

function setToken(token) {
  const t = String(token || '').trim();
  if (!t) throw new Error('refusing to set empty token; use clearToken() instead');
  const cfg = _readConfig();
  cfg.hae = cfg.hae || {};
  cfg.hae.token = t;
  cfg.hae.lastRegeneratedAt = new Date().toISOString();
  _writeConfig(cfg);
  return t;
}

function generateToken() {
  return setToken(crypto.randomBytes(32).toString('hex'));
}

function clearToken() {
  const cfg = _readConfig();
  if (cfg && cfg.hae) {
    delete cfg.hae.token;
    delete cfg.hae.lastRegeneratedAt;
  }
  _writeConfig(cfg);
}

// Idempotent. Safe to run on every boot. Returns true if migration
// happened, false otherwise.
function migrateFromEnvIfNeeded() {
  if (getToken()) return false;
  const env = (process.env.HEALTH_AUTO_EXPORT_TOKEN || '').trim();
  if (!env) return false;
  const cfg = _readConfig();
  cfg.hae = cfg.hae || {};
  cfg.hae.token = env;
  // Mark with a migration timestamp so the UI can distinguish a freshly
  // generated token from one inherited from the env var.
  cfg.hae.migratedFromEnvAt = new Date().toISOString();
  _writeConfig(cfg);
  console.warn(
    '[hae] migrated HEALTH_AUTO_EXPORT_TOKEN env var into config.json; '
    + 'you can remove the env var on next deploy'
  );
  return true;
}

module.exports = {
  getToken,
  getLastRegeneratedAt,
  setToken,
  generateToken,
  clearToken,
  migrateFromEnvIfNeeded,
};
