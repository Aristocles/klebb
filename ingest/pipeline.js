// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// ingest/pipeline.js
// Orchestrates the inbox -> reports pipeline.
//
// On start():
//   1. drain any files left over in INBOX_DIR from a previous boot
//      (server crashed mid-extract).
//   2. begin watching INBOX_DIR for new drops.
//
// Per-file processing waits for mtime+size to be stable before extracting,
// to avoid racing rsync mid-copy. Failures move the source to _failed/
// with a sibling .error file. An in-flight Set prevents the debounced
// re-scan from double-processing the same file.

const fs = require('fs');
const path = require('path');
const PATHS = require('../config/paths');
const watcher = require('./watcher');
const { extract, formatFor } = require('./extract');
const { writeReport } = require('./writeReport');

const STABILITY_DELAY_MS = 500;
const STABILITY_MAX_ATTEMPTS = 6;

const _inFlight = new Set();
let _watcherHandle = null;

function _isProcessable(name) {
  if (!name) return false;
  if (name.startsWith('.') || name.startsWith('_')) return false;
  return true;
}

function _scanInbox(inboxDir) {
  let entries;
  try { entries = fs.readdirSync(inboxDir); } catch { return []; }
  const out = [];
  for (const f of entries) {
    if (!_isProcessable(f)) continue;
    const abs = path.join(inboxDir, f);
    let stat;
    try { stat = fs.statSync(abs); } catch { continue; }
    if (!stat.isFile()) continue;
    out.push(abs);
  }
  return out;
}

function _sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function _waitUntilStable(absPath) {
  let prev;
  try { prev = fs.statSync(absPath); } catch { return false; }
  for (let i = 0; i < STABILITY_MAX_ATTEMPTS; i++) {
    await _sleep(STABILITY_DELAY_MS);
    let cur;
    try { cur = fs.statSync(absPath); } catch { return false; }
    if (cur.size === prev.size && cur.mtimeMs === prev.mtimeMs) return true;
    prev = cur;
  }
  return false;
}

async function _moveToFailed(absPath, reason) {
  try { fs.mkdirSync(PATHS.INBOX_FAILED_DIR, { recursive: true }); } catch {}
  const base = path.basename(absPath);
  const dest = path.join(PATHS.INBOX_FAILED_DIR, base);
  try {
    fs.renameSync(absPath, dest);
  } catch (e) {
    console.warn(`[ingest] could not move ${base} to _failed/: ${e.message}`);
  }
  const errPath = dest + '.error';
  const stamp = new Date().toISOString();
  try {
    fs.writeFileSync(errPath, `${stamp}\n${reason}\n`);
  } catch (e) {
    console.warn(`[ingest] could not write error sibling for ${base}: ${e.message}`);
  }
}

async function processOne(absPath) {
  const base = path.basename(absPath);
  if (_inFlight.has(base)) return { skipped: 'in-flight' };
  _inFlight.add(base);
  try {
    const stable = await _waitUntilStable(absPath);
    if (!stable) {
      await _moveToFailed(absPath, 'file mtime never stabilised; still being copied?');
      return { failed: true, reason: 'unstable' };
    }
    const fmt = formatFor(absPath);
    if (!fmt) {
      await _moveToFailed(absPath, `unsupported format: ${path.extname(absPath).toLowerCase() || '(none)'}`);
      return { failed: true, reason: 'unsupported' };
    }
    let extracted;
    try {
      extracted = await extract(absPath);
    } catch (e) {
      await _moveToFailed(absPath, `extraction failed: ${e.message}`);
      return { failed: true, reason: 'extract-error' };
    }
    const ingestedAt = new Date().toISOString();
    const archiveAbs = path.join(PATHS.REPORTS_ARCHIVE_DIR, base);
    const archiveRel = path.posix.join('reports', '_archive', base);
    let outName;
    try {
      const written = writeReport({
        reportsDir: PATHS.REPORTS_DIR,
        text: extracted.text,
        sourceFile: base,
        sourceFormat: extracted.sourceFormat,
        ingestedAt,
        archivePath: archiveRel,
      });
      outName = written.outName;
    } catch (e) {
      await _moveToFailed(absPath, `report write failed: ${e.message}`);
      return { failed: true, reason: 'write-error' };
    }
    try { fs.mkdirSync(PATHS.REPORTS_ARCHIVE_DIR, { recursive: true }); } catch {}
    try {
      fs.renameSync(absPath, archiveAbs);
    } catch (e) {
      console.warn(`[ingest] processed ${base} but could not archive: ${e.message}`);
    }
    return { ok: true, outName };
  } finally {
    _inFlight.delete(base);
  }
}

function _onChange() {
  const inbox = PATHS.INBOX_DIR;
  for (const abs of _scanInbox(inbox)) {
    const base = path.basename(abs);
    if (_inFlight.has(base)) continue;
    processOne(abs).catch(e => console.warn(`[ingest] processOne(${base}) threw:`, e.message));
  }
}

function start() {
  try { fs.mkdirSync(PATHS.INBOX_DIR, { recursive: true }); } catch {}
  try { fs.mkdirSync(PATHS.INBOX_FAILED_DIR, { recursive: true }); } catch {}
  try { fs.mkdirSync(PATHS.REPORTS_DIR, { recursive: true }); } catch {}
  try { fs.mkdirSync(PATHS.REPORTS_ARCHIVE_DIR, { recursive: true }); } catch {}

  _onChange();

  if (_watcherHandle) { try { _watcherHandle.stop(); } catch {} }
  _watcherHandle = watcher.start({ inboxDir: PATHS.INBOX_DIR, onChange: _onChange });
  return _watcherHandle;
}

function stop() {
  if (_watcherHandle) { try { _watcherHandle.stop(); } catch {} _watcherHandle = null; }
}

module.exports = { start, stop, processOne };
