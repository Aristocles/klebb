// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// public/js/lib/hero-tier.js
// Partition the Today view's cards into a pinned hero band plus the rest.
//
// A card opts into the hero tier by setting a numeric meta.view.priority
// (lower = higher up). Presence of priority flags the card as "pinned" for
// a visual affordance; it does NOT re-sort the list. The server already
// sorts cards by (viewConfig.order ?? meta.order), and a manual reorder
// rewrites meta.order, so preserving the incoming order is what lets a drag
// stick: priority can never override a deliberate manual placement. Authors
// give a hero card a low meta.order to seed it near the top; once the user
// drags it, meta.order reflects the new position and nothing snaps it back.
//
// Only the default Today view ('view') gets the pinned flag; every other
// view (trends, calendar, reports, dayDetail) is returned with pinned:false.

const HERO_VIEW = 'view';

function priorityOf(card) {
  const p = card?.meta?.view?.priority;
  return typeof p === 'number' && Number.isFinite(p) ? p : null;
}

// Returns a new array of { card, pinned } in the SAME order as the input
// (the server's meta.order sequence). pinned is true when the card declares
// a numeric priority; it is a styling hook only, never a sort key.
export function orderCardsForView(cards, view) {
  const list = Array.isArray(cards) ? cards : [];
  if (view !== HERO_VIEW) {
    return list.map(card => ({ card, pinned: false }));
  }
  return list.map(card => ({ card, pinned: priorityOf(card) !== null }));
}
