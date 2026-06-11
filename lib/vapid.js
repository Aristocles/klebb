// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// lib/vapid.js
//
// VAPID keys for Web Push (RFC 8292). Generated lazily on first call,
// stored at $HEALTH_HOME/keys/vapid.json (mode 0o600, atomic, fsynced).
// The file is intentionally NOT under sessions/ - keys are not session
// data, and conflating the directories invites accidental nuke during
// a session-troubleshooting reset.
//
// Operator rotation: delete the file and restart. Subscriptions tied
// to the old key 401/403 on next send and are reaped by the
// dead-subscription handling in lib/web-push-send.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const webpush = require('web-push');
const PATHS = require('../config/paths');

const FILE_MODE = 0o600;

let _cache = null;

function _readFile() {
  try {
    const raw = fs.readFileSync(PATHS.VAPID_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object'
      && typeof parsed.publicKey === 'string'
      && typeof parsed.privateKey === 'string') {
      return parsed;
    }
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.warn(`[vapid] could not read ${PATHS.VAPID_FILE}: ${e.message}`);
    }
  }
  return null;
}

function _writeFile(obj) {
  const file = PATHS.VAPID_FILE;
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch {}
  const tmp = file + '.tmp';
  const fd = fs.openSync(tmp, 'w', FILE_MODE);
  try {
    fs.writeSync(fd, JSON.stringify(obj, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

// Generate + persist a fresh keypair. web-push uses raw P-256 keys
// base64url-encoded (no PEM/PKCS#8 wrapper).
function _generate() {
  const keys = webpush.generateVAPIDKeys();
  const obj = {
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
    createdAt: new Date().toISOString(),
  };
  _writeFile(obj);
  return obj;
}

// Lazy resolve: read cache, then file, then generate. Idempotent.
function _resolve() {
  if (_cache) return _cache;
  const fromFile = _readFile();
  if (fromFile) {
    _cache = fromFile;
    return _cache;
  }
  _cache = _generate();
  return _cache;
}

function getPublicKey() {
  return _resolve().publicKey;
}

function getPrivateKey() {
  return _resolve().privateKey;
}

// 8-character fingerprint of the public key for the client's rotation
// detection (compare what the server returned now vs the keyId stored
// in localStorage; on mismatch the client force-resubscribes).
function getKeyId() {
  return crypto.createHash('sha256')
    .update(getPublicKey())
    .digest('hex')
    .slice(0, 8);
}

// Reset the in-memory cache - tests use this between sandboxes; not for
// production use.
function _resetForTests() {
  _cache = null;
}

module.exports = {
  getPublicKey,
  getPrivateKey,
  getKeyId,
  _resetForTests,
};
