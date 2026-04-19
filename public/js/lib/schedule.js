// public/js/lib/schedule.js
// Pure functions evaluating whether a scheduled item is "on" for a given date.
// Shared by eh-checklist-card, eh-schedule-timeline, eh-calendar-view etc.

const DAY_NAMES_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function dayName(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return DAY_NAMES_SHORT[d.getDay()];
}

// Returns one of:
//   'scheduled' — on an active cycle + schedule day
//   'rest'      — on an active cycle but a rest day per the schedule
//   'off'       — inside an "off" cycle segment
//   false       — outside all cycles
export function isScheduledOnDate(item, dateStr) {
  const sched = item.schedule;
  const cycles = item.cycles;

  // If no cycles: just use schedule directly + optional item-level dates
  if (!cycles || cycles.length === 0) {
    if (!sched) return 'scheduled';
    if (item.startDate && dateStr < item.startDate) return false;
    if (item.endDate && dateStr > item.endDate) return false;
    return evalSchedule(sched, dateStr, item.startDate);
  }

  // Find the cycle this date falls into
  const active = cycles.find(c => {
    const start = c.start || c.start_date;
    const end = c.end || c.end_date || c.off_end;
    if (!start) return false;
    if (end) return dateStr >= start && dateStr <= end;
    return dateStr >= start;
  });
  if (!active) return false;

  // "off" cycle
  if (active.type === 'off') return 'off';

  // "on" cycle: evaluate schedule
  if (!sched) return 'scheduled';
  const startRef = active.start || active.start_date;
  return evalSchedule(sched, dateStr, startRef);
}

function evalSchedule(sched, dateStr, startRef) {
  const dName = dayName(dateStr);
  const freq = sched.frequency || sched.type;

  if (freq === 'daily' || freq === 'daily_straight') return 'scheduled';

  if (freq === 'weekly') {
    const dow = (sched.dayOfWeek || '').toLowerCase();
    if (dow === dName.toLowerCase() || dow === dName.toLowerCase().slice(0, 3)) return 'scheduled';
    return 'rest';
  }

  if (freq === 'every_n_days') {
    const n = sched.nDays || sched.every || 1;
    const start = sched.startDate || startRef;
    if (!start) return 'scheduled';
    const d1 = new Date(start + 'T00:00:00');
    const d2 = new Date(dateStr + 'T00:00:00');
    const diffDays = Math.round((d2 - d1) / (24 * 3600 * 1000));
    if (diffDays < 0) return false;
    return (diffDays % n === 0) ? 'scheduled' : 'rest';
  }

  if (freq === 'on_off') {
    const on = (sched.on_days || []).map(s => s.slice(0, 3));
    const off = (sched.off_days || []).map(s => s.slice(0, 3));
    if (on.includes(dName)) return 'scheduled';
    if (off.includes(dName)) return 'rest';
    return 'rest';
  }

  if (freq === 'phased') {
    if (!startRef) return 'scheduled';
    const cycleStart = new Date(startRef + 'T00:00:00');
    const current = new Date(dateStr + 'T00:00:00');
    const weekNum = Math.floor((current - cycleStart) / (7 * 86400000)) + 1;
    const loadingWeeks = sched.loading?.duration_weeks || 4;
    if (weekNum <= loadingWeeks) {
      const days = (sched.loading?.days || []).map(s => s.slice(0, 3));
      return days.includes(dName) ? 'scheduled' : 'rest';
    }
    const days = (sched.maintenance?.days || []).map(s => s.slice(0, 3));
    return days.includes(dName) ? 'scheduled' : 'rest';
  }

  return false;
}

// Return all dates in [startStr..endStr] inclusive (ISO YYYY-MM-DD).
export function enumerateDates(startStr, endStr) {
  const out = [];
  const d = new Date(startStr + 'T00:00:00');
  const end = new Date(endStr + 'T00:00:00');
  while (d <= end) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    out.push(`${y}-${m}-${day}`);
    d.setDate(d.getDate() + 1);
  }
  return out;
}
