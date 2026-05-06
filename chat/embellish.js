// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// chat/embellish.js
// Pick context-aware "embellishment" offers to surface as chips after the
// chat agent creates or edits a manifest. Pure: no I/O, no registry calls.
// The server runs this against the just-written manifest and attaches the
// result as `followup` on the /api/chat response. Renderer-aware so we only
// offer fields the card can actually take; field-absence gated so we never
// offer something already set.

const MAX_OFFERS = 3;

const INTRO = {
  create: 'Want to flesh it out?',
  edit: 'Anything else while we are here?',
};

// Each entry is { id, label, buildPrompt(label), eligible(meta) }.
// eligible() returns true when the manifest can take this embellishment
// AND the relevant field is currently absent.
const CATALOG = [
  {
    id: 'add-emoji',
    label: 'Pick an emoji',
    buildPrompt: (label) => `Pick an emoji for the ${label} card.`,
    eligible: (meta) => !meta.emoji,
  },
  {
    id: 'add-category',
    label: 'Give it a category',
    buildPrompt: (label) => `Set a category for the ${label} card.`,
    eligible: (meta) => !meta.category,
  },
  {
    id: 'add-calendar',
    label: 'Show on the calendar',
    buildPrompt: (label) => `Enable a calendar marker for the ${label} card.`,
    eligible: (meta) => !(meta.calendar && meta.calendar.enabled),
  },
  {
    id: 'add-thresholds',
    label: 'Add a target range',
    buildPrompt: (label) =>
      `Add coloured target thresholds to the ${label} card so out-of-range values stand out.`,
    eligible: (meta) =>
      renderer(meta) === 'generic-card'
      && !(meta.view && meta.view.display && meta.view.display.thresholds),
  },
  {
    id: 'add-trend-arrow',
    label: 'Show a trend arrow',
    buildPrompt: (label) =>
      `Add a trend arrow to the ${label} card so I can see direction at a glance.`,
    eligible: (meta) =>
      renderer(meta) === 'generic-card'
      && !(meta.view && meta.view.display && meta.view.display.trendArrow),
  },
  {
    id: 'add-trends-line',
    label: 'Include in Trends',
    buildPrompt: (label) =>
      `Include the ${label} card in the Trends view as a line chart.`,
    eligible: (meta) => {
      const r = renderer(meta);
      if (r !== 'generic-card' && r !== 'line-chart') return false;
      return !(meta.trends && meta.trends.enabled);
    },
  },
  {
    id: 'add-trends-timeline',
    label: 'Show as a timeline',
    buildPrompt: (label) =>
      `Include the ${label} card in the Trends view as a schedule timeline.`,
    eligible: (meta) => {
      const r = renderer(meta);
      if (r !== 'schedule-card' && r !== 'checklist-card') return false;
      return !(meta.trends && meta.trends.enabled);
    },
  },
  {
    id: 'add-adherence-report',
    label: 'Track adherence in Reports',
    buildPrompt: (label) =>
      `Add an adherence report for the ${label} card so I can see how I am tracking.`,
    eligible: (meta) => {
      const r = renderer(meta);
      if (r !== 'schedule-card' && r !== 'checklist-card') return false;
      return !(meta.reports && meta.reports.enabled);
    },
  },
  {
    id: 'add-daily-prompt',
    label: 'Nag me daily',
    buildPrompt: (label) =>
      `Enable the daily modal prompt for the ${label} card so it asks me to log each day.`,
    eligible: (meta) => {
      const inputs = meta.writeable && Array.isArray(meta.writeable.inputs)
        ? meta.writeable.inputs
        : null;
      if (!inputs || inputs.length === 0) return false;
      return !(meta.prompt && meta.prompt.enabled);
    },
  },
];

function renderer(meta) {
  return (meta && meta.view && meta.view.component) || null;
}

function pickEmbellishments(manifest, { rng = Math.random, flow = 'create' } = {}) {
  if (!manifest || !manifest.meta) return null;
  const meta = manifest.meta;
  const label = meta.label || meta.id || 'card';

  const eligible = CATALOG.filter(e => {
    try { return e.eligible(meta); }
    catch { return false; }
  });
  if (eligible.length === 0) return null;

  const shuffled = shuffle(eligible, rng).slice(0, MAX_OFFERS);
  const text = INTRO[flow] || INTRO.create;
  const embellishments = shuffled.map(e => ({
    id: e.id,
    label: e.label,
    prompt: e.buildPrompt(label),
  }));
  return { text, embellishments };
}

function shuffle(arr, rng) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

module.exports = { pickEmbellishments, CATALOG, MAX_OFFERS, INTRO };
