// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// public/sw.js
//
// Klebb service worker. Scope: /. The PWA shell registers it once on app
// load; this file's only job in v3.0.0 is to be present so push events
// can be delivered when the notifications feature lands.
//
// No fetch listener: browsers handle navigation efficiently without one,
// and an empty fetch handler is a known performance footgun.
// No precache: offline shell is not in v3.0.0 scope.

const VERSION = 'klebb-sw-v1';

self.addEventListener('install', (event) => {
  // New SW takes over without waiting for old tabs to close. Safe because
  // there is no offline cache to invalidate; updates are picked up on the
  // next visibilitychange.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Take control of clients without requiring a reload. event.waitUntil
  // ensures iOS doesn't terminate the SW before claim() resolves.
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  // Stub. The notifications PR (#387) replaces the body with a real
  // payload parser + showNotification() call. event.waitUntil is
  // mandatory on iOS PWAs: the SW is killed within seconds of an event
  // resolving, so any async work must keep the event alive.
  event.waitUntil((async () => {
    let payload = {};
    try {
      if (event.data) payload = event.data.json();
    } catch {
      payload = {};
    }
    const title = payload.title || 'Klebb';
    const body = payload.body || 'You have a reminder.';
    await self.registration.showNotification(title, {
      body,
      tag: payload.tag || VERSION,
      data: { url: payload.url || '/' },
      icon: '/icons/icon-192.png',
      renotify: true,
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    // Same-origin guard: payload-supplied URLs must not redirect off-origin.
    let target = '/';
    try {
      const raw = event.notification.data && event.notification.data.url;
      if (raw) {
        const u = new URL(raw, self.location.origin);
        if (u.origin === self.location.origin) target = u.pathname + u.search + u.hash;
      }
    } catch {}

    const allClients = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true,
    });
    for (const c of allClients) {
      if (c.url && new URL(c.url).origin === self.location.origin) {
        c.postMessage({ type: 'klebb-deep-link', url: target });
        return c.focus();
      }
    }
    return self.clients.openWindow(target);
  })());
});

self.addEventListener('pushsubscriptionchange', (event) => {
  // Stub: the notifications PR (#387) handles real resubscription.
  // For now, log only — there is no /api/push/subscribe yet, so attempting
  // to POST here would just 404 and log noise.
  event.waitUntil(Promise.resolve());
});
