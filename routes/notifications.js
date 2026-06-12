// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// routes/notifications.js
//
// Web Push subscription + notification state HTTP surface. Exports a
// single `handle(req, res, ctx)` function that returns true when it
// has fully handled the request, false otherwise.
//
// Auth: every endpoint is gated by the existing isAuthenticated()
// middleware (which the main dispatcher applies before delegating
// here). State-changing endpoints additionally check the Origin
// header against ENV.WEBAUTHN_ORIGIN: SameSite=Lax cookies don't
// block cross-fetch from same-eTLD+1 subdomains, and a future
// blog.klebb.app could otherwise register its own push sub under
// the operator's account.

const ENV = require('../config/env');
const vapid = require('../lib/vapid');
const subs = require('../lib/push-subscriptions');
const stateStore = require('../lib/notifications-state');
const webPushSend = require('../lib/web-push-send');

const TEST_RATE_LIMIT_MS = 60_000;
const _testFireRecent = new Map(); // key: `${subId}#${notifId}` -> timestamp

function _send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function _readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', c => buf += c);
    req.on('end', () => {
      if (!buf) return resolve({});
      try { resolve(JSON.parse(buf)); }
      catch { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

// Origin allowlist: SameSite=Lax does not protect against same-site
// cross-subdomain fetches. Reject any state-changing request whose
// Origin doesn't match the configured public origin.
function _checkOrigin(req, res) {
  const origin = req.headers.origin;
  if (origin && origin === ENV.WEBAUTHN_ORIGIN) return true;
  // Same-host requests with no Origin header (e.g. curl from the
  // operator) are allowed: they can't have ridden a CSRF, and the
  // operator deliberately turning off Origin is their call.
  if (!origin) return true;
  _send(res, 403, { error: 'origin not allowed' });
  return false;
}

function _testRateOk(subId, notifId) {
  const key = `${subId}#${notifId}`;
  const last = _testFireRecent.get(key) || 0;
  const now = Date.now();
  if (now - last < TEST_RATE_LIMIT_MS) return false;
  _testFireRecent.set(key, now);
  return true;
}

// `parts` is the path split (e.g. ['push', 'subscribe']). `registry`
// is passed via ctx so we can resolve manifest meta for /api/notifications.
async function handle(req, res, parts, ctx) {
  // Demo-mode short-circuit: every push and notifications endpoint 410s.
  if (ENV.KLEBB_DEMO && (parts[0] === 'push' || parts[0] === 'notifications' || (parts[0] === 'diagnostics'))) {
    _send(res, 410, { error: 'disabled in demo mode' });
    return true;
  }

  // GET /api/push/vapid-public-key
  if (parts[0] === 'push' && parts[1] === 'vapid-public-key' && parts.length === 2 && req.method === 'GET') {
    _send(res, 200, { key: vapid.getPublicKey(), keyId: vapid.getKeyId() });
    return true;
  }

  // POST /api/push/subscribe
  if (parts[0] === 'push' && parts[1] === 'subscribe' && parts.length === 2 && req.method === 'POST') {
    if (!_checkOrigin(req, res)) return true;
    let body;
    try { body = await _readBody(req); }
    catch { _send(res, 400, { error: 'invalid JSON body' }); return true; }
    try {
      const result = subs.add(
        { endpoint: body.endpoint, keys: body.keys },
        {
          userAgent: req.headers['user-agent'] || null,
          nickname: typeof body.nickname === 'string' && body.nickname.slice(0, 64) || null,
          userHandle: ctx && ctx.userHandle || null,
        },
      );
      _send(res, result.created ? 201 : 200, { id: result.id, created: result.created });
    } catch (e) {
      if (e.code === 'INVALID_SUB') _send(res, 400, { error: 'invalid subscription' });
      else _send(res, 500, { error: e.message || 'subscribe failed' });
    }
    return true;
  }

  // POST /api/push/subscribe/heartbeat
  if (parts[0] === 'push' && parts[1] === 'subscribe' && parts[2] === 'heartbeat' && parts.length === 3 && req.method === 'POST') {
    if (!_checkOrigin(req, res)) return true;
    let body;
    try { body = await _readBody(req); }
    catch { _send(res, 400, { error: 'invalid JSON body' }); return true; }
    if (typeof body.endpoint !== 'string') { _send(res, 400, { error: 'endpoint required' }); return true; }
    const ok = subs.heartbeat(body.endpoint);
    if (!ok) { _send(res, 404, { error: 'unknown endpoint' }); return true; }
    _send(res, 200, { ok: true });
    return true;
  }

  // POST /api/push/unsubscribe
  if (parts[0] === 'push' && parts[1] === 'unsubscribe' && parts.length === 2 && req.method === 'POST') {
    if (!_checkOrigin(req, res)) return true;
    let body;
    try { body = await _readBody(req); }
    catch { _send(res, 400, { error: 'invalid JSON body' }); return true; }
    if (typeof body.endpoint !== 'string') { _send(res, 400, { error: 'endpoint required' }); return true; }
    subs.remove(body.endpoint);
    res.statusCode = 204;
    res.end();
    return true;
  }

  // GET /api/notifications - aggregate of every declared item across
  // every manifest, plus its toggle state and lastFired.
  if (parts[0] === 'notifications' && parts.length === 1 && req.method === 'GET') {
    const cur = stateStore.read();
    const list = [];
    for (const card of ctx.registry.list()) {
      const meta = card.meta;
      const notifs = meta && meta.notifications;
      if (!notifs || !Array.isArray(notifs.items)) continue;
      for (const item of notifs.items) {
        const id = `${meta.id}#${item.id}`;
        const itemState = cur.items[id] || {};
        list.push({
          id,
          card_id: meta.id,
          item_id: item.id,
          label: item.label,
          card_label: meta.label,
          card_emoji: meta.emoji || null,
          title: item.title,
          body: item.body,
          trigger: item.trigger,
          // Runtime state wins: the user's per-notification privacy
          // toggle in Settings overrides the manifest's declared default.
          privacy: itemState.privacy || item.privacy || 'private',
          enabled: itemState.enabled !== false && (notifs.enabled !== false),
          last_fired: itemState.lastFired || null,
          last_fire_status: itemState.lastFireStatus || null,
        });
      }
    }
    _send(res, 200, {
      notifications: list,
      quiet_hours: cur.quiet_hours,
      paused_until: cur.paused_until,
    });
    return true;
  }

  // POST /api/notifications/state - toggle enabled and/or privacy on a
  // single item.
  if (parts[0] === 'notifications' && parts[1] === 'state' && parts.length === 2 && req.method === 'POST') {
    if (!_checkOrigin(req, res)) return true;
    let body;
    try { body = await _readBody(req); }
    catch { _send(res, 400, { error: 'invalid JSON body' }); return true; }
    if (typeof body.id !== 'string' || !/^[a-z0-9][a-z0-9._-]*#[a-z0-9][a-z0-9._-]*$/.test(body.id)) {
      _send(res, 400, { error: 'id required' });
      return true;
    }
    const patch = {};
    if (body.enabled === true || body.enabled === false) patch.enabled = body.enabled;
    if (body.privacy === 'private' || body.privacy === 'public') patch.privacy = body.privacy;
    if (Object.keys(patch).length === 0) {
      _send(res, 400, { error: 'no fields to update' });
      return true;
    }
    const updated = stateStore.writeItem(body.id, patch);
    _send(res, 200, { ok: true, state: updated });
    return true;
  }

  // POST /api/notifications/global-state - quiet_hours and paused_until.
  if (parts[0] === 'notifications' && parts[1] === 'global-state' && parts.length === 2 && req.method === 'POST') {
    if (!_checkOrigin(req, res)) return true;
    let body;
    try { body = await _readBody(req); }
    catch { _send(res, 400, { error: 'invalid JSON body' }); return true; }
    const patch = {};
    if ('quiet_hours' in body) patch.quiet_hours = body.quiet_hours;
    if ('paused_until' in body) patch.paused_until = body.paused_until;
    const updated = stateStore.writeGlobal(patch);
    _send(res, 200, { ok: true, ...updated });
    return true;
  }

  // POST /api/notifications/test - fire the configured payload to every
  // live subscription right now. Rate-limited per (sub, notif).
  if (parts[0] === 'notifications' && parts[1] === 'test' && parts.length === 2 && req.method === 'POST') {
    if (!_checkOrigin(req, res)) return true;
    let body;
    try { body = await _readBody(req); }
    catch { _send(res, 400, { error: 'invalid JSON body' }); return true; }
    if (typeof body.id !== 'string') { _send(res, 400, { error: 'id required' }); return true; }
    const [cardId, itemId] = body.id.split('#');
    if (!cardId || !itemId) { _send(res, 400, { error: 'id must be cardId#itemId' }); return true; }

    const card = ctx.registry.get(cardId);
    if (!card) { _send(res, 404, { error: 'unknown card' }); return true; }
    const item = (card.meta && card.meta.notifications && Array.isArray(card.meta.notifications.items))
      ? card.meta.notifications.items.find(i => i.id === itemId)
      : null;
    if (!item) { _send(res, 404, { error: 'unknown notification item' }); return true; }

    // Rate-limit globally per (notif, all-subs) so a session-token leak
    // can't spam the operator's phone.
    if (!_testRateOk('all', body.id)) {
      _send(res, 429, { error: 'rate-limited; max 1 test fire per minute per notification' });
      return true;
    }

    try {
      const result = await webPushSend.testFire({
        manifest: { id: cardId, label: card.meta.label, emoji: card.meta.emoji || null },
        item,
      });
      _send(res, 200, { ok: true, sent: result.sent });
    } catch (e) {
      _send(res, 500, { error: e.message || 'test fire failed' });
    }
    return true;
  }

  // GET /api/diagnostics
  if (parts[0] === 'diagnostics' && parts.length === 1 && req.method === 'GET') {
    const cur = stateStore.read();
    const subList = subs.list({ includeDead: true }).map(s => ({
      id: s.id,
      nickname: s.nickname || null,
      userAgentSummary: (s.userAgent || '').slice(0, 80),
      createdAt: s.createdAt,
      lastSentAt: s.lastSentAt,
      lastStatus: s.lastStatus,
      dead: !!s.dead,
      deadSince: s.deadSince || null,
    }));
    _send(res, 200, {
      tz: process.env.TZ || null,
      vapid_key_id: vapid.getKeyId(),
      subscriptions: subList,
      recent_fires: cur.recent_fires || [],
      quiet_hours: cur.quiet_hours,
      paused_until: cur.paused_until,
    });
    return true;
  }

  return false;
}

// Expose a fixed list of route prefixes the dispatcher can use to know
// whether to delegate. Cleaner than having server.js know our internal
// paths.
const ROUTE_PREFIXES = ['push', 'notifications', 'diagnostics'];

module.exports = { handle, ROUTE_PREFIXES };
