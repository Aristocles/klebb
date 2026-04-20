// public/js/lib/display-template.js
// Generic display-template engine for manifest-driven cards.
// Dual-runtime: browser (ESM) + Node (CommonJS) via UMD pattern.
//
// Given a template string and a row of data, produce a rendered string.
// Supports:
//   - {key}                       → row[key]
//   - {key:emoji}                 → look up row[key] in display.emojiMap[key]
//                                   (value-keyed) and substitute the emoji
//   - {key:round(1)}              → round to N decimal places
//   - {key|default}               → value, falling back to "default" literal when missing
//   - {key?present:absent}        → ternary: present-text when truthy, absent-text otherwise
//   - Unresolved keys render as empty string (no "undefined" leakage).
//
// Returns a plain string. The caller wraps it in whatever HTML they want.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ehDisplayTemplate = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {

  function isEmpty(v) {
    return v === null || v === undefined || v === '';
  }

  function lookupEmoji(display, key, value) {
    if (!display || !display.emojiMap) return null;
    const map = display.emojiMap[key];
    if (!map) return null;
    return map[String(value)] ?? map[value] ?? null;
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

  return { renderTemplate, getValue, lookupEmoji, applyRound };
}));
