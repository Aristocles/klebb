// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// public/js/lib/card-notifications.js
// Pure logic for the settings gear's Notifications section.
//
// The gear only ever touches the manifest (meta.notifications); per-item
// enable/privacy live in notifications.state.json and stay with Settings ›
// Notifications. Privacy is left at the schema default (private): the gear
// is the simple on/off switch, richer text + timing are Klebbius's job.
//
// Three card states drive the UI:
//   - 'has-items'    : meta.notifications.items[] is non-empty. Show a master
//                      toggle bound to meta.notifications.enabled.
//   - 'can-create'   : no items yet, but the card is loggable
//                      (meta.writeable.fromWebapp). The toggle creates one
//                      default daily reminder on enable.
//   - 'none'         : not loggable + no items. No toggle; the Klebbius link
//                      is the only path.

const DEFAULT_TIME = '09:00';
const TITLE_MAX = 30;
const LABEL_MAX = 80;

function items(meta) {
  const n = meta?.notifications;
  return n && Array.isArray(n.items) ? n.items : [];
}

export function notificationsState(meta) {
  if (items(meta).length > 0) return 'has-items';
  if (meta?.writeable?.fromWebapp) return 'can-create';
  return 'none';
}

// Whether reminders are currently on. With items present it's the master
// flag (default true when the block exists). With no block, off.
export function notificationsEnabled(meta) {
  const n = meta?.notifications;
  if (!n) return false;
  return n.enabled !== false;
}

function clamp(s, max) {
  return s.length > max ? s.slice(0, max) : s;
}

// Build one private daily reminder for a loggable card. Mirrors the strict
// validator's required fields (id, non-empty label/title/body, daily trigger
// with HH:MM). privacy/default are omitted so the schema defaults
// (private / on) apply. time defaults to 09:00; timing changes go via Klebbius.
export function buildDefaultReminder(meta, { time = DEFAULT_TIME } = {}) {
  const name = (meta?.label || meta?.id || 'this').trim();
  return {
    id: 'reminder',
    label: clamp(`${name} reminder`, LABEL_MAX),
    title: clamp(name, TITLE_MAX),
    body: 'Tap to log today’s entry.',
    trigger: { type: 'daily', time },
  };
}

// Build the meta-patch for toggling notifications. Returns null when the
// requested state already holds (no-op). Array-replace semantics of the
// merge-patch mean we send the full items[] only when creating; the
// has-items master toggle never sends items[], so existing items are
// preserved untouched.
export function buildNotificationsPatch(meta, enable) {
  const state = notificationsState(meta);
  const currentlyOn = notificationsEnabled(meta);

  if (state === 'none') return null;

  if (state === 'has-items') {
    if (enable === currentlyOn) return null;
    return { meta: { notifications: { enabled: enable } } };
  }

  // can-create: enabling seeds the default reminder; disabling with no
  // block yet is a no-op (nothing to turn off).
  if (!enable) return null;
  return {
    meta: {
      notifications: { enabled: true, items: [buildDefaultReminder(meta)] },
    },
  };
}
