// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// lib/web-push-send.js
//
// Wraps the web-push npm package: build the wire payload, send to every
// live subscription, map provider error codes to dead/alive, append the
// fire to the recent_fires ring buffer for the Diagnostics tab.
//
// Justification for the dep: this is the cryptographic surface (VAPID
// JWT signing per RFC 8292, content encryption per RFC 8291). One
// well-audited package replaces ~250 lines of from-scratch crypto we'd
// otherwise own and is widely exercised in production.

const crypto = require('crypto');
const webpush = require('web-push');
const ENV = require('../config/env');
const vapid = require('./vapid');
const subs = require('./push-subscriptions');
const stateStore = require('./notifications-state');

const TTL_SECONDS = 300;
const URGENCY = 'high';

let _vapidConfigured = false;
function _ensureVapidConfigured() {
  if (_vapidConfigured) return;
  webpush.setVapidDetails(
    ENV.HEALTH_OPERATOR_EMAIL,
    vapid.getPublicKey(),
    vapid.getPrivateKey(),
  );
  _vapidConfigured = true;
}

// Public entry: dispatch a list of scheduler events. Each event has
// .id, .slot, and .items[]. Each item carries the manifest meta + the
// full notification spec. We send one Web Push per (subscription,
// event); the SW unpacks the items[] array on the device.
async function dispatch(events) {
  if (!Array.isArray(events) || events.length === 0) return;
  const recipients = subs.list({ includeDead: false });
  if (recipients.length === 0) return;
  _ensureVapidConfigured();

  for (const ev of events) {
    const payload = buildPayload(ev);
    const results = await Promise.allSettled(
      recipients.map(r => _sendOne(r, payload, ev)),
    );
    const sent = results.filter(r => r.status === 'fulfilled' && r.value && r.value.ok).length;
    const failed = results.length - sent;
    const statuses = results.map(r =>
      r.status === 'fulfilled' ? r.value.statusCode : 'rejected'
    );
    stateStore.appendFire({
      id: ev.id,
      sent,
      failed,
      statuses,
    });
  }
}

// Sub-shape of the wire payload. Title/body are visible on the lock
// screen; for `private` items they're generic, and the SW substitutes
// the real text from cached card data on the device after decryption.
function buildPayload(ev) {
  // Single-item: shape it as a one-item bundle so the SW has one path.
  // Multi-item: the SW shows a "N reminders" coalesced banner.
  const items = ev.items.map(i => {
    const isPublic = i.item.privacy === 'public';
    const hhmm = String(i.slot).slice(11, 16);
    const action = i.item.action || { type: 'open-card', card: i.manifest.id };
    const url = '/?card=' + encodeURIComponent(action.card || i.manifest.id)
      + (action.intent ? '&action=' + encodeURIComponent(action.intent) : '');
    return {
      id: i.id,
      time: hhmm,
      privacy: i.item.privacy || 'private',
      title: isPublic ? i.item.title : 'Klebb',
      body: isPublic ? i.item.body : 'You have a reminder.',
      realTitle: isPublic ? null : i.item.title,
      realBody: isPublic ? null : i.item.body,
      cardId: i.manifest.id,
      cardLabel: i.manifest.label,
      cardEmoji: i.manifest.emoji,
      url,
      tag: _opaqueTag(i.id),
    };
  });

  return {
    type: items.length > 1 ? 'coalesced' : 'single',
    slot: ev.slot,
    items,
  };
}

function _opaqueTag(id) {
  return 'klebb-' + crypto.createHash('sha256').update(id).digest('hex').slice(0, 12);
}

async function _sendOne(sub, payload, ev) {
  const wire = JSON.stringify(payload);
  // Only one tag per HTTP send. With multi-item events all items share
  // the same coalesced tag; with single-item it's the per-id opaque tag.
  const topic = payload.items[0]?.tag || 'klebb-' + ev.id;
  try {
    const result = await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: sub.keys },
      wire,
      {
        TTL: TTL_SECONDS,
        urgency: URGENCY,
        topic,
      },
    );
    subs.recordSendResult(sub.endpoint, result.statusCode);
    return { ok: true, statusCode: result.statusCode };
  } catch (e) {
    const status = e.statusCode || 0;
    if (status === 401 || status === 403 || status === 404 || status === 410) {
      subs.markDead(sub.endpoint, status);
    } else {
      subs.recordSendResult(sub.endpoint, status || 'error');
    }
    return { ok: false, statusCode: status };
  }
}

// Test-fire path: bypass scheduler trigger evaluation; build a payload
// from the manifest item directly and send to every live sub.
async function testFire({ manifest, item, slot }) {
  const ev = {
    id: 'test-' + (item.id || 'item') + '-' + Date.now(),
    slot: slot || new Date().toISOString(),
    items: [{
      id: `${manifest.id}#${item.id}`,
      slot: slot || new Date().toISOString(),
      item,
      manifest: { id: manifest.id, label: manifest.label, emoji: manifest.emoji || null },
    }],
  };
  const before = subs.list({ includeDead: false }).length;
  await dispatch([ev]);
  return { sent: before }; // total live subs; per-recipient outcome lives in recent_fires.
}

module.exports = {
  dispatch,
  testFire,
  buildPayload,        // exported for tests
  _opaqueTag,          // exported for tests
};
