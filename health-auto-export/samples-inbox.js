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

const FILE = path.join(PATHS.AUTO_EXPORT_DIR, 'samples.json');

// Import and rename aside. Returns null when there is nothing to do, else
// { pushes, inserted, backup }.
function drain() {
  if (!fs.existsSync(FILE)) return null;

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (e) {
    // Renamed with a distinct suffix rather than left in place: a file that
    // will never parse would otherwise log the same failure on every boot.
    const bad = `${FILE}.unreadable-${Date.now()}`;
    try { fs.renameSync(FILE, bad); } catch {}
    throw new Error(`samples.json is not valid JSON (moved to ${path.basename(bad)}): ${e.message}`);
  }

  const list = Array.isArray(parsed) ? parsed : parsed?.pushes;
  if (!Array.isArray(list)) {
    throw new Error('samples.json has no pushes[] array');
  }

  const result = samples.importPushes(list);

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
