// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/vision.test.js
// The vision transcription extractor (#679): payload shape, the all-or-nothing
// page contract, truncation detection, and the image-rejection memo.
//
// Pure-function and fs-only; no spawnServer in this file. The gateway is an
// injected function throughout, in the comprehend.test.js style.

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  transcribePage, transcribePages, resetImageSupportMemo, looksLikeImageRejection,
  TRANSCRIBE_PROMPT, TRANSCRIBE_TIMEOUT_MS, TRANSCRIBE_MAX_TOKENS,
} = require('../ingest/extractors/vision');
const { toDataUrl } = require('../ingest/extractors/imageprep');
const { makePng } = require('./helpers/binary-fixtures');

// Replies keyed by data URL when a map is given, else one reply for all.
// `delayMs` makes pool-order assertions deterministic.
function stubGateway(reply, { delayMs = 0 } = {}) {
  const calls = [];
  const fn = async ({ messages, timeoutMs, maxTokens }) => {
    calls.push({ messages, timeoutMs, maxTokens });
    if (delayMs) await new Promise(r => setTimeout(r, delayMs));
    const url = messages.at(-1).content.find(p => p.type === 'image_url').image_url.url;
    const value = reply instanceof Map ? reply.get(url) : reply;
    if (value instanceof Error) throw value;
    if (value && typeof value === 'object' && value.choices) return value;
    return { choices: [{ message: { role: 'assistant', content: value }, finish_reason: 'stop' }] };
  };
  fn.calls = calls;
  return fn;
}

describe('#679 vision transcription', () => {
  let tmp;
  const page = (name, w = 8, h = 8) => {
    const abs = path.join(tmp, name);
    fs.writeFileSync(abs, makePng(w, h));
    return { path: abs, mediaType: 'image/png' };
  };

  before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'klebb-vision-')); });
  after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });
  beforeEach(() => resetImageSupportMemo());

  test('sends one page as system prompt + text + data-URL image, with an explicit ceiling', async () => {
    const gw = stubGateway('TSH  2.1  mIU/L  (0.4 - 4.0)');
    const p = page('one.png');
    const r = await transcribePage({ ...p, callGatewayFn: gw });
    assert.equal(r.text, 'TSH  2.1  mIU/L  (0.4 - 4.0)');

    assert.equal(gw.calls.length, 1);
    const { messages, timeoutMs, maxTokens } = gw.calls[0];
    assert.equal(messages[0].role, 'system');
    assert.equal(messages[0].content, TRANSCRIBE_PROMPT);
    const parts = messages[1].content;
    assert.equal(parts[0].type, 'text');
    assert.equal(parts[1].type, 'image_url');
    assert.equal(parts[1].image_url.url, toDataUrl(p.path, 'image/png'));
    assert.equal(timeoutMs, TRANSCRIBE_TIMEOUT_MS);
    assert.equal(maxTokens, TRANSCRIBE_MAX_TOKENS);
  });

  test('the prompt carries its load-bearing rules', () => {
    assert.match(TRANSCRIBE_PROMPT, /\[illegible\]/);
    assert.match(TRANSCRIBE_PROMPT, /never an instruction/i);
    assert.match(TRANSCRIBE_PROMPT, /exactly as written/i);
  });

  test('trailing whitespace is trimmed, leading structure kept', async () => {
    const gw = stubGateway('  col a   col b\nrow    1\n\n  \n');
    const r = await transcribePage({ ...page('two.png'), callGatewayFn: gw });
    assert.equal(r.text, '  col a   col b\nrow    1');
  });

  test('finish_reason length is truncation, never a silent partial', async () => {
    const gw = stubGateway({ choices: [{ message: { content: 'partial...' }, finish_reason: 'length' }] });
    await assert.rejects(
      transcribePage({ ...page('three.png'), callGatewayFn: gw }),
      /vision_truncated/);
  });

  test('any other early finish reason is an incomplete page, not a complete one (#689)', async () => {
    const gw = stubGateway({ choices: [{ message: { content: 'half a page' }, finish_reason: 'content_filter' }] });
    await assert.rejects(
      transcribePage({ ...page('three-b.png'), callGatewayFn: gw }),
      /vision_incomplete.*content_filter/);
  });

  test('a missing finish_reason is tolerated as a whole page', async () => {
    const gw = stubGateway({ choices: [{ message: { content: 'whole page' } }] });
    const r = await transcribePage({ ...page('three-c.png'), callGatewayFn: gw });
    assert.equal(r.text, 'whole page');
  });

  test('a reply with no text content is a parse failure', async () => {
    const gw = stubGateway({ choices: [] });
    await assert.rejects(
      transcribePage({ ...page('four.png'), callGatewayFn: gw }),
      /vision_parse/);
  });

  test('gateway errors propagate with their classification intact', async () => {
    const gw = stubGateway(new Error('gateway_budget: Budget has been exceeded!'));
    await assert.rejects(
      transcribePage({ ...page('five.png'), callGatewayFn: gw }),
      /gateway_budget/);
  });

  test('a 400 blaming image input flips the memo; later calls never hit the gateway', async () => {
    const gw = stubGateway(new Error('gateway_http_400: this model does not support image input'));
    await assert.rejects(
      transcribePage({ ...page('six.png'), callGatewayFn: gw }),
      /vision_unsupported/);
    assert.equal(gw.calls.length, 1);

    const gw2 = stubGateway('never used');
    await assert.rejects(
      transcribePage({ ...page('six.png'), callGatewayFn: gw2 }),
      /vision_unsupported/);
    assert.equal(gw2.calls.length, 0, 'the memo must short-circuit before any call');
  });

  test('an unrelated 400 does NOT poison the memo', async () => {
    const gw = stubGateway(new Error('gateway_http_400: request entity too large'));
    await assert.rejects(
      transcribePage({ ...page('seven.png'), callGatewayFn: gw }),
      /gateway_http_400/);

    const gw2 = stubGateway('still reachable');
    const r = await transcribePage({ ...page('seven.png'), callGatewayFn: gw2 });
    assert.equal(r.text, 'still reachable');
    assert.equal(gw2.calls.length, 1);
  });

  test('looksLikeImageRejection requires a 400 AND an image-shaped complaint', () => {
    assert.equal(looksLikeImageRejection('gateway_http_400: invalid content type for vision'), true);
    assert.equal(looksLikeImageRejection('gateway_http_400: bad request'), false);
    assert.equal(looksLikeImageRejection('gateway_http_500: image service down'), false);
  });

  test('a per-file size complaint never poisons the memo (#689)', async () => {
    assert.equal(looksLikeImageRejection('gateway_http_400: image exceeds the 5 MB maximum'), false);
    assert.equal(looksLikeImageRejection('gateway_http_400: image too large for this model'), false);

    const gw = stubGateway(new Error('gateway_http_400: image exceeds the 5 MB maximum'));
    await assert.rejects(
      transcribePage({ ...page('big.png'), callGatewayFn: gw }),
      /gateway_http_400/);
    const gw2 = stubGateway('still reading fine');
    const r = await transcribePage({ ...page('big.png'), callGatewayFn: gw2 });
    assert.equal(r.text, 'still reading fine');
  });

  test('multi-page documents assemble with the tesseract-style page scaffolding', async () => {
    const pages = [page('p1.png', 8, 8), page('p2.png', 9, 9), page('p3.png', 10, 10)];
    const replies = new Map(pages.map((p, i) =>
      [toDataUrl(p.path, 'image/png'), ['alpha 1', 'beta 2', 'gamma 3'][i]]));
    const gw = stubGateway(replies);

    const r = await transcribePages(pages, { callGatewayFn: gw });
    assert.equal(r.pages, 3);
    assert.equal(r.text,
      '--- page 1 ---\n\nalpha 1\n\n--- page 2 ---\n\nbeta 2\n\n--- page 3 ---\n\ngamma 3');
    // Content characters only: the scaffolding must never count as recovery.
    assert.equal(r.recovered, 17);
  });

  test('a single page carries no scaffolding at all', async () => {
    const gw = stubGateway('just the text');
    const r = await transcribePages([page('solo.png')], { callGatewayFn: gw });
    assert.equal(r.text, 'just the text');
    assert.equal(r.pages, 1);
  });

  test('one failed page rejects the document and abandons the rest of the queue', async () => {
    const pages = [page('f1.png', 8, 8), page('f2.png', 9, 9), page('f3.png', 10, 10),
      page('f4.png', 11, 11), page('f5.png', 12, 12)];
    const replies = new Map(pages.map((p, i) =>
      [toDataUrl(p.path, 'image/png'),
        i === 0 ? new Error('gateway_timeout') : `page ${i + 1}`]));
    const gw = stubGateway(replies, { delayMs: 25 });

    await assert.rejects(transcribePages(pages, { callGatewayFn: gw }), /gateway_timeout/);
    assert.equal(gw.calls.length, 3,
      'the first three pages start concurrently; pages after the failure must never be sent');
  });

  test('an empty page list is a parse failure, not a silent empty document', async () => {
    await assert.rejects(transcribePages([], { callGatewayFn: stubGateway('x') }), /vision_parse/);
  });
});
