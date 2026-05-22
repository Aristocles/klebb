// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// ingest/extract.js
// Extension-keyed extractor dispatcher.

const path = require('path');
const { extractText } = require('./extractors/text');
const { extractPdf } = require('./extractors/pdf');
const { extractImage } = require('./extractors/image');
const { extractAudio } = require('./extractors/audio');

const EXT_TO_FORMAT = {
  '.pdf': 'pdf',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.txt': 'text',
  '.md': 'markdown',
  '.mp3': 'audio',
  '.wav': 'audio',
  '.m4a': 'audio',
  '.ogg': 'audio',
  '.opus': 'audio',
};

function formatFor(absPath) {
  return EXT_TO_FORMAT[path.extname(absPath).toLowerCase()] || null;
}

async function extract(absPath) {
  const fmt = formatFor(absPath);
  if (!fmt) throw new Error(`unsupported format: ${path.extname(absPath).toLowerCase() || '(none)'}`);
  let result;
  switch (fmt) {
    case 'pdf':      result = await extractPdf(absPath); break;
    case 'image':    result = await extractImage(absPath); break;
    case 'text':
    case 'markdown': result = await extractText(absPath); break;
    case 'audio':    result = await extractAudio(absPath); break;
  }
  return { text: result.text, sourceFormat: fmt };
}

module.exports = { extract, formatFor, EXT_TO_FORMAT };
