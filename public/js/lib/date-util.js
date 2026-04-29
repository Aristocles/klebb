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
