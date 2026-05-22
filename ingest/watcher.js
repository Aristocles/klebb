// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// ingest/watcher.js
// fs.watch + 250ms debounce over the inbox dir. Mirrors the manifest
// registry's watcher shape (manifests/registry.js).

const fs = require('fs');

const DEBOUNCE_MS = 250;

function start({ inboxDir, onChange }) {
  let timer = null;
  let watcher = null;
  const fire = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      try { onChange(); } catch (e) { console.warn('[ingest] onChange threw:', e.message); }
    }, DEBOUNCE_MS);
  };
  try {
    watcher = fs.watch(inboxDir, { persistent: false }, fire);
  } catch (e) {
    console.warn('[ingest] fs.watch unavailable:', e.message);
  }
  return {
    stop() {
      if (timer) { clearTimeout(timer); timer = null; }
      if (watcher) { try { watcher.close(); } catch {} watcher = null; }
    },
  };
}

module.exports = { start, DEBOUNCE_MS };
