// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// lib/notifications-state.js
//
// Runtime state for notifications. Lives at $HEALTH_HOME/notifications.state.json
// (mode 0o600, atomic tmp+rename, fsynced). Stores:
//   - per-item enabled flag and lastFired (the slot the scheduler last
//     dispatched for, NOT the wall-clock time it fired - that lets the
//     idempotency check survive restarts inside the same minute);
//   - global quiet_hours window (off-hours where the slot is recorded as
//     fired but no push is sent);
//   - global paused_until (whole-feature mute up to a deadline).
//
// The file is created lazily on the first toggle: instances that never
// open Settings > Notifications never gain a state file.

const fs = require('fs');
const path = require('path');
const PATHS = require('../config/paths');

const FILE_MODE = 0o600;

const RECENT_FIRES_CAP = 100;

function _emptyState() {
  return { items: {}, quiet_hours: null, paused_until: null, recent_fires: [] };
}

// Load + parse with quiet recovery from corruption / missing.
function read() {
  try {
    const raw = fs.readFileSync(PATHS.NOTIFICATIONS_STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return {
        items: parsed.items && typeof parsed.items === 'object' && !Array.isArray(parsed.items)
          ? parsed.items
          : {},
        quiet_hours: _isValidQuietHours(parsed.quiet_hours) ? parsed.quiet_hours : null,
        paused_until: typeof parsed.paused_until === 'string' ? parsed.paused_until : null,
        recent_fires: Array.isArray(parsed.recent_fires)
          ? parsed.recent_fires.slice(-RECENT_FIRES_CAP)
          : [],
      };
    }
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.warn(`[notifications-state] could not read state: ${e.message}; starting fresh`);
    }
  }
  return _emptyState();
}

function _isValidQuietHours(qh) {
  if (qh === null || qh === undefined) return false;
  if (typeof qh !== 'object' || Array.isArray(qh)) return false;
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(qh.start) && /^([01]\d|2[0-3]):[0-5]\d$/.test(qh.end);
}

// Write + fsync atomically. Caller passes the full new state object.
function write(state) {
  const file = PATHS.NOTIFICATIONS_STATE_FILE;
  // Ensure the parent directory exists. Lazy creation: HEALTH_HOME itself
  // is bootstrap territory, but a fresh install may not yet have it.
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

// Return the per-item state, initialising it from the manifest's declared
// `default` if not yet known. Does NOT persist; caller decides when to
// write the merged state back.
function getOrInitItem(state, id, defaultOn = true) {
  if (state.items[id]) return state.items[id];
  const created = {
    enabled: defaultOn !== false,
    lastFired: null,
    lastFireStatus: null,
  };
  state.items[id] = created;
  return created;
}

// Patch a single item's state. Reads, merges, writes atomically.
function writeItem(id, patch) {
  const state = read();
  const current = state.items[id] || { enabled: true, lastFired: null, lastFireStatus: null };
  state.items[id] = { ...current, ...patch };
  write(state);
  return state.items[id];
}

// Patch the global controls (quiet_hours, paused_until). Pass null to
// clear an entry.
function writeGlobal(patch) {
  const state = read();
  if ('quiet_hours' in patch) {
    state.quiet_hours = patch.quiet_hours === null
      ? null
      : (_isValidQuietHours(patch.quiet_hours) ? { start: patch.quiet_hours.start, end: patch.quiet_hours.end } : state.quiet_hours);
  }
  if ('paused_until' in patch) {
    state.paused_until = patch.paused_until === null ? null : String(patch.paused_until);
  }
  write(state);
  return { quiet_hours: state.quiet_hours, paused_until: state.paused_until };
}

// Drop every items[] key whose runtime id starts with `${cardId}#`.
// Called from the registry's onDelete hook so a deleted card doesn't
// leave orphan toggle state behind. No-op when the file doesn't exist
// yet (the common case on a fresh instance).
function pruneCard(cardId) {
  let state;
  try {
    state = read();
  } catch {
    return 0;
  }
  if (!fs.existsSync(PATHS.NOTIFICATIONS_STATE_FILE)) return 0;
  const prefix = cardId + '#';
  let removed = 0;
  for (const k of Object.keys(state.items)) {
    if (k.startsWith(prefix)) {
      delete state.items[k];
      removed += 1;
    }
  }
  if (removed > 0) write(state);
  return removed;
}

// Inside-quiet-hours check at a given instant. Returns boolean.
// `qh` is { start, end } in "HH:MM" - both in the user's TZ.
// Wall clock is computed once by the caller via lib/notification-trigger
// and passed in as `nowHHMM`; this keeps the function pure.
function isQuietNow(qh, nowHHMM) {
  if (!qh || typeof qh.start !== 'string' || typeof qh.end !== 'string') return false;
  const a = qh.start, b = qh.end, n = nowHHMM;
  if (a === b) return false; // Empty window.
  if (a < b) {
    // Same-day window, e.g. 13:00..17:00.
    return n >= a && n < b;
  }
  // Crosses midnight, e.g. 22:00..07:00.
  return n >= a || n < b;
}

// Append a fire-event to the ring buffer. Each entry: { ts, id, sent,
// failed, statuses }. The Diagnostics tab reads this back to surface
// "why didn't I get reminded".
function appendFire(entry) {
  const state = read();
  const next = [...state.recent_fires, {
    ts: entry.ts || new Date().toISOString(),
    id: entry.id,
    sent: entry.sent || 0,
    failed: entry.failed || 0,
    statuses: Array.isArray(entry.statuses) ? entry.statuses : [],
  }];
  state.recent_fires = next.slice(-RECENT_FIRES_CAP);
  write(state);
}

module.exports = {
  read,
  write,
  writeItem,
  writeGlobal,
  pruneCard,
  getOrInitItem,
  isQuietNow,
  appendFire,
  RECENT_FIRES_CAP,
};
