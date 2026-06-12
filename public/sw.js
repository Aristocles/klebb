// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// public/sw.js
//
// Klebb service worker. Scope: /. Registered from app.js on first load.
//
// Responsibilities:
//   - Receive Web Push events and surface them as system notifications.
//   - Substitute real title/body for `private` notifications (the wire
//     payload only carried generic text; the real strings ride alongside
//     in realTitle / realBody and are decrypted on-device).
//   - On notificationclick, focus the app or open a same-origin deep link.
//   - Persist deep-link intent in IndexedDB BEFORE showNotification, so a
//     cold-start launch on iOS (which may strip query strings) can read
//     the intent on boot.
//   - Foreground branch: if a Klebb tab is already visible, post a message
//     instead of showing a banner (avoids iOS suppressing the
//     showNotification call when the app is in the foreground anyway).

const VERSION = 'klebb-sw-v2';
const IDB_NAME = 'klebb-sw';
const IDB_STORE = 'deep-links';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  event.waitUntil(handlePush(event));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(handleNotificationClick(event));
});

self.addEventListener('pushsubscriptionchange', (event) => {
  // Best-effort: re-fetch the public key, resubscribe, and POST. A 404
  // here is fine; the foreground heartbeat path will catch it on the
  // next visibilitychange and re-subscribe with proper UX.
  event.waitUntil((async () => {
    try {
      const r = await fetch('/api/push/vapid-public-key', { credentials: 'same-origin' });
      if (!r.ok) return;
      const { key } = await r.json();
      const sub = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: b64urlToUint8Array(key),
      });
      await fetch('/api/push/subscribe', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sub.toJSON()),
      });
    } catch {}
  })());
});

async function handlePush(event) {
  let payload = {};
  try {
    if (event.data) payload = event.data.json();
  } catch {
    payload = {};
  }

  // Single-item or coalesced; either way render one OS notification per
  // push event (coalesced gets a count summary).
  const items = Array.isArray(payload.items) ? payload.items : [];
  if (items.length === 0) {
    await self.registration.showNotification('Klebb', {
      body: 'You have a reminder.',
      tag: VERSION,
      icon: '/icons/icon-192.png',
      renotify: true,
    });
    return;
  }

  // Foreground branch: if a Klebb tab is open and visible, post a
  // message instead of (or in addition to) the banner. iOS suppresses
  // banner display when the app is in the foreground, so showing only
  // the toast keeps the budget intact.
  const visibleClients = (await self.clients.matchAll({
    type: 'window',
    includeUncontrolled: true,
  })).filter(c => c.visibilityState === 'visible');

  // Persist deep-link intent BEFORE showNotification so a cold-start
  // launch on iOS (which can strip query strings off openWindow URLs)
  // can read the intent on app boot.
  const primary = items[0];
  await idbPutDeepLink({
    ts: Date.now(),
    url: primary.url || '/',
    cardId: primary.cardId || null,
  });

  if (visibleClients.length > 0) {
    for (const c of visibleClients) {
      try {
        c.postMessage({
          type: 'klebb-foreground-notification',
          title: _displayTitle(payload),
          body: _displayBody(payload),
          items,
        });
      } catch {}
    }
    // Skip showNotification entirely when foreground is open - iOS
    // would suppress it anyway and APNs would count that as a budget
    // violation.
    return;
  }

  await self.registration.showNotification(_displayTitle(payload), {
    body: _displayBody(payload),
    tag: primary.tag || VERSION,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { url: primary.url || '/', cardId: primary.cardId || null },
    renotify: true,
    requireInteraction: false,
  });
}

function _displayTitle(payload) {
  const items = payload.items;
  if (payload.type === 'coalesced' && items.length > 1) {
    return 'Klebb';
  }
  const it = items[0];
  return it.realTitle || it.title || 'Klebb';
}

function _displayBody(payload) {
  const items = payload.items;
  if (payload.type === 'coalesced' && items.length > 1) {
    return `${items.length} reminders for now: ` + items.map(i => i.cardLabel || i.title).join(', ');
  }
  const it = items[0];
  return it.realBody || it.body || 'You have a reminder.';
}

async function handleNotificationClick(event) {
  const data = event.notification.data || {};
  // Same-origin guard: payload-supplied URLs MUST not redirect off-origin.
  let target = '/';
  try {
    const raw = data.url;
    if (raw) {
      const u = new URL(raw, self.location.origin);
      if (u.origin === self.location.origin) {
        target = u.pathname + u.search + u.hash;
      }
    }
  } catch {}

  const allClients = await self.clients.matchAll({
    type: 'window',
    includeUncontrolled: true,
  });
  for (const c of allClients) {
    try {
      if (new URL(c.url).origin === self.location.origin) {
        c.postMessage({ type: 'klebb-deep-link', url: target });
        return c.focus();
      }
    } catch {}
  }
  return self.clients.openWindow(target);
}

// Tiny IndexedDB helper, no library. One object store keyed by 'pending'
// (we only ever care about the single most recent deep-link).
function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPutDeepLink(value) {
  try {
    const db = await idbOpen();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(value, 'pending');
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {}
}

function b64urlToUint8Array(b64) {
  const padding = '='.repeat((4 - (b64.length % 4)) % 4);
  const base64 = (b64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
