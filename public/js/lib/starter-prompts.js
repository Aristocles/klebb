// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// public/js/lib/starter-prompts.js
// Dual-runtime picker for chat-widget starter chips driven by the
// enabled cards' meta.chat.starterPrompts arrays. See #195.
//
// Pure functions — no I/O, no DOM. Consumed by health-chat.js in the
// browser and by tests/starter-prompts.test.js under node --test.
//
// Input:
//   cards            — array of card meta objects
//                      ({ id, label, chat: { starterPrompts: [{text,kind}] }? })
//   opts.count       — target chip count (default 7)
//   opts.random      — optional Math.random substitute for deterministic tests
//
// Output:
//   array of { text, kind, cardId } of length <= count, balanced so
//   kind: "data" and kind: "tweak" roughly alternate (no strict 50/50).
//   Missing manifests → generated default of kind "data".

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ehStarterPrompts = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {

  const VALID_KINDS = new Set(['data', 'tweak']);

  // Normalise a card's declared starterPrompts to a clean array. Falls
  // back to a single {kind:"data"} default when the field is absent or
  // empty. Keeps the caller simple — every card contributes at least
  // one candidate.
  function candidatesFor(card) {
    const id = card && card.id;
    const label = (card && card.label) || id || '';
    const declared = card && card.chat && Array.isArray(card.chat.starterPrompts)
      ? card.chat.starterPrompts
      : [];
    const cleaned = declared
      .filter(p => p && typeof p === 'object' && typeof p.text === 'string' && p.text.trim().length > 0)
      .map(p => ({
        text: p.text.trim(),
        kind: VALID_KINDS.has(p.kind) ? p.kind : 'data',
        cardId: id,
      }));
    if (cleaned.length > 0) return cleaned;
    // Fallback for a card with no starterPrompts declared.
    return [{
      text: `Show me my ${label} data`,
      kind: 'data',
      cardId: id,
    }];
  }

  // Fisher–Yates shuffle using the provided RNG (defaults to Math.random).
  function shuffle(arr, random) {
    const rnd = random || Math.random;
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      const t = a[i];
      a[i] = a[j];
      a[j] = t;
    }
    return a;
  }

  // Pick one candidate per card (at random). Reduces one card's
  // multi-prompt list to a single representative.
  function pickOnePerCard(cards, random) {
    const out = [];
    for (const card of cards) {
      const cands = candidatesFor(card);
      if (cands.length === 0) continue;
      const pick = cands[Math.floor((random || Math.random)() * cands.length)];
      out.push(pick);
    }
    return out;
  }

  // Balance a shuffled candidate list so the first `count` entries
  // interleave kinds as much as the supply allows — avoids "all seven
  // chips are tweaks" sets.
  function balanceByKind(candidates, count) {
    const data = candidates.filter(c => c.kind === 'data');
    const tweak = candidates.filter(c => c.kind === 'tweak');
    const out = [];
    // Alternate data/tweak in rounds. Each round takes at most one
    // of each. Stop when we hit `count` or both lists are empty.
    while (out.length < count && (data.length > 0 || tweak.length > 0)) {
      if (data.length > 0) {
        out.push(data.shift());
        if (out.length >= count) break;
      }
      if (tweak.length > 0) {
        out.push(tweak.shift());
      }
    }
    return out;
  }

  // Main entry point.
  function pickStarterPrompts(cards, opts) {
    const options = opts || {};
    const count = Math.max(1, options.count | 0 || 7);
    const random = options.random;
    const shuffledCards = shuffle(cards || [], random);
    // One representative per card (so chip set doesn't repeat a card).
    const reps = pickOnePerCard(shuffledCards, random);
    // Shuffle the reps to decouple kind-balance from card order.
    const shuffledReps = shuffle(reps, random);
    return balanceByKind(shuffledReps, count);
  }

  return {
    candidatesFor,
    pickStarterPrompts,
    // Exposed for unit tests.
    _internals: { shuffle, pickOnePerCard, balanceByKind },
  };
}));
