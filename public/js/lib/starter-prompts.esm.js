// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// public/js/lib/starter-prompts.esm.js
// ES-module twin of starter-prompts.js (UMD). Keep in sync — Node
// tests use the UMD version, browser components use this one. See
// #195.

const VALID_KINDS = new Set(['data', 'tweak']);

export function candidatesFor(card) {
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
  return [{
    text: `Show me my ${label} data`,
    kind: 'data',
    cardId: id,
  }];
}

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

function balanceByKind(candidates, count) {
  const data = candidates.filter(c => c.kind === 'data');
  const tweak = candidates.filter(c => c.kind === 'tweak');
  const out = [];
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

export function pickStarterPrompts(cards, opts) {
  const options = opts || {};
  const count = Math.max(1, options.count | 0 || 7);
  const random = options.random;
  const shuffledCards = shuffle(cards || [], random);
  const reps = pickOnePerCard(shuffledCards, random);
  const shuffledReps = shuffle(reps, random);
  return balanceByKind(shuffledReps, count);
}
