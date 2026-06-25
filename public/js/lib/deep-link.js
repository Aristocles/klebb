// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// public/js/lib/deep-link.js
//
// On cold-start launches from a notification click (especially on iOS
// PWAs where clients.openWindow can strip the query string), the SW
// has stashed the pending deep-link intent in IndexedDB. This module
// reads-and-clears that intent on app boot and dispatches a
// 'klebb-deep-link' event the app shell already knows how to handle.
//
// Stashed shape:
//   {
//     ts:   number               // ms since epoch; >5min entries are dropped
//     url:  string               // same-origin path the SPA should route to
//     cardId?: string | null     // primary card extracted from the payload
//     reminders?: Array<{
//       cardId, cardLabel, cardEmoji,
//       due_now: Array<{name, short_name}>,
//       missed_earlier: Array<{name, short_name}>,
//     }> | null                  // schedule_due carry-forward for the modal
//   }

const IDB_NAME = 'klebb-sw';
const IDB_STORE = 'deep-links';

function _openDb() {
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

export async function consumePendingDeepLink() {
  if (!('indexedDB' in window)) return null;
  try {
    const db = await _openDb();
    const value = await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      const store = tx.objectStore(IDB_STORE);
      const get = store.get('pending');
      get.onsuccess = () => {
        const v = get.result;
        store.delete('pending');
        tx.oncomplete = () => resolve(v || null);
        tx.onerror = () => reject(tx.error);
      };
      get.onerror = () => reject(get.error);
    });
    db.close();
    if (value && value.url) {
      // Discard intents older than 5 minutes - the user almost
      // certainly didn't tap a notification from yesterday.
      if (typeof value.ts === 'number' && Date.now() - value.ts > 5 * 60 * 1000) {
        return null;
      }
      return value;
    }
  } catch {}
  return null;
}
