// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// ingest/extract.js
// Extension-keyed extractor dispatcher.

const path = require('path');
const { extractText } = require('./extractors/text');
const { extractPdf } = require('./extractors/pdf');
const { readImage } = require('./extractors/image');
const { extractAudio } = require('./extractors/audio');
const { extractDocx } = require('./extractors/docx');
const { defaultRung } = require('./reader');

const EXT_TO_FORMAT = {
  '.pdf': 'pdf',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.txt': 'text',
  '.md': 'markdown',
  '.csv': 'text',
  '.docx': 'docx',
  '.mp3': 'audio',
  '.wav': 'audio',
  '.m4a': 'audio',
  '.ogg': 'audio',
  '.opus': 'audio',
};

// The upload endpoint's allow-list IS the dispatcher's key set. Deriving it
// rather than maintaining a second list makes the two impossible to drift;
// drift presents to the user as "the upload succeeded and then the file
// vanished" (accepted at the boundary, rejected by the pipeline).
const ALLOWED_UPLOAD_EXTS = Object.freeze(Object.keys(EXT_TO_FORMAT));

function formatFor(absPath) {
  return EXT_TO_FORMAT[path.extname(absPath).toLowerCase()] || null;
}

// The rung a call resolves to, exported so the mapping is testable without
// any binary on the box. A bare {psm} is the legacy spelling of a tesseract
// rung and must keep meaning exactly that: dropping it silently dispatches
// the default reader, which is how a "retry at psm 6" once re-ran psm 3.
function rungFor(fmt, opts = {}) {
  if (fmt !== 'pdf' && fmt !== 'image') return null;
  if (opts.rung) return opts.rung;
  if (Number.isInteger(opts.psm)) return { reader: 'tesseract', psm: opts.psm };
  return defaultRung();
}

async function extract(absPath, opts = {}) {
  const fmt = formatFor(absPath);
  if (!fmt) throw new Error(`unsupported format: ${path.extname(absPath).toLowerCase() || '(none)'}`);
  // The reader rung only means something for the two formats a human has to
  // verify afterwards. Resolved here rather than in the pipeline so a direct
  // caller gets the same default a queued upload does.
  const rung = rungFor(fmt, opts);
  let result;
  switch (fmt) {
    case 'pdf':      result = await extractPdf(absPath, { rung }); break;
    case 'image':    result = await readImage(absPath, { rung }); break;
    case 'text':
    case 'markdown': result = await extractText(absPath); break;
    case 'docx':     result = await extractDocx(absPath); break;
    case 'audio':    result = await extractAudio(absPath); break;
  }
  return {
    text: result.text,
    // An extractor may refine the format it was dispatched under: a scanned
    // PDF comes back as 'pdf-ocr', which decides whether the result needs
    // human OCR verification downstream.
    sourceFormat: result.sourceFormat || fmt,
    // Which reader actually produced the text (image/pdf-ocr only), the
    // tesseract rung when that reader ran, and the numbers a vision read
    // carries that the local witness could not corroborate.
    readBy: result.readBy,
    psm: result.psm,
    unwitnessed: result.unwitnessed,
    // True when a vision attempt failed for a reason that is a property of
    // the document (overflow, filtered, empty) and would fail identically on
    // a retry; the ladder records it as attempted.
    visionDeterministic: result.visionDeterministic,
    reason: result.reason,
    truncated: result.truncated,
  };
}

module.exports = { extract, formatFor, rungFor, EXT_TO_FORMAT, ALLOWED_UPLOAD_EXTS };
