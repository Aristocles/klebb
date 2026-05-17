// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// public/js/lib/date-util.js
// Local-date helpers. `new Date().toISOString()` always returns UTC,
// which silently rolls back to "yesterday" for UTC+ timezones in the
// morning. These return YYYY-MM-DD in the device's local timezone.

export function localDateStr(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function localToday() {
  return localDateStr(new Date());
}

// Whole-day difference between two YYYY-MM-DD ISO date strings (later
// minus earlier). Anchors at UTC midnight so DST shifts can't add or
// drop an hour and flip the count. Negative when `later` precedes
// `earlier`. Returns null if either argument is malformed. See #231.
export function daysBetweenISO(earlier, later) {
  if (typeof earlier !== 'string' || typeof later !== 'string') return null;
  const re = /^(\d{4})-(\d{2})-(\d{2})$/;
  const a = re.exec(earlier);
  const b = re.exec(later);
  if (!a || !b) return null;
  const ms = Date.UTC(+b[1], +b[2] - 1, +b[3]) - Date.UTC(+a[1], +a[2] - 1, +a[3]);
  return Math.round(ms / 86_400_000);
}
