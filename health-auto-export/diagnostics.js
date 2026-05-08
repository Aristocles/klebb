// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// health-auto-export/diagnostics.js
//
// Reads and writes $HEALTH_HOME/data/auto-export/last-push.json, a
// single-snapshot diagnostic describing what the most recent HAE
// webhook did. Overwritten on every push; the raw archive remains the
// audit log.

const fs = require('fs');
const path = require('path');
const PATHS = require('../config/paths');

const FILE = path.join(PATHS.AUTO_EXPORT_DIR, 'last-push.json');

function writeLastPush(snapshot) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2));
    fs.renameSync(tmp, FILE);
  } catch (e) {
    console.error('[hae] failed to write last-push diagnostic:', e.message);
  }
}

function readLastPush() {
  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

module.exports = { writeLastPush, readLastPush, FILE };
