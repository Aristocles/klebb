#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// scripts/export-embed.js
//
// Materialise a portable copy of this instance: every card manifest is
// written to the target with its `data` block re-embedded from the
// datastore, so the exported tree round-trips into a fresh instance via
// the boot import inbox (#494). Drop the tree into a new $HEALTH_HOME,
// start the server, and every card comes back with its history.
//
// This is the blessed export path (see docs/DEPLOY.md "Backup and
// sensitive files"): it never copies credentials/, sessions/, keys/, or
// db/ (the exported card files carry the data, so the raw DB is not
// needed and a live WAL copy could be torn anyway).
//
// Target layout mirrors $HEALTH_HOME:
//   <target>/config.json   instance config, secrets stripped by default
//                          (HAE ingest token + invite codes; keep with
//                          --include-secrets)
//   <target>/data/         card files with data re-embedded, plus non-card
//                          data files (info/, auto-export/, ...) verbatim.
//                          auto-export/raw/ is skipped unless --include-raw.
//   <target>/reports/      markdown reports, verbatim
//
// A card that has never held data exports without a data key; a card whose
// stored value is null exports with `data: null`. The import inbox records
// the same distinction on re-import, so hasData parity survives the trip.
//
// Usage:
//   node scripts/export-embed.js <target-dir> [--include-secrets] [--include-raw]
//   npm run export -- <target-dir>

'use strict';

const fs = require('fs');
const path = require('path');

const BACKUP_NAME_RE = /\.json\.[^/\\]+\.json$/i;

function parseArgs(argv) {
  const args = { target: null, includeSecrets: false, includeRaw: false, help: false };
  for (const a of argv) {
    if (a === '-h' || a === '--help') args.help = true;
    else if (a === '--include-secrets') args.includeSecrets = true;
    else if (a === '--include-raw') args.includeRaw = true;
    else if (!a.startsWith('-') && !args.target) args.target = a;
    else { console.error(`error: unknown argument: ${a}`); return null; }
  }
  return args;
}

function usage() {
  console.log(`Usage: export-embed.js <target-dir> [--include-secrets] [--include-raw]

Write a portable copy of the instance to <target-dir>: card files with their
data re-embedded from the datastore, non-card data files, reports, and the
instance config. The tree round-trips into a fresh $HEALTH_HOME via the boot
import. Never copies credentials/, sessions/, keys/, or db/.

  --include-secrets  Keep the HAE ingest token and invite codes in the
                     exported config.json (stripped by default).
  --include-raw      Also copy data/auto-export/raw/ (the raw ingest archive;
                     large, skipped by default).
  --help             Show this message.`);
}

// The instance config carries two secret families: the HAE push bearer token
// (cfg.hae.*) and invite codes (cfg.auth.invites). Strip both by default; a
// portable archive should not mint access to the source instance.
function sanitiseConfig(cfg) {
  const out = JSON.parse(JSON.stringify(cfg));
  if (out.hae && typeof out.hae === 'object') {
    delete out.hae.token;
    delete out.hae.lastRegeneratedAt;
    delete out.hae.migratedFromEnvAt;
    if (Object.keys(out.hae).length === 0) delete out.hae;
  }
  if (out.auth && typeof out.auth === 'object') {
    delete out.auth.invites;
    if (Object.keys(out.auth).length === 0) delete out.auth;
  }
  return out;
}

function writeJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

// Recursive verbatim copy, skipping tmp strays and (unless included) the
// auto-export raw archive. `skipDirs` holds absolute paths to prune.
function copyTree(src, dst, skipDirs) {
  const entries = fs.readdirSync(src, { withFileTypes: true });
  fs.mkdirSync(dst, { recursive: true });
  let copied = 0;
  for (const ent of entries) {
    const from = path.join(src, ent.name);
    if (ent.isDirectory()) {
      if (skipDirs.has(from)) continue;
      copied += copyTree(from, path.join(dst, ent.name), skipDirs);
    } else if (ent.isFile()) {
      if (ent.name.endsWith('.tmp')) continue;
      fs.copyFileSync(from, path.join(dst, ent.name));
      copied += 1;
    }
  }
  return copied;
}

function classifyCard(file) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (parsed.$schema !== 'klebb.datafile.v1') return null;
  const id = parsed.meta && parsed.meta.id;
  if (!id || typeof id !== 'string') return null;
  return { id, parsed };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args) { usage(); return 2; }
  if (args.help) { usage(); return 0; }
  if (!args.target) { console.error('error: target directory required'); usage(); return 2; }

  const PATHS = require('../config/paths');
  const target = path.resolve(args.target);

  if ((target + path.sep).startsWith(PATHS.DATA_DIR + path.sep) || target === PATHS.DATA_DIR) {
    console.error(`error: target must not sit inside the data dir (${PATHS.DATA_DIR})`);
    return 2;
  }
  if (fs.existsSync(target) && fs.readdirSync(target).length > 0) {
    console.error(`error: target ${target} exists and is not empty`);
    return 2;
  }
  if (!fs.existsSync(PATHS.DATA_DIR)) {
    console.error(`error: no data dir at ${PATHS.DATA_DIR}`);
    return 2;
  }

  // Read-only view of the datastore. A missing DB is a valid state (fresh or
  // pre-migration instance): every card then exports with whatever its file
  // already carries. Never let the export create db/ as a side effect.
  let store = null;
  if (fs.existsSync(PATHS.DB_FILE)) {
    const { open } = require('../lib/datastore');
    store = open(PATHS.DB_FILE);
    store.load();
  }

  const outData = path.join(target, 'data');
  fs.mkdirSync(outData, { recursive: true });

  const counts = { embedded: 0, inline: 0, noData: 0, filesCopied: 0 };
  const skipDirs = new Set();
  if (!args.includeRaw) skipDirs.add(path.join(PATHS.AUTO_EXPORT_DIR, 'raw'));

  for (const ent of fs.readdirSync(PATHS.DATA_DIR, { withFileTypes: true })) {
    const from = path.join(PATHS.DATA_DIR, ent.name);
    if (ent.isDirectory()) {
      if (skipDirs.has(from)) continue;
      counts.filesCopied += copyTree(from, path.join(outData, ent.name), skipDirs);
      continue;
    }
    if (!ent.isFile() || ent.name.endsWith('.tmp')) continue;
    if (BACKUP_NAME_RE.test(ent.name)) continue;

    const card = ent.name.endsWith('.json') ? classifyCard(from) : null;
    if (!card) {
      fs.copyFileSync(from, path.join(outData, ent.name));
      counts.filesCopied += 1;
      continue;
    }

    const envelope = card.parsed;
    if (Object.prototype.hasOwnProperty.call(envelope, 'data')) {
      // Not yet imported (pre-migration file or hand-added block): the file
      // already carries its data. Export it as-is.
      counts.inline += 1;
    } else if (store && store.dataUpdatedAt(card.id) !== null) {
      // A stored record exists; null is a real recorded value here, distinct
      // from "never held data", and must round-trip as data: null.
      envelope.data = store.getData(card.id);
      counts.embedded += 1;
    } else {
      counts.noData += 1;
    }
    writeJSON(path.join(outData, ent.name), envelope);
  }

  if (fs.existsSync(PATHS.CONFIG_PATH)) {
    let cfg = null;
    try {
      cfg = JSON.parse(fs.readFileSync(PATHS.CONFIG_PATH, 'utf8'));
    } catch (e) {
      console.warn(`  ! config.json unreadable, not exported: ${e.message}`);
    }
    if (cfg && typeof cfg === 'object') {
      writeJSON(path.join(target, 'config.json'), args.includeSecrets ? cfg : sanitiseConfig(cfg));
    }
  }

  if (fs.existsSync(PATHS.REPORTS_DIR)) {
    counts.filesCopied += copyTree(PATHS.REPORTS_DIR, path.join(target, 'reports'), skipDirs);
  }

  if (store) store.close();

  const cards = counts.embedded + counts.inline + counts.noData;
  console.log(`Exported ${cards} card(s) to ${target}`);
  console.log(`  data embedded from store: ${counts.embedded}`);
  console.log(`  data already inline:      ${counts.inline}`);
  console.log(`  no data (key omitted):    ${counts.noData}`);
  console.log(`  other files copied:       ${counts.filesCopied}`);
  console.log(`  secrets: ${args.includeSecrets ? 'INCLUDED (--include-secrets)' : 'stripped from config.json'}`);
  console.log(`  auto-export/raw: ${args.includeRaw ? 'included (--include-raw)' : 'skipped'}`);
  return 0;
}

if (require.main === module) {
  process.exit(main());
} else {
  module.exports = { sanitiseConfig };
}
