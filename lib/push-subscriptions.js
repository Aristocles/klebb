// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// lib/push-subscriptions.js
//
// Persistence for the operator's Web Push subscriptions. Single-user-
// per-instance, so this is one flat list with a per-device row. File
// lives at $HEALTH_HOME/push-subscriptions.json (mode 0o600, atomic
// tmp+rename, fsynced).
//
// Each row:
//   {
//     id, endpoint, keys: { p256dh, auth },
//     userAgent, nickname, userHandle,
//     createdAt, lastSentAt, lastStatus,
//     dead, deadSince
//   }
//
// id = sha256(endpoint), full hex (64 chars). Truncated only for log
// lines; the API exposes the full id so we never have to worry about
// short-id collisions later.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PATHS = require('../config/paths');

const FILE_MODE = 0o600;
const ACTIVE_CAP = 20;
const DEAD_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function _emptyState() {
  return { subscriptions: [] };
}

function _read() {
  try {
    const raw = fs.readFileSync(PATHS.PUSH_SUBSCRIPTIONS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.subscriptions)) return parsed;
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.warn(`[push-subs] could not read state: ${e.message}; starting fresh`);
    }
  }
  return _emptyState();
}

function _write(state) {
  const file = PATHS.PUSH_SUBSCRIPTIONS_FILE;
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch {}
  const tmp = file + '.tmp';
  const fd = fs.openSync(tmp, 'w', FILE_MODE);
  try {
    fs.writeSync(fd, JSON.stringify(state, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

function _id(endpoint) {
  return crypto.createHash('sha256').update(endpoint).digest('hex');
}

function list({ includeDead = false } = {}) {
  const state = _read();
  return includeDead
    ? state.subscriptions
    : state.subscriptions.filter(s => !s.dead);
}

function getById(id) {
  return _read().subscriptions.find(s => s.id === id) || null;
}

function getByEndpoint(endpoint) {
  return getById(_id(endpoint));
}

// Add a new sub or replace an existing one. On duplicate endpoint we
// REPLACE keys + userAgent + nickname rather than skip - browser key
// rotation produces a new keypair under the same endpoint, and a stale
// cached set silently fails to decrypt on the device. After replace,
// dead/deadSince are cleared.
function add(sub, { userAgent = null, nickname = null, userHandle = null } = {}) {
  if (!sub || typeof sub.endpoint !== 'string'
    || !sub.keys || typeof sub.keys.p256dh !== 'string'
    || typeof sub.keys.auth !== 'string') {
    const err = new Error('invalid subscription');
    err.code = 'INVALID_SUB';
    throw err;
  }
  const state = _read();
  const id = _id(sub.endpoint);
  const now = new Date().toISOString();
  const existing = state.subscriptions.find(s => s.id === id);
  if (existing) {
    existing.endpoint = sub.endpoint;
    existing.keys = { p256dh: sub.keys.p256dh, auth: sub.keys.auth };
    if (userAgent) existing.userAgent = userAgent;
    if (nickname) existing.nickname = nickname;
    if (userHandle) existing.userHandle = userHandle;
    existing.dead = false;
    existing.deadSince = null;
    _write(state);
    return { id, created: false };
  }

  // Capacity guard: when we're at the cap, evict the oldest active sub
  // (createdAt ascending). Dead subs are already excluded from list()
  // and don't count.
  const active = state.subscriptions.filter(s => !s.dead);
  if (active.length >= ACTIVE_CAP) {
    active.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
    const evict = active[0];
    if (evict) {
      const idx = state.subscriptions.findIndex(s => s.id === evict.id);
      if (idx >= 0) state.subscriptions.splice(idx, 1);
    }
  }

  state.subscriptions.push({
    id,
    endpoint: sub.endpoint,
    keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
    userAgent,
    nickname,
    userHandle,
    createdAt: now,
    lastSentAt: null,
    lastStatus: null,
    dead: false,
    deadSince: null,
  });
  _write(state);
  return { id, created: true };
}

function remove(endpoint) {
  const state = _read();
  const id = _id(endpoint);
  const before = state.subscriptions.length;
  state.subscriptions = state.subscriptions.filter(s => s.id !== id);
  if (state.subscriptions.length !== before) _write(state);
  return before - state.subscriptions.length;
}

// Mark a subscription as dead (push provider returned 401/403/404/410).
function markDead(endpoint, status) {
  const state = _read();
  const id = _id(endpoint);
  const sub = state.subscriptions.find(s => s.id === id);
  if (!sub) return false;
  sub.dead = true;
  sub.deadSince = new Date().toISOString();
  sub.lastStatus = status;
  _write(state);
  return true;
}

// Update lastSentAt + lastStatus after a successful (or non-dead-mapping)
// send so the diagnostics tab can surface it.
function recordSendResult(endpoint, status) {
  const state = _read();
  const id = _id(endpoint);
  const sub = state.subscriptions.find(s => s.id === id);
  if (!sub) return;
  sub.lastSentAt = new Date().toISOString();
  sub.lastStatus = status;
  _write(state);
}

// Heartbeat from the foreground client: reconcile a known endpoint as
// alive (clears dead/deadSince). Returns true if the endpoint exists,
// false otherwise (the client should re-subscribe in that case).
function heartbeat(endpoint) {
  const state = _read();
  const id = _id(endpoint);
  const sub = state.subscriptions.find(s => s.id === id);
  if (!sub) return false;
  if (sub.dead) {
    sub.dead = false;
    sub.deadSince = null;
    _write(state);
  }
  return true;
}

// Drop subscriptions marked dead for >7 days. Returns the count removed.
function pruneDead(now = Date.now()) {
  const state = _read();
  const cutoff = now - DEAD_TTL_MS;
  const before = state.subscriptions.length;
  state.subscriptions = state.subscriptions.filter(s => {
    if (!s.dead || !s.deadSince) return true;
    const t = Date.parse(s.deadSince);
    if (!Number.isFinite(t)) return true;
    return t > cutoff;
  });
  if (state.subscriptions.length !== before) _write(state);
  return before - state.subscriptions.length;
}

module.exports = {
  list,
  getById,
  getByEndpoint,
  add,
  remove,
  markDead,
  recordSendResult,
  heartbeat,
  pruneDead,
  _id,        // exported for tests
  ACTIVE_CAP,
};
