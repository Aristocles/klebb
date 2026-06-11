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

let _registry = null;
let _timer = null;
let _stopping = false;
let _dispatch = _logDispatch;

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

      // Quiet hours: record the slot as fired (so we don't replay a
      // backlog when the window ends), but skip the dispatch.
      const inQuiet = state.isQuietNow(cur.quiet_hours, _hhmmIn(now, tz));
      itemState.lastFired = slots.prev;
      itemState.lastFireStatus = inQuiet ? 'quiet' : 'pending';
      mutated = true;
      if (inQuiet) continue;

      due.push({
        id,
        slot: slots.prev,
        item,
        manifest: { id: meta.id, label: meta.label, emoji: meta.emoji || null },
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
