// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// public/js/lib/hero-tier.js
// Partition the Today view's cards into a pinned hero band plus the rest.
//
// A card opts into the hero tier by setting a numeric meta.view.priority
// (lower = higher up). Presence of priority means pinned. The band only
// applies to the default Today view ('view'); every other view (trends,
// calendar, reports, dayDetail) is returned untouched with pinned:false so
// there is no behavioural change away from Today.
//
// Input cards are assumed already sorted by the server's order convention
// (viewConfig.order ?? meta.order). Both the partition (within pinned) and
// the rest preserve that incoming order for ties, so absent any priority
// the output order is identical to the input.

const HERO_VIEW = 'view';

function priorityOf(card) {
  const p = card?.meta?.view?.priority;
  return typeof p === 'number' && Number.isFinite(p) ? p : null;
}

// Returns a new array of { card, pinned } in render order. Stable: equal
// priorities keep their incoming relative order.
export function orderCardsForView(cards, view) {
  const list = Array.isArray(cards) ? cards : [];
  if (view !== HERO_VIEW) {
    return list.map(card => ({ card, pinned: false }));
  }
  const pinned = [];
  const rest = [];
  list.forEach((card, i) => {
    const p = priorityOf(card);
    if (p !== null) pinned.push({ card, priority: p, i });
    else rest.push({ card });
  });
  pinned.sort((a, b) => (a.priority - b.priority) || (a.i - b.i));
  return [
    ...pinned.map(({ card }) => ({ card, pinned: true })),
    ...rest.map(({ card }) => ({ card, pinned: false })),
  ];
}
