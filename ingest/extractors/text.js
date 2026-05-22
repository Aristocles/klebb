// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// ingest/extractors/text.js
// Verbatim read of plain-text drops.

const fs = require('fs');

async function extractText(absPath) {
  return { text: fs.readFileSync(absPath, 'utf8') };
}

module.exports = { extractText };
