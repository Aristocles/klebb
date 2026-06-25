// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// public/js/lib/card-advanced.js
// "Discover and park" for advanced, user-added feature blocks.
//
// Some cards carry rich optional blocks a user added via Klebbius (a
// schedule card's per-dose check-off form, a generic card's thresholds,
// etc.). The gear can't *author* these, but it can turn an existing one
// off without losing it, and back on later. "Off" moves the block to a
// parking namespace under meta.view._disabled.<feature>; "on" moves it
// back. Renderers only ever read the LIVE path, so absence == off, which
// is exactly how they already behave.
//
// Invariant — LIVE WINS, PARKED EVAPORATES:
//   The renderer honours only the live block. The parked copy is consulted
//   only when no live block exists. If both exist (e.g. Klebbius rebuilt
//   the feature while it was parked), the live block wins and the stale
//   parked copy is purged. No merge, no reconciliation.
//
// Klebbius is blind to _disabled: the user re-enables via this toggle.
//
// display.template is intentionally NOT parkable — it is the card's
// headline, not an optional feature; parking it would blank the card.

import { getAtPath } from './card-settings.js';

const PARK_ROOT = 'view._disabled';

// Registry of parkable features. `key` is the field name under meta.view;
// `livePath`/`parkPath` are dotted, rooted at meta (matching card-settings
// descriptors). `present(v)` decides whether a value counts as a real,
// non-empty block worth offering a toggle for.
export const ADVANCED_FEATURES = [
  {
    key: 'checkOffForm',
    label: 'Per-dose check-off form',
    help: 'Captures extra fields (e.g. injection site, reactions) when you tick a dose.',
    components: ['schedule-card'],
    present: (v) => isObj(v) && (arr(v.currentDoseFields).length > 0 || arr(v.previousDoseFields).length > 0),
  },
  {
    key: 'colorMap',
    label: 'Custom item colours',
    help: 'Hand-picked colours for each scheduled item.',
    components: ['schedule-card'],
    present: (v) => isObj(v) && Object.keys(v).length > 0,
  },
];

// Display-block features live under meta.view.display.<key>. Same contract,
// different parent path.
export const ADVANCED_DISPLAY_FEATURES = [
  {
    key: 'thresholds',
    label: 'Status thresholds',
    help: 'Colour bands + labels based on the logged value.',
    components: ['generic-card'],
    present: (v) => Array.isArray(v) && v.length > 0,
  },
  {
    key: 'trendArrow',
    label: 'Trend arrow',
    help: 'An up/down arrow comparing the latest value to the previous one.',
    components: ['generic-card'],
    present: (v) => isObj(v) && !!v.field,
  },
  {
    key: 'emojiMap',
    label: 'Emoji value labels',
    help: 'Renders chosen values (e.g. a mood rating) as emoji.',
    components: ['generic-card'],
    present: (v) => isObj(v) && Object.keys(v).length > 0,
  },
];

function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function arr(v) { return Array.isArray(v) ? v : []; }

// All feature definitions that apply to a given renderer component, each
// tagged with the dotted live + park paths it occupies.
function featuresFor(component) {
  const out = [];
  for (const f of ADVANCED_FEATURES) {
    if (f.components.includes(component)) {
      out.push({ ...f, livePath: `view.${f.key}`, parkPath: `${PARK_ROOT}.${f.key}` });
    }
  }
  for (const f of ADVANCED_DISPLAY_FEATURES) {
    if (f.components.includes(component)) {
      out.push({ ...f, livePath: `view.display.${f.key}`, parkPath: `${PARK_ROOT}.display.${f.key}` });
    }
  }
  return out;
}

// Discover the advanced features to show for this card. Each entry:
//   { key, label, help, on, livePath, parkPath, _stale }
// `on` reflects the live block's presence (live wins). `_stale` flags a
// parked copy shadowed by a live block — it should be purged on next save.
// A feature with neither a live nor a parked block is omitted (there's
// nothing to toggle until Klebbius creates it).
export function discoverAdvanced(meta, component) {
  const defs = featuresFor(component);
  const found = [];
  for (const f of defs) {
    const live = getAtPath(meta, f.livePath);
    const parked = getAtPath(meta, f.parkPath);
    const hasLive = f.present(live);
    const hasParked = f.present(parked);
    if (!hasLive && !hasParked) continue;
    found.push({
      key: f.key,
      label: f.label,
      help: f.help,
      on: hasLive,
      livePath: f.livePath,
      parkPath: f.parkPath,
      _stale: hasLive && hasParked, // parked copy is stale; purge it
    });
  }
  return found;
}

// Build the meta-patch for a set of advanced-feature toggle decisions.
// `edits` maps feature.key -> desired on/off boolean. `discovered` is the
// output of discoverAdvanced (carries the current value + paths).
//
// Turning OFF: copy the live block to its park path, null the live path.
// Turning ON:  copy the parked block to its live path, null the park path.
// Stale parked copies (live present AND parked present) are purged whenever
// we touch that feature, enforcing live-wins.
//
// Returns null when nothing changed.
export function buildAdvancedPatch(meta, discovered, edits) {
  const meta_ = {};
  let changed = false;
  // Track which park sub-keys we end up clearing, so we can collapse an
  // emptied _disabled (and _disabled.display) rather than leave {} behind.
  for (const feat of discovered) {
    const desired = (feat.key in edits) ? edits[feat.key] : feat.on;
    const live = getAtPath(meta, feat.livePath);
    const parked = getAtPath(meta, feat.parkPath);

    if (desired === feat.on && !feat._stale) continue; // no change for this feature

    if (desired) {
      // Turn ON: restore from parked (if live absent), purge park slot.
      if (!isPresentValue(live) && isPresentValue(parked)) {
        setLeaf(meta_, feat.livePath, deepClone(parked));
      }
      setLeaf(meta_, feat.parkPath, null);
      changed = true;
    } else {
      // Turn OFF: park the live block, null the live path. If a stale
      // parked copy exists it is overwritten by the current live block.
      if (isPresentValue(live)) {
        setLeaf(meta_, feat.parkPath, deepClone(live));
        setLeaf(meta_, feat.livePath, null);
        changed = true;
      } else if (feat._stale) {
        // No live block but flagged stale — shouldn't happen, but purge.
        setLeaf(meta_, feat.parkPath, null);
        changed = true;
      }
    }
  }
  return changed ? { meta: meta_ } : null;
}

function isPresentValue(v) {
  if (v === undefined || v === null) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return true;
}

function deepClone(v) {
  return JSON.parse(JSON.stringify(v));
}

// Set a leaf at a dotted path rooted at meta, building intermediate
// objects. Mirrors card-settings.setAtPath but kept local so this module
// can also write nested paths under view._disabled.display.*.
function setLeaf(obj, path, value) {
  const keys = path.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (cur[k] == null || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
  return obj;
}
