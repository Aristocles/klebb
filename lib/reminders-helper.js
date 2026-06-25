// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// lib/reminders-helper.js
//
// Carry-forward computation for schedule_due fires. Lifted out of the
// scheduler so the test-fire path in lib/web-push-send.js can compute
// the same surviving / missed-earlier item lists without pulling in
// the whole scheduler module (which owns the live registry + timer).

const SLOT_ORDER = ['morning', 'midday', 'evening', 'night'];

function _itemSlotsSet(item) {
  const v = item?.schedule?.time_of_day;
  if (typeof v === 'string') return new Set([v]);
  if (Array.isArray(v)) return new Set(v);
  return null;
}

function _hasTakenDoseToday(item, todayIso) {
  const doses = Array.isArray(item?.doses) ? item.doses : [];
  for (const d of doses) {
    if (d && d.scheduledDate === todayIso && d.takenAt != null && d.takenAt !== '') return true;
  }
  return false;
}

// One-line dose summary for the modal. Mirrors eh-prompt-modal._doseLabel
// so the same item renders identically across the prompt modal and the
// reminder modal. Returns "" when no dose-shaped fields are present.
function _doseLabel(item) {
  const parts = [];
  if (item.dose_label) parts.push(item.dose_label);
  else if (item.dose_mg != null) parts.push(`${item.dose_mg}mg`);
  else if (item.dose) parts.push(item.dose);
  if (item.dose_units != null) parts.push(`${item.dose_units}u`);
  if (item.route) parts.push(item.route);
  return parts.join(' · ');
}

function _trim(item) {
  const out = { name: item.name, short_name: item.short_name };
  const dose = _doseLabel(item);
  if (dose) out.dose = dose;
  if (item.timing) out.timing = item.timing;
  return out;
}

function todayIsoIn(now, tz) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = fmt.formatToParts(now);
  const y = parts.find(p => p.type === 'year').value;
  const m = parts.find(p => p.type === 'month').value;
  const d = parts.find(p => p.type === 'day').value;
  return `${y}-${m}-${d}`;
}

// Compute surviving + missed-earlier items for a schedule_due fire.
// Returns { surviving, missedEarlier } as arrays of {name, short_name}.
function filterScheduleDue(scheduleLib, card, slot, todayIso) {
  const items = Array.isArray(card?.data?.items) ? card.data.items : [];
  const slotIdx = SLOT_ORDER.indexOf(slot);
  const surviving = [];
  const missedEarlier = [];
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const slots = _itemSlotsSet(it);
    if (!slots) continue;
    const status = scheduleLib.isScheduledOnDate(it, todayIso);
    if (status !== 'scheduled') continue;
    if (_hasTakenDoseToday(it, todayIso)) continue;
    const trim = _trim(it);
    if (slots.has(slot)) {
      surviving.push(trim);
      continue;
    }
    if (slotIdx > 0) {
      let earliest = SLOT_ORDER.length;
      for (const s of slots) {
        const idx = SLOT_ORDER.indexOf(s);
        if (idx >= 0 && idx < earliest) earliest = idx;
      }
      if (earliest < slotIdx) missedEarlier.push(trim);
    }
  }
  return { surviving, missedEarlier };
}

module.exports = {
  SLOT_ORDER,
  filterScheduleDue,
  todayIsoIn,
};
