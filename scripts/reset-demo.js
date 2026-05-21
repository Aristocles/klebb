// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// scripts/reset-demo.js
//
// Wipes $HEALTH_HOME/data/ for the public demo and restores the
// curated dataset from demo/fixtures/. Resolves `__OFFSET_DAYS:N__`
// placeholders against today so the dashboard always looks current.
//
// Refuses to run unless KLEBB_DEMO=1 — never invoke this against a
// real instance.

const fs = require('fs');
const path = require('path');

const PATHS = require('../config/paths');

const FIXTURES_DIR = path.join(__dirname, '..', 'demo', 'fixtures');

// Match __OFFSET_DAYS:N__ where N is a signed integer.
const OFFSET_RE = /__OFFSET_DAYS:(-?\d+)__/g;

function pad(n) { return n.toString().padStart(2, '0'); }

function isoDateNDaysFromToday(offset, today = new Date()) {
  const d = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function rewritePlaceholders(text, today = new Date()) {
  return text.replace(OFFSET_RE, (_, n) => isoDateNDaysFromToday(parseInt(n, 10), today));
}

function listFixtures(dir = FIXTURES_DIR) {
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => path.join(dir, f));
}

function wipeDataDir(dataDir) {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
    return [];
  }
  const removed = [];
  for (const entry of fs.readdirSync(dataDir)) {
    const full = path.join(dataDir, entry);
    const stat = fs.statSync(full);
    if (stat.isFile() && entry.endsWith('.json')) {
      fs.unlinkSync(full);
      removed.push(entry);
    }
  }
  return removed;
}

function copyFixtures({ dataDir, fixturesDir = FIXTURES_DIR, today = new Date() } = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const written = [];
  for (const src of listFixtures(fixturesDir)) {
    const raw = fs.readFileSync(src, 'utf8');
    const resolved = rewritePlaceholders(raw, today);
    // Validate the result parses; better to fail loudly than ship a broken
    // demo dataset to disk.
    JSON.parse(resolved);
    const dest = path.join(dataDir, path.basename(src));
    fs.writeFileSync(dest, resolved);
    written.push(path.basename(src));
  }
  return written;
}

function resetDemo({ dataDir = PATHS.DATA_DIR, fixturesDir = FIXTURES_DIR, today = new Date() } = {}) {
  if (process.env.KLEBB_DEMO !== '1') {
    throw new Error('reset-demo refuses to run without KLEBB_DEMO=1');
  }
  const removed = wipeDataDir(dataDir);
  const written = copyFixtures({ dataDir, fixturesDir, today });
  return { dataDir, removed, written };
}

if (require.main === module) {
  try {
    const result = resetDemo();
    console.log(`[reset-demo] data dir: ${result.dataDir}`);
    if (result.removed.length) {
      console.log(`[reset-demo] removed ${result.removed.length} existing file(s)`);
    }
    for (const name of result.written) {
      console.log(`[reset-demo] restored ${name}`);
    }
    console.log(`[reset-demo] done — ${result.written.length} fixture(s) restored`);
    process.exit(0);
  } catch (e) {
    console.error(`[reset-demo] ${e.message}`);
    process.exit(1);
  }
}

module.exports = {
  resetDemo,
  rewritePlaceholders,
  isoDateNDaysFromToday,
  listFixtures,
  wipeDataDir,
  copyFixtures,
  FIXTURES_DIR,
};
