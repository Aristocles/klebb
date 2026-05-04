// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// public/js/lib/combines-resolver.esm.js
// ES-module re-export of the combines resolver. Keep in sync with
// combines-resolver.js (UMD) — Node tests use the UMD version, browser
// components use this one.

export function getByPath(obj, pathStr) {
  if (!obj || !pathStr) return undefined;
  const parts = String(pathStr).split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

export function firstScalarKey(row) {
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

export function stringifyValue(value, emojiMap) {
  if (value === null || value === undefined) return null;
  if (emojiMap) {
    const key = String(value);
    if (emojiMap[key]) return emojiMap[key];
  }
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return String(value);
    return String(Math.round(value * 100) / 100);
  }
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return String(value);
}

export function resolveEntry(entry, sources, date) {
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

export function resolveCombines(combines, sources, date) {
  if (!Array.isArray(combines)) return [];
  return combines.map(entry => resolveEntry(entry, sources, date));
}
