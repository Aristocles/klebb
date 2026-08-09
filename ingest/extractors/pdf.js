// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// ingest/extractors/pdf.js
// pdftotext for digital PDFs, with a pdftoppm + tesseract fallback for scans.
//
// Real doctors' letters and pathology reports arrive as scans: a PDF whose
// pages are images with no text layer at all. pdftotext returns near-empty on
// those, which used to produce a report with an empty body and no explanation.
// When the text layer is sparse we rasterise the pages and OCR them instead.
//
// Both binaries ship in poppler-utils / tesseract-ocr, already in the image,
// so this needs no Dockerfile change. Probed at runtime all the same.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { extractImage } = require('./image');

// Sparseness thresholds. A digital PDF of a lab report runs to thousands of
// alphanumerics; a scan yields a handful of stray marks at most. The per-page
// floor catches the mixed case: a 12-page scan with a text-layer cover sheet
// clears the 200 total but is still 99% unreadable.
const SPARSE_TOTAL_CHARS = 200;
const SPARSE_CHARS_PER_PAGE = 50;

// Rasterising is the expensive half: 300 dpi PNG of a full page is several MB
// and each page is its own tesseract run, all on the thread serving HTTP.
// Capped, and the truncation is stated in the body so a user never believes a
// report is complete when its tail is missing.
const OCR_DPI = 300;
const OCR_MAX_PAGES = 20;

// Wall-clock ceiling per shelled-out binary, and a cap on how much stdout we
// will hold. Generous enough for a 20-page render on a slow container, tight
// enough that a wedged process cannot own the queue for the rest of the uptime.
const SPAWN_TIMEOUT_MS = 180_000;
const MAX_OUTPUT_BYTES = 20 * 1024 * 1024;

function _alnumCount(s) {
  const m = (s || '').match(/[a-z0-9]/gi);
  return m ? m.length : 0;
}

// Every shell-out is bounded. A hung binary would otherwise hold the ingest
// queue's single slot forever: no later upload could ever be processed, and
// nothing in the UI would explain why. node's own spawn timeout sends the kill
// for us, but it only fires once the process is spawned, so ENOENT still
// rejects through 'error'.
function _run(bin, args, timeoutMs = SPAWN_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
    });
    const out = [];
    let stderr = '';
    let bytes = 0;
    proc.stdout.on('data', c => {
      // A runaway extractor could otherwise stream unbounded output into memory.
      bytes += c.length;
      if (bytes <= MAX_OUTPUT_BYTES) out.push(c);
    });
    proc.stderr.on('data', c => { if (stderr.length < 4000) stderr += c.toString(); });
    proc.on('error', e => reject(new Error(`${bin} spawn failed: ${e.message}`)));
    proc.on('close', (code, signal) => {
      if (signal === 'SIGKILL') {
        return reject(new Error(`${bin} timed out after ${Math.round(timeoutMs / 1000)}s and was killed`));
      }
      if (code !== 0) return reject(new Error(`${bin} exit ${code}: ${stderr.slice(0, 300)}`));
      resolve(Buffer.concat(out).toString('utf8'));
    });
  });
}

let _pdftoppmProbe = null;
function hasPdftoppm() {
  if (_pdftoppmProbe === null) {
    const probe = spawnSync('pdftoppm', ['-v'], { stdio: 'ignore' });
    // pdftoppm -v exits non-zero on some builds while still being present, so
    // an ENOENT-free spawn is the real signal.
    _pdftoppmProbe = !probe.error;
  }
  return _pdftoppmProbe;
}

// Page count via pdfinfo when available; the renderer's own output is the
// fallback, so a missing pdfinfo is not fatal.
async function _pageCount(absPath) {
  try {
    const info = await _run('pdfinfo', [absPath]);
    const m = info.match(/^Pages:\s+(\d+)/m);
    if (m) return parseInt(m[1], 10);
  } catch {}
  return null;
}

async function _ocrPages(absPath) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'klebb-pdfocr-'));
  const started = Date.now();
  try {
    const pages = await _pageCount(absPath);
    const last = pages ? Math.min(pages, OCR_MAX_PAGES) : OCR_MAX_PAGES;
    const truncated = !!(pages && pages > OCR_MAX_PAGES);

    const prefix = path.join(tmp, 'page');
    await _run('pdftoppm', ['-r', String(OCR_DPI), '-png', '-f', '1', '-l', String(last), absPath, prefix]);

    const rendered = fs.readdirSync(tmp)
      .filter(f => f.endsWith('.png'))
      .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
    if (!rendered.length) throw new Error('pdftoppm produced no pages');

    const chunks = [];
    // Tracked separately from the assembled text: the page separators below
    // are our own scaffolding, and counting them as recovered content makes a
    // blank page look like a successful OCR.
    let recovered = 0;
    for (let i = 0; i < rendered.length; i++) {
      const { text } = await extractImage(path.join(tmp, rendered[i]));
      const pageText = (text || '').trim();
      recovered += _alnumCount(pageText);
      chunks.push(`--- page ${i + 1} ---\n\n${pageText}`);
    }
    if (truncated) {
      chunks.push(`--- truncated ---\n\nOnly the first ${OCR_MAX_PAGES} of ${pages} pages were processed. The rest of this document was not read.`);
    }
    const ms = Date.now() - started;
    console.log(`[ingest] pdf-ocr ${rendered.length} page(s), ${recovered} chars in ${ms}ms`);
    return { text: chunks.join('\n\n'), pages: rendered.length, truncated, ms, recovered };
  } finally {
    // Always: 300 dpi PNGs are large and a leaked temp dir per upload adds up.
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

async function extractPdf(absPath) {
  const text = await _run('pdftotext', ['-layout', absPath, '-']);
  const alnum = _alnumCount(text);

  const pages = await _pageCount(absPath);
  const sparse = alnum < SPARSE_TOTAL_CHARS
    || (pages && pages > 0 && (alnum / pages) < SPARSE_CHARS_PER_PAGE);
  if (!sparse) return { text, sourceFormat: 'pdf' };

  if (!hasPdftoppm()) {
    // Leave the near-empty text as-is rather than inventing content, and say
    // why, so the report explains itself instead of looking merely broken.
    console.warn('[ingest] sparse PDF text layer but pdftoppm is unavailable; leaving as-is');
    return { text, sourceFormat: 'pdf', sparse: true, reason: 'scanned pdf; OCR unavailable' };
  }

  try {
    const ocr = await _ocrPages(absPath);
    // Compare recovered page text, NOT the assembled body: the page separators
    // are our own scaffolding, and counting them makes a blank scan look like a
    // successful OCR. If OCR recovered no more than the text layer the document
    // really is blank, and claiming pdf-ocr provenance would be a lie that
    // then costs the user a pointless verification step.
    if (ocr.recovered <= alnum) return { text, sourceFormat: 'pdf', sparse: true };
    return { text: ocr.text, sourceFormat: 'pdf-ocr', pages: ocr.pages, truncated: ocr.truncated };
  } catch (e) {
    console.warn(`[ingest] pdf OCR fallback failed: ${e.message}`);
    return { text, sourceFormat: 'pdf', sparse: true, reason: `scanned pdf; OCR failed: ${e.message}` };
  }
}

module.exports = {
  extractPdf,
  SPAWN_TIMEOUT_MS,
  hasPdftoppm,
  SPARSE_TOTAL_CHARS,
  SPARSE_CHARS_PER_PAGE,
  OCR_DPI,
  OCR_MAX_PAGES,
};
