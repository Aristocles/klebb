// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// lib/user-tz.js
//
// Per-instance user preferences. Today this is just the user's IANA
// timezone, captured by the browser on each session and used by the
// scheduler so reminders fire in the user's local time, not the server's.
//
// Single-user-per-instance: this is one file, not a per-user store.
// $HEALTH_HOME/user.json, mode 0o600, atomic tmp+rename, fsynced.

const fs = require('fs');
const path = require('path');
const PATHS = require('../config/paths');

const FILE_MODE = 0o600;

// IANA timezones change rarely but Intl.supportedValuesOf is the canonical
// source. Cache the snapshot at module load to avoid the per-request cost.
const SUPPORTED_TZS = (() => {
  try {
    if (typeof Intl.supportedValuesOf === 'function') {
      return new Set(Intl.supportedValuesOf('timeZone'));
    }
  } catch {}
  return null; // Older Node: skip strict membership check, fall back to format probe.
})();

function _isValidTz(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  if (SUPPORTED_TZS) return SUPPORTED_TZS.has(tz);
  // Fallback: try to construct an Intl.DateTimeFormat - throws on invalid.
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function _readFile() {
  try {
    const raw = fs.readFileSync(PATHS.USER_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.warn(`[user-tz] could not read ${PATHS.USER_FILE}: ${e.message}`);
    }
  }
  return {};
}

function _writeFile(obj) {
  const file = PATHS.USER_FILE;
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch {}
  const tmp = file + '.tmp';
  const fd = fs.openSync(tmp, 'w', FILE_MODE);
  try {
    fs.writeSync(fd, JSON.stringify(obj, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

// Resolve the active TZ: client-supplied if known, else process.env.TZ
// (which Node already honours for Date math), else 'UTC' as a final
// safety net.
function readUserTz() {
  const stored = _readFile().tz;
  if (typeof stored === 'string' && stored) return stored;
  return process.env.TZ || 'UTC';
}

// Persist a new TZ if (a) it parses, (b) it differs from the current
// stored value. Returns { tz, changed }.
function writeUserTz(tz) {
  if (!_isValidTz(tz)) {
    const err = new Error('invalid tz');
    err.code = 'INVALID_TZ';
    throw err;
  }
  const obj = _readFile();
  if (obj.tz === tz) return { tz, changed: false };
  obj.tz = tz;
  _writeFile(obj);
  return { tz, changed: true };
}

module.exports = {
  readUserTz,
  writeUserTz,
  _isValidTz, // exposed for the API handler error mapping + tests
};
