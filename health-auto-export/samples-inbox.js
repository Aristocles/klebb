// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// health-auto-export/samples-inbox.js
//
// One-way import inbox for HAE push history, at
// $HEALTH_HOME/data/auto-export/samples.json.
//
// Mirrors the card-data import inbox (lib/datastore/import.js): a file found on
// disk is imported into the database and then renamed aside, so the file is a
// door in rather than a second source of truth. It exists because
// scripts/export-embed.js writes the sample history as a file (db/ is never
// staged into an export), and a restored tree has to come back with its HAE
// history intact.
//
// Imports are idempotent by content: recordPush() dedupes on the sample hash,
// so a re-import of the same tree adds no samples. The file is still renamed,
// because leaving it would re-walk it on every boot for no gain.

'use strict';

const fs = require('fs');
const path = require('path');
const PATHS = require('../config/paths');
const samples = require('./samples');
const { streamPushes } = require('./samples-stream');

const FILE = path.join(PATHS.AUTO_EXPORT_DIR, 'samples.json');

// Yield to the event loop every this many elements. The streamer's chunk
// reads only settle between chunks, and a 64 KB chunk can hold hundreds of
// small pushes; without a real macrotask yield a live server could not
// answer /healthz during a long drain (#632).
const YIELD_EVERY = 20;

// Import and rename aside. Returns null when there is nothing to do, else
// { pushes, inserted, backup }.
//
// Async since #632: the file is streamed one push at a time (peak memory is
// one push, never the file; a real restore's samples.json blew a small
// container's heap at whole-file JSON.parse), with an event-loop yield
// between batches so a live server keeps breathing.
async function drain() {
  if (!fs.existsSync(FILE)) return null;

  let pushes = 0;
  let inserted = 0;
  let seen = 0;
  const it = streamPushes(FILE);
  for (;;) {
    let next;
    try {
      next = await it.next();
    } catch (e) {
      if (e && e.code === 'SAMPLES_STREAM_NO_PUSHES') {
        throw new Error('samples.json has no pushes[] array');
      }
      // Renamed with a distinct suffix rather than left in place: a file that
      // will never parse would otherwise log the same failure on every boot.
      // Pushes imported before the bad element stay imported; the content
      // dedupe makes a later re-import of the repaired file add nothing twice.
      const bad = `${FILE}.unreadable-${Date.now()}`;
      try { fs.renameSync(FILE, bad); } catch {}
      throw new Error(`samples.json is not valid JSON (moved to ${path.basename(bad)}): ${e.message}`);
    }
    if (next.done) break;
    // Outside the try above on purpose: a datastore failure must propagate
    // untouched, not masquerade as an unreadable file.
    const r = samples.importPush(next.value);
    if (r) {
      pushes += 1;
      inserted += r.inserted;
    }
    seen += 1;
    if (seen % YIELD_EVERY === 0) {
      await new Promise(resolve => setImmediate(resolve));
    }
  }

  const result = { pushes, inserted };

  // Keep the file as a backup beside the inbox slot, matching the card import
  // inbox's `.pre-import-<ts>` convention: an operator who dropped it in by
  // hand can still see what was imported.
  const backup = `${FILE}.imported-${new Date().toISOString().replace(/[:.]/g, '')}`;
  try {
    fs.renameSync(FILE, backup);
  } catch (e) {
    console.warn('[hae] samples.json imported but could not be renamed:', e.message);
  }

  return { ...result, backup: path.basename(backup) };
}

module.exports = { drain, FILE };
