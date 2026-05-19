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
// CCs have fewer meaningfully-different embellishments but they're the
// whole point of the renderer, so give them a slightly higher cap.
const MAX_CC_OFFERS = 4;

const INTRO = {
  create: 'Want to flesh it out?',
  edit: 'Anything else while we are here?',
};

const INTRO_CC = {
  create: 'CCs shine with embellishments. Try one:',
  edit: 'Anything else to layer on?',
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

// CC-specific embellishment picks. Runs when the just-modified manifest
// is a combination card. Order matters (priority, not random): we offer
// layout switch first because it changes the shape of every other
// embellishment, then per-donor promotions, then per-donor polish.
//
// Returns a { text, embellishments } tuple in the same shape pickEmbellishments
// returns for atomic cards, or null when nothing applies.
function pickCcEmbellishments(manifest, { flow = 'create' } = {}) {
  const meta = manifest.meta;
  const label = meta.label || meta.id || 'card';
  const view = meta.view || {};
  const combines = Array.isArray(view.combines) ? view.combines : [];
  if (combines.length === 0) return null;

  const chips = [];

  // 1. Layout switch — the shape-level choice.
  const layout = view.layout || 'stack';
  if (layout === 'stack') {
    chips.push({
      id: 'cc-switch-to-rings',
      label: 'Switch to rings layout',
      prompt: `Change the ${label} card's layout to rings. For each ring segment, ask me for a sensible daily goal and pick a colour.`,
    });
  } else if (layout === 'rings') {
    chips.push({
      id: 'cc-switch-to-stack',
      label: 'Switch to stack layout',
      prompt: `Change the ${label} card back to the stack layout.`,
    });
  }

  // 2. Promote a donor to primary when nothing is primary yet. Pick the
  // first donor as the suggestion target; klebbius can ask the user to
  // pick a different one.
  const hasPrimary = combines.some(c => c && c.role === 'primary');
  if (!hasPrimary && combines[0]) {
    const donor = combines[0];
    const donorLabel = donor.label || donor.sourceId;
    chips.push({
      id: 'cc-set-primary',
      label: `Make ${donorLabel} primary`,
      prompt: `On the ${label} card, make "${donor.sourceId}" the primary donor so it renders larger than the others. If another donor would be a better primary, propose it instead.`,
    });
  }

  // 3. For any ring-segment donor missing both goalDaily and goalWeekly,
  // offer goals.
  const ringSegmentsNoGoal = combines.filter(c =>
    c && c.role === 'ring-segment'
    && c.goalDaily === undefined
    && c.goalWeekly === undefined);
  if (ringSegmentsNoGoal.length > 0) {
    // One chip covering all ungoaled ring segments at once — less noisy
    // than one chip per donor when users just switched to rings.
    const names = ringSegmentsNoGoal.map(c => c.label || c.sourceId);
    chips.push({
      id: 'cc-add-goals',
      label: ringSegmentsNoGoal.length === 1
        ? `Add a goal for ${names[0]}`
        : 'Add goals to the rings',
      prompt: `On the ${label} card, set a sensible goal for each ring segment: ${names.join(', ')}. For per-day targets use goalDaily; for weekly accumulation (Mon-Sun) use goalWeekly. Ask me what I'm aiming for if unclear.`,
    });
  }

  // 4. Colour-code ring segments that don't have a colour yet.
  const ringSegmentsNoColour = combines.filter(c =>
    c && c.role === 'ring-segment' && !c.colour);
  if (ringSegmentsNoColour.length > 0) {
    chips.push({
      id: 'cc-set-colours',
      label: 'Colour-code the rings',
      prompt: `On the ${label} card, pick a distinct colour for each ring segment so they're easy to tell apart at a glance.`,
    });
  }

  if (chips.length === 0) return null;

  return {
    text: (INTRO_CC[flow] || INTRO_CC.create),
    embellishments: chips.slice(0, MAX_CC_OFFERS),
  };
}

function pickEmbellishments(manifest, { rng = Math.random, flow = 'create' } = {}) {
  if (!manifest || !manifest.meta) return null;
  const meta = manifest.meta;

  // CCs have their own branch — the atomic-card catalogue doesn't have
  // meaningful options for them (e.g. "add a trend arrow" doesn't apply
  // to a combination-card renderer).
  if (renderer(meta) === 'combination-card') {
    return pickCcEmbellishments(manifest, { flow });
  }

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

module.exports = {
  pickEmbellishments,
  pickCcEmbellishments,
  CATALOG,
  MAX_OFFERS,
  MAX_CC_OFFERS,
  INTRO,
  INTRO_CC,
};
