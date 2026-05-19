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

export function mondayOfWeekISO(isoDate) {
  if (typeof isoDate !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) return null;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const dow = new Date(ms).getUTCDay();
  const back = dow === 0 ? 6 : dow - 1;
  const monMs = ms - back * 86_400_000;
  const d = new Date(monMs);
  const y = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${mm}-${dd}`;
}

export function sundayOfWeekISO(isoDate) {
  const mon = mondayOfWeekISO(isoDate);
  if (!mon) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(mon);
  const sunMs = Date.UTC(+m[1], +m[2] - 1, +m[3]) + 6 * 86_400_000;
  const d = new Date(sunMs);
  const y = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${mm}-${dd}`;
}

export function resolveEntry(entry, sources, date) {
  const sourceId = entry?.sourceId;
  const role = entry?.role || 'annotation';
  const base = {
    sourceId,
    role,
    label: entry?.label || null,
    unit: entry?.unit || null,
    colour: entry?.colour || null,
    emojiMap: entry?.emojiMap || null,
  };

  const isRingSegment = role === 'ring-segment';
  const goalWeeklyN = isRingSegment ? Number(entry?.goalWeekly) : null;
  const goalDailyN = isRingSegment ? Number(entry?.goalDaily) : null;
  const hasWeekly = isRingSegment && Number.isFinite(goalWeeklyN) && goalWeeklyN > 0;
  const hasDaily  = isRingSegment && Number.isFinite(goalDailyN)  && goalDailyN  > 0;
  if (isRingSegment && !hasWeekly && !hasDaily) {
    return { ...base, state: 'no-goal', value: null, displayValue: null, row: null };
  }
  const period = hasWeekly ? 'week' : (isRingSegment ? 'daily' : null);

  if (!sourceId) {
    return { ...base, state: 'no-source', value: null, displayValue: null, row: null };
  }

  const source = sources?.[sourceId];
  if (!source || !source.loaded) {
    return { ...base, state: 'no-source', value: null, displayValue: null, row: null };
  }

  if (!base.label && source.meta?.label) base.label = source.meta.label;

  const rows = Array.isArray(source.data) ? source.data : [];

  if (isRingSegment && period === 'week') {
    const mon = mondayOfWeekISO(date);
    const sun = sundayOfWeekISO(date);
    if (!mon || !sun) {
      return { ...base, state: 'no-entry', value: null, displayValue: null, row: null };
    }
    const weekRows = rows.filter(r => r && typeof r.date === 'string'
      && r.date >= mon && r.date <= sun);
    if (weekRows.length === 0) {
      return { ...base, state: 'no-entry', value: null, displayValue: null, row: null };
    }
    const accessor = entry?.accessor || firstScalarKey(weekRows[0]);
    if (!accessor) {
      return { ...base, state: 'no-accessor-match', value: null, displayValue: null, row: null };
    }
    let sum = 0;
    let any = false;
    for (const r of weekRows) {
      const v = getByPath(r, accessor);
      const n = Number(v);
      if (Number.isFinite(n)) { sum += n; any = true; }
    }
    if (!any) {
      return { ...base, state: 'no-accessor-match', value: null, displayValue: null, row: null };
    }
    return {
      ...base,
      state: 'ok',
      value: sum,
      displayValue: stringifyValue(sum, base.emojiMap),
      row: null,
      period: 'week',
      goalWeekly: goalWeeklyN,
      ratio: sum / goalWeeklyN,
      complete: (sum / goalWeeklyN) >= 1,
    };
  }

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

  const result = {
    ...base,
    state: 'ok',
    value,
    displayValue: stringifyValue(value, base.emojiMap),
    row,
  };

  if (isRingSegment) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return { ...base, state: 'no-accessor-match', value: null, displayValue: null, row };
    }
    result.period = 'daily';
    result.goalDaily = goalDailyN;
    result.ratio = numeric / goalDailyN;
    result.complete = result.ratio >= 1;
  }

  return result;
}

export function resolveCombines(combines, sources, date) {
  if (!Array.isArray(combines)) return [];
  return combines.map(entry => resolveEntry(entry, sources, date));
}

export function canEditDonor(donorMeta, dateMode) {
  if (!donorMeta || typeof donorMeta !== 'object') return false;
  const w = donorMeta.writeable;
  if (!w || !w.fromWebapp) return false;
  if (!Array.isArray(w.inputs) || w.inputs.length === 0) return false;
  if (dateMode === 'today')  return w.todayAllowed !== false;
  if (dateMode === 'past')   return w.pastAllowed === true;
  if (dateMode === 'future') return w.futureAllowed === true;
  return false;
}

export function donorIdsInOrder(combines) {
  if (!Array.isArray(combines)) return [];
  const seen = new Set();
  const out = [];
  for (const c of combines) {
    const id = c?.sourceId;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}
