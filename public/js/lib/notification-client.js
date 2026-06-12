// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// public/js/lib/notification-client.js
//
// Browser-side helpers for the notifications feature: capability
// detection, permission + subscribe flow, foreground heartbeat, and
// VAPID-keyId rotation detection.
//
// Lazy by design: nothing here runs until the user opens Settings >
// Notifications and acts. Never prompts for Notification.permission
// on app load.

const KEY_ID_STORAGE = 'klebb-vapid-key-id';

function _b64urlToUint8Array(b64) {
  const padding = '='.repeat((4 - (b64.length % 4)) % 4);
  const base64 = (b64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function isPushSupported() {
  return ('serviceWorker' in navigator)
    && ('Notification' in window)
    && ('PushManager' in window);
}

// On iOS, Web Push only delivers when the PWA has been installed to the
// Home Screen. Use feature detection: if push is unsupported AND we
// detect we're on iOS, the user needs the install dance. Standalone
// mode + push support means we can prompt.
export function detectIosInstallNeeded() {
  const ua = navigator.userAgent || '';
  const isIos = /iPhone|iPad|iPod/.test(ua);
  if (!isIos) return false;
  // navigator.standalone is the only reliable signal on iOS Safari;
  // matchMedia('(display-mode: standalone)') has historically
  // misreported true under in-app browsers.
  const standalone = window.navigator.standalone === true;
  return !standalone || !isPushSupported();
}

export function permissionState() {
  if (!('Notification' in window)) return 'unsupported';
  return Notification.permission; // 'default' | 'granted' | 'denied'
}

export async function getCurrentSubscription() {
  if (!('serviceWorker' in navigator)) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

// Returns { keyId, key } from the server. Used both during subscribe
// and at every Settings > Notifications open to detect rotation.
async function _fetchVapid() {
  const r = await fetch('/api/push/vapid-public-key', { credentials: 'same-origin' });
  if (!r.ok) throw new Error('vapid fetch failed: ' + r.status);
  return r.json();
}

// Run on every app boot + visibilitychange. Compares the locally-cached
// keyId against what the server reports now. On mismatch, force-
// resubscribe with the new key. No UI prompt: VAPID rotation is
// invisible to the user.
export async function detectAndHandleKeyRotation() {
  if (!isPushSupported()) return;
  const stored = (() => { try { return localStorage.getItem(KEY_ID_STORAGE); } catch { return null; } })();
  if (!stored) return; // nothing subscribed yet
  let server;
  try { server = await _fetchVapid(); } catch { return; }
  if (server.keyId === stored) return;
  // Rotation: drop the old sub on the device and resubscribe.
  try {
    const reg = await navigator.serviceWorker.ready;
    const existing = await reg.pushManager.getSubscription();
    if (existing) await existing.unsubscribe();
    await _subscribeWithKey(reg, server.key);
    try { localStorage.setItem(KEY_ID_STORAGE, server.keyId); } catch {}
  } catch (e) {
    console.warn('[push] keyId rotation handler failed:', e);
  }
}

// Heartbeat: foreground re-validation that the server still has our
// sub. Called on every visibilitychange to visible and on app boot in
// standalone PWA mode. Critical for iOS PWA reinstall flows where
// permission state is wiped along with WebKit storage.
export async function heartbeat() {
  if (!isPushSupported()) return;
  let sub;
  try { sub = await getCurrentSubscription(); } catch { return; }
  if (!sub) return;
  try {
    const r = await fetch('/api/push/subscribe/heartbeat', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    });
    if (r.status === 404) {
      // Server lost our row (post-restore-from-backup, post-rotation,
      // or someone rm'd push-subscriptions.json). Resubscribe via the
      // existing pushManager subscription's keys.
      const reg = await navigator.serviceWorker.ready;
      await _resubscribeFromExisting(reg, sub);
    }
  } catch {}
}

async function _subscribeWithKey(reg, b64urlKey) {
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: _b64urlToUint8Array(b64urlKey),
  });
  await _postSubscription(sub);
  return sub;
}

async function _resubscribeFromExisting(reg, existing) {
  const json = existing.toJSON ? existing.toJSON() : {
    endpoint: existing.endpoint,
    keys: existing.keys,
  };
  await fetch('/api/push/subscribe', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }),
  });
}

async function _postSubscription(sub, nickname = null) {
  const json = sub.toJSON ? sub.toJSON() : { endpoint: sub.endpoint, keys: sub.keys };
  const r = await fetch('/api/push/subscribe', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      endpoint: json.endpoint,
      keys: json.keys,
      nickname,
    }),
  });
  if (!r.ok) throw new Error('subscribe failed: ' + r.status);
  return r.json();
}

// User-driven enable: prompt for permission, subscribe via pushManager,
// POST to /api/push/subscribe, store keyId for rotation detection.
// `nickname` is shown in Diagnostics so the operator can identify the
// device.
export async function enable({ nickname = null } = {}) {
  if (!isPushSupported()) {
    return { ok: false, reason: 'unsupported' };
  }
  if (Notification.permission === 'denied') {
    return { ok: false, reason: 'denied' };
  }
  if (Notification.permission === 'default') {
    const result = await Notification.requestPermission();
    if (result !== 'granted') return { ok: false, reason: 'declined' };
  }

  let server;
  try { server = await _fetchVapid(); }
  catch (e) { return { ok: false, reason: 'vapid-fetch-failed', error: e.message }; }

  const reg = await navigator.serviceWorker.ready;
  // If we already have a sub for a different keyId, drop it first.
  const existing = await reg.pushManager.getSubscription();
  if (existing) {
    try { await existing.unsubscribe(); } catch {}
  }

  let sub;
  try {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: _b64urlToUint8Array(server.key),
    });
  } catch (e) {
    return { ok: false, reason: 'subscribe-failed', error: e.message };
  }

  try {
    await _postSubscription(sub, nickname);
  } catch (e) {
    return { ok: false, reason: 'server-rejected', error: e.message };
  }

  try { localStorage.setItem(KEY_ID_STORAGE, server.keyId); } catch {}
  return { ok: true };
}

export async function disable() {
  if (!isPushSupported()) return { ok: true };
  let sub;
  try { sub = await getCurrentSubscription(); } catch { return { ok: true }; }
  if (sub) {
    try {
      await fetch('/api/push/unsubscribe', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: sub.endpoint }),
      });
    } catch {}
    try { await sub.unsubscribe(); } catch {}
  }
  try { localStorage.removeItem(KEY_ID_STORAGE); } catch {}
  return { ok: true };
}
