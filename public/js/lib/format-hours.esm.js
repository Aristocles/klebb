// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// public/js/lib/format-hours.esm.js
// ES-module re-export of the decimal-hours formatter. Keep in sync
// with format-hours.js (UMD) — Node tests use the UMD version,
// browser components use this one.

export function hoursToHM(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const clamped = n < 0 ? 0 : n;
  const totalMinutes = Math.round(clamped * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${h}:${String(m).padStart(2, '0')}`;
}
