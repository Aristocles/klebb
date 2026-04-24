#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// scripts/seed-demo.js
//
// Seed a fresh $HEALTH_HOME with a rich demo set: 15 pre-populated cards
// + 5 sample markdown reports. Opt-in manual invocation:
//
//   npm run seed:demo                    # uses $HEALTH_HOME
//   npm run seed:demo -- --dir /tmp/x    # alternate target
//   npm run seed:demo -- --force         # overwrite existing cards + reports
//   npm run seed:demo -- --dry-run       # preview, write nothing
//
// Also used by server.js on first boot (via the runFirstBootDemoSeed()
// helper in this file). That path is guarded by a .klebb-seeded sentinel
// so the seed never re-runs even if the user clears their data.
//
// Card content generated from scripts/lib/demo-cards.js; reports copied
// verbatim from data.demo/reports/.

'use strict';

const fs = require('fs');
const path = require('path');
const { generateDemoCards } = require('./lib/demo-cards');

const REPO_ROOT = path.resolve(__dirname, '..');
const REPORTS_SRC = path.join(REPO_ROOT, 'data.demo', 'reports');
const SENTINEL_NAME = '.klebb-seeded';
// Bumping this triggers a future one-shot top-up if we ever add a
// "refresh demo on new versions" flow. Today it's informational.
const SEED_VERSION = 1;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { dir: null, force: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') out.force = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--dir') out.dir = argv[++i];
    else if (a.startsWith('--dir=')) out.dir = a.slice(6);
    else if (a === '--help' || a === '-h') {
      process.stdout.write(
        'Usage: node scripts/seed-demo.js [--dir <HEALTH_HOME>] [--force] [--dry-run]\n' +
        '  Seeds 15 demo cards + 5 markdown reports into $HEALTH_HOME.\n' +
        '  Sets .klebb-seeded sentinel to prevent re-seed on future boots.\n'
      );
      process.exit(0);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Core — runDemoSeed()
// Writes cards + reports + sentinel into `healthHome`. Returns a summary.
// Safe to call from the server on first boot or from the CLI.
// ---------------------------------------------------------------------------
function runDemoSeed({ healthHome, force = false, dryRun = false, today = null, log = () => {} } = {}) {
  if (!healthHome) throw new Error('runDemoSeed: healthHome is required');

  const dataDir = path.join(healthHome, 'data');
  const reportsDir = path.join(healthHome, 'reports');
  const sentinel = path.join(healthHome, SENTINEL_NAME);

  const summary = {
    healthHome,
    cardsWritten: [],
    cardsSkipped: [],
    reportsWritten: [],
    reportsSkipped: [],
    sentinelWritten: false,
    dryRun
  };

  if (!dryRun) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(reportsDir, { recursive: true });
  }

  // --- Cards ---
  const cards = generateDemoCards({ today });
  for (const [filename, manifest] of Object.entries(cards)) {
    const dst = path.join(dataDir, filename);
    if (fs.existsSync(dst) && !force) {
      summary.cardsSkipped.push(filename);
      log(`[demo-seed] skip card: ${filename} (exists)`);
      continue;
    }
    if (!dryRun) {
      fs.writeFileSync(dst, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    }
    summary.cardsWritten.push(filename);
    log(`[demo-seed] write card: ${filename}`);
  }

  // --- Reports ---
  if (fs.existsSync(REPORTS_SRC)) {
    const reportFiles = fs.readdirSync(REPORTS_SRC).filter(f => f.endsWith('.md'));
    for (const filename of reportFiles) {
      const src = path.join(REPORTS_SRC, filename);
      const dst = path.join(reportsDir, filename);
      if (fs.existsSync(dst) && !force) {
        summary.reportsSkipped.push(filename);
        log(`[demo-seed] skip report: ${filename} (exists)`);
        continue;
      }
      if (!dryRun) {
        fs.copyFileSync(src, dst);
      }
      summary.reportsWritten.push(filename);
      log(`[demo-seed] write report: ${filename}`);
    }
  } else {
    log(`[demo-seed] reports source missing: ${REPORTS_SRC}`);
  }

  // --- Sentinel ---
  if (!dryRun) {
    const payload = {
      seededAt: new Date().toISOString(),
      seedVersion: SEED_VERSION,
      cardsWritten: summary.cardsWritten,
      reportsWritten: summary.reportsWritten
    };
    fs.writeFileSync(sentinel, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    summary.sentinelWritten = true;
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Auto-seed helper — called by server.js on boot
//
// Runs if and only if:
//   - HEALTH_HOME is set and a directory
//   - KLEBB_SKIP_DEMO_SEED is not truthy
//   - $HEALTH_HOME/.klebb-seeded does NOT exist
//   - $HEALTH_HOME/data/ is empty (or contains only dotfiles / reserved _dirs)
//
// Returns { ran, reason, summary? }. Never throws; logs and no-ops on error.
// ---------------------------------------------------------------------------
function isDataDirEmptyForSeed(dataDir) {
  if (!fs.existsSync(dataDir)) return true;
  let entries;
  try {
    entries = fs.readdirSync(dataDir);
  } catch {
    return false;
  }
  // Ignore hidden files and reserved `_`-prefixed subdirs (legacy auto-export).
  const meaningful = entries.filter(n => !n.startsWith('.') && !n.startsWith('_'));
  return meaningful.length === 0;
}

function runFirstBootDemoSeed({ healthHome, env = process.env, logger = console } = {}) {
  const log = (msg) => { try { logger.log(msg); } catch {} };
  try {
    if (!healthHome) return { ran: false, reason: 'no-health-home' };
    if (env.KLEBB_SKIP_DEMO_SEED) return { ran: false, reason: 'opt-out-env' };

    const sentinel = path.join(healthHome, SENTINEL_NAME);
    if (fs.existsSync(sentinel)) return { ran: false, reason: 'sentinel-present' };

    const dataDir = path.join(healthHome, 'data');
    if (!isDataDirEmptyForSeed(dataDir)) {
      // Write the sentinel anyway so existing installs don't get nagged
      // by this check on every boot. Their data is already theirs.
      try {
        fs.mkdirSync(healthHome, { recursive: true });
        fs.writeFileSync(sentinel, JSON.stringify({
          seededAt: new Date().toISOString(),
          seedVersion: SEED_VERSION,
          skipped: 'pre-existing-data'
        }, null, 2) + '\n', 'utf8');
      } catch (e) {
        log(`[demo-seed] note: could not write skip-sentinel: ${e.message}`);
      }
      return { ran: false, reason: 'existing-data' };
    }

    log('[demo-seed] empty install detected — seeding demo cards + reports');
    const summary = runDemoSeed({ healthHome, force: false, dryRun: false, log });
    log(`[demo-seed] wrote ${summary.cardsWritten.length} card(s), ${summary.reportsWritten.length} report(s)`);
    log('[demo-seed] set KLEBB_SKIP_DEMO_SEED=1 in your env to skip on future fresh installs');
    return { ran: true, reason: 'seeded', summary };
  } catch (e) {
    log(`[demo-seed] error during first-boot seed: ${e.message}`);
    return { ran: false, reason: 'error', error: e.message };
  }
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------
function cli() {
  const args = parseArgs(process.argv.slice(2));
  let target = args.dir;
  if (!target) {
    target = process.env.HEALTH_HOME ||
             path.join(require('os').homedir(), 'klebb');
  }
  target = path.resolve(target);

  const log = (m) => console.log(m);
  log(`Seeding demo into: ${target}`);
  if (args.dryRun) log('(dry-run — no files will be written)');
  if (args.force)  log('(force — existing files will be overwritten)');

  const summary = runDemoSeed({
    healthHome: target,
    force: args.force,
    dryRun: args.dryRun,
    log
  });

  log('');
  log(`Cards:   ${summary.cardsWritten.length} written, ${summary.cardsSkipped.length} skipped`);
  log(`Reports: ${summary.reportsWritten.length} written, ${summary.reportsSkipped.length} skipped`);
  if (summary.sentinelWritten) log(`Sentinel: wrote ${SENTINEL_NAME}`);
  if (summary.cardsSkipped.length > 0 && !args.force) {
    log('\n(Use --force to overwrite existing files.)');
  }
  if (summary.cardsWritten.length > 0 && !args.dryRun) {
    log('\nRestart the server (or refresh the page) to see the new cards.');
  }
}

if (require.main === module) {
  cli();
}

module.exports = {
  runDemoSeed,
  runFirstBootDemoSeed,
  isDataDirEmptyForSeed,
  SENTINEL_NAME,
  SEED_VERSION
};
