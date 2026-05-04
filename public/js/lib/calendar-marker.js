// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// public/js/lib/calendar-marker.js
// Resolve a calendar cell's marker for a given date from meta.calendar.marker.
// Dual-runtime: browser (ESM) + Node (CommonJS) via UMD pattern.
//
// meta.calendar.marker shapes:
//   "💊"                                  → same glyph every logged day
//   { type: "field-emoji", field, emojiMap, fallback? }
//   { type: "trend-arrow", field, up?, down?, flat?, fallback? }
//   { type: "threshold",   field, rules: [{ min?, max?, eq?, emoji }], fallback? }
//   { type: "template",    template, fallback? }
//
// Public surface:
//   extractDatedRows(data) -> Map<"YYYY-MM-DD", row>
//     Flattens array-of-{date}, date-keyed object, and items[].doses[] shapes
//     into one map. When a date has multiple rows, the latest wins
//     (last by array index for arrays; last by takenAt for doses).
//
//   resolveMarker(spec, ctx) -> string
//     ctx = { date, row, sortedRows, fallback, display, renderTemplate }
//     sortedRows: dated rows ascending by date (for trend-arrow).
//     fallback: glyph used if the spec yields nothing.
//     display: the card's meta.view.display block (for template type to
//       reuse its emojiMap).
//     renderTemplate: an injected string-template render function
//       (same signature as display-template.renderTemplate). Injected
//       rather than imported to keep this lib dependency-free and
//       UMD-simple. Only required when using type: "template".

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ehCalendarMarker = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {

  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  function isDateStr(s) { return typeof s === 'string' && DATE_RE.test(s); }

  function getValue(row, keyPath) {
    if (!row || typeof row !== 'object' || !keyPath) return undefined;
    if (keyPath.indexOf('.') === -1) return row[keyPath];
    let cur = row;
    for (const part of keyPath.split('.')) {
      if (cur === null || cur === undefined) return undefined;
      cur = cur[part];
    }
    return cur;
  }

  // Flatten every known dated-row shape into Map<date, row>.
  // On collision: later array entries win; for doses[], the dose with the
  // most recent takenAt wins, or the last listed if no takenAt.
  function extractDatedRows(data) {
    const out = new Map();
    if (!data) return out;

    if (Array.isArray(data)) {
      for (const row of data) {
        if (row && isDateStr(row.date)) out.set(row.date, row);
      }
      return out;
    }

    if (typeof data !== 'object') return out;

    // Date-keyed object (e.g. legacy notes)
    for (const k of Object.keys(data)) {
      if (isDateStr(k) && data[k] && typeof data[k] === 'object') {
        out.set(k, data[k]);
      }
    }

    // items[].doses[] shape (peptides / medication-schedule)
    if (Array.isArray(data.items)) {
      for (const item of data.items) {
        if (!item || !Array.isArray(item.doses)) continue;
        for (const dose of item.doses) {
          if (!dose || !isDateStr(dose.scheduledDate)) continue;
          if (!dose.takenAt) continue; // only count doses that were actually taken
          const existing = out.get(dose.scheduledDate);
          if (!existing || (dose.takenAt > (existing.takenAt || ''))) {
            out.set(dose.scheduledDate, dose);
          }
        }
      }
    }

    return out;
  }

  function resolveMarker(spec, ctx) {
    const fallback = (ctx && ctx.fallback) || '•';

    if (spec == null) return fallback;
    if (typeof spec === 'string') return spec || fallback;
    if (typeof spec !== 'object') return fallback;

    const row = (ctx && ctx.row) || null;

    switch (spec.type) {
      case 'field-emoji': {
        if (!spec.field || !spec.emojiMap || !row) {
          return spec.fallback || fallback;
        }
        const v = getValue(row, spec.field);
        if (v === null || v === undefined || v === '') {
          return spec.fallback || fallback;
        }
        const hit = spec.emojiMap[String(v)] ?? spec.emojiMap[v];
        if (hit) return hit;
        return spec.fallback || fallback;
      }

      case 'trend-arrow': {
        if (!spec.field || !row) {
          return spec.fallback || fallback;
        }
        const currentVal = getValue(row, spec.field);
        const currentNum = Number(currentVal);
        if (currentVal === null || currentVal === undefined || Number.isNaN(currentNum)) {
          return spec.fallback || fallback;
        }
        const currentDate = ctx && ctx.date;
        const sorted = (ctx && ctx.sortedRows) || [];
        // Find the most recent earlier entry that has a numeric value here.
        let prevNum = null;
        for (let i = sorted.length - 1; i >= 0; i--) {
          const r = sorted[i];
          if (!r || !r.date || r.date >= currentDate) continue;
          const pv = getValue(r, spec.field);
          const pn = Number(pv);
          if (pv === null || pv === undefined || Number.isNaN(pn)) continue;
          prevNum = pn;
          break;
        }
        if (prevNum === null) {
          return spec.fallback || fallback;
        }
        if (currentNum > prevNum) return spec.up || '⬆️';
        if (currentNum < prevNum) return spec.down || '⬇️';
        return spec.flat || '➡️';
      }

      case 'threshold': {
        // Accept `rules` (canonical, matches docs) or `bands` (legacy
        // alias; see #70 — an early system-prompt revision told agents
        // to use `bands`, so manifests written during that window carry
        // the old key).
        const rules = Array.isArray(spec.rules) ? spec.rules
          : Array.isArray(spec.bands) ? spec.bands
          : null;
        if (!spec.field || !rules || !row) {
          return spec.fallback || fallback;
        }
        const v = getValue(row, spec.field);
        if (v === null || v === undefined || v === '') {
          return spec.fallback || fallback;
        }
        for (const rule of rules) {
          if (!rule || typeof rule !== 'object') continue;
          if ('eq' in rule) {
            if (String(v) === String(rule.eq)) return rule.emoji || spec.fallback || fallback;
            continue;
          }
          // Bounds-less rule = catch-all (matches any value). Put it
          // last as the "anything else" emoji for the field.
          if (!('min' in rule) && !('max' in rule)) {
            return rule.emoji || spec.fallback || fallback;
          }
          const n = Number(v);
          if (Number.isNaN(n)) continue;
          if ('min' in rule && n < Number(rule.min)) continue;
          if ('max' in rule && n > Number(rule.max)) continue;
          return rule.emoji || spec.fallback || fallback;
        }
        return spec.fallback || fallback;
      }

      case 'template': {
        if (!spec.template || !row) {
          return spec.fallback || fallback;
        }
        const render = ctx && ctx.renderTemplate;
        if (typeof render !== 'function') {
          return spec.fallback || fallback;
        }
        const out = render(spec.template, row, (ctx && ctx.display) || null);
        if (out && out.trim()) return out;
        return spec.fallback || fallback;
      }

      default:
        // Unknown type — render nothing special, just fall back.
        return spec.fallback || fallback;
    }
  }

  return { extractDatedRows, resolveMarker, getValue };
}));
