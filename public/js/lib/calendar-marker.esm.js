// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// public/js/lib/calendar-marker.esm.js
// ES-module twin of calendar-marker.js. Keep in sync — Node tests use the
// UMD version, browser components use this one.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isDateStr(s) { return typeof s === 'string' && DATE_RE.test(s); }

export function getValue(row, keyPath) {
  if (!row || typeof row !== 'object' || !keyPath) return undefined;
  if (keyPath.indexOf('.') === -1) return row[keyPath];
  let cur = row;
  for (const part of keyPath.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[part];
  }
  return cur;
}

export function extractDatedRows(data) {
  const out = new Map();
  if (!data) return out;

  if (Array.isArray(data)) {
    for (const row of data) {
      if (row && isDateStr(row.date)) out.set(row.date, row);
    }
    return out;
  }

  if (typeof data !== 'object') return out;

  for (const k of Object.keys(data)) {
    if (isDateStr(k) && data[k] && typeof data[k] === 'object') {
      out.set(k, data[k]);
    }
  }

  if (Array.isArray(data.items)) {
    for (const item of data.items) {
      if (!item || !Array.isArray(item.doses)) continue;
      for (const dose of item.doses) {
        if (!dose || !isDateStr(dose.scheduledDate)) continue;
        if (!dose.takenAt) continue;
        const existing = out.get(dose.scheduledDate);
        if (!existing || (dose.takenAt > (existing.takenAt || ''))) {
          out.set(dose.scheduledDate, dose);
        }
      }
    }
  }

  return out;
}

export function resolveMarker(spec, ctx) {
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

    default:
      return spec.fallback || fallback;
  }
}
