// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// lib/activity-state.js
// A coarse "is anyone actually using this instance" signal for the
// control-plane admin API: when the user last interacted, and on how many of
// the trailing seven days they did at all.
//
// Interaction is deliberately narrow: a session-authenticated request that
// either mutates something (non-GET API) or loads the app shell. GET API
// traffic is excluded on purpose because components poll, and a tab left
// open over a weekend must not read as a person. Agent-bearer, admin-API and
// ingest traffic never reach record() at all: the caller only reports
// session-authenticated requests.
//
// State is a small JSON sidecar under data/_meta/ (the dismissals pattern):
// in-memory counters, flushed at most once a minute and on shutdown, pruned
// past 14 days. Losing up to a minute on a crash is fine; the signal is
// coarse by design.

const fs = require('fs');
const path = require('path');
const PATHS = require('../config/paths');

const FILE = path.join(PATHS.DATA_DIR, '_meta', 'activity.json');
const FLUSH_MS = 60 * 1000;
const KEEP_DAYS = 14;

let state = null;
let dirty = false;
let lastFlush = 0;

function load() {
  if (state) return state;
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    state = {
      lastActiveAt: typeof raw.lastActiveAt === 'string' ? raw.lastActiveAt : null,
      days: raw.days && typeof raw.days === 'object' ? raw.days : {},
    };
  } catch {
    state = { lastActiveAt: null, days: {} };
  }
  return state;
}

function prune(now) {
  const cutoff = new Date(now - KEEP_DAYS * 86400000).toISOString().slice(0, 10);
  for (const day of Object.keys(state.days)) {
    if (day < cutoff) delete state.days[day];
  }
}

function flush(now = Date.now()) {
  if (!dirty || !state) return;
  prune(now);
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, FILE);
    dirty = false;
    lastFlush = now;
  } catch (e) {
    console.warn('[activity] flush failed:', e.message);
  }
}

// The caller has already established a session-authenticated human request;
// this decides whether it counts as an interaction and records it.
function record(method, pathname, now = Date.now()) {
  const shell = pathname === '/' || pathname === '/index.html';
  if (method === 'GET' && !shell) return;
  load();
  state.lastActiveAt = new Date(now).toISOString();
  const day = state.lastActiveAt.slice(0, 10);
  state.days[day] = (state.days[day] || 0) + 1;
  dirty = true;
  if (now - lastFlush >= FLUSH_MS) flush(now);
}

// { lastActiveAt, activeDays7 } for /api/admin/info. Distinct days, not
// request counts: counts would reward noisy sessions over regular ones.
function summary(now = Date.now()) {
  load();
  const cutoff = new Date(now - 7 * 86400000).toISOString().slice(0, 10);
  const activeDays7 = Object.keys(state.days).filter(d => d > cutoff).length;
  return { lastActiveAt: state.lastActiveAt, activeDays7 };
}

module.exports = { record, summary, flush };
