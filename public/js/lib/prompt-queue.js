// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// public/js/lib/prompt-queue.js
// Evaluate which cards opt into meta.prompt and should fire today.
//
// See docs/CARDS.md → Modal prompts for user-facing documentation.
//
// Algorithm (per the locked spec):
//   For each manifest with meta.prompt.enabled === true:
//     1. If a shown-today localStorage marker exists → skip
//     2. If prompt.whenMissing (default true) AND today's entry
//        already exists in the data → skip
//     3. Otherwise → include in the queue
//   Sort the queue by meta.order ascending, stable.
//
// Exports:
//   checkPromptsForToday() -> Promise<Array<Card>>
//     Returns full manifest objects ({ meta, data }) ready to pass to
//     eh-prompt-modal.

import { localToday } from './date-util.js';
import { isScheduledOnDate } from '../../../lib/schedule.js';

const STORAGE_PREFIX = 'klebb-prompt-shown-';

function todayStr() {
  return localToday();
}

export function shownTodayKey(cardId, date = todayStr()) {
  return `${STORAGE_PREFIX}${cardId}-${date}`;
}

export function wasShownToday(cardId, date = todayStr(), storage = globalThis.localStorage) {
  try {
    return storage?.getItem(shownTodayKey(cardId, date)) === '1';
  } catch {
    return false;
  }
}

export function markShownToday(cardId, date = todayStr(), storage = globalThis.localStorage) {
  try {
    storage?.setItem(shownTodayKey(cardId, date), '1');
  } catch {
    // quota / private-mode — non-fatal
  }
}

// Detect whether a card has an entry for the given date.
// Supports the common shapes:
//   data: [{ date, ... }]              — generic-card entries
//   data.items: [...]                  — schedule-card / checklist items
//     each item may have doses: [{ scheduledDate, takenAt }]
//     or takenDates: [YYYY-MM-DD, ...]
//   data.current: [...]                — supplements-style; uses takenDates
// For cards with items + per-day ticks, "entry exists today" means:
//   at least one item has a taken mark for today. (Some cards have
//   multiple items; the modal is opt-in so this behaviour is documented
//   as "shows until ANY item is ticked off".)
//
// For checklist-mode prompts the gate is per-item, not any/all-or-nothing
// — see allScheduledTakenForDate below.
export function entryExistsForDate(data, date) {
  if (!data) return false;
  if (Array.isArray(data)) {
    return data.some(row => row && row.date === date);
  }
  if (Array.isArray(data.items)) {
    for (const item of data.items) {
      if (Array.isArray(item.doses)) {
        if (item.doses.some(dd => dd.scheduledDate === date && dd.takenAt)) return true;
      }
      if (Array.isArray(item.takenDates) && item.takenDates.includes(date)) return true;
    }
    return false;
  }
  if (Array.isArray(data.current)) {
    for (const item of data.current) {
      if (Array.isArray(item.takenDates) && item.takenDates.includes(date)) return true;
    }
    return false;
  }
  return false;
}

// Eligibility helper for checklist-mode prompts. Returns true when every
// item scheduled for the given date already has a takenAt dose, i.e. the
// checklist would render with nothing to tick. The default
// entryExistsForDate is too eager here — it would suppress the prompt as
// soon as one of three items was logged.
export function allScheduledTakenForDate(data, date) {
  const items = Array.isArray(data?.items)
    ? data.items
    : Array.isArray(data?.current) ? data.current
    : [];
  let scheduledCount = 0;
  for (const item of items) {
    if (isScheduledOnDate(item, date) !== 'scheduled') continue;
    scheduledCount++;
    const dosed = Array.isArray(item.doses)
      && item.doses.some(d => d.scheduledDate === date && d.takenAt);
    const flagged = Array.isArray(item.takenDates) && item.takenDates.includes(date);
    if (!dosed && !flagged) return false;
  }
  return scheduledCount > 0;
}

// Build the set of donor ids surfaced by at least one visible
// combination card. A combination card lists its donors in
// meta.view.combines[].sourceId; if the combo itself is visible, those
// donors are effectively visible to the user even when their atomic
// card has meta.enabled:false. See #316 — without this, hiding the
// atomic Mood card to roll it into a combo silently kills its prompt.
function surfacedByVisibleCombo(manifests) {
  const out = new Set();
  for (const card of manifests || []) {
    const meta = card?.meta;
    if (!meta) continue;
    if (meta.enabled === false) continue;
    const combines = meta.view?.combines;
    if (!Array.isArray(combines)) continue;
    for (const c of combines) {
      if (c?.sourceId) out.add(c.sourceId);
    }
  }
  return out;
}

// Build the queue. Pure function separated so tests can run it against
// a synthetic manifest list without hitting the network.
//
// `surfaced` (optional) lets the caller pre-compute donor-visibility from
// a wider manifest list than `manifests` itself. The network path passes
// only candidate cards in `manifests`, so combo cards aren't there to
// rediscover the surfacing relationship — see #338.
export function buildPromptQueue(manifests, {
  date = todayStr(),
  storage = globalThis.localStorage,
  surfaced = null,
} = {}) {
  const out = [];
  if (!surfaced) surfaced = surfacedByVisibleCombo(manifests);
  for (const card of manifests || []) {
    const meta = card?.meta;
    if (!meta) continue;
    const prompt = meta.prompt;
    if (!prompt || prompt.enabled !== true) continue;
    // Respect disabled cards at the registry level — don't nag about
    // cards the user has hidden. Exception: a hidden card surfaced by
    // a visible combination card still prompts, since the user is
    // seeing it through the combo (#316).
    if (meta.enabled === false && !surfaced.has(meta.id)) continue;
    if (wasShownToday(meta.id, date, storage)) continue;
    const whenMissing = prompt.whenMissing !== false; // default true
    if (whenMissing) {
      const eligible = prompt.mode === 'checklist'
        ? !allScheduledTakenForDate(card.data, date)
        : !entryExistsForDate(card.data, date);
      if (!eligible) continue;
    }
    out.push(card);
  }
  // meta.order ascending, stable on id for determinism
  out.sort((a, b) => {
    const oa = a.meta.order ?? 999;
    const ob = b.meta.order ?? 999;
    if (oa !== ob) return oa - ob;
    return (a.meta.id || '').localeCompare(b.meta.id || '');
  });
  return out;
}

export async function checkPromptsForToday() {
  let list;
  try {
    const r = await fetch('/api/manifests', { credentials: 'same-origin' });
    if (!r.ok) return [];
    list = await r.json();
  } catch {
    return [];
  }
  // /api/manifests returns { entries: [{id, meta}, ...] } — no data inline.
  const entries = Array.isArray(list?.entries) ? list.entries
                : Array.isArray(list?.manifests) ? list.manifests
                : Array.isArray(list) ? list : [];
  // First-pass filter: only fetch data for cards that opt into prompts
  // AND haven't already been shown today. This avoids a data fetch for
  // every card on the homepage every time the app loads.
  const date = todayStr();
  // A hidden donor that's referenced by a visible combination card
  // still warrants a prompt (#316). Compute this against the full
  // manifest list before filtering out hidden cards.
  const surfaced = surfacedByVisibleCombo(
    entries.map(e => ({ meta: e.meta || e })),
  );
  const candidates = [];
  for (const e of entries) {
    const meta = e.meta || e;
    const prompt = meta?.prompt;
    if (!prompt || prompt.enabled !== true) continue;
    if (meta.enabled === false && !surfaced.has(meta.id)) continue;
    if (wasShownToday(meta.id, date)) continue;
    candidates.push(meta);
  }
  if (candidates.length === 0) return [];

  // Fetch data only for candidates.
  const withData = await Promise.all(candidates.map(async (meta) => {
    try {
      const r = await fetch(`/api/manifests/${encodeURIComponent(meta.id)}/data`, {
        credentials: 'same-origin',
      });
      if (!r.ok) return { meta, data: null };
      const j = await r.json();
      return { meta, data: j?.data ?? j };
    } catch {
      return { meta, data: null };
    }
  }));

  return buildPromptQueue(withData, { date, surfaced });
}
