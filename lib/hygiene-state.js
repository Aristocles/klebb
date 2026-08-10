// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// lib/hygiene-state.js
// Dismissal sidecar for the ambient hygiene surface (GET /api/hygiene),
// mirroring meta/cc-suggestions dismissals: whole-file atomic JSON under the
// gitignored data/_meta/ namespace, created lazily on first dismiss.
//
// A dismissal is keyed by cardId + kind, so silencing a stale nudge for one
// card never suppresses a different card or a different finding kind.
//
// Dismissal is permanent. `dismissedAt` is recorded for the audit trail, not
// as an expiry: nothing reads it back. Staleness is opt-in per card
// (meta.cadence), so a dismissal is the author withdrawing a request to be
// chased, which does not lapse. Deleting the entry from this file, or dropping
// the card's cadence, is how you change your mind.

const fs = require('fs');
const path = require('path');
const PATHS = require('../config/paths');

const FILE = path.join(PATHS.DATA_DIR, '_meta', 'hygiene-dismissed.json');

function key(cardId, kind) {
  return `${cardId}::${kind}`;
}

function loadDismissed() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveDismissed(state) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, FILE);
  } catch (e) {
    console.error('[hygiene] failed to write dismissed state:', e.message);
  }
}

function isDismissed(cardId, kind) {
  return Object.prototype.hasOwnProperty.call(loadDismissed(), key(cardId, kind));
}

function dismiss(cardId, kind, now = new Date().toISOString()) {
  if (!cardId || !kind) return false;
  const state = loadDismissed();
  state[key(cardId, kind)] = { cardId, kind, dismissedAt: now };
  saveDismissed(state);
  return true;
}

// Drop findings the user has already dismissed.
function filterDismissed(findings) {
  const state = loadDismissed();
  return findings.filter(f => !Object.prototype.hasOwnProperty.call(state, key(f.cardId, f.kind)));
}

module.exports = { isDismissed, dismiss, filterDismissed, loadDismissed, FILE };
