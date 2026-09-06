// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// ingest/pipeline.js
// Orchestrates the inbox -> reports pipeline.
//
// Files reach the inbox one of two ways, both of which end at enqueue():
//   1. POST /api/reports/upload writes the bytes to a dot-prefixed .part
//      staging file and renames it into place, then enqueues.
//   2. The boot drain picks up anything sitting in the inbox from a previous
//      boot (a crash mid-extract) or dropped in by an operator with
//      `docker cp` + restart. Same cap, same queue, same rules.
//
// There is no filesystem watcher and no mtime-stability wait: a file at its
// final inbox name was renamed there atomically, so it is complete by
// construction. Extraction is serialised through a single slot, because
// tesseract and pdftoppm are CPU-bound and share node's thread with request
// serving. Failures move the source to _failed/ with a sibling .error file.

const fs = require('fs');
const path = require('path');
const PATHS = require('../config/paths');
const { extract, formatFor } = require('./extract');
const { writeReport } = require('./writeReport');
const { comprehend } = require('./comprehend');
const { quota, countIngestedReports, parseReportHeader } = require('./catalogue');
const { bodyText } = require('../lib/reports-api');

function _alnumCount(s) {
  const m = (s || '').match(/[a-z0-9]/gi);
  return m ? m.length : 0;
}

const _inFlight = new Set();
const _queue = [];
let _running = false;

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

async function _moveToFailed(absPath, reason) {
  try { fs.mkdirSync(PATHS.INBOX_FAILED_DIR, { recursive: true }); } catch {}
  const base = path.basename(absPath);
  // Suffix on collision: a second failure of the same filename would otherwise
  // overwrite the first, so the earlier file and its reason both vanished.
  let name = base;
  if (fs.existsSync(path.join(PATHS.INBOX_FAILED_DIR, name))) {
    const ext = path.extname(base);
    const stem = base.slice(0, base.length - ext.length);
    for (let i = 2; i < 1000; i++) {
      const candidate = `${stem}-${i}${ext}`;
      if (!fs.existsSync(path.join(PATHS.INBOX_FAILED_DIR, candidate))) { name = candidate; break; }
    }
  }
  const dest = path.join(PATHS.INBOX_FAILED_DIR, name);
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

// A free name inside the archive dir, suffixing -2, -3 before the extension.
// Reprocess passes archiveName explicitly and so never comes through here.
function _freeArchiveName(base) {
  const dir = PATHS.REPORTS_ARCHIVE_DIR;
  if (!fs.existsSync(path.join(dir, base))) return base;
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  for (let i = 2; i < 1000; i++) {
    const candidate = `${stem}-${i}${ext}`;
    if (!fs.existsSync(path.join(dir, candidate))) return candidate;
  }
  return `${stem}-${Date.now()}${ext}`;
}

// The digest already on disk for a report, or null. Used so a reprocess that
// cannot reach the gateway keeps the summary the user already had.
function _existingDigest(name) {
  try {
    const header = parseReportHeader(
      fs.readFileSync(path.join(PATHS.REPORTS_DIR, `${name}.md`), 'utf8'));
    return header || null;
  } catch { return null; }
}

// `opts.rung` selects the reader for a reprocess ({reader:'vision'} or
// {reader:'tesseract', psm}); `opts.psm` is the legacy spelling of the
// tesseract rung and still honoured. `opts.priorAttempts` carries the rung
// labels that already produced text, so the retry ladder has memory.
// `opts.overwriteName` rewrites an existing report rather than allocating a
// new name, and `opts.archiveName` names the already-archived original when
// reprocessing (nothing to move).
async function processOne(absPath, opts = {}) {
  const base = path.basename(absPath);
  if (_inFlight.has(base)) return { skipped: 'in-flight' };
  _inFlight.add(base);

  // On a reprocess the source IS the archived original, and it is the only
  // remaining copy of the user's document. Moving it to _failed/ on a failure
  // would destroy it: the report still points at an archive_path that no longer
  // exists, so the compare view breaks and no future reprocess can ever work.
  // A failed retry must cost the retry, never the document.
  const isArchivedSource = path.resolve(path.dirname(absPath))
    === path.resolve(PATHS.REPORTS_ARCHIVE_DIR);
  const abandon = async (reason) => {
    if (isArchivedSource) {
      console.warn(`[ingest] reprocess of ${base} failed (${reason}); leaving the archived original in place`);
      return;
    }
    await _moveToFailed(absPath, reason);
  };

  try {
    const fmt = formatFor(absPath);
    if (!fmt) {
      await abandon(`unsupported format: ${path.extname(absPath).toLowerCase() || '(none)'}`);
      return { failed: true, reason: 'unsupported' };
    }
    let extracted;
    try {
      // extract owns the legacy {psm} -> rung mapping; forwarding both keeps
      // exactly one place that knows what a bare psm means.
      extracted = await extract(absPath, { rung: opts.rung, psm: opts.psm });
    } catch (e) {
      await abandon(`extraction failed: ${e.message}`);
      return { failed: true, reason: 'extract-error' };
    }

    // The comprehension pass. Always resolves: every failure inside it comes
    // back as a `raw` digest carrying the extracted text and a stated reason,
    // so a dead gateway costs the digest, never the report.
    const digest = await comprehend({
      text: extracted.text,
      sourceFormat: extracted.sourceFormat,
      ocrPsm: extracted.psm ?? null,
      readBy: extracted.readBy ?? null,
    });

    // The ladder's memory: rungs that PRODUCED text, prior ones first. A
    // vision attempt that failed transiently is deliberately not recorded, so
    // it stays retryable once the gateway is back; one that failed for a
    // document-deterministic reason IS recorded, or the retry button would
    // offer the same doomed spend forever.
    const producedRung = extracted.readBy
      ? (extracted.readBy === 'vision' ? 'vision' : String(extracted.psm ?? 3))
      : null;
    const priorAttempts = Array.isArray(opts.priorAttempts) ? opts.priorAttempts.map(String) : [];
    const ocrAttempts = producedRung
      ? [...new Set([
          ...priorAttempts,
          ...(extracted.visionDeterministic ? ['vision'] : []),
          producedRung,
        ])]
      : null;

    // Reprocessing with a dead gateway would otherwise replace a perfectly good
    // digest with `raw` and no title or bullets: the user asks to re-read a
    // photo, the gateway happens to be down, and they lose the summary they
    // already had. Keep the existing digest and record why the retry could not
    // improve on it. Only for an overwrite; a first ingest has nothing to keep.
    if (opts.overwriteName && digest.status === 'raw') {
      const previous = _existingDigest(opts.overwriteName);
      if (previous && previous.status !== 'raw') {
        console.warn(`[ingest] reprocess of ${opts.overwriteName} could not re-summarise (${digest.reason}); keeping the previous digest`);
        digest.status = previous.status;
        digest.title = previous.title;
        digest.documentDate = previous.documentDate;
        digest.relevance = previous.relevance;
        digest.bullets = previous.bullets;
        digest.reason = `previous summary kept; this re-read could not be summarised (${digest.reason})`;
      }
    }

    // A failed retry must cost the retry, never the document: a re-read that
    // recovered almost nothing (a gateway returning empty pages, a blank OCR
    // pass) must not replace a report that had real content. The archived
    // original is untouched either way, so nothing is lost by refusing.
    if (opts.overwriteName) {
      let previousAlnum = 0;
      try {
        previousAlnum = _alnumCount(bodyText(
          fs.readFileSync(path.join(PATHS.REPORTS_DIR, `${opts.overwriteName}.md`), 'utf8')));
      } catch {}
      const nextAlnum = _alnumCount(digest.body || '');
      if (previousAlnum >= 40 && nextAlnum < previousAlnum / 10) {
        console.warn(`[ingest] re-read of ${opts.overwriteName} recovered ${nextAlnum} chars against the existing ${previousAlnum}; keeping the report as it was`);
        return { skipped: 'thin-rewrite' };
      }
    }

    const ingestedAt = new Date().toISOString();
    // Allocate a free archive name. Two uploads of the same filename (a month
    // apart, say, both called results.pdf) would otherwise write to the same
    // archive path: the second overwrote the first, so the older report's
    // compare view silently showed the NEWER document, and a reprocess of it
    // re-read the wrong file. The inbox de-dup does not help, because by then
    // the first file has already been renamed out of the inbox.
    try { fs.mkdirSync(PATHS.REPORTS_ARCHIVE_DIR, { recursive: true }); } catch {}
    const archiveName = opts.archiveName || _freeArchiveName(base);
    const archiveAbs = path.join(PATHS.REPORTS_ARCHIVE_DIR, archiveName);
    const archiveRel = path.posix.join('reports', '_archive', archiveName);
    let outName;
    try {
      const written = writeReport({
        reportsDir: PATHS.REPORTS_DIR,
        version: 2,
        text: digest.body,
        sourceFile: archiveName,
        sourceFormat: extracted.sourceFormat,
        ingestedAt,
        archivePath: archiveRel,
        status: digest.status,
        verify: digest.verify,
        title: digest.title,
        documentDate: digest.documentDate,
        relevance: digest.relevance,
        ocrPsm: digest.ocrPsm,
        readBy: extracted.readBy ?? null,
        ocrAttempts,
        unwitnessed: extracted.unwitnessed ?? null,
        // An extractor-level note (a truncated scan, a reader fallback) is
        // kept even when comprehension has its own reason: "nothing to
        // comprehend" without "the vision read was unavailable" hides the
        // half of the story the user can actually act on.
        reason: digest.reason && extracted.reason
          ? `${digest.reason} (${extracted.reason})`
          : digest.reason || extracted.reason || null,
        bullets: digest.bullets,
        overwriteName: opts.overwriteName || null,
      });
      outName = written.outName;
    } catch (e) {
      await abandon(`report write failed: ${e.message}`);
      return { failed: true, reason: 'write-error' };
    }

    try { fs.mkdirSync(PATHS.REPORTS_ARCHIVE_DIR, { recursive: true }); } catch {}
    // On reprocess the source IS the archived original, so leave it be.
    if (path.resolve(absPath) !== path.resolve(archiveAbs)) {
      try {
        fs.renameSync(absPath, archiveAbs);
      } catch (e) {
        console.warn(`[ingest] processed ${base} but could not archive: ${e.message}`);
      }
    }
    return { ok: true, outName, status: digest.status, verify: digest.verify };
  } finally {
    _inFlight.delete(base);
  }
}

// Drive the queue one file at a time. _running is set synchronously before
// the first await so two enqueue() calls in the same tick cannot both see it
// false and start parallel chains.
async function _drive() {
  if (_running) return;
  _running = true;
  try {
    while (_queue.length) {
      const { absPath, opts } = _queue.shift();
      const base = path.basename(absPath);
      const started = Date.now();
      try {
        const r = await processOne(absPath, opts);
        if (r && r.ok) {
          console.log(`[ingest] ${base} -> ${r.outName} (${r.status}/${r.verify}) in ${Date.now() - started}ms`);
        }
      } catch (e) {
        console.warn(`[ingest] processOne(${base}) threw:`, e.message);
      }
    }
  } finally {
    _running = false;
  }
  // A file enqueued while the loop was winding down would otherwise sit
  // untouched until the next upload.
  if (_queue.length) _drive();
}

// Returns whether the file was actually queued: a dedupe hit means an earlier
// request's run (with ITS options) is what will happen, and the caller should
// not report otherwise.
function enqueue(absPath, opts = {}) {
  if (_queue.some(e => e.absPath === absPath)) return false;
  _queue.push({ absPath, opts });
  _drive();
  return true;
}

function queueDepth() { return _queue.length + (_running ? 1 : 0); }

// Pick up whatever is in the inbox at boot. Enforces the cap so a bulk
// `docker cp` cannot walk an instance past its limit; overflow lands in
// _failed/ with an actionable reason rather than being silently dropped.
//
// The budget is computed once, against the reports already on disk, and then
// decremented locally. Re-reading quota() per file would count the pending
// inbox files against their own admission (they are exactly what is being
// drained), so nothing would ever be admitted on a full inbox.
function drain() {
  const pending = _scanInbox(PATHS.INBOX_DIR);
  if (!pending.length) return { queued: 0, overflow: 0 };

  const max = quota().max;
  let budget = Math.max(0, max - countIngestedReports());
  let overflow = 0;
  for (const abs of pending) {
    if (budget < 1) {
      overflow++;
      _moveToFailed(abs, `report cap reached (${max}); delete a report and re-upload`)
        .catch(() => {});
      continue;
    }
    budget--;
    enqueue(abs);
  }
  if (overflow) console.warn(`[ingest] boot drain: ${overflow} file(s) over the report cap moved to _failed/`);
  return { queued: _queue.length, overflow };
}

// A .part left behind means a client aborted mid-upload at a moment the
// cleanup handlers could not cover (a hard kill). Harmless (the drain skips
// dot-prefixed names) but worth saying out loud once.
function _warnOnStrayParts() {
  let entries;
  try { entries = fs.readdirSync(PATHS.INBOX_DIR); } catch { return; }
  const strays = entries.filter(f => f.endsWith('.part'));
  if (strays.length) {
    console.warn(`[ingest] ${strays.length} stray .part file(s) in inbox/ from an interrupted upload; safe to delete`);
  }
}

function start() {
  try { fs.mkdirSync(PATHS.INBOX_DIR, { recursive: true }); } catch {}
  try { fs.mkdirSync(PATHS.INBOX_FAILED_DIR, { recursive: true }); } catch {}
  try { fs.mkdirSync(PATHS.REPORTS_DIR, { recursive: true }); } catch {}
  try { fs.mkdirSync(PATHS.REPORTS_ARCHIVE_DIR, { recursive: true }); } catch {}

  _warnOnStrayParts();
  return drain();
}

function stop() {
  _queue.length = 0;
}

module.exports = { start, stop, processOne, enqueue, drain, queueDepth };
