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
  computeUnwitnessed, witnessOrNull, visionFailureReason, UNWITNESSED_CAP,
} = require('../ingest/reader');
const { rungFor } = require('../ingest/extract');

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

describe('#688 a blind witness is discarded, not amplified', () => {
  const table = 'Hb 152 g/L (130-180) WCC 6.4 Plt 289 Ferritin 27 TSH 2.4 CRP 1.8';

  test('a witness that read only the headings is discarded to null', () => {
    assert.equal(witnessOrNull(table, 'Hb WCC Plt Ferritin TSH CRP'), null);
  });

  test('a witness that corroborates most numbers keeps its targeted flags', () => {
    const witness = 'Hb 152 g/L (130-180) WCC 6.4 Plt 289 Ferritin 21 TSH 2.4 CRP 1.8';
    assert.deepEqual(witnessOrNull(table, witness), ['27']);
  });

  test('a fully corroborating witness returns the empty list, never null', () => {
    assert.deepEqual(witnessOrNull(table, table), []);
  });

  test('a document with too few numbers never triggers the blindness rule', () => {
    // 2 tokens, both unwitnessed: below the floor, so the flags stand.
    assert.deepEqual(witnessOrNull('dose 5 mg then 10 mg', 'dose mg then mg'), ['5', '10']);
  });

  test('the ratio is measured uncapped, so a long blind read still discards', () => {
    const vision = Array.from({ length: 200 }, (_, i) => 1000 + i).join(' ');
    // A witness that saw only the first 60: 140/200 uncorroborated. The capped
    // list would be 40/200 = 20% and would wrongly look targeted.
    const witness = Array.from({ length: 60 }, (_, i) => 1000 + i).join(' ');
    assert.equal(witnessOrNull(vision, witness), null);
  });

  test('more flags than the display cap is discarded, never silently truncated (#689)', () => {
    // 41/100 flagged: under the blindness ratio but past the 40-token cap; a
    // truncated list would render token 41 as corroborated.
    const vision = Array.from({ length: 100 }, (_, i) => 1000 + i).join(' ');
    const witness = Array.from({ length: 59 }, (_, i) => 1000 + i).join(' ');
    assert.equal(witnessOrNull(vision, witness), null);
  });

  test('page scaffolding cannot corroborate a misread (#689)', () => {
    // Vision misreads a value as '18' on an 18+ page document: the witness
    // text contains '--- page 18 ---' but never the number in page content.
    const vision = 'Hb 18 g/L x 152 y 289 z 27 w 2.4';
    const witness = '--- page 18 ---\n\nHb 11.8 g/L x 152 y 289 z 27 w 2.4';
    assert.deepEqual(witnessOrNull(vision, witness), ['18']);
  });

  test('the truncation note cannot corroborate either (#689)', () => {
    const vision = 'count 34 a 1 b 2 c 3 d 4';
    const witness = 'a 1 b 2 c 3 d 4\n--- truncated ---\n\nOnly the first 20 of 34 pages were processed. The rest of this document was not read.';
    assert.deepEqual(witnessOrNull(vision, witness), ['34']);
  });
});

describe('#687 the legacy psm argument keeps meaning a tesseract rung', () => {
  test('a bare psm maps to the tesseract rung it always meant', () => {
    assert.deepEqual(rungFor('image', { psm: 6 }), { reader: 'tesseract', psm: 6 });
    assert.deepEqual(rungFor('pdf', { psm: 4 }), { reader: 'tesseract', psm: 4 });
  });

  test('an explicit rung outranks the legacy spelling', () => {
    assert.deepEqual(rungFor('image', { rung: { reader: 'vision' }, psm: 6 }), { reader: 'vision' });
  });

  test('formats that are never re-read resolve to no rung at all', () => {
    assert.equal(rungFor('text', { psm: 6 }), null);
    assert.equal(rungFor('docx', {}), null);
  });

  test('no rung and no psm falls back to the reader default', () => {
    const r = rungFor('image', {});
    assert.ok(r && (r.reader === 'vision' || (r.reader === 'tesseract' && r.psm === 3)));
  });
});

describe('#680 vision failure reasons', () => {
  test('each failure class maps to a distinct human phrase', () => {
    assert.match(visionFailureReason(new Error('vision_unsupported: x')), /rejects image input/);
    assert.match(visionFailureReason(new Error('vision_truncated: x')), /overflowed/);
    assert.match(visionFailureReason(new Error('vision_disabled: x')), /KLEBB_OCR_MODE=local/);
    assert.match(visionFailureReason(new Error('vision_incomplete: x')), /cut a page short/);
    assert.match(visionFailureReason(new Error('vision_empty: x')), /came back empty/);
    assert.match(visionFailureReason(new Error('vision_parse: x')), /unreadable/);
    assert.match(visionFailureReason(new Error('gateway_budget: Budget has been exceeded!')), /allowance/);
    assert.match(visionFailureReason(new Error('gateway_timeout')), /timed out/);
    assert.match(visionFailureReason(new Error('gateway_unavailable: ECONNREFUSED')), /unreachable/);
    // A bare 429 is rate limiting, never an exhausted allowance.
    assert.match(visionFailureReason(new Error('gateway_http_429: slow down')), /unreachable/);
  });
});
