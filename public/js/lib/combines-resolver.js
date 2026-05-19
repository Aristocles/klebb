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
//     state: 'ok' | 'no-source' | 'no-entry' | 'no-accessor-match' | 'no-goal',
//     value: any | null,
//     displayValue: string | null,  // value rendered to a display string
//     row: object | null,            // the full source row, or null (weekly: null)
//     // Present only when role === 'ring-segment' and state === 'ok':
//     period?: 'daily' | 'week',
//     goalDaily?: number,    // when period === 'daily'
//     goalWeekly?: number,   // when period === 'week'
//     ratio?: number,        // value / goal (unclamped; > 1 means overshoot)
//     complete?: boolean,    // ratio >= 1
//   }
// Period is 'week' when the ring-segment entry sets goalWeekly; the
// resolver sums the accessor across all rows in the Mon-Sun week
// containing the viewed date. If both goalDaily and goalWeekly are
// set, goalWeekly wins. The 'no-goal' state is emitted when a
// ring-segment has neither — renderer treats it as a placeholder.

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

  // Monday (ISO week start) of the week containing `isoDate`. Anchors at
  // UTC midnight so DST never adds or drops an hour and flips the count.
  // Returns YYYY-MM-DD or null if the input is malformed.
  function mondayOfWeekISO(isoDate) {
    if (typeof isoDate !== 'string') return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
    if (!m) return null;
    const ms = Date.UTC(+m[1], +m[2] - 1, +m[3]);
    const dow = new Date(ms).getUTCDay(); // 0=Sun..6=Sat
    const back = dow === 0 ? 6 : dow - 1;  // days to subtract to reach Mon
    const monMs = ms - back * 86_400_000;
    const d = new Date(monMs);
    const y = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${mm}-${dd}`;
  }

  // Sunday of the week containing `isoDate` (Mon + 6).
  function sundayOfWeekISO(isoDate) {
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

  function resolveEntry(entry, sources, date) {
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

    // Ring-segment entries need a positive finite target. goalWeekly wins
    // over goalDaily when both are set; absence of both → no-goal placeholder.
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

    // Fill in label from source meta if not overridden
    if (!base.label && source.meta?.label) base.label = source.meta.label;

    const rows = Array.isArray(source.data) ? source.data : [];

    // Weekly ring-segment: sum accessor across Mon-Sun rows containing
    // the viewed date. Single missing day is fine (sum stays 0); only a
    // completely empty week resolves to no-entry.
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

  function resolveCombines(combines, sources, date) {
    if (!Array.isArray(combines)) return [];
    return combines.map(entry => resolveEntry(entry, sources, date));
  }

  // Given a donor manifest's meta and the viewed dateMode
  // ("today" | "past" | "future"), decide whether the combo card should
  // render an edit affordance for that donor. Mirrors the _canWrite
  // getter in EhBaseCard so donors behave identically whether edited
  // via the atomic card or via the combo.
  function canEditDonor(donorMeta, dateMode) {
    if (!donorMeta || typeof donorMeta !== 'object') return false;
    const w = donorMeta.writeable;
    if (!w || !w.fromWebapp) return false;
    if (!Array.isArray(w.inputs) || w.inputs.length === 0) return false;
    if (dateMode === 'today')  return w.todayAllowed !== false;
    if (dateMode === 'past')   return w.pastAllowed === true;
    if (dateMode === 'future') return w.futureAllowed === true;
    return false;
  }

  // Unique sourceIds in the order they first appear in combines[]. The
  // combo renderer attaches the edit pencil to the first row of each
  // donor group.
  function donorIdsInOrder(combines) {
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

  return {
    resolveCombines,
    resolveEntry,
    getByPath,
    firstScalarKey,
    stringifyValue,
    canEditDonor,
    donorIdsInOrder,
    mondayOfWeekISO,
    sundayOfWeekISO,
  };
}));
