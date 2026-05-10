// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// meta/cc-suggestions.js
//
// Combination-card suggestion heuristic + dismissal state.
//
// Surfaces clusters of >=3 enabled atomic cards that share a
// meta.category value, excluding cards already combined in an
// existing combination-card manifest and excluding CCs themselves.
// Dismissal is keyed on `{category}::{sorted cardIds joined by ','}`
// so adding a fourth card to the cluster re-fires as a new suggestion.
//
// Persisted state: $HEALTH_HOME/data/_meta/cc-suggestions-dismissed.json
// Lazily created on first dismiss.

const fs = require('fs');
const path = require('path');
const PATHS = require('../config/paths');

const MIN_CLUSTER_SIZE = 3;
const FILE = path.join(PATHS.DATA_DIR, '_meta', 'cc-suggestions-dismissed.json');

function clusterKey(category, cardIds) {
  return `${category}::${[...cardIds].sort().join(',')}`;
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
    console.error('[cc-suggestions] failed to write dismissed state:', e.message);
  }
}

// Collect the set of card IDs already used as donors in an existing
// combination-card manifest. These are excluded from suggestion clusters
// so a user who already combined HRV + Sleep + Resting HR doesn't get
// re-nagged about the same cluster.
function combinedSourceIds(registry) {
  const used = new Set();
  const all = typeof registry.list === 'function' ? registry.list() : [];
  for (const c of all) {
    const comp = c?.meta?.view?.component;
    if (comp !== 'combination-card') continue;
    const combines = c?.meta?.view?.combines || c?.meta?.viewConfig?.combines || [];
    for (const donor of combines) {
      if (donor?.sourceId) used.add(donor.sourceId);
    }
  }
  return used;
}

// Build the suggestion list by clustering eligible cards by category.
// Returns [{ category, cardIds }, ...] — the UI is responsible for
// turning this into human-readable copy.
function list(registry) {
  const all = typeof registry.list === 'function' ? registry.list() : [];
  const usedInCC = combinedSourceIds(registry);
  const byCategory = {};

  for (const c of all) {
    const meta = c?.meta || {};
    const comp = meta.view?.component;
    if (comp === 'combination-card') continue;        // don't cluster CCs themselves
    if (meta.enabled === false) continue;              // respect master disable
    const cat = meta.category;
    if (!cat) continue;                                // no category → invisible
    if (usedInCC.has(c.id)) continue;                  // already combined
    (byCategory[cat] ||= []).push(c.id);
  }

  const dismissed = loadDismissed();
  const suggestions = [];
  for (const [category, cardIds] of Object.entries(byCategory)) {
    if (cardIds.length < MIN_CLUSTER_SIZE) continue;
    const key = clusterKey(category, cardIds);
    if (dismissed[key]) continue;
    suggestions.push({
      category,
      cardIds: [...cardIds].sort(),
    });
  }

  // Stable output: by category name.
  suggestions.sort((a, b) => a.category.localeCompare(b.category));
  return { suggestions };
}

function dismiss(category, cardIds, now = new Date().toISOString()) {
  if (!category || !Array.isArray(cardIds) || cardIds.length === 0) return false;
  const key = clusterKey(category, cardIds);
  const state = loadDismissed();
  state[key] = {
    category,
    cardIds: [...cardIds].sort(),
    dismissedAt: now,
  };
  saveDismissed(state);
  return true;
}

module.exports = {
  list,
  dismiss,
  loadDismissed,
  clusterKey,
  MIN_CLUSTER_SIZE,
  FILE,
};
