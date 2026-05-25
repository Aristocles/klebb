// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// public/js/lib/format-hours.js
// Decimal-hours → "H:MM" formatter shared by combines-resolver and
// display-template. Dual-runtime: browser (ESM) + Node (CommonJS) via
// UMD pattern. Keep in sync with format-hours.esm.js.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ehFormatHours = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {

  // 0.999 hours rounds to 60 minutes; carry to the next hour so we
  // never emit "0:60". Negative inputs clamp at "0:00" defensively;
  // ring values can't go negative but goals or accessors might.
  function hoursToHM(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    const clamped = n < 0 ? 0 : n;
    const totalMinutes = Math.round(clamped * 60);
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    return `${h}:${String(m).padStart(2, '0')}`;
  }

  return { hoursToHM };
}));
