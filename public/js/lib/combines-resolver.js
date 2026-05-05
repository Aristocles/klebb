// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// public/js/lib/combines-resolver.js
// Pure resolver for combination-card's meta.view.combines[].
// Dual-runtime: browser (ESM) + Node (CommonJS) via UMD pattern.
//
// Given:
//   - combines[]       (array of entries from meta.view.combines)
//   - sources          (object mapping sourceId -> { loaded, data, meta })
//                        loaded:false means the sourceId is not a known manifest
//                        data is the source's data array (rows with a `date` field)
//                        meta is the source's meta object (for label fallback)
//   - date             (ISO date string the viewer is on, YYYY-MM-DD)
//
// Produce an array of resolved rows, one per combines[] entry, in order.
// Each resolved row has:
//   {
//     sourceId, role, label, unit, colour?, emojiMap?,
//     state: 'ok' | 'no-source' | 'no-entry' | 'no-accessor-match',
//     value: any | null,
//     displayValue: string | null,  // value rendered to a display string
//     row: object | null,            // the full source row, or null
//   }

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ehCombinesResolver = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {

  // Dotted-path accessor. Returns undefined if any hop is missing.
  function getByPath(obj, pathStr) {
    if (!obj || !pathStr) return undefined;
    const parts = String(pathStr).split('.');
    let cur = obj;
    for (const p of parts) {
      if (cur == null) return undefined;
      cur = cur[p];
    }
    return cur;
  }

  // First non-`date` scalar on a row. Returns the key name or null.
  function firstScalarKey(row) {
    if (!row || typeof row !== 'object') return null;
    for (const k of Object.keys(row)) {
      if (k === 'date') continue;
      const v = row[k];
      const t = typeof v;
      if (v === null) continue;
      if (t === 'string' || t === 'number' || t === 'boolean') return k;
    }
    return null;
  }

  // Stringify the resolved value for display. The renderer can override
  // presentation (e.g. emojiMap lookup) but this gives a sensible default.
  function stringifyValue(value, emojiMap) {
    if (value === null || value === undefined) return null;
    if (emojiMap) {
      const key = String(value);
      if (emojiMap[key]) return emojiMap[key];
    }
    if (typeof value === 'number') {
      // Trim to 2dp unless already integral
      if (Number.isInteger(value)) return String(value);
      return String(Math.round(value * 100) / 100);
    }
    if (typeof value === 'boolean') return value ? 'yes' : 'no';
    return String(value);
  }

  function resolveEntry(entry, sources, date) {
    const sourceId = entry?.sourceId;
    const base = {
      sourceId,
      role: entry?.role || 'annotation',
      label: entry?.label || null,
      unit: entry?.unit || null,
      colour: entry?.colour || null,
      emojiMap: entry?.emojiMap || null,
    };

    if (!sourceId) {
      return { ...base, state: 'no-source', value: null, displayValue: null, row: null };
    }

    const source = sources?.[sourceId];
    if (!source || !source.loaded) {
      return { ...base, state: 'no-source', value: null, displayValue: null, row: null };
    }

    // Fill in label from source meta if not overridden
    if (!base.label && source.meta?.label) base.label = source.meta.label;

    const rows = Array.isArray(source.data) ? source.data : [];
    const row = rows.find(r => r && r.date === date) || null;
    if (!row) {
      return { ...base, state: 'no-entry', value: null, displayValue: null, row: null };
    }

    const accessor = entry?.accessor || firstScalarKey(row);
    if (!accessor) {
      return { ...base, state: 'no-accessor-match', value: null, displayValue: null, row };
    }

    const value = getByPath(row, accessor);
    if (value === undefined || value === null) {
      return { ...base, state: 'no-accessor-match', value: null, displayValue: null, row };
    }

    return {
      ...base,
      state: 'ok',
      value,
      displayValue: stringifyValue(value, base.emojiMap),
      row,
    };
  }

  function resolveCombines(combines, sources, date) {
    if (!Array.isArray(combines)) return [];
    return combines.map(entry => resolveEntry(entry, sources, date));
  }

  return {
    resolveCombines,
    resolveEntry,
    getByPath,
    firstScalarKey,
    stringifyValue,
  };
}));
