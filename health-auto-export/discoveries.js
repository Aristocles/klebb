// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// health-auto-export/discoveries.js
//
// Persists a per-instance record of HAE metrics that have been seen in
// payloads but that no manifest subscribes to yet. Shape on disk:
//
//   {
//     "heart_rate_variability": {
//       "firstSeenAt": "2026-05-08T14:22:11.003Z",
//       "dismissed": false
//     },
//     "blood_oxygen_saturation": {
//       "firstSeenAt": "2026-05-08T14:22:11.003Z",
//       "dismissed": true,
//       "dismissedAt": "2026-05-09T08:15:00.000Z"
//     }
//   }
//
// Lives at $HEALTH_HOME/data/auto-export/discovered.json. Created
// lazily on the first unsubscribed metric. The dispatcher calls
// sync() after every push; API handlers call dismiss() / unhide() /
// load() on user action.

const fs = require('fs');
const path = require('path');
const PATHS = require('../config/paths');

const FILE = path.join(PATHS.AUTO_EXPORT_DIR, 'discovered.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return {};
  }
}

function save(state) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, FILE);
  } catch (e) {
    console.error('[hae] failed to write discovered.json:', e.message);
  }
}

// Reconcile the on-disk discoveries state against the latest push.
//   seen:       metrics present in the payload but unsubscribed
//   subscribed: metrics now covered by a subscriber (used for cleanup)
// New entries for unseen-before metrics preserve default dismissed:false.
// Existing entries have their dismiss state preserved across sync calls.
// Subscribed metrics are removed entirely — the card that subscribes is
// the discovery's graduation.
function sync({ seen, subscribed, now = new Date().toISOString() }) {
  const state = load();
  let changed = false;

  for (const metric of seen || []) {
    if (subscribed && subscribed.includes(metric)) continue;
    if (!state[metric]) {
      state[metric] = { firstSeenAt: now, dismissed: false };
      changed = true;
    }
  }

  for (const metric of subscribed || []) {
    if (state[metric]) {
      delete state[metric];
      changed = true;
    }
  }

  if (changed) save(state);
  return state;
}

function dismiss(metric, now = new Date().toISOString()) {
  const state = load();
  if (!state[metric]) return false;
  state[metric].dismissed = true;
  state[metric].dismissedAt = now;
  save(state);
  return true;
}

function unhide(metric) {
  const state = load();
  if (!state[metric]) return false;
  state[metric].dismissed = false;
  delete state[metric].dismissedAt;
  save(state);
  return true;
}

// Consumed by GET /api/health-auto-export/discoveries and the UI.
// Partitions undismissed entries into catalogue-supported (grouped by
// category) vs unsupported (flat list). Dismissed entries remain flat.
// Shape:
//   {
//     undismissed: {
//       supported:   { [category]: [{metric, firstSeenAt}, ...] },
//       unsupported: [{metric, firstSeenAt}, ...]
//     },
//     dismissed: [{metric, firstSeenAt, dismissedAt}, ...]
//   }
function list() {
  // Lazy-require to avoid any circular import surprise.
  const catalogue = require('./catalogue');
  const state = load();
  const supported = {};
  const unsupported = [];
  const dismissed = [];

  for (const [metric, entry] of Object.entries(state)) {
    const row = { metric, firstSeenAt: entry.firstSeenAt };
    if (entry.dismissed) {
      dismissed.push({ ...row, dismissedAt: entry.dismissedAt });
      continue;
    }
    const cat = catalogue[metric];
    if (cat && cat.category) {
      (supported[cat.category] ||= []).push(row);
    } else {
      unsupported.push(row);
    }
  }

  // Stable orderings: by firstSeenAt within each group, metric name in
  // the unsupported + dismissed lists.
  for (const group of Object.values(supported)) {
    group.sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt));
  }
  unsupported.sort((a, b) => a.metric.localeCompare(b.metric));
  dismissed.sort((a, b) => a.metric.localeCompare(b.metric));

  return {
    undismissed: { supported, unsupported },
    dismissed,
  };
}

module.exports = { load, sync, dismiss, unhide, list, FILE };
