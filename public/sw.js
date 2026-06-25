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

const VERSION = 'klebb-sw-v3';
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

  // Persist deep-link intent BEFORE showNotification so a cold-start
  // launch on iOS (which can strip query strings off openWindow URLs)
  // can read the intent on app boot. Reminder groups ride along so the
  // tap-response modal can render straight from the SW data without
  // re-fetching the card.
  const primary = items[0];
  const reminders = _mergeReminderGroups(items);
  const stash = {
    ts: Date.now(),
    url: primary.url || '/',
    cardId: primary.cardId || null,
  };
  if (reminders) stash.reminders = reminders;
  await idbPutDeepLink(stash);

  // Best-effort: tell every visible client about the incoming push so a
  // future in-app toast layer can render an inline notification. This
  // is purely additive - the OS notification still fires, so the user
  // sees the banner whether they're focused on the app or not. If we
  // skipped showNotification while a tab was visible, foreground-test
  // pushes would silently disappear and the user would have no way to
  // verify the feature worked.
  const visibleClients = (await self.clients.matchAll({
    type: 'window',
    includeUncontrolled: true,
  })).filter(c => c.visibilityState === 'visible');
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

  await self.registration.showNotification(_displayTitle(payload), {
    body: _displayBody(payload),
    tag: primary.tag || VERSION,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { url: primary.url || '/', cardId: primary.cardId || null, reminders },
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

// Collapse per-item reminders into one array of source-card groups.
// Returns null when no item carries any due_now / missed_earlier rows
// (daily/weekly triggers, or schedule_due with nothing actually due).
function _mergeReminderGroups(items) {
  const groups = [];
  for (const i of items) {
    const r = i && i.reminders;
    if (!r) continue;
    const due = Array.isArray(r.due_now) ? r.due_now : [];
    const miss = Array.isArray(r.missed_earlier) ? r.missed_earlier : [];
    if (due.length === 0 && miss.length === 0) continue;
    groups.push({
      cardId: i.cardId || null,
      cardLabel: i.cardLabel || null,
      cardEmoji: i.cardEmoji || null,
      due_now: due,
      missed_earlier: miss,
    });
  }
  return groups.length ? groups : null;
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

  // Pass an absolute URL to clients.openWindow / WindowClient.navigate.
  // Some browsers (notably Edge on Windows when the click comes from
  // Action Center after the SW has been idle) treat a relative path
  // as an opaque address-bar string and trigger the default search
  // engine; an absolute same-origin URL is unambiguous.
  const absoluteTarget = self.location.origin + target;

  const allClients = await self.clients.matchAll({
    type: 'window',
    includeUncontrolled: true,
  });
  for (const c of allClients) {
    let sameOrigin = false;
    try {
      sameOrigin = new URL(c.url).origin === self.location.origin;
    } catch {}
    if (!sameOrigin) continue;

    // postMessage so the SPA can do a soft route change. The page's
    // listener may not always fire (Edge on Windows can deliver these
    // with event.source === null and a strict source check would drop
    // them), so we ALSO call WindowClient.navigate() as the robust
    // path: a real navigation that always lands the tab on the
    // intended URL.
    try {
      c.postMessage({
        type: 'klebb-deep-link',
        url: target,
        reminders: data.reminders || null,
      });
    } catch {}
    try {
      if (typeof c.navigate === 'function') {
        await c.navigate(absoluteTarget);
      }
    } catch {}
    return c.focus();
  }
  return self.clients.openWindow(absoluteTarget);
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
