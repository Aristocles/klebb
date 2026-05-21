// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// scripts/reset-demo.js
//
// Wipes $HEALTH_HOME/data/ for the public demo and restores the
// curated dataset from demo/fixtures/. Resolves `__OFFSET_DAYS:N__`
// placeholders against today so the dashboard always looks current.
//
// Refuses to run unless KLEBB_DEMO=1: never invoke this against a
// real instance.

const fs = require('fs');
const path = require('path');

const PATHS = require('../config/paths');

const FIXTURES_DIR = path.join(__dirname, '..', 'demo', 'fixtures');
const REPORTS_FIXTURES_DIR = path.join(FIXTURES_DIR, 'reports');

// Match __OFFSET_DAYS:N__ or __OFFSET_DAYS_N__ where N is a signed
// integer. The underscore form is needed in filenames on Windows since
// `:` is not a legal NTFS character.
const OFFSET_RE = /__OFFSET_DAYS[:_](-?\d+)__/g;

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

function listReportFixtures(dir = REPORTS_FIXTURES_DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.md'))
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

function wipeReportsDir(reportsDir) {
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
    return [];
  }
  const removed = [];
  for (const entry of fs.readdirSync(reportsDir)) {
    const full = path.join(reportsDir, entry);
    const stat = fs.statSync(full);
    if (stat.isFile() && entry.endsWith('.md')) {
      fs.unlinkSync(full);
      removed.push(entry);
    }
  }
  return removed;
}

function copyReportFixtures({ reportsDir, fixturesDir = REPORTS_FIXTURES_DIR, today = new Date() } = {}) {
  fs.mkdirSync(reportsDir, { recursive: true });
  const written = [];
  for (const src of listReportFixtures(fixturesDir)) {
    const raw = fs.readFileSync(src, 'utf8');
    const resolved = rewritePlaceholders(raw, today);
    // Resolve the placeholder in the filename too so reports show up as
    // e.g. BLOODS-2026-04-21.md rather than the literal placeholder.
    const destName = rewritePlaceholders(path.basename(src), today);
    const dest = path.join(reportsDir, destName);
    fs.writeFileSync(dest, resolved);
    written.push(destName);
  }
  return written;
}

function resolveReportsDir() {
  // Mirror config/paths.js logic but without filesystem-existence shortcuts:
  // the demo always writes to the canonical $HEALTH_HOME/reports/ unless
  // overridden by HEALTH_REPORTS_DIR. We can't `require('../config/paths')`
  // for this because that module memoises on first import and would yield
  // stale paths if HEALTH_HOME changed in-process (test fixtures do this).
  if (process.env.HEALTH_REPORTS_DIR) return process.env.HEALTH_REPORTS_DIR;
  const home = process.env.HEALTH_HOME && process.env.HEALTH_HOME.trim()
    ? path.resolve(process.env.HEALTH_HOME)
    : PATHS.HEALTH_HOME;
  return path.join(home, 'reports');
}

function resetDemo({
  dataDir = PATHS.DATA_DIR,
  reportsDir = resolveReportsDir(),
  fixturesDir = FIXTURES_DIR,
  reportsFixturesDir = REPORTS_FIXTURES_DIR,
  today = new Date(),
} = {}) {
  if (process.env.KLEBB_DEMO !== '1') {
    throw new Error('reset-demo refuses to run without KLEBB_DEMO=1');
  }
  const removed = wipeDataDir(dataDir);
  const written = copyFixtures({ dataDir, fixturesDir, today });
  const reportsRemoved = wipeReportsDir(reportsDir);
  const reportsWritten = copyReportFixtures({ reportsDir, fixturesDir: reportsFixturesDir, today });
  return { dataDir, removed, written, reportsDir, reportsRemoved, reportsWritten };
}

if (require.main === module) {
  try {
    const result = resetDemo();
    console.log(`[reset-demo] data dir: ${result.dataDir}`);
    if (result.removed.length) {
      console.log(`[reset-demo] removed ${result.removed.length} existing data file(s)`);
    }
    for (const name of result.written) {
      console.log(`[reset-demo] restored ${name}`);
    }
    console.log(`[reset-demo] reports dir: ${result.reportsDir}`);
    if (result.reportsRemoved.length) {
      console.log(`[reset-demo] removed ${result.reportsRemoved.length} existing report(s)`);
    }
    for (const name of result.reportsWritten) {
      console.log(`[reset-demo] restored report ${name}`);
    }
    console.log(`[reset-demo] done: ${result.written.length} fixture(s) and ${result.reportsWritten.length} report(s) restored`);
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
  listReportFixtures,
  wipeDataDir,
  wipeReportsDir,
  copyFixtures,
  copyReportFixtures,
  FIXTURES_DIR,
  REPORTS_FIXTURES_DIR,
};
