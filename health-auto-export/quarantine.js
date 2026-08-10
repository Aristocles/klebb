// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// health-auto-export/quarantine.js
//
// Holds the raw bytes of pushes that would not parse, at
// $HEALTH_HOME/data/auto-export/unparsed/.
//
// The samples table stores parsed samples, so it cannot hold a payload that
// isn't JSON, and the endpoint deliberately answers 200 on a parse failure to
// stop the phone's retry loop spiralling. Without the bytes there would be
// nothing at all to look at afterwards, which is the one case the old
// archive-everything behaviour genuinely earned its keep.
//
// Bounded on purpose: KEEP most recent files, oldest pruned on write. A parse
// failure means a payload shape change or a truncated upload, and the newest
// few are all anyone reads. Unbounded is how the raw archive reached 404 MB.

'use strict';

const fs = require('fs');
const path = require('path');
const PATHS = require('../config/paths');

const DIR = path.join(PATHS.AUTO_EXPORT_DIR, 'unparsed');
const KEEP = 5;
// A body big enough to be pathological is not worth keeping whole; the first
// megabyte carries the shape and the truncation point.
const MAX_BYTES = 1024 * 1024;

function _prune() {
  let names;
  try {
    names = fs.readdirSync(DIR).filter(f => f.endsWith('.json')).sort();
  } catch {
    return;
  }
  while (names.length > KEEP) {
    const victim = names.shift();
    try { fs.unlinkSync(path.join(DIR, victim)); } catch {}
  }
}

// Write one unparseable body. Returns the filename, or null on failure:
// callers report which happened rather than claiming a copy was kept.
function write(body) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '');
    const name = `${stamp}.json`;
    const file = path.join(DIR, name);
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, bytes.subarray(0, MAX_BYTES));
    fs.renameSync(tmp, file);
    _prune();
    return name;
  } catch (e) {
    console.error('[hae] failed to quarantine unparseable payload:', e.message);
    return null;
  }
}

function list() {
  try {
    return fs.readdirSync(DIR).filter(f => f.endsWith('.json')).sort();
  } catch {
    return [];
  }
}

module.exports = { write, list, DIR, KEEP, MAX_BYTES };
