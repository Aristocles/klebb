// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// chat/date-context.js
//
// Builds the "## Today's date" system-prompt block. Language models are
// unreliable at weekday arithmetic from an ISO date (they confidently name
// the wrong weekday), so we inject a pre-computed lookup table and tell
// the model not to compute weekdays itself.

const WEEKDAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Today's YYYY-MM-DD in the given IANA timezone.
function todayIsoInTz(now, tz) {
  return now.toLocaleDateString('en-CA', { timeZone: tz });
}

// Weekday (0=Sun..6=Sat) for a YYYY-MM-DD calendar date. A bare YYYY-MM-DD
// has an unambiguous weekday regardless of timezone, so we resolve it via
// UTC midnight.
function weekdayFor(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function addDays(isoDate, n) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

function offsetLabel(n) {
  if (n === 0) return ' 00';
  const mag = String(Math.abs(n)).padStart(2, '0');
  return (n > 0 ? '+' : '-') + mag;
}

// Build the full system-prompt block. Exposed for testing; server.js
// calls buildTodayBlock() which uses defaults.
function buildDateContextBlock({ now = new Date(), tz = 'UTC', pastDays = 14, futureDays = 60 } = {}) {
  const today = todayIsoInTz(now, tz);
  const todayWeekday = WEEKDAY_LONG[weekdayFor(today)];

  const lines = [];
  for (let n = -pastDays; n <= futureDays; n++) {
    const iso = addDays(today, n);
    const wk = WEEKDAY_SHORT[weekdayFor(iso)];
    let suffix = '';
    if (n === 0) suffix = '  (today)';
    else if (n === 1) suffix = '  (tomorrow)';
    else if (n === -1) suffix = '  (yesterday)';
    lines.push(`  ${offsetLabel(n)}  ${wk}  ${iso}${suffix}`);
  }

  return `\n\n## Today's date

Today is ${todayWeekday}, ${today}.

Use the table below to resolve any relative date ("next Monday", "in two weeks", "tomorrow", "5 days from now"). Do NOT compute weekdays yourself; if the date you need is in the table, copy its weekday from the table; if it isn't, give the ISO date only and do not state a weekday you have not been told.

Known dates (offset, weekday, ISO):

${lines.join('\n')}

Never hardcode a year from training data.
`;
}

module.exports = { buildDateContextBlock };
