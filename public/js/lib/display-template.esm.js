// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// public/js/lib/display-template.esm.js
// ES-module re-export of the display-template engine. Keep in sync with
// display-template.js (UMD) — Node tests use the UMD version, browser
// components use this one.

export function isEmpty(v) {
  return v === null || v === undefined || v === '';
}

export function getValue(row, keyPath) {
  if (!row || typeof row !== 'object') return undefined;
  if (keyPath.indexOf('.') === -1) return row[keyPath];
  let cur = row;
  for (const part of keyPath.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[part];
  }
  return cur;
}

export function lookupEmoji(display, key, value) {
  if (!display || !display.emojiMap) return null;
  const map = display.emojiMap[key];
  if (!map) return null;
  return map[String(value)] ?? map[value] ?? null;
}

export function applyRound(value, digits) {
  const n = Number(value);
  if (Number.isNaN(n)) return value;
  const d = Number(digits);
  if (Number.isNaN(d)) return n.toString();
  return n.toFixed(d);
}

function resolveField(row, display, expr) {
  const ternMatch = expr.match(/^([a-zA-Z0-9_.]+)\?([^:]*):(.*)$/);
  if (ternMatch) {
    const [, key, yes, no] = ternMatch;
    const val = getValue(row, key);
    return val && val !== '' ? yes : no;
  }
  const pipeIdx = expr.indexOf('|');
  let key = expr;
  let fallback = null;
  if (pipeIdx !== -1) {
    key = expr.slice(0, pipeIdx);
    fallback = expr.slice(pipeIdx + 1);
  }
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
  }
  if (isEmpty(value)) return fallback ?? '';
  return String(value);
}

export function renderTemplate(template, row, display = null) {
  if (typeof template !== 'string') return '';
  return template.replace(/\{([^}]+)\}/g, (_, expr) => {
    try {
      return resolveField(row, display, expr);
    } catch {
      return '';
    }
  });
}

// --- Threshold evaluator ---
// See display-template.js for detailed docs.
export function evaluateThresholds(row, thresholds) {
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
    // Put it last as a fallback for values that missed every specific band.
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
export function computeTrend(row, key, allRows) {
  if (!row || !key || !Array.isArray(allRows)) return null;
  const currentVal = getValue(row, key);
  if (currentVal === null || currentVal === undefined) return null;
  const currentNum = Number(currentVal);
  if (Number.isNaN(currentNum)) return null;
  const currentDate = row.date;
  if (!currentDate) return null;
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
