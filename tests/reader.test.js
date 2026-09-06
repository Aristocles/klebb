// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/reader.test.js
// Reader selection and the retry ladder (#680): rung defaults, attempts-aware
// walking, the witness diff, and the failure-reason mapping.
//
// Pure-function; no spawnServer in this file. Eligibility is driven through
// the explicit overrides so the process env plays no part.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  RUNGS, rungLabel, visionEligible, defaultRung, attemptsFrom, nextRung,
  computeUnwitnessed, visionFailureReason, UNWITNESSED_CAP,
} = require('../ingest/reader');

const AUTO = { mode: 'auto', available: true };
const NO_VISION = { mode: 'auto', available: false };
const LOCAL = { mode: 'local', available: true };

describe('#680 rungs and defaults', () => {
  test('the ladder is vision first, then the psm walk', () => {
    assert.deepEqual([...RUNGS], ['vision', 3, 6, 4]);
  });

  test('rungLabel round-trips both rung shapes', () => {
    assert.equal(rungLabel({ reader: 'vision' }), 'vision');
    assert.equal(rungLabel({ reader: 'tesseract', psm: 6 }), '6');
  });

  test('vision is eligible only in auto mode with a usable gateway', () => {
    assert.equal(visionEligible(AUTO), true);
    assert.equal(visionEligible(NO_VISION), false);
    assert.equal(visionEligible(LOCAL), false);
  });

  test('the default rung follows eligibility', () => {
    assert.deepEqual(defaultRung(AUTO), { reader: 'vision' });
    assert.deepEqual(defaultRung(LOCAL), { reader: 'tesseract', psm: 3 });
    assert.deepEqual(defaultRung(NO_VISION), { reader: 'tesseract', psm: 3 });
  });
});

describe('#680 attempts and the next rung', () => {
  test('a recorded attempts list wins over the legacy fields', () => {
    assert.deepEqual(attemptsFrom({ ocrAttempts: ['vision', '3'], readBy: 'tesseract', ocrPsm: 6 }),
      ['vision', '3']);
  });

  test('legacy reports reconstruct the old ladder walk up to their recorded rung', () => {
    assert.deepEqual(attemptsFrom({ readBy: 'vision', ocrPsm: null }), ['vision']);
    assert.deepEqual(attemptsFrom({ ocrPsm: 3 }), ['3']);
    assert.deepEqual(attemptsFrom({ ocrPsm: 6 }), ['3', '6']);
    assert.deepEqual(attemptsFrom({ ocrPsm: 4 }), ['3', '6', '4']);
    assert.deepEqual(attemptsFrom({}), []);
    assert.deepEqual(attemptsFrom(null), []);
  });

  test('an untried vision rung outranks the psm walk', () => {
    assert.deepEqual(nextRung({ ocrPsm: 3 }, AUTO), { reader: 'vision' });
    assert.deepEqual(nextRung({ ocrPsm: 4 }, AUTO), { reader: 'vision' });
  });

  test('after vision produced text the psm walk resumes', () => {
    assert.deepEqual(nextRung({ ocrAttempts: ['vision'] }, AUTO), { reader: 'tesseract', psm: 3 });
    assert.deepEqual(nextRung({ ocrAttempts: ['vision', '3'] }, AUTO), { reader: 'tesseract', psm: 6 });
    assert.deepEqual(nextRung({ ocrAttempts: ['vision', '3', '6'] }, AUTO), { reader: 'tesseract', psm: 4 });
  });

  test('the exhausted ladder saturates at the bottom tesseract rung', () => {
    assert.deepEqual(nextRung({ ocrAttempts: ['vision', '3', '6', '4'] }, AUTO),
      { reader: 'tesseract', psm: 4 });
  });

  test('without vision the ladder is exactly the old psm walk', () => {
    assert.deepEqual(nextRung({ ocrPsm: 3 }, LOCAL), { reader: 'tesseract', psm: 6 });
    assert.deepEqual(nextRung({ ocrPsm: 4 }, LOCAL), { reader: 'tesseract', psm: 4 });
    assert.deepEqual(nextRung({}, LOCAL), { reader: 'tesseract', psm: 3 });
  });
});

describe('#680 the witness diff', () => {
  test('numbers the witness saw are corroborated; the rest are not', () => {
    const visionText = 'TSH 2.1 mIU/L\nFerritin 88 ug/L (30-300)';
    const witnessText = 'TSH 2.l mIU/L\nFerritin 88 ug/L (30-300)'; // OCR mangled 2.1
    assert.deepEqual(computeUnwitnessed(visionText, witnessText), ['2.1']);
  });

  test('formatting differences are not disagreements', () => {
    assert.deepEqual(computeUnwitnessed('total 1,234 units 7.0', 'total 1234 units 7'), []);
  });

  test('an empty witness leaves every number uncorroborated', () => {
    assert.deepEqual(computeUnwitnessed('a 1 b 2 c 3', ''), ['1', '2', '3']);
  });

  test('identical readings corroborate everything', () => {
    assert.deepEqual(computeUnwitnessed('147 and 88', 'now 88, then 147'), []);
  });

  test('the list is capped so a pathological page cannot bloat the header', () => {
    const vision = Array.from({ length: 100 }, (_, i) => 1000 + i).join(' ');
    assert.equal(computeUnwitnessed(vision, '').length, UNWITNESSED_CAP);
  });
});

describe('#680 vision failure reasons', () => {
  test('each failure class maps to a distinct human phrase', () => {
    assert.match(visionFailureReason(new Error('vision_unsupported: x')), /rejects image input/);
    assert.match(visionFailureReason(new Error('vision_truncated: x')), /overflowed/);
    assert.match(visionFailureReason(new Error('vision_parse: x')), /unreadable/);
    assert.match(visionFailureReason(new Error('gateway_budget: Budget has been exceeded!')), /allowance/);
    assert.match(visionFailureReason(new Error('gateway_timeout')), /timed out/);
    assert.match(visionFailureReason(new Error('gateway_unavailable: ECONNREFUSED')), /unreachable/);
    // A bare 429 is rate limiting, never an exhausted allowance.
    assert.match(visionFailureReason(new Error('gateway_http_429: slow down')), /unreachable/);
  });
});
