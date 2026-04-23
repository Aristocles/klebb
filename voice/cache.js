// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// voice/cache.js — in-memory TTS cache (keyed by content hash).
// iOS's media pipeline does a Range-probe (bytes=0-1) then a full fetch;
// both need to hit the same bytes, and we don't want to call Fish twice.
// LRU-capped to ~50 entries / 25MB total.

const crypto = require('crypto');

const MAX_ENTRIES = 50;
const MAX_BYTES = 25 * 1024 * 1024;

const _entries = new Map(); // key -> { buffer, contentType, lastUsed }
let _totalBytes = 0;

function hashKey(text, voiceId, format) {
  return crypto.createHash('sha256')
    .update(`${voiceId}|${format}|${text}`)
    .digest('hex')
    .slice(0, 16);
}

function get(key) {
  const e = _entries.get(key);
  if (!e) return null;
  e.lastUsed = Date.now();
  return e;
}

function set(key, buffer, contentType) {
  if (_entries.has(key)) {
    _totalBytes -= _entries.get(key).buffer.length;
  }
  _entries.set(key, { buffer, contentType, lastUsed: Date.now() });
  _totalBytes += buffer.length;
  _evictIfNeeded();
}

function _evictIfNeeded() {
  while ((_entries.size > MAX_ENTRIES || _totalBytes > MAX_BYTES) && _entries.size > 1) {
    // Find oldest entry
    let oldestKey = null;
    let oldestTime = Infinity;
    for (const [k, v] of _entries) {
      if (v.lastUsed < oldestTime) {
        oldestTime = v.lastUsed;
        oldestKey = k;
      }
    }
    if (!oldestKey) break;
    _totalBytes -= _entries.get(oldestKey).buffer.length;
    _entries.delete(oldestKey);
  }
}

function stats() {
  return { entries: _entries.size, totalBytes: _totalBytes };
}

module.exports = { hashKey, get, set, stats };
