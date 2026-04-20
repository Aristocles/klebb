// public/js/lib/display-template.esm.js
// ES-module re-export of the core display-template engine so browser components
// can `import { renderTemplate } from '../lib/display-template.esm.js'`.
// Node tests use the UMD version directly.

// Inline the engine (so browsers don't need to load both files). Keep in sync
// with display-template.js.

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
