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
//
// Staleness is opt-in per card (meta.cadence.expectDays); growth and
// orphaned-input are not, because they are author-facing tidy-ups that hold
// regardless of whether a card has a cadence. See the stale check for why.

const { buildRecentActivity } = require('./recent-activity');

// Don't flag growth until a card is genuinely large enough to matter.
const ROW_GROWTH_SOFT_CAP = 730;
// Don't flag staleness/orphans on near-empty cards: too little signal.
const MIN_ROWS_FOR_STALE = 3;

// The declared staleness window, or null when the card never opted in.
// Trusts the registry's validation (meta.cadence is cleaned at load), but
// re-checks the one property this file depends on so a hand-built registry in
// a test or a caller that skipped validation cannot produce a nonsense window.
function cadenceDays(meta) {
  const v = meta && meta.cadence ? meta.cadence.expectDays : null;
  return Number.isInteger(v) && v > 0 ? v : null;
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
//   registry : manifest registry (list/get/dataUpdatedAt/sourceMtime)
//   today    : server-local ISO date (YYYY-MM-DD)
// Returns { findings: [{cardId, kind, severity, detail}] }.
function scanHygiene(registry, today) {
  const activity = buildRecentActivity(registry, today);
  const findings = [];

  for (const card of activity) {
    const entry = typeof registry.get === 'function' ? registry.get(card.id) : null;
    const meta = entry ? entry.meta || {} : {};
    const data = entry ? entry.data : null;

    // A hidden card is not a card the user is neglecting; it is one they chose
    // to put away. `meta.enabled: false` already means "hidden from every view"
    // (registry.js viewEnabled), and hide_card is offered as the non-destructive
    // alternative to deleting, so nagging about staleness afterwards punishes
    // exactly the tidy-up the nudge is asking for. Skipped for every finding
    // kind, not just staleness: growth and orphaned inputs on a put-away card
    // are equally not worth a mention.
    if (meta.enabled === false) continue;

    // Stale-vs-cadence is OPT-IN: a card is only ever flagged when its author
    // declared what cadence it expects, via meta.cadence.expectDays.
    //
    // It used to be opt-out, with a 21-day default guess and an exclusion added
    // each time the nudge embarrassed itself: hidden cards (#560), read-only
    // cards (#564), and a card of undated rows reporting "Last: unknown" (#570).
    // The blocklist kept growing because "is this card stale?" is not answerable
    // from card structure. It needs the author's intent, and now the manifest
    // carries it. A card that says nothing is silent, whatever its shape.
    //
    // The behavioural floor below still applies on top of the opt-in, so opting
    // in cannot resurrect the cases already settled as wrong:
    //   - writeable from the webapp, else "go log something" is impossible
    //     (HAE-fed cards that are ALSO writeable stay in: a phone that stopped
    //     pushing is worth mentioning)
    //   - enough rows to carry signal
    //   - a real per-row date, so the age means "no entry since" rather than
    //     "nothing wrote this file", which is what produced "Last: unknown"
    const expectDays = cadenceDays(meta);
    const userWriteable = !!(meta.writeable && meta.writeable.fromWebapp);
    const dated = card.staleSource === 'rows' && card.lastEntryDate;
    if (expectDays && userWriteable && dated && card.rowCount >= MIN_ROWS_FOR_STALE
        && card.ageDays > expectDays) {
      findings.push({
        cardId: card.id,
        kind: 'stale',
        severity: card.ageDays > expectDays * 2 ? 'warn' : 'info',
        detail: `No entry in ${card.ageDays} days (expected within ~${expectDays}). Last: ${card.lastEntryDate}.`,
      });
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

module.exports = { scanHygiene, ambientStaleness, orphanedInputKeys, cadenceDays };
