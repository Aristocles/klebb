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
//                          data files (info/, auto-export/, ...) verbatim,
//                          including auto-export/samples.json: the HAE push
//                          history rebuilt from the samples table (#546), which
//                          cannot ride in db/ because db/ is never staged.
//   <target>/reports/      markdown reports, verbatim
//   <target>/klebb-export.json  provenance manifest over everything above,
//                          written last (contract in docs/EXPORT-FORMAT.md)
//
// A card that has never held data exports without a data key; a card whose
// stored value is null exports with `data: null`. The import inbox records
// the same distinction on re-import, so hasData parity survives the trip.
//
// Usage:
//   node scripts/export-embed.js <target-dir> [--include-secrets]
//   npm run export -- <target-dir>

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { decompose } = require('../lib/datastore/shape');
const { rawArchiveDirs } = require('../health-auto-export/raw-archives');

const BACKUP_NAME_RE = /\.json\.[^/\\]+\.json$/i;
const MANIFEST_NAME = 'klebb-export.json';

function parseArgs(argv) {
  const args = { target: null, includeSecrets: false, help: false };
  for (const a of argv) {
    if (a === '-h' || a === '--help') args.help = true;
    else if (a === '--include-secrets') args.includeSecrets = true;
    // --include-raw referred to the raw file archive, which no longer exists
    // (#546). Accepted and ignored so an existing invocation does not fail.
    else if (a === '--include-raw') continue;
    else if (!a.startsWith('-') && !args.target) args.target = a;
    else { console.error(`error: unknown argument: ${a}`); return null; }
  }
  return args;
}

function usage() {
  console.log(`Usage: export-embed.js <target-dir> [--include-secrets]

Write a portable copy of the instance to <target-dir>: card files with their
data re-embedded from the datastore, non-card data files, reports, and the
instance config. The tree round-trips into a fresh $HEALTH_HOME via the boot
import. Never copies credentials/, sessions/, keys/, or db/.

  --include-secrets  Keep the HAE ingest token and invite codes in the
                     exported config.json (stripped by default).
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

// Chunked on purpose: samples.json can be bigger than a small container's
// heap, and the export path must not re-materialise what it just streamed
// out (#655).
function sha256(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(1024 * 1024);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      hash.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

// Write {version:1, pushes:[...]} from an iterator, one push at a time,
// byte-identical to what writeJSON produced from the whole array (#655).
// Returns the push count; writes nothing (not even the directory) when the
// iterator is empty, matching the old "no pushes, no file" behaviour.
function writeSamplesFile(file, iter) {
  const first = iter.next();
  if (first.done) return 0;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'w');
  let n = 0;
  try {
    fs.writeSync(fd, '{\n  "version": 1,\n  "pushes": [\n');
    for (let cur = first; !cur.done; cur = iter.next()) {
      const text = JSON.stringify(cur.value, null, 2).split('\n').map(l => `    ${l}`).join('\n');
      fs.writeSync(fd, (n ? ',\n' : '') + text);
      n += 1;
    }
    fs.writeSync(fd, '\n  ]\n}');
  } finally {
    fs.closeSync(fd);
  }
  return n;
}

// Manifest row count via the datastore's own decomposition: the sum of the
// container row lengths. A doc, null, or absent value has no rows, and a doc's
// single __doc__ row deliberately counts as none.
function countRows(value) {
  const { shape, containers } = decompose(value);
  if (shape.kind !== 'array' && shape.kind !== 'object') return 0;
  let rows = 0;
  for (const arr of Object.values(containers)) rows += arr.length;
  return rows;
}

// Recursive verbatim copy, skipping tmp strays. `skipDirs` holds absolute
// paths to prune. `opts.onCopy` receives each written destination file;
// `opts.skipReserved` drops any file named klebb-export.json (a restored tree
// re-exported later must not nest a stale manifest).
function copyTree(src, dst, skipDirs, opts = {}) {
  const entries = fs.readdirSync(src, { withFileTypes: true });
  fs.mkdirSync(dst, { recursive: true });
  let copied = 0;
  for (const ent of entries) {
    const from = path.join(src, ent.name);
    if (ent.isDirectory()) {
      if (skipDirs.has(from)) continue;
      copied += copyTree(from, path.join(dst, ent.name), skipDirs, opts);
    } else if (ent.isFile()) {
      if (ent.name.endsWith('.tmp')) continue;
      if (opts.skipReserved && ent.name === MANIFEST_NAME) {
        console.warn(`  ! ${MANIFEST_NAME} is a reserved name, not copied: ${from}`);
        continue;
      }
      const to = path.join(dst, ent.name);
      fs.copyFileSync(from, to);
      if (opts.onCopy) opts.onCopy(to);
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

// The whole export, lifted out of main() so an in-process caller (the import
// wizard's pre-import safety export) can run it inside a live server. Throws
// on failure instead of exiting; main() translates to the CLI's exit codes.
// opts: { includeSecrets = false }. Returns { target, counts }.
//
// Handle discipline: exportTo closes only the handles it opens (its own
// read-only datastore view). The HAE samples module is a lazy process-wide
// singleton whose handle belongs to whoever else is alive in the process (a
// live server's ingest path), so exportTo reads through it and leaves it
// open; the CLI wrapper closes it before exiting.
function exportTo(targetDir, opts = {}) {
  const { includeSecrets = false } = opts;
  const PATHS = require('../config/paths');
  const target = path.resolve(targetDir);

  if ((target + path.sep).startsWith(PATHS.DATA_DIR + path.sep) || target === PATHS.DATA_DIR) {
    throw new Error(`target must not sit inside the data dir (${PATHS.DATA_DIR})`);
  }
  if (fs.existsSync(target) && fs.readdirSync(target).length > 0) {
    throw new Error(`target ${target} exists and is not empty`);
  }
  if (!fs.existsSync(PATHS.DATA_DIR)) {
    throw new Error(`no data dir at ${PATHS.DATA_DIR}`);
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

  try {
    const outData = path.join(target, 'data');
    fs.mkdirSync(outData, { recursive: true });

    const counts = { embedded: 0, inline: 0, noData: 0, filesCopied: 0, haePushes: 0 };
    // Provenance manifest inventory (docs/EXPORT-FORMAT.md). Every file the
    // export writes is recorded here with the sha256 of its bytes as written;
    // the manifest itself is written last so a torn export never carries one.
    const inventory = { cards: [], samples: null, reports: [], other: [] };
    const rel = file => path.relative(target, file).split(path.sep).join('/');
    const fileEntry = file => ({ file: rel(file), sha256: sha256(file) });
    // The shared list (health-auto-export/raw-archives.js) keeps these
    // skips in lockstep with the import wipe's spares: a dir the export
    // leaves out is a dir the wipe must not destroy (#656).
    const skipDirs = new Set(rawArchiveDirs(PATHS.AUTO_EXPORT_DIR));

    for (const ent of fs.readdirSync(PATHS.DATA_DIR, { withFileTypes: true })) {
      const from = path.join(PATHS.DATA_DIR, ent.name);
      if (ent.isDirectory()) {
        if (skipDirs.has(from)) continue;
        counts.filesCopied += copyTree(from, path.join(outData, ent.name), skipDirs, {
          skipReserved: true,
          onCopy: file => inventory.other.push(fileEntry(file)),
        });
        continue;
      }
      if (!ent.isFile() || ent.name.endsWith('.tmp')) continue;
      if (BACKUP_NAME_RE.test(ent.name)) continue;
      if (ent.name === MANIFEST_NAME) {
        console.warn(`  ! ${MANIFEST_NAME} is a reserved name, not copied: ${from}`);
        continue;
      }

      const card = ent.name.endsWith('.json') ? classifyCard(from) : null;
      if (!card) {
        const to = path.join(outData, ent.name);
        fs.copyFileSync(from, to);
        inventory.other.push(fileEntry(to));
        counts.filesCopied += 1;
        continue;
      }

      const envelope = card.parsed;
      let dataState = 'none';
      if (Object.prototype.hasOwnProperty.call(envelope, 'data')) {
        // Not yet imported (pre-migration file or hand-added block): the file
        // already carries its data. Export it as-is.
        counts.inline += 1;
        dataState = 'inline';
      } else if (store && store.dataUpdatedAt(card.id) !== null) {
        // A stored record exists; null is a real recorded value here, distinct
        // from "never held data", and must round-trip as data: null.
        envelope.data = store.getData(card.id);
        counts.embedded += 1;
        dataState = envelope.data === null ? 'null' : 'embedded';
      } else {
        counts.noData += 1;
      }
      const to = path.join(outData, ent.name);
      writeJSON(to, envelope);
      inventory.cards.push({
        id: card.id,
        file: rel(to),
        data: dataState,
        rows: countRows(envelope.data),
        sha256: sha256(to),
      });
    }

    if (fs.existsSync(PATHS.CONFIG_PATH)) {
      let cfg = null;
      try {
        cfg = JSON.parse(fs.readFileSync(PATHS.CONFIG_PATH, 'utf8'));
      } catch (e) {
        console.warn(`  ! config.json unreadable, not exported: ${e.message}`);
      }
      if (cfg && typeof cfg === 'object') {
        const to = path.join(target, 'config.json');
        writeJSON(to, includeSecrets ? cfg : sanitiseConfig(cfg));
        inventory.other.push(fileEntry(to));
      }
    }

    if (fs.existsSync(PATHS.REPORTS_DIR)) {
      counts.filesCopied += copyTree(PATHS.REPORTS_DIR, path.join(target, 'reports'), skipDirs, {
        onCopy: file => inventory.reports.push({
          file: rel(file), bytes: fs.statSync(file).size, sha256: sha256(file),
        }),
      });
    }

    // HAE push history. It lives in the samples table inside klebb.db, and db/ is
    // never staged (a live WAL copy can be torn, and the staged tree goes to a
    // customer), so it is written out as payloads: the same shape the ingest
    // endpoint accepts, so restoring is the ordinary ingest path.
    //
    // Read through the module singleton and leave it OPEN: closing here would
    // take a live server's own handle down with it. The CLI wrapper closes it.
    if (fs.existsSync(PATHS.DB_FILE)) {
      const to = path.join(target, 'data', 'auto-export', 'samples.json');
      try {
        const samples = require('../health-auto-export/samples');
        const haePushes = writeSamplesFile(to, samples.exportPushesStream());
        if (haePushes) {
          counts.haePushes = haePushes;
          inventory.samples = { file: rel(to), pushes: haePushes, sha256: sha256(to) };
        }
      } catch (e) {
        // A failure mid-stream must not leave a partial file: the old
        // whole-array path wrote nothing on error, and a torn samples.json
        // would refuse validation at import.
        try { fs.rmSync(to, { force: true }); } catch {}
        console.warn(`  ! HAE sample history not exported: ${e.message}`);
      }
    }

    // The manifest is the last file written, on purpose: an export that threw
    // anywhere above leaves a tree with no manifest, which readers treat as
    // torn and refuse. The `samples` key is absent when no samples file was
    // exported. Contract: docs/EXPORT-FORMAT.md.
    writeJSON(path.join(target, MANIFEST_NAME), {
      format: 'klebb.export.v1',
      formatVersion: 1,
      appVersion: require('../package.json').version,
      exportedAt: new Date().toISOString(),
      inventory: {
        cards: inventory.cards,
        ...(inventory.samples ? { samples: inventory.samples } : {}),
        reports: inventory.reports,
        other: inventory.other,
      },
    });

    return { target, counts };
  } finally {
    if (store) store.close();
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args) { usage(); return 2; }
  if (args.help) { usage(); return 0; }
  if (!args.target) { console.error('error: target directory required'); usage(); return 2; }

  let result;
  try {
    result = exportTo(args.target, { includeSecrets: args.includeSecrets });
  } catch (e) {
    console.error(`error: ${e.message}`);
    return 2;
  } finally {
    // exportTo leaves the samples module singleton open on purpose (an
    // in-process caller shares that handle with a live server). The CLI owns
    // the whole process, so it closes and WAL-checkpoints here. Safe to call
    // having never opened.
    require('../health-auto-export/samples').close();
  }

  const { target, counts } = result;
  const cards = counts.embedded + counts.inline + counts.noData;
  console.log(`Exported ${cards} card(s) to ${target}`);
  console.log(`  data embedded from store: ${counts.embedded}`);
  console.log(`  data already inline:      ${counts.inline}`);
  console.log(`  no data (key omitted):    ${counts.noData}`);
  console.log(`  other files copied:       ${counts.filesCopied}`);
  console.log(`  secrets: ${args.includeSecrets ? 'INCLUDED (--include-secrets)' : 'stripped from config.json'}`);
  console.log(`  HAE push history:         ${counts.haePushes} push(es)`);
  return 0;
}

if (require.main === module) {
  process.exit(main());
} else {
  module.exports = { exportTo, sanitiseConfig };
}
