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
  if (recipients.length === 0) {
    if (events.length > 0) {
      console.log(`[notifications] dispatch ev=${events[0].id} recipients=0 (no live subs)`);
    }
    return;
  }
  _ensureVapidConfigured();

  for (const ev of events) {
    const payload = buildPayload(ev);
    console.log(`[notifications] send ev=${ev.id} recipients=${recipients.length}`);
    const results = await Promise.allSettled(
      recipients.map(r => _sendOne(r, payload, ev)),
    );
    const sent = results.filter(r => r.status === 'fulfilled' && r.value && r.value.ok).length;
    const failed = results.length - sent;
    const statuses = results.map(r =>
      r.status === 'fulfilled' ? r.value.statusCode : 'rejected'
    );
    // Per-recipient line: short id + UA hint + status. Lets `docker
    // logs` answer "did device X get the push" without grepping the
    // state file. Keep it terse: one short line per recipient.
    for (let i = 0; i < recipients.length; i++) {
      const r = recipients[i];
      const v = results[i].status === 'fulfilled' ? results[i].value : { ok: false, statusCode: 'rejected' };
      const ua = (r.userAgent || '').match(/iPhone|iPad|Android|Edg|Firefox|Chrome|Safari/)?.[0] || 'unknown';
      console.log(`[notifications]   sub=${r.id.slice(0, 8)} ua=${ua} status=${v.statusCode} ok=${!!v.ok}`);
    }
    console.log(`[notifications] done ev=${ev.id} sent=${sent} failed=${failed}`);

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
    const title = _substitutePlaceholders(i.item.title, i.surviving, i.missed_earlier);
    const body = _substitutePlaceholders(i.item.body, i.surviving, i.missed_earlier);
    return {
      id: i.id,
      time: hhmm,
      privacy: i.item.privacy || 'private',
      title: isPublic ? title : 'Klebb',
      body: isPublic ? body : 'You have a reminder.',
      realTitle: isPublic ? null : title,
      realBody: isPublic ? null : body,
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

// Substitute {schedule_due} and {missed_earlier} in a body/title string.
// {missed_earlier} carries its own ". Also missed earlier: " prefix when
// non-empty, otherwise empty string, so an author writing
// "Time for {schedule_due}{missed_earlier}" gets a clean sentence in
// either case. Triggers other than schedule_due always land here with
// both arrays empty, so both placeholders substitute to "".
function _substitutePlaceholders(text, surviving, missedEarlier) {
  if (typeof text !== 'string') return text;
  const survList = Array.isArray(surviving) ? surviving : [];
  const missList = Array.isArray(missedEarlier) ? missedEarlier : [];
  const survStr = survList.map(_displayName).join(', ');
  const missStr = missList.length > 0
    ? '. Also missed earlier: ' + missList.map(_displayName).join(', ')
    : '';
  return text.replaceAll('{schedule_due}', survStr).replaceAll('{missed_earlier}', missStr);
}

function _displayName(it) {
  if (!it) return '';
  return it.short_name || it.name || '';
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
