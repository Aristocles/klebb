// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// ingest/extract.js
// Extension-keyed extractor dispatcher.

const path = require('path');
const { extractText } = require('./extractors/text');
const { extractPdf } = require('./extractors/pdf');
const { extractImage } = require('./extractors/image');
const { extractAudio } = require('./extractors/audio');
const { extractDocx } = require('./extractors/docx');

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

async function extract(absPath, opts = {}) {
  const fmt = formatFor(absPath);
  if (!fmt) throw new Error(`unsupported format: ${path.extname(absPath).toLowerCase() || '(none)'}`);
  let result;
  switch (fmt) {
    case 'pdf':      result = await extractPdf(absPath); break;
    case 'image':    result = await extractImage(absPath, { psm: opts.psm }); break;
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
    // Image only; recorded so a "retry OCR" can advance the ladder.
    psm: result.psm,
    reason: result.reason,
    truncated: result.truncated,
  };
}

module.exports = { extract, formatFor, EXT_TO_FORMAT, ALLOWED_UPLOAD_EXTS };
