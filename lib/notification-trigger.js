// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// lib/notification-trigger.js
//
// Pure trigger-evaluation helpers. Given a trigger spec, a "now" instant,
// and a user-configured IANA timezone, compute the previous and next fire
// slots for the trigger.
//
// v3.0.0 supports two trigger types: daily and weekly. Other types are
// deferred to v3.1.
//
// The slots returned are ISO 8601 strings in the user's TZ (e.g.
// "2026-06-11T20:00:00+10:00"). The scheduler compares them as strings -
// equality is sufficient for "have we fired this slot yet" because two
// computations of the same slot in the same TZ always yield byte-equal
// strings.

const WEEKDAY_INDEX = {
  // Map IANA short weekday strings to day-of-week integers.
  // Date#getDay() is 0=Sun..6=Sat; we use that ordering.
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

function _parseHHMM(time) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!m) return null;
  return { h: Number(m[1]), m: Number(m[2]) };
}

// Given a UTC instant and a TZ, return the wall-clock components in that TZ.
// Uses Intl.DateTimeFormat under the hood; correct across DST transitions.
function _wallClockIn(instant, tz) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
    weekday: 'short',
  });
  const parts = fmt.formatToParts(instant);
  const get = (k) => parts.find(p => p.type === k)?.value;
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour') === '24' ? '0' : get('hour')),
    minute: Number(get('minute')),
    second: Number(get('second')),
    weekday: get('weekday').toLowerCase().slice(0, 3),
  };
}

// Given wall-clock components in a TZ, return the UTC instant whose
// projection into that TZ matches. Handles DST: searches by binary-iterating
// the offset until the projection matches the requested wall-clock.
function _wallClockToInstant(year, month, day, hour, minute, tz) {
  // Start with a UTC guess (TZ is unknown offset; project to find it).
  // Walk in two passes: project guess back to wall-clock, compute the
  // offset, then re-anchor. Two passes converge for any IANA TZ that
  // doesn't change offset twice in <24h.
  let guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  for (let pass = 0; pass < 3; pass++) {
    const wc = _wallClockIn(new Date(guess), tz);
    const target = Date.UTC(year, month - 1, day, hour, minute, 0);
    const got = Date.UTC(wc.year, wc.month - 1, wc.day, wc.hour, wc.minute, 0);
    const drift = got - target;
    if (drift === 0) return new Date(guess);
    guess -= drift;
  }
  return new Date(guess);
}

// Format an instant as an ISO string in the given TZ, including offset.
function _formatIso(instant, tz) {
  const wc = _wallClockIn(instant, tz);
  // Compute the offset from the wall-clock vs the UTC instant.
  const wcUtc = Date.UTC(wc.year, wc.month - 1, wc.day, wc.hour, wc.minute, wc.second);
  const offsetMin = Math.round((wcUtc - instant.getTime()) / 60000);
  const sign = offsetMin >= 0 ? '+' : '-';
  const a = Math.abs(offsetMin);
  const oh = String(Math.floor(a / 60)).padStart(2, '0');
  const om = String(a % 60).padStart(2, '0');
  const pad = (n) => String(n).padStart(2, '0');
  return `${wc.year}-${pad(wc.month)}-${pad(wc.day)}T${pad(wc.hour)}:${pad(wc.minute)}:${pad(wc.second)}${sign}${oh}:${om}`;
}

// daily: most recent and next instant of HH:MM in the user's TZ.
function _evalDaily(trigger, now, tz) {
  const t = _parseHHMM(trigger.time);
  if (!t) return null;
  const wc = _wallClockIn(now, tz);

  const todayInstant = _wallClockToInstant(wc.year, wc.month, wc.day, t.h, t.m, tz);
  if (todayInstant.getTime() <= now.getTime()) {
    // Today's slot has already passed (or is right now). Next is tomorrow.
    const tomorrow = new Date(now.getTime() + 24 * 3600 * 1000);
    const twc = _wallClockIn(tomorrow, tz);
    const nextInstant = _wallClockToInstant(twc.year, twc.month, twc.day, t.h, t.m, tz);
    return {
      prev: _formatIso(todayInstant, tz),
      next: _formatIso(nextInstant, tz),
    };
  }
  // Today's slot hasn't fired yet. Previous is yesterday at HH:MM.
  const yesterday = new Date(now.getTime() - 24 * 3600 * 1000);
  const ywc = _wallClockIn(yesterday, tz);
  const prevInstant = _wallClockToInstant(ywc.year, ywc.month, ywc.day, t.h, t.m, tz);
  return {
    prev: _formatIso(prevInstant, tz),
    next: _formatIso(todayInstant, tz),
  };
}

function _evalWeekly(trigger, now, tz) {
  const t = _parseHHMM(trigger.time);
  if (!t) return null;
  const days = (trigger.days || []).filter(d => d in WEEKDAY_INDEX);
  if (days.length === 0) return null;
  const dowSet = new Set(days.map(d => WEEKDAY_INDEX[d]));

  const wc = _wallClockIn(now, tz);
  const todayDow = WEEKDAY_INDEX[wc.weekday] ?? 0;

  // Find the next eligible slot at or after now.
  let nextInstant = null;
  for (let offset = 0; offset < 8; offset++) {
    const candidateDow = (todayDow + offset) % 7;
    if (!dowSet.has(candidateDow)) continue;
    const future = new Date(now.getTime() + offset * 24 * 3600 * 1000);
    const fwc = _wallClockIn(future, tz);
    const inst = _wallClockToInstant(fwc.year, fwc.month, fwc.day, t.h, t.m, tz);
    if (inst.getTime() > now.getTime()) {
      nextInstant = inst;
      break;
    }
  }

  // Find the most recent eligible slot before now.
  let prevInstant = null;
  for (let offset = 0; offset < 8; offset++) {
    const candidateDow = (todayDow + 7 - offset) % 7;
    if (!dowSet.has(candidateDow)) continue;
    const past = new Date(now.getTime() - offset * 24 * 3600 * 1000);
    const pwc = _wallClockIn(past, tz);
    const inst = _wallClockToInstant(pwc.year, pwc.month, pwc.day, t.h, t.m, tz);
    if (inst.getTime() <= now.getTime()) {
      prevInstant = inst;
      break;
    }
  }

  if (!nextInstant || !prevInstant) return null;
  return {
    prev: _formatIso(prevInstant, tz),
    next: _formatIso(nextInstant, tz),
  };
}

// Evaluate a trigger: returns { prev, next } as ISO strings, or null if
// the trigger type is unknown / the spec is malformed (the validator
// should have caught the latter, so null here is the load-time-lenient
// recovery path).
function evaluate(trigger, now, tz) {
  if (!trigger || !tz) return null;
  if (trigger.type === 'daily') return _evalDaily(trigger, now, tz);
  if (trigger.type === 'weekly') return _evalWeekly(trigger, now, tz);
  // schedule_due: slot wall-clock is identical to daily; the per-item
  // filter is the scheduler's job, not the evaluator's.
  if (trigger.type === 'schedule_due') return _evalDaily(trigger, now, tz);
  return null;
}

module.exports = {
  evaluate,
  // Exported for tests:
  _parseHHMM,
  _wallClockIn,
  _wallClockToInstant,
  _formatIso,
};
