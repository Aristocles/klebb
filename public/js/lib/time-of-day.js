// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// public/js/lib/time-of-day.js
// Schedule time-of-day vocabulary + chip projection. Dual-runtime
// (browser ESM + Node CJS via UMD) so Node tests and browser
// renderers share the same source. Keep in sync with
// time-of-day.esm.js.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ehTimeOfDay = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {

  const TIME_OF_DAY_TOKENS = ['morning', 'midday', 'evening', 'night'];
  const ORDER = new Map(TIME_OF_DAY_TOKENS.map((t, i) => [t, i]));
  const EMOJI = {
    morning: '☀️',
    midday: '🌤️',
    evening: '🌙',
    night: '💤',
  };
  const LABEL = {
    morning: 'Morning',
    midday: 'Midday',
    evening: 'Evening',
    night: 'Night',
  };

  function emojiFor(token) {
    if (typeof token !== 'string') return '';
    return EMOJI[token] || '';
  }

  function chipsFor(value) {
    const tokens = typeof value === 'string'
      ? [value]
      : Array.isArray(value) ? value : [];
    const seen = new Set();
    const kept = [];
    for (const t of tokens) {
      if (typeof t !== 'string') continue;
      if (!ORDER.has(t)) continue;
      if (seen.has(t)) continue;
      seen.add(t);
      kept.push(t);
    }
    kept.sort((a, b) => ORDER.get(a) - ORDER.get(b));
    return kept.map(t => ({ token: t, emoji: EMOJI[t], label: LABEL[t] }));
  }

  return { TIME_OF_DAY_TOKENS, emojiFor, chipsFor };
}));
