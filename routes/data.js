// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// routes/data.js
//
// Export download + import HTTP surface. Exports a single
// `handle(req, res, parts, ctx)` that returns true when it has fully
// handled the request, false otherwise (the notifications mount pattern).
//
// GET  /api/export           stage exportTo -> writeZip -> stream the file
// POST /api/import/upload    raw zip body streamed to <home>/import/upload.zip
// POST /api/import/start     extract the staged zip, wizard.startFromTree
// POST /api/import/scan-tree operator door: wizard on <home>/import/tree
// GET  /api/import/status    wizard.status() (confirmNonce delivered ONCE:
//                            whichever response carries it, the caller must
//                            hold it; it is never repeated)
// POST /api/import/apply     wizard.confirmAndApply({nonce, selection});
//                            answers 202 with the applying snapshot
//                            immediately, the pipeline runs detached (#633: a
//                            blocking apply outlived proxy response
//                            ceilings); poll status for progress and the
//                            terminal state. An optional `selection` names
//                            the artefacts to restore (#646) and a bad one
//                            answers 400 with nothing destroyed
// POST /api/import/rollback  wizard.rollback(); 202 + poll, same shape
// POST /api/import/abort     wizard.abort()
//
// Auth: the main dispatcher's session gate runs before delegating here.
// Mutating import routes are additionally origin-checked. Demo mode 403s
// the export and the whole import family before any work.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ENV = require('../config/env');
const PATHS = require('../config/paths');
const { originAllowed } = require('../lib/origin-check');
const { openZip } = require('../lib/zip/read');
const { writeZip } = require('../lib/zip/write');
const { exportTo } = require('../scripts/export-embed');
const { createDefaultWizard, jobFilePath } = require('../lib/import/wizard');

const UPLOAD_ZIP = 'upload.zip';

// One wizard per process, created on first use so it binds the registry's
// own datastore handle after boot has settled. A boot that resumes a
// crashed job detached (#633) adopts ITS wizard instead: a fresh one would
// read job.json once and never see the live pipeline's progress.
let _wizard = null;
function wizard() {
  if (!_wizard) _wizard = createDefaultWizard();
  return _wizard;
}

function adoptWizard(w) {
  _wizard = w;
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.setEncoding('utf8');
    req.on('data', c => buf += c);
    req.on('end', () => {
      if (!buf) return resolve({});
      try { resolve(JSON.parse(buf)); }
      catch { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

// The persisted job record mirrors the wizard's in-memory state (it is
// written on every transition and removed by abort), so it answers "is a
// job active?" without calling status(), which would burn the once-only
// confirmNonce on an internal check.
function jobActive() {
  try {
    const record = JSON.parse(fs.readFileSync(jobFilePath(PATHS.HEALTH_HOME), 'utf8'));
    return record && typeof record === 'object' && record.state ? record.state : null;
  } catch {
    return null;
  }
}

// === Export ===

let _exportInFlight = false;

function exportFilename(now = new Date()) {
  const slug = String(ENV.INSTANCE_NAME || '')
    .toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'klebb';
  const p = n => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`
    + `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `${slug}-export-${stamp}.zip`;
}

function listZipEntries(root, rel = '') {
  const out = [];
  const dir = rel ? path.join(root, rel) : root;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const r = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) out.push(...listZipEntries(root, r));
    else if (ent.isFile()) out.push({ name: r, sourcePath: path.join(root, r) });
  }
  return out;
}

async function handleExport(req, res) {
  if (ENV.KLEBB_DEMO) {
    send(res, 403, { error: 'Not available in demo mode' });
    return true;
  }
  if (_exportInFlight) {
    send(res, 409, { error: 'an export is already in progress; try again when it finishes' });
    return true;
  }
  _exportInFlight = true;

  const stagingDir = path.join(PATHS.HEALTH_HOME, `export-staging.${Date.now()}`);
  const zipFile = `${stagingDir}.zip`;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    _exportInFlight = false;
    try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(zipFile, { force: true }); } catch {}
  };

  try {
    exportTo(stagingDir);
    await writeZip(zipFile, listZipEntries(stagingDir));
    const { size } = fs.statSync(zipFile);
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Length': size,
      'Content-Disposition': `attachment; filename="${exportFilename()}"`,
      'Cache-Control': 'private, no-store',
    });
    // Staging is removed only when the RESPONSE ends ('close' fires on both
    // completion and a client that walked away), never when this handler
    // returns: the read stream is still serving bytes out of the zip.
    res.on('close', cleanup);
    const stream = fs.createReadStream(zipFile);
    stream.on('error', () => { try { res.destroy(); } catch {} });
    stream.pipe(res);
  } catch (e) {
    cleanup();
    console.error('[export] failed:', e.message);
    send(res, 500, { error: `export failed: ${e.message}` });
  }
  return true;
}

// === Import ===

function handleUpload(req, res) {
  const importDir = PATHS.IMPORT_DIR;
  try { fs.mkdirSync(importDir, { recursive: true }); } catch {}

  const capBytes = ENV.IMPORT_MAX_TREE_MB * 1024 * 1024;

  // Free-space gate before a byte is accepted: the zip, the extracted tree
  // and the pipeline's rollback snapshot can all coexist at peak, so demand
  // three times the cap. statfs is not supported on every filesystem; a
  // check that cannot run must not block an import that would have fit.
  try {
    const s = fs.statfsSync(PATHS.HEALTH_HOME);
    const free = Number(s.bavail) * Number(s.bsize);
    if (free < 3 * capBytes) {
      res.writeHead(507, { 'Content-Type': 'application/json', 'Connection': 'close' });
      res.end(JSON.stringify({
        error: `not enough free space: importing needs ${3 * capBytes} bytes free, ${free} available`,
      }));
      req.resume();
      return true;
    }
  } catch (e) {
    console.warn('[import] free-space check unavailable (continuing):', e.message);
  }

  const partFile = path.join(importDir, `.${UPLOAD_ZIP}.${crypto.randomBytes(6).toString('hex')}.part`);
  const finalFile = path.join(importDir, UPLOAD_ZIP);

  let total = 0;
  let settled = false;
  const sink = fs.createWriteStream(partFile);

  // Same discipline as the reports upload: unlink only once the write
  // handle is closed (an open handle blocks unlink on Windows), and clean
  // up on every terminal event so an aborted request leaves no .part.
  const cleanupPart = () => {
    const unlink = () => { try { fs.unlinkSync(partFile); } catch {} };
    if (sink.closed || sink.destroyed) return unlink();
    sink.once('close', unlink);
    sink.destroy();
  };
  const abandon = (statusCode, payload) => {
    if (settled) return;
    settled = true;
    cleanupPart();
    if (statusCode) {
      res.writeHead(statusCode, { 'Content-Type': 'application/json', 'Connection': 'close' });
      res.end(JSON.stringify(payload));
      req.resume();
    }
  };

  sink.on('error', e => abandon(500, { error: `could not stage upload: ${e.message}` }));
  req.on('aborted', () => abandon(null, null));
  req.on('error', () => abandon(null, null));
  res.on('close', () => { if (!settled) abandon(null, null); });

  req.on('data', chunk => {
    if (settled) return;
    total += chunk.length;
    if (total > capBytes) {
      return abandon(413, {
        error: `archive too large (${ENV.IMPORT_MAX_TREE_MB} MB limit; KLEBB_IMPORT_MAX_TREE_MB)`,
        maxBytes: capBytes,
      });
    }
    sink.write(chunk);
  });

  req.on('end', () => {
    if (settled) return;
    if (total === 0) return abandon(400, { error: 'empty upload' });
    sink.end(() => {
      if (settled) return;
      settled = true;
      try {
        // Re-upload replaces: rename over the previous staged archive.
        fs.renameSync(partFile, finalFile);
      } catch (e) {
        cleanupPart();
        return send(res, 500, { error: `could not stage upload: ${e.message}` });
      }
      send(res, 200, { ok: true, bytes: total });
    });
  });
  return true;
}

async function handleStart(req, res) {
  // Job-active first, so a refused second start never consumes the staged
  // upload the running job's owner may still need.
  const active = jobActive();
  if (active && active !== 'idle') {
    send(res, 409, { error: `a job is already active (state: ${active}); abort it first`, code: 'JOB_ACTIVE' });
    return true;
  }
  const zipPath = path.join(PATHS.IMPORT_DIR, UPLOAD_ZIP);
  if (!fs.existsSync(zipPath)) {
    send(res, 404, { error: 'no uploaded archive; POST /api/import/upload first' });
    return true;
  }

  const staging = path.join(PATHS.IMPORT_DIR, `staging-${Date.now()}`);
  let zip = null;
  try {
    zip = await openZip(zipPath, {
      maxEntries: ENV.IMPORT_MAX_FILES,
      maxEntryBytes: ENV.IMPORT_MAX_FILE_MB * 1024 * 1024,
      maxTotalBytes: ENV.IMPORT_MAX_TREE_MB * 1024 * 1024,
    });
    await zip.extractTo(staging);
  } catch (e) {
    if (typeof e.code === 'string' && e.code.startsWith('ZIP_')) {
      send(res, 422, { error: e.message, code: e.code });
      return true;
    }
    send(res, 500, { error: `could not extract the archive: ${e.message}` });
    return true;
  } finally {
    if (zip) await zip.close().catch(() => {});
  }
  fs.rmSync(zipPath, { force: true });

  const started = wizard().startFromTree(staging);
  if (started.code === 'JOB_ACTIVE') {
    // Lost the (in-process) race with another start: the tree just staged
    // belongs to no job, so it must not linger.
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
    send(res, 409, started);
    return true;
  }
  // status(), not the startFromTree return: only status() carries the
  // once-only confirmNonce, and the starter is the caller who must hold it.
  send(res, 200, wizard().status());
  return true;
}

function handleScanTree(req, res) {
  const treeDir = path.join(PATHS.IMPORT_DIR, 'tree');
  let st = null;
  try { st = fs.statSync(treeDir); } catch {}
  if (!st || !st.isDirectory()) {
    send(res, 404, { error: `no extracted tree at ${treeDir}` });
    return true;
  }
  const started = wizard().startFromTree(treeDir);
  if (started.code === 'JOB_ACTIVE') {
    send(res, 409, started);
    return true;
  }
  send(res, 200, wizard().status());
  return true;
}

async function handleApply(req, res) {
  let body;
  try { body = await readBody(req); }
  catch { send(res, 400, { error: 'invalid JSON body' }); return true; }

  // 202, not 200: the pipeline runs detached and the caller polls status.
  // The wizard has already persisted 'applying' and engaged the freeze by
  // the time confirmAndApply returns, so nothing can slip in between this
  // response and the gate.
  const result = wizard().confirmAndApply({ nonce: body.nonce, selection: body.selection });
  if (result.code === 'CONFIRM_REQUIRED') { send(res, 428, result); return true; }
  if (result.code === 'BAD_STATE') { send(res, 409, result); return true; }
  // A selection the archive cannot satisfy is the caller's mistake, and it is
  // refused before anything is wiped: the job stays awaiting-confirm with its
  // nonce unspent, so a corrected apply goes straight through.
  if (result.code === 'SELECTION_INVALID' || result.code === 'SELECTION_EMPTY') {
    send(res, 400, result);
    return true;
  }
  send(res, 202, result);
  return true;
}

function handleRollback(req, res) {
  const result = wizard().rollback();
  if (result.code === 'NO_SNAPSHOT') { send(res, 404, result); return true; }
  if (result.code === 'BAD_STATE') { send(res, 409, result); return true; }
  send(res, 202, result);
  return true;
}

function handleAbort(req, res) {
  const result = wizard().abort();
  if (result.code === 'BAD_STATE') { send(res, 409, result); return true; }
  send(res, 200, result);
  return true;
}

async function handle(req, res, parts) {
  // GET /api/export
  if (parts[0] === 'export' && parts.length === 1 && req.method === 'GET') {
    return handleExport(req, res);
  }
  if (parts[0] !== 'import') return false;

  if (ENV.KLEBB_DEMO) {
    send(res, 403, { error: 'Not available in demo mode' });
    req.resume();
    return true;
  }

  // GET /api/import/status
  if (parts[1] === 'status' && parts.length === 2 && req.method === 'GET') {
    send(res, 200, wizard().status());
    return true;
  }

  if (req.method !== 'POST' || parts.length !== 2) return false;
  if (!originAllowed(req)) {
    send(res, 403, { error: 'origin not allowed' });
    req.resume();
    return true;
  }

  if (parts[1] === 'upload') return handleUpload(req, res);
  if (parts[1] === 'start') return handleStart(req, res);
  if (parts[1] === 'scan-tree') return handleScanTree(req, res);
  if (parts[1] === 'apply') return handleApply(req, res);
  if (parts[1] === 'rollback') return handleRollback(req, res);
  if (parts[1] === 'abort') return handleAbort(req, res);
  return false;
}

const ROUTE_PREFIXES = ['export', 'import'];

module.exports = { handle, ROUTE_PREFIXES, adoptWizard };
