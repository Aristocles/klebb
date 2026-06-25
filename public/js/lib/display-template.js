// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// public/js/lib/display-template.js
// Generic display-template engine for manifest-driven cards.
// Dual-runtime: browser (ESM) + Node (CommonJS) via UMD pattern.
//
// Given a template string and a row of data, produce a rendered string.
// Template syntax:
//   {key}                 → row[key]
//   {key:emoji}           → display.emojiMap[key][row[key]] or raw value
//   {key:round(N)}        → round to N decimal places
//   {key|default}         → value, falling back to "default" when missing/empty
//   {key?yes:no}          → ternary: yes when truthy, no otherwise
//   {key.nested.path}     → dotted-path access
//   Unresolved keys render as empty string.
//
// Also exports threshold + trend evaluators used by the generic card renderer:
//   evaluateThresholds(row, thresholds)  → { colour, label, rule } | null
//   computeTrend(row, key, allRows)      → { dir: 'up'|'down'|'flat', delta } | null
//   trendColour(dir, goodDirection)      → CSS colour string for the arrow
//   resolveGoodDirection(trendArrow)     → 'up'|'down'|'neutral'|null
//   formatTrendDelta(delta)              → signed string, e.g. "+0.4" / "-0.6"
//
// Returns a plain string. The caller wraps it in whatever HTML they want.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./format-hours.js'));
  } else {
    root.ehDisplayTemplate = factory(root.ehFormatHours);
  }
}(typeof self !== 'undefined' ? self : this, function (formatHours) {

  const hoursToHM = formatHours && formatHours.hoursToHM;

  function isEmpty(v) {
    return v === null || v === undefined || v === '';
  }

  function lookupEmoji(display, key, value) {
    if (!display || !display.emojiMap) return null;
    // Keyed shape: emojiMap[field][value] — used by multi-field cards
    // and the canonical mood template.
    const keyed = display.emojiMap[key];
    if (keyed && typeof keyed === 'object' && !Array.isArray(keyed)) {
      const hit = keyed[String(value)] ?? keyed[value];
      if (hit) return hit;
    }
    // Flat shape: emojiMap[value] — used by mood on klebbtest and any
    // manifest where a single emoji map drives both the card
    // headline and the calendar marker (#183). The calendar marker
    // and rating input already accept both shapes; this lets the
    // template modifier do the same so there's one source of truth.
    const flat = display.emojiMap[String(value)] ?? display.emojiMap[value];
    if (flat && typeof flat === 'string') return flat;
    return null;
  }

  function applyRound(value, digits) {
    const n = Number(value);
    if (Number.isNaN(n)) return value;
    const d = Number(digits);
    if (Number.isNaN(d)) return n.toString();
    return n.toFixed(d);
  }

  function getValue(row, keyPath) {
    if (!row || typeof row !== 'object') return undefined;
    if (keyPath.indexOf('.') === -1) return row[keyPath];
    let cur = row;
    for (const part of keyPath.split('.')) {
      if (cur === null || cur === undefined) return undefined;
      cur = cur[part];
    }
    return cur;
  }

  function resolveField(row, display, expr) {
    // Ternary: key?yes:no
    const ternMatch = expr.match(/^([a-zA-Z0-9_.]+)\?([^:]*):(.*)$/);
    if (ternMatch) {
      const [, key, yes, no] = ternMatch;
      const val = getValue(row, key);
      return val && val !== '' ? yes : no;
    }

    // Pipe-default: key|default
    const pipeIdx = expr.indexOf('|');
    let key = expr;
    let fallback = null;
    if (pipeIdx !== -1) {
      key = expr.slice(0, pipeIdx);
      fallback = expr.slice(pipeIdx + 1);
    }

    // Colon-modifier: key:modifier
    let modifier = null;
    const colonIdx = key.indexOf(':');
    if (colonIdx !== -1) {
      modifier = key.slice(colonIdx + 1);
      key = key.slice(0, colonIdx);
    }

    const value = getValue(row, key);

    if (modifier) {
      if (modifier === 'emoji') {
        const emoji = lookupEmoji(display, key, value);
        if (emoji) return emoji;
        if (isEmpty(value)) return fallback ?? '';
        return String(value);
      }
      const roundMatch = modifier.match(/^round\((\d+)\)$/);
      if (roundMatch) {
        if (isEmpty(value)) return fallback ?? '';
        return applyRound(value, roundMatch[1]);
      }
      const truncateMatch = modifier.match(/^truncate\((\d+)\)$/);
      if (truncateMatch) {
        if (isEmpty(value)) return fallback ?? '';
        const n = parseInt(truncateMatch[1], 10);
        const s = String(value);
        return s.length > n ? s.slice(0, n) + '…' : s;
      }
      // :check — render ✅ when truthy, empty string when falsy/missing.
      // Use for boolean fields (e.g. workouts `trained`) that shouldn't
      // stringify to "true"/"false" on the card. See #215.
      if (modifier === 'check') {
        return value ? '✅' : (fallback ?? '');
      }
      // :hm — treat the field as decimal hours and render as H:MM.
      // Non-numeric / missing values fall through to the fallback.
      if (modifier === 'hm') {
        if (isEmpty(value)) return fallback ?? '';
        const hm = hoursToHM ? hoursToHM(value) : null;
        if (hm !== null) return hm;
        return fallback ?? String(value);
      }
      // Unknown modifier → ignore
    }

    if (isEmpty(value)) return fallback ?? '';
    return String(value);
  }

  function renderTemplate(template, row, display) {
    if (typeof template !== 'string') return '';
    display = display || null;
    return template.replace(/\{([^}]+)\}/g, function (_, expr) {
      try {
        return resolveField(row, display, expr);
      } catch {
        return '';
      }
    });
  }

  // --- Threshold evaluator ---
  //
  // Input:
  //   row         — the data entry (e.g. { systolic: 135, diastolic: 85 })
  //   thresholds  — an array of rules, evaluated top-to-bottom, first match wins
  //
  // Each rule is one of:
  //   { ifField, min?, max?, eq?, colour?, label? }
  //
  // Rule matches when:
  //   - row[ifField] is defined, AND
  //   - if min: row[ifField] >= min
  //   - if max: row[ifField] <= max
  //   - if eq:  row[ifField] === eq (stringified)
  //
  // Returns the winning rule (colour + label fields accessible) or null if
  // nothing matches.
  function evaluateThresholds(row, thresholds) {
    if (!Array.isArray(thresholds) || thresholds.length === 0) return null;
    if (!row || typeof row !== 'object') return null;
    for (const rule of thresholds) {
      if (!rule || typeof rule !== 'object') continue;
      const field = rule.ifField || rule.field;
      if (!field) continue;
      const v = getValue(row, field);
      if (v === undefined || v === null) continue;
      if ('eq' in rule) {
        if (String(v) === String(rule.eq)) return rule;
        continue;
      }
      // Bounds-less rule = catch-all (matches any value at this field).
      // Put it last in the list as a fallback for values that missed
      // every specific band above.
      if (!('min' in rule) && !('max' in rule)) return rule;
      const n = Number(v);
      if (Number.isNaN(n)) continue;
      if ('min' in rule && n < Number(rule.min)) continue;
      if ('max' in rule && n > Number(rule.max)) continue;
      return rule;
    }
    return null;
  }

  // --- Trend computer ---
  //
  // Compares the given row's value at `key` to the "previous" row's value
  // at the same key, where "previous" is the row with the closest earlier
  // `date` field (lexical ISO-date order).
  //
  // Input:
  //   row        — the current entry being rendered
  //   key        — the field to compare (e.g. "kg", "systolic")
  //   allRows    — the full data array from the manifest
  //
  // Returns: { dir, delta, prev } where dir ∈ {'up', 'down', 'flat'}; or null
  // if no prior entry exists or values aren't numeric.
  function computeTrend(row, key, allRows) {
    if (!row || !key || !Array.isArray(allRows)) return null;
    const currentVal = getValue(row, key);
    if (currentVal === null || currentVal === undefined) return null;
    const currentNum = Number(currentVal);
    if (Number.isNaN(currentNum)) return null;
    const currentDate = row.date;
    if (!currentDate) return null;
    // Find previous entry with an earlier date and a numeric value for this key
    const candidates = allRows
      .filter(r => r && r.date && r.date < currentDate)
      .filter(r => {
        const v = getValue(r, key);
        return v !== null && v !== undefined && !Number.isNaN(Number(v));
      })
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    if (candidates.length === 0) return null;
    const prev = candidates[0];
    const prevNum = Number(getValue(prev, key));
    const delta = currentNum - prevNum;
    let dir = 'flat';
    if (delta > 0) dir = 'up';
    else if (delta < 0) dir = 'down';
    return { dir, delta, prev };
  }

  // --- Numeric series extractor ---
  //
  // Pulls the numeric values for `field` over the last N dated rows, oldest
  // to newest, ready to feed a sparkline. A row qualifies only when it has a
  // truthy `date` and `Number(getValue(row, field))` is not NaN (the same
  // predicate computeTrend uses, so the two stay consistent).
  //
  // Input:
  //   rows     : the full data array from the manifest
  //   field    : the field to extract (dotted paths allowed, via getValue)
  //   endDate  : optional ISO date; rows with date > endDate are excluded
  //   limit    : keep at most this many of the most recent qualifying rows
  //
  // Returns: number[] in ascending date order, or [] if nothing qualifies.
  function numericSeries(rows, field, options) {
    if (!Array.isArray(rows) || !field) return [];
    const { endDate = null, limit = 30 } = options || {};
    return rows
      .filter(r => r && r.date && (!endDate || r.date <= endDate))
      .filter(r => {
        const v = getValue(r, field);
        return v !== null && v !== undefined && !Number.isNaN(Number(v));
      })
      .sort((a, b) => (a.date || '').localeCompare(b.date || ''))
      .map(r => Number(getValue(r, field)))
      .slice(-limit);
  }

  // --- Trend-arrow colour semantics ---
  //
  // Colour palette (shared across both runtimes):
  const TREND_GOOD = '#55cc77';
  const TREND_BAD = '#ff7755';
  const TREND_NEUTRAL = 'var(--text-muted, var(--text-secondary))';

  // Normalise a trendArrow config into which direction is "good".
  // Canonical key is `goodDirection` ∈ {'up','down','neutral'}. The
  // `lowerIsBetter: true` alias (shipped in a demo fixture) maps to
  // 'down'. Anything absent/unrecognised returns null, which the
  // colour helper treats as the historical weight default (down=good).
  function resolveGoodDirection(trendArrow) {
    if (!trendArrow || typeof trendArrow !== 'object') return null;
    const gd = trendArrow.goodDirection;
    if (gd === 'up' || gd === 'down' || gd === 'neutral') return gd;
    if (trendArrow.lowerIsBetter === true) return 'down';
    return null;
  }

  // Pick the arrow colour for a trend direction given which direction is
  // "good". `dir` ∈ {'up','down','flat'}; `goodDirection` ∈
  // {'up','down','neutral'} or null/undefined. With no goodDirection the
  // historical default holds: up=bad (red), down=good (green), correct
  // for weight, where rising is bad. 'neutral' paints both directions a
  // muted colour so it reads as movement, not judgement. See #423.
  function trendColour(dir, goodDirection) {
    if (dir === 'flat') return TREND_NEUTRAL;
    if (goodDirection === 'neutral') return TREND_NEUTRAL;
    const goodDir = goodDirection === 'up' ? 'up' : 'down';
    return dir === goodDir ? TREND_GOOD : TREND_BAD;
  }

  // Render a trend delta as a signed string so the magnitude + direction
  // are carried by the number, not by colour alone. Trailing zeros from
  // float subtraction are trimmed (e.g. 0.40000000000000036 → "+0.4").
  function formatTrendDelta(delta) {
    const n = Number(delta);
    if (Number.isNaN(n)) return '';
    const rounded = Math.round(n * 100) / 100;
    const sign = rounded > 0 ? '+' : '';
    return sign + String(rounded);
  }

  return {
    renderTemplate,
    getValue,
    lookupEmoji,
    applyRound,
    evaluateThresholds,
    computeTrend,
    numericSeries,
    trendColour,
    resolveGoodDirection,
    formatTrendDelta,
  };
}));
