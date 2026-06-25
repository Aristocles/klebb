// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// chat/hygiene.js
// Card-hygiene findings for the Klebbius agent. Pure, deterministic checks
// over the manifest registry; never auto-corrects, only reports. Builds on
// the shared recency/staleness derivation in recent-activity.js so freshness
// is computed in exactly one place.
//
// Severity is advisory: 'info' < 'warn'. The ambient surface (GET /api/hygiene)
// only carries high-confidence staleness; the full set is for the on-demand
// hygiene_scan tool, where the agent mediates whether to surface a finding.

const { buildRecentActivity, dateFieldFor } = require('./recent-activity');

// How long a card may sit untouched before it reads as "stale". Cards with a
// daily-ish cadence go stale fast; everything else gets a generous window.
const STALE_DAYS_DEFAULT = 21;
const STALE_DAYS_SCHEDULED = 7;
// Don't flag growth until a card is genuinely large enough to matter.
const ROW_GROWTH_SOFT_CAP = 730;
// Don't flag staleness/orphans on near-empty cards: too little signal.
const MIN_ROWS_FOR_STALE = 3;

// Does any data.items[] entry carry a recurring schedule? Such cards expect
// frequent check-offs, so they go stale faster. Defensive: data shape varies.
function hasScheduleCadence(data) {
  const items = Array.isArray(data) ? data : (data && Array.isArray(data.items) ? data.items : null);
  if (!items) return false;
  return items.some(it => it && typeof it === 'object' && it.schedule && typeof it.schedule === 'object');
}

// Inputs whose key never appears in any data row. A genuine "you built a
// field nobody fills" signal. Only meaningful for array-of-rows cards that
// actually declare inputs.
function orphanedInputKeys(meta, data) {
  const inputs = meta && meta.writeable && Array.isArray(meta.writeable.inputs) ? meta.writeable.inputs : [];
  if (inputs.length === 0 || !Array.isArray(data) || data.length === 0) return [];
  const seen = new Set();
  for (const row of data) {
    if (row && typeof row === 'object') for (const k of Object.keys(row)) seen.add(k);
  }
  return inputs
    .map(i => i && typeof i.key === 'string' ? i.key : null)
    .filter(k => k && !seen.has(k));
}

// Build the full hygiene finding list.
//   registry : manifest registry (list/get/sourceMtime)
//   today    : server-local ISO date (YYYY-MM-DD)
// Returns { findings: [{cardId, kind, severity, detail}] }.
function scanHygiene(registry, today) {
  const activity = buildRecentActivity(registry, today);
  const findings = [];

  for (const card of activity) {
    const entry = typeof registry.get === 'function' ? registry.get(card.id) : null;
    const meta = entry ? entry.meta || {} : {};
    const data = entry ? entry.data : null;
    const scheduled = hasScheduleCadence(data);

    // Stale-vs-cadence: a card with enough history that has gone quiet past
    // its expected window. Tighter window for schedule-bearing cards.
    if (card.ageDays != null && card.rowCount >= MIN_ROWS_FOR_STALE) {
      const limit = scheduled ? STALE_DAYS_SCHEDULED : STALE_DAYS_DEFAULT;
      if (card.ageDays > limit) {
        findings.push({
          cardId: card.id,
          kind: 'stale',
          severity: card.ageDays > limit * 2 ? 'warn' : 'info',
          detail: `No entry in ${card.ageDays} days (expected within ~${limit}). Last: ${card.lastEntryDate || 'unknown'}.`,
        });
      }
    }

    // Unbounded growth: a very large data block that would benefit from a
    // rolling window or archive.
    if (card.rowCount > ROW_GROWTH_SOFT_CAP) {
      findings.push({
        cardId: card.id,
        kind: 'growth',
        severity: 'info',
        detail: `${card.rowCount} rows; consider archiving old data or a rolling window.`,
      });
    }

    // Orphaned inputs: declared capture fields that no row ever uses.
    const orphans = orphanedInputKeys(meta, data);
    if (orphans.length) {
      findings.push({
        cardId: card.id,
        kind: 'orphaned-input',
        severity: 'info',
        detail: `Input field(s) never logged: ${orphans.join(', ')}. Remove from meta.writeable.inputs or start logging them.`,
      });
    }
  }

  return { findings };
}

// The ambient surface (GET /api/hygiene) only ever shows high-confidence
// staleness: unambiguous, self-explanatory, and the one signal worth a passive
// nudge. Everything else is pull-only via hygiene_scan to avoid nagging.
function ambientStaleness(registry, today) {
  return scanHygiene(registry, today).findings.filter(f => f.kind === 'stale');
}

module.exports = { scanHygiene, ambientStaleness, orphanedInputKeys, hasScheduleCadence };
