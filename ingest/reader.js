// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// ingest/reader.js
// Which reader gets a photo or scan, and what the next attempt should be.
//
// A rung is { reader: 'vision' } or { reader: 'tesseract', psm }. The ladder
// is vision first, then the tesseract page-segmentation walk, and the report
// remembers which rungs have already produced text (`ocr_attempts`), so a
// document first read by tesseract because the gateway happened to be down
// can still be retried with vision once it is back. Only rungs that PRODUCED
// text count as attempted: a transient vision failure stays retryable.

const ENV = require('../config/env');
const { classifyGatewayError } = require('../lib/gateway');
const { visionAvailable } = require('./extractors/vision');
const { numericTokens } = require('./comprehend');

const RUNGS = Object.freeze(['vision', 3, 6, 4]);
const UNWITNESSED_CAP = 40;

function _asRung(entry) {
  return entry === 'vision' ? { reader: 'vision' } : { reader: 'tesseract', psm: entry };
}

function rungLabel(rung) {
  return rung.reader === 'vision' ? 'vision' : String(rung.psm);
}

// The overrides exist for tests; callers in the app pass nothing.
function visionEligible({ mode = ENV.OCR_MODE, available = visionAvailable() } = {}) {
  return mode === 'auto' && available;
}

function defaultRung(opts) {
  return visionEligible(opts) ? { reader: 'vision' } : { reader: 'tesseract', psm: 3 };
}

// Rung labels already tried, from a parsed report header. Legacy reports
// carry no attempts list; their recorded psm was reached by walking the old
// 3 -> 6 -> 4 ladder, so every earlier rung is implied. Without that, a
// report parked at the old top rung would be offered psm 3 "as new" and the
// fixed point the retry button relies on would wrap.
function attemptsFrom(header) {
  if (Array.isArray(header?.ocrAttempts) && header.ocrAttempts.length) {
    return header.ocrAttempts.map(String);
  }
  if (header?.readBy === 'vision') return ['vision'];
  if (Number.isInteger(header?.ocrPsm)) {
    const walk = [3, 6, 4];
    const i = walk.indexOf(header.ocrPsm);
    return (i === -1 ? [header.ocrPsm] : walk.slice(0, i + 1)).map(String);
  }
  return [];
}

// First untried rung, in ladder order; the bottom tesseract rung is a fixed
// point once everything has been walked.
function nextRung(header, opts) {
  const attempted = new Set(attemptsFrom(header));
  const ladder = visionEligible(opts) ? RUNGS : RUNGS.slice(1);
  for (const entry of ladder) {
    if (!attempted.has(String(entry))) return _asRung(entry);
  }
  return { reader: 'tesseract', psm: 4 };
}

// Numbers the vision transcription contains that local OCR could not see.
// The witness is advisory: tesseract misses digits routinely, so this never
// gates anything; it aims the human's eye during verification.
function computeUnwitnessed(visionText, witnessText) {
  const witness = numericTokens(witnessText);
  const out = [];
  for (const [token] of numericTokens(visionText)) {
    if (!witness.has(token)) {
      out.push(token);
      if (out.length >= UNWITNESSED_CAP) break;
    }
  }
  return out;
}

// A witness that fails to corroborate most of what the model read is not
// witnessing (a low-resolution photo local OCR cannot read is precisely the
// document vision exists for). Highlighting every number reads as targeted
// suspicion and buries the real signal, so a mostly-blind witness is
// discarded: null means "no witness", which the verify screen already
// renders as "check every value". The ratio is measured uncapped; the
// returned list stays capped.
const WITNESS_BLIND_RATIO = 0.6;
const WITNESS_MIN_TOKENS = 5;

function witnessOrNull(visionText, witnessText) {
  const witness = numericTokens(witnessText);
  const vision = numericTokens(visionText);
  let flagged = 0;
  for (const [token] of vision) {
    if (!witness.has(token)) flagged++;
  }
  if (vision.size >= WITNESS_MIN_TOKENS && flagged / vision.size > WITNESS_BLIND_RATIO) {
    console.warn(`[ingest] witness corroborated ${vision.size - flagged}/${vision.size} numbers; discarding it as blind`);
    return null;
  }
  return computeUnwitnessed(visionText, witnessText);
}

// One short human phrase for why a vision read did not happen, recorded in
// the report's reason field next to "read by local OCR".
function visionFailureReason(err) {
  const msg = String((err && err.message) || err || '');
  if (msg.startsWith('vision_unsupported')) return 'the gateway model rejects image input';
  if (msg.startsWith('vision_truncated')) return 'a page transcription overflowed';
  if (msg.startsWith('vision_parse')) return 'the gateway returned an unreadable reply';
  const cause = classifyGatewayError(err);
  if (cause === 'budget') return "this month's AI allowance is used up";
  if (cause === 'timeout') return 'the gateway timed out';
  return 'the gateway was unreachable';
}

module.exports = {
  RUNGS,
  UNWITNESSED_CAP,
  rungLabel,
  visionEligible,
  defaultRung,
  attemptsFrom,
  nextRung,
  computeUnwitnessed,
  witnessOrNull,
  visionFailureReason,
};
