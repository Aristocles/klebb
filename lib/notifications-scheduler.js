// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// lib/notifications-scheduler.js
//
// In-process scheduler that walks the manifest registry once per minute,
// evaluates triggers, and fires due notifications. v3.0.0 wires this up
// to logging only (no push send); the notifications-send PR (#386)
// replaces _dispatch() with the real send path.
//
// Idempotency: lastFired stores the SLOT instant (the prevFire ISO from
// the trigger evaluator), not the wall-clock fire time. So a server
// restart at 08:00:30 sees lastFired=2026-06-12T08:00:00... and skips,
// rather than refiring 30s later.
//
// Coalescing: if multiple items fire in the same minute they are bundled
// into one logical dispatch event. The send-side PR uses this to send
// one collapsed Web Push instead of N separate notifications.

const trigger = require('./notification-trigger');
const state = require('./notifications-state');
const userTz = require('./user-tz');

const TICK_MS = 60_000;
const ITEMS_CAP = 50;
const SLOT_ORDER = ['morning', 'midday', 'evening', 'night'];

let _registry = null;
let _timer = null;
let _stopping = false;
let _dispatch = _logDispatch;

// schedule.js is ESM; this module is CJS. Cache the dynamic import so
// the cost is paid once at first need. Returns a thenable on first call,
// the resolved module on every subsequent call.
let _scheduleLib = null;
let _scheduleLibPromise = null;
async function _loadScheduleLib() {
  if (_scheduleLib) return _scheduleLib;
  if (!_scheduleLibPromise) _scheduleLibPromise = import('./schedule.js');
  _scheduleLib = await _scheduleLibPromise;
  return _scheduleLib;
}

// Default dispatch: log what would be sent. PR #386 swaps this for the
// real Web Push send path via setDispatch().
function _logDispatch(events) {
  for (const ev of events) {
    console.log(`[notifications] would-fire id=${ev.id} slot=${ev.slot} items=${ev.items.length}`);
  }
}

// Replace the dispatch function. Called by the boot wiring in PR4 once
// the send module exists.
function setDispatch(fn) {
  _dispatch = typeof fn === 'function' ? fn : _logDispatch;
}

// Self-rescheduling timer that lands close to the start of each minute.
// setInterval would drift under event-loop pressure; setTimeout +
// next-minute alignment keeps fires deterministic.
function _schedule() {
  if (_stopping) return;
  const now = Date.now();
  const ms = now % 60_000;
  const delay = ms === 0 ? TICK_MS : (TICK_MS - ms);
  _timer = setTimeout(async () => {
    try { await _tick(new Date()); } catch (e) {
      console.warn(`[notifications-scheduler] tick error: ${e.message}`);
    }
    _schedule();
  }, delay);
  if (typeof _timer.unref === 'function') _timer.unref();
}

// Look up a card by id from the registry. Prefer get(id) when the
// registry exposes it (production); fall back to scanning list() for
// the lighter-weight test stubs that only ship a list().
function _lookupCard(cardId) {
  if (!_registry) return null;
  if (typeof _registry.get === 'function') {
    const got = _registry.get(cardId);
    if (got) return got;
  }
  if (typeof _registry.list === 'function') {
    for (const c of _registry.list()) {
      const id = c?.meta?.id || c?.id;
      if (id === cardId) return c;
    }
  }
  return null;
}

// YYYY-MM-DD in the user's TZ.
function _todayIsoIn(now, tz) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = fmt.formatToParts(now);
  const y = parts.find(p => p.type === 'year').value;
  const m = parts.find(p => p.type === 'month').value;
  const d = parts.find(p => p.type === 'day').value;
  return `${y}-${m}-${d}`;
}

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

// Compute surviving + missed-earlier items for a schedule_due fire.
// Returns { surviving, missedEarlier } as arrays of {name, short_name}.
function _filterScheduleDue(scheduleLib, card, slot, todayIso) {
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
    const trim = { name: it.name, short_name: it.short_name };
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

// Format Date#now in the user TZ as HH:MM (used for quiet-hours
// inside-window check).
function _hhmmIn(now, tz) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const h = parts.find(p => p.type === 'hour').value;
  const m = parts.find(p => p.type === 'minute').value;
  return `${h === '24' ? '00' : h}:${m}`;
}

// Single tick: evaluate every notification across every manifest, write
// any state changes once, and dispatch the coalesced events.
async function _tick(now) {
  if (!_registry) return;
  const tz = userTz.readUserTz();
  const cur = state.read();

  // Global pause short-circuits everything: do NOT advance lastFired so
  // when paused expires, the next tick fires the most recent missed slot.
  if (cur.paused_until && cur.paused_until > now.toISOString()) {
    return;
  }

  let scheduleLib = null;
  const due = [];
  let mutated = false;
  let activeCount = 0;

  for (const card of _registry.list()) {
    const meta = card.meta;
    const notifs = meta && meta.notifications;
    if (!notifs || notifs.enabled === false) continue;
    const items = Array.isArray(notifs.items) ? notifs.items : [];
    for (const item of items) {
      const id = `${meta.id}#${item.id}`;
      const itemState = state.getOrInitItem(cur, id, (item.default || 'on') !== 'off');
      if (itemState.enabled === false) continue;
      if (++activeCount > ITEMS_CAP) {
        console.warn(`[notifications-scheduler] active-item cap (${ITEMS_CAP}) reached; skipping further items this tick`);
        break;
      }

      const slots = trigger.evaluate(item.trigger, now, tz);
      if (!slots) continue;

      const slotMs = new Date(slots.prev).getTime();
      // Only fire when the slot is in the past (or now-ish) AND we
      // haven't already recorded firing for it. The slot string equality
      // is what makes this idempotent across restarts.
      if (slotMs > now.getTime()) continue;
      if (itemState.lastFired === slots.prev) continue;

      // schedule_due: filter by the named card's items + dose state.
      // If nothing survives and nothing was missed earlier today, we
      // still advance lastFired (the slot has passed; the user expects
      // the next tick to evaluate tomorrow's slot, not replay this one).
      let surviving = [];
      let missedEarlier = [];
      if (item.trigger.type === 'schedule_due') {
        if (!scheduleLib) scheduleLib = await _loadScheduleLib();
        const target = _lookupCard(item.trigger.card);
        const targetItems = Array.isArray(target?.data?.items) ? target.data.items : null;
        const targetEnabled = !target || target.meta?.enabled !== false;
        if (target && targetItems && targetEnabled) {
          const todayIso = _todayIsoIn(now, tz);
          const filtered = _filterScheduleDue(scheduleLib, target, item.trigger.time_of_day, todayIso);
          surviving = filtered.surviving;
          missedEarlier = filtered.missedEarlier;
        }
        if (surviving.length === 0 && missedEarlier.length === 0) {
          // Suppress dispatch but advance lastFired so the slot doesn't
          // re-evaluate next minute.
          itemState.lastFired = slots.prev;
          itemState.lastFireStatus = 'suppressed';
          mutated = true;
          continue;
        }
      }

      // Quiet hours: record the slot as fired (so we don't replay a
      // backlog when the window ends), but skip the dispatch.
      const inQuiet = state.isQuietNow(cur.quiet_hours, _hhmmIn(now, tz));
      itemState.lastFired = slots.prev;
      itemState.lastFireStatus = inQuiet ? 'quiet' : 'pending';
      mutated = true;
      if (inQuiet) continue;

      // Resolve privacy with state-wins precedence: the user's toggle in
      // Settings (persisted to notifications.state.json) overrides the
      // manifest's declared default. Without this, flipping "Show full
      // text" on in the UI persisted in state but the actual push went
      // out with the manifest's privacy and the lock screen still saw
      // the generic "You have a reminder" payload.
      const resolvedItem = {
        ...item,
        privacy: itemState.privacy || item.privacy || 'private',
      };
      due.push({
        id,
        slot: slots.prev,
        item: resolvedItem,
        manifest: { id: meta.id, label: meta.label, emoji: meta.emoji || null },
        surviving,
        missed_earlier: missedEarlier,
      });
    }
    if (activeCount > ITEMS_CAP) break;
  }

  if (mutated) state.write(cur);

  if (due.length === 0) return;

  // Coalesce same-minute fires (currently every fire shares the tick's
  // wall-clock minute, so coalescing means one event per item bundle).
  // The dispatch contract is: an array of events, each with .items, even
  // when the items array has length 1.
  const events = [{
    id: 'tick-' + now.toISOString().slice(0, 16),
    slot: due[0].slot,
    items: due,
  }];
  await _dispatch(events);
}

function start(registry) {
  if (_timer) return;
  _registry = registry;
  _stopping = false;
  // Fire on boot so a notification due during a restart window catches up
  // within ~1 second instead of waiting up to 60s.
  _tick(new Date()).catch(() => {});
  _schedule();
}

// Set the registry without starting the timer (for tests).
function _setRegistryForTests(registry) {
  _registry = registry;
}

function stop() {
  _stopping = true;
  if (_timer) { clearTimeout(_timer); _timer = null; }
}

module.exports = {
  start,
  stop,
  setDispatch,
  // Exported for tests:
  _tick,
  _setRegistryForTests,
};
