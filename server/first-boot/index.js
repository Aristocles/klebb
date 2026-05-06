// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// server/first-boot/index.js
// On server start, if HEALTH_HOME/data/ contains zero manifests, copy the
// welcome card fixture into data/welcome.klebb.json. No sentinel file; the
// check is "is data empty" not "have we ever seeded". A user who deletes
// the welcome card will not have it re-created, because by then their
// data/ directory holds other manifests.

const fs = require('fs');
const path = require('path');

const WELCOME_FIXTURE = path.join(__dirname, 'welcome.klebb.json');
const WELCOME_FILENAME = 'welcome.klebb.json';

// Returns true if the data directory has no manifest files (anything ending
// in .json). Files starting with '.' are ignored.
function isDataDirEmpty(dataDir) {
  let entries;
  try {
    entries = fs.readdirSync(dataDir, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return true;
    throw e;
  }
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    if (ent.name.startsWith('.')) continue;
    if (ent.name.endsWith('.json')) return false;
  }
  return true;
}

function runFirstBoot({ dataDir, log = console.log } = {}) {
  if (!dataDir) throw new Error('dataDir required');
  try {
    fs.mkdirSync(dataDir, { recursive: true });
  } catch {}
  if (!isDataDirEmpty(dataDir)) {
    return { ran: false, reason: 'data-not-empty' };
  }
  const target = path.join(dataDir, WELCOME_FILENAME);
  if (fs.existsSync(target)) {
    return { ran: false, reason: 'welcome-already-exists' };
  }
  const source = fs.readFileSync(WELCOME_FIXTURE, 'utf8');
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, source);
  fs.renameSync(tmp, target);
  log('[first-boot] wrote welcome card to', target);
  return { ran: true, reason: 'seeded', target };
}

module.exports = { runFirstBoot, isDataDirEmpty, WELCOME_FILENAME };
