// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// ingest/extractors/image.js
// Reading image reports: vision transcription through the gateway on the
// vision rung, tesseract OCR on the local rungs and as the fallback. When
// vision produced the text and tesseract is present, tesseract still reads
// the original as a witness, so the verify screen can point at numbers local
// OCR could not corroborate.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

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

// Bounded: a wedged tesseract would otherwise hold the ingest queue's single
// slot for the rest of the process's uptime, with nothing in the UI to explain
// why no later upload is being read.
const SPAWN_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 20 * 1024 * 1024;

function extractImage(absPath, { psm = PSM_LADDER[0] } = {}) {
  const effectivePsm = PSM_LADDER.includes(Number(psm)) ? Number(psm) : PSM_LADDER[0];
  return new Promise((resolve, reject) => {
    const proc = spawn('tesseract', tesseractArgs(absPath, effectivePsm), {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: SPAWN_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    const out = [];
    let stderr = '';
    let bytes = 0;
    proc.stdout.on('data', c => {
      bytes += c.length;
      if (bytes <= MAX_OUTPUT_BYTES) out.push(c);
    });
    proc.stderr.on('data', c => { if (stderr.length < 4000) stderr += c.toString(); });
    proc.on('error', e => reject(new Error(`tesseract spawn failed: ${e.message}`)));
    proc.on('close', (code, signal) => {
      if (signal === 'SIGKILL') {
        return reject(new Error(`tesseract timed out after ${Math.round(SPAWN_TIMEOUT_MS / 1000)}s and was killed`));
      }
      if (code !== 0) return reject(new Error(`tesseract exit ${code}: ${stderr.slice(0, 300)}`));
      resolve({
        text: Buffer.concat(out).toString('utf8'),
        psm: effectivePsm,
        ladderIndex: PSM_LADDER.indexOf(effectivePsm),
      });
    });
  });
}

let _tesseractProbe = null;
function hasTesseract() {
  if (_tesseractProbe === null) {
    const probe = spawnSync('tesseract', ['--version'], { stdio: 'ignore' });
    _tesseractProbe = !probe.error;
  }
  return _tesseractProbe;
}

// Read one image document at the given rung. Requiring these lazily keeps
// the module graph acyclic (reader.js knows nothing about extractors' guts,
// but this orchestration needs reader.js's witness diff).
function _deps() {
  return {
    vision: require('./vision'),
    imageprep: require('./imageprep'),
    reader: require('../reader'),
  };
}

async function _tesseractRead(absPath, psm, fallbackReason) {
  const r = await extractImage(absPath, { psm });
  return {
    text: r.text,
    psm: r.psm,
    readBy: 'tesseract',
    reason: fallbackReason || null,
  };
}

// rung: { reader: 'vision' } or { reader: 'tesseract', psm }. A failed vision
// attempt falls back to the base tesseract rung with the reason recorded; a
// box with neither reader available fails the document with both causes named,
// so the .error sidecar explains itself.
async function readImage(absPath, { rung } = {}) {
  const effective = rung || { reader: 'tesseract', psm: PSM_LADDER[0] };
  if (effective.reader !== 'vision') {
    return _tesseractRead(absPath, effective.psm);
  }

  const { vision, imageprep, reader } = _deps();
  // A failure that is a property of the DOCUMENT (a page overflowing the
  // transcription ceiling, a filtered or empty read) will fail identically on
  // every retry; recording the vision rung as attempted stops the ladder
  // offering an attempt that only burns allowance. Transport failures stay
  // unrecorded so vision remains retryable once the gateway is back.
  const fallback = async (why, cause) => {
    const note = `vision read unavailable (${why}); read by local OCR`;
    const deterministic = /^vision_(?:truncated|incomplete|empty)/.test(String((cause && cause.message) || ''));
    try {
      const read = await _tesseractRead(absPath, PSM_LADDER[0], note);
      return deterministic ? { ...read, visionDeterministic: true } : read;
    } catch (e) {
      throw new Error(`vision read failed (${why}) and local OCR failed: ${e.message}`);
    }
  };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'klebb-vision-'));
  try {
    const prep = await imageprep.prepareImage(absPath, tmp);
    if (!prep.ok) return await fallback(prep.reason);

    let transcribed;
    try {
      transcribed = await vision.transcribePages([{ path: prep.path, mediaType: prep.mediaType }]);
      if (!transcribed.text.trim()) {
        // An empty reading is far more often a filter or model artefact than
        // a genuinely blank upload; publishing it would replace real content
        // with nothing on a re-read.
        throw new Error('vision_empty: the vision read came back empty');
      }
    } catch (e) {
      return await fallback(reader.visionFailureReason(e), e);
    }

    // The witness reads the ORIGINAL at full resolution, not the downscaled
    // copy: its whole value is an independent opinion about the digits.
    let unwitnessed = null;
    if (hasTesseract()) {
      try {
        const w = await extractImage(absPath, { psm: PSM_LADDER[0] });
        unwitnessed = reader.witnessOrNull(transcribed.text, w.text);
      } catch (e) {
        console.warn(`[ingest] witness OCR failed (${e.message}); vision text stands uncorroborated`);
      }
    }
    return { text: transcribed.text, readBy: 'vision', unwitnessed };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

module.exports = {
  extractImage, readImage, hasTesseract,
  PSM_LADDER, nextPsm, tesseractArgs, SPAWN_TIMEOUT_MS,
};
