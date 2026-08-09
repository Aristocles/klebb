// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// ingest/extractors/image.js
// Tesseract OCR for image reports.

const { spawn } = require('child_process');

// Page segmentation modes, in the order a human retrying a bad scan should
// walk them:
//   3 — fully automatic, no orientation detection. Tesseract's own default,
//       and the right first guess for a photo of a document.
//   6 — assume one uniform block of text. Usually the winner on a lab table,
//       where mode 3 hunts for columns and shreds the rows.
//   4 — assume a single column of variable-sized text. Helps on letters where
//       mode 6 runs lines together.
//
// Deliberately NOT auto-trying all three and scoring: that triples OCR time on
// every upload, and any scoring heuristic can prefer the worse output. The
// human comparing OCR text against the original image is the scorer.
const PSM_LADDER = Object.freeze([3, 6, 4]);

// Next rung for a "retry OCR" action; the top rung is a fixed point.
function nextPsm(current) {
  const i = PSM_LADDER.indexOf(Number(current));
  if (i === -1) return PSM_LADDER[1];
  return PSM_LADDER[Math.min(i + 1, PSM_LADDER.length - 1)];
}

// Tesseract's CLI is positional-then-flags and fussy about it:
//   tesseract <in> <out> [-l lang] [--psm N] [-c key=value]
// --psm takes its value as a separate token; `--psm=6` is rejected outright as
// an unknown argument.
function tesseractArgs(absPath, psm) {
  return [
    absPath,
    'stdout',
    '-l', 'eng',
    '--psm', String(psm),
    // Stops tesseract collapsing the run of spaces that separates columns,
    // which is the only thing keeping a lab table legible downstream.
    '-c', 'preserve_interword_spaces=1',
  ];
}

function extractImage(absPath, { psm = PSM_LADDER[0] } = {}) {
  const effectivePsm = PSM_LADDER.includes(Number(psm)) ? Number(psm) : PSM_LADDER[0];
  return new Promise((resolve, reject) => {
    const proc = spawn('tesseract', tesseractArgs(absPath, effectivePsm), { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    let stderr = '';
    proc.stdout.on('data', c => out.push(c));
    proc.stderr.on('data', c => stderr += c.toString());
    proc.on('error', e => reject(new Error(`tesseract spawn failed: ${e.message}`)));
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(`tesseract exit ${code}: ${stderr.slice(0, 300)}`));
      resolve({
        text: Buffer.concat(out).toString('utf8'),
        psm: effectivePsm,
        ladderIndex: PSM_LADDER.indexOf(effectivePsm),
      });
    });
  });
}

module.exports = { extractImage, PSM_LADDER, nextPsm, tesseractArgs };
