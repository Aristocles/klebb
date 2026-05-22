// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// ingest/extractors/image.js
// Tesseract OCR for image drops.

const { spawn } = require('child_process');

function extractImage(absPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn('tesseract', [absPath, 'stdout', '-l', 'eng'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    let stderr = '';
    proc.stdout.on('data', c => out.push(c));
    proc.stderr.on('data', c => stderr += c.toString());
    proc.on('error', e => reject(new Error(`tesseract spawn failed: ${e.message}`)));
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(`tesseract exit ${code}: ${stderr.slice(0, 300)}`));
      resolve({ text: Buffer.concat(out).toString('utf8') });
    });
  });
}

module.exports = { extractImage };
