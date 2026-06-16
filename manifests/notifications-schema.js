// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// manifests/notifications-schema.js
//
// Validator for meta.notifications. Mirrors the existing two-stage pattern
// in manifests/registry.js: lenient at load (drop bad items silently,
// return cleaned), strict at create + PATCH (throw with a prefix the HTTP
// handler maps to a status code).
//
// Strict-mode error prefixes (handler maps these):
//   "invalid notifications: ..."  -> 422
//
// v3.1 supports three trigger types: daily, weekly, schedule_due.
// interval and last_logged are still deferred.

const ITEM_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const WEEKDAYS = new Set(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
const TIME_OF_DAY_TOKENS = new Set(['morning', 'midday', 'evening', 'night']);
const TRIGGER_TYPES = new Set(['daily', 'weekly', 'schedule_due']);

const TITLE_MAX = 30;
const BODY_MAX = 80;
const LABEL_MAX = 80;
const ITEMS_MAX = 10;
const ID_MAX = 64;

const PRIVACY_VALUES = new Set(['private', 'public']);
const DEFAULT_VALUES = new Set(['on', 'off']);
const ACTION_INTENTS = new Set(['view', 'log']);
const CARD_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function fail(strict, msg) {
  if (strict) throw new Error(`invalid notifications: ${msg}`);
}

// Validate one item. Returns the item (possibly with optional fields
// normalised) or null if invalid. In strict mode, throws on the first
// failure. In lenient mode, returns null for the caller to drop.
function validateItem(item, strict, seenIds) {
  if (!isPlainObject(item)) {
    fail(strict, 'each items[] entry must be an object');
    return null;
  }

  const id = item.id;
  if (typeof id !== 'string' || !ITEM_ID_PATTERN.test(id) || id.length > ID_MAX) {
    fail(strict, `item.id missing or invalid (must match ^[a-z0-9][a-z0-9._-]{0,63}$)`);
    return null;
  }
  if (seenIds.has(id)) {
    fail(strict, `duplicate item.id "${id}" within meta.notifications.items[]`);
    return null;
  }
  seenIds.add(id);

  if (typeof item.label !== 'string' || !item.label || item.label.length > LABEL_MAX) {
    fail(strict, `item ${id}: label must be a non-empty string up to ${LABEL_MAX} chars`);
    return null;
  }
  if (typeof item.title !== 'string' || !item.title || item.title.length > TITLE_MAX) {
    fail(strict, `item ${id}: title must be a non-empty string up to ${TITLE_MAX} chars`);
    return null;
  }
  if (typeof item.body !== 'string' || !item.body || item.body.length > BODY_MAX) {
    fail(strict, `item ${id}: body must be a non-empty string up to ${BODY_MAX} chars`);
    return null;
  }

  const trig = item.trigger;
  if (!isPlainObject(trig) || !TRIGGER_TYPES.has(trig.type)) {
    fail(strict, `item ${id}: trigger.type must be "daily", "weekly", or "schedule_due"`);
    return null;
  }
  if (typeof trig.time !== 'string' || !TIME_PATTERN.test(trig.time)) {
    fail(strict, `item ${id}: trigger.time must match HH:MM (24-hour)`);
    return null;
  }
  if (trig.type === 'weekly') {
    if (!Array.isArray(trig.days) || trig.days.length === 0) {
      fail(strict, `item ${id}: weekly trigger requires non-empty days[]`);
      return null;
    }
    const seen = new Set();
    for (const d of trig.days) {
      if (typeof d !== 'string' || !WEEKDAYS.has(d) || seen.has(d)) {
        fail(strict, `item ${id}: weekly trigger.days entries must be unique and one of mon|tue|wed|thu|fri|sat|sun`);
        return null;
      }
      seen.add(d);
    }
  }
  if (trig.type === 'schedule_due') {
    if (typeof trig.card !== 'string' || !CARD_ID_PATTERN.test(trig.card)) {
      fail(strict, `item ${id}: schedule_due trigger.card must match ^[a-z0-9][a-z0-9._-]{0,63}$`);
      return null;
    }
    if (typeof trig.time_of_day !== 'string' || !TIME_OF_DAY_TOKENS.has(trig.time_of_day)) {
      fail(strict, `item ${id}: schedule_due trigger.time_of_day must be one of morning|midday|evening|night`);
      return null;
    }
  }

  // action: optional. When present, must be the open-card shape.
  let action = item.action;
  if (action !== undefined) {
    if (!isPlainObject(action) || action.type !== 'open-card') {
      fail(strict, `item ${id}: action.type must be "open-card"`);
      return null;
    }
    if (action.card !== undefined && (typeof action.card !== 'string' || !CARD_ID_PATTERN.test(action.card))) {
      fail(strict, `item ${id}: action.card must match ^[a-z0-9][a-z0-9._-]{0,63}$`);
      return null;
    }
    if (action.intent !== undefined && !ACTION_INTENTS.has(action.intent)) {
      fail(strict, `item ${id}: action.intent must be "view" or "log"`);
      return null;
    }
  }

  if (item.privacy !== undefined && !PRIVACY_VALUES.has(item.privacy)) {
    fail(strict, `item ${id}: privacy must be "private" or "public"`);
    return null;
  }
  if (item.default !== undefined && !DEFAULT_VALUES.has(item.default)) {
    fail(strict, `item ${id}: default must be "on" or "off"`);
    return null;
  }

  // Normalise: surface the defaults so downstream code never has to repeat them.
  let normalisedTrigger;
  if (trig.type === 'daily') {
    normalisedTrigger = { type: 'daily', time: trig.time };
  } else if (trig.type === 'weekly') {
    normalisedTrigger = { type: 'weekly', time: trig.time, days: [...trig.days] };
  } else {
    normalisedTrigger = {
      type: 'schedule_due',
      card: trig.card,
      time_of_day: trig.time_of_day,
      time: trig.time,
    };
  }
  return {
    id,
    label: item.label,
    title: item.title,
    body: item.body,
    trigger: normalisedTrigger,
    action: action ? { ...action } : undefined,
    privacy: item.privacy || 'private',
    default: item.default || 'on',
  };
}

// Validate the meta.notifications block on a manifest object.
// In lenient mode (strict=false), invalid items are dropped silently and
// the function returns a cleaned block (or undefined if the whole block is
// the wrong shape).
// In strict mode (strict=true), the first failure throws with the
// "invalid notifications: ..." prefix.
function validateNotifications(notifications, { strict = false } = {}) {
  if (notifications === undefined || notifications === null) {
    return undefined;
  }
  if (!isPlainObject(notifications)) {
    fail(strict, 'meta.notifications must be an object');
    return undefined;
  }

  const enabled = notifications.enabled === false ? false : true;

  const rawItems = notifications.items;
  if (rawItems === undefined) {
    return { enabled, items: [] };
  }
  if (!Array.isArray(rawItems)) {
    fail(strict, 'meta.notifications.items must be an array');
    return { enabled, items: [] };
  }
  if (rawItems.length > ITEMS_MAX) {
    fail(strict, `meta.notifications.items length exceeds the cap of ${ITEMS_MAX}`);
    // Lenient: keep the first N and drop the rest.
  }

  const cleaned = [];
  const seenIds = new Set();
  const limit = strict ? rawItems.length : Math.min(rawItems.length, ITEMS_MAX);
  for (let i = 0; i < limit; i++) {
    const out = validateItem(rawItems[i], strict, seenIds);
    if (out) cleaned.push(out);
  }

  return { enabled, items: cleaned };
}

module.exports = {
  validateNotifications,
  // Exported for use in tests + future trigger/scheduler modules.
  ITEMS_MAX,
  TITLE_MAX,
  BODY_MAX,
  LABEL_MAX,
  ITEM_ID_PATTERN,
  TIME_PATTERN,
  WEEKDAYS: [...WEEKDAYS],
  TIME_OF_DAY_TOKENS: [...TIME_OF_DAY_TOKENS],
  TRIGGER_TYPES: [...TRIGGER_TYPES],
};
