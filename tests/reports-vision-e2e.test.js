// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/reports-vision-e2e.test.js
//
// The vision reading path through the real pipeline (#680): upload endpoint,
// queue, reader selection, transcription against a stub gateway, provenance
// on disk, fallback and the process-lifetime image-rejection memo, and the
// local mode that must never let a page image leave the box.
//
// Some outcomes legitimately differ with tesseract installed or absent (the
// fallback reader either produces a report or fails the file); those forks
// assert BOTH branches explicitly rather than guarding themselves green.
//
// spawnServer only in this file.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');
const {
  createSandbox, cleanupSandbox, spawnServer, fakeAuthState, req,
} = require('./helpers/sandbox');
const { parseReportHeader } = require('../ingest/catalogue');
const { makePng } = require('./helpers/binary-fixtures');

function which(bin) {
  return spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin]).status === 0;
}
const HAS_TESSERACT = which('tesseract');

const TRANSCRIPT = [
  'THYROID FUNCTION',
  'TSH 2.1 mIU/L (0.4 - 4.0)',
  'Free T4 14 pmol/L (9 - 19)',
].join('\n');

// The digest body only quotes numbers the transcript contains, so the
// numeric-fidelity gate passes and the report publishes as ready.
const DIGEST = JSON.stringify({
  title: 'Thyroid function panel',
  document_date: '2026-03-12',
  bullets: ['TSH 2.1 mIU/L, in range'],
  relevance: 'health',
  body: TRANSCRIPT,
});

const isTranscription = (parsed) =>
  typeof parsed?.messages?.[0]?.content === 'string'
  && parsed.messages[0].content.startsWith('You transcribe');

// One stub speaking both dialects: transcription requests get the queued
// transcript (or a 400 when the test plays a text-only model), everything
// else gets the comprehension digest.
function startVisionStub() {
  const seen = [];
  const state = { transcript: TRANSCRIPT, rejectImages: false };
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', c => { body += c; });
    request.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch {}
      seen.push(parsed);
      if (isTranscription(parsed) && state.rejectImages) {
        response.writeHead(400, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'This model does not support image input' } }));
        return;
      }
      const content = isTranscription(parsed) ? state.transcript : DIGEST;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
      }));
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
      seen,
      state,
      transcriptionCalls: () => seen.filter(isTranscription).length,
      close: () => new Promise(r => server.close(r)),
    }));
  });
}

function upload(baseUrl, filename, body, cookie) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const r = http.request(new URL('/api/reports/upload', baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': payload.length,
        'X-Klebb-Filename': encodeURIComponent(filename),
        ...(cookie ? { Cookie: cookie } : {}),
      },
    }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch {}
        resolve({ status: res.statusCode, body: buf, json });
      });
    });
    r.on('error', reject);
    r.setTimeout(20000, () => r.destroy(new Error('request timeout')));
    r.write(payload);
    r.end();
  });
}

async function waitFor(predicate, { timeoutMs = 20000, intervalMs = 120 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await predicate();
    if (r) return r;
    await new Promise(res => setTimeout(res, intervalMs));
  }
  return null;
}

// A file settles as either a parsed report or a _failed entry; waiting on
// both outcomes keeps the binary-dependent forks below honest.
function waitForSettled(sandbox, stem) {
  return waitFor(() => {
    const dir = path.join(sandbox, 'reports');
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.md') || !f.includes(stem)) continue;
      const body = fs.readFileSync(path.join(dir, f), 'utf8');
      const header = parseReportHeader(body);
      if (header) return { kind: 'report', name: f.replace(/\.md$/, ''), body, header };
    }
    const failedDir = path.join(sandbox, 'inbox', '_failed');
    const entries = fs.existsSync(failedDir) ? fs.readdirSync(failedDir) : [];
    for (const f of entries) {
      if (f.endsWith('.error') || !f.includes(stem)) continue;
      let error = null;
      try { error = fs.readFileSync(path.join(failedDir, `${f}.error`), 'utf8'); } catch {}
      if (error) return { kind: 'failed', filename: f, error };
    }
    return null;
  });
}

describe('#680 vision reading through the pipeline', () => {
  let sandbox, server, auth, gw;

  before(async () => {
    gw = await startVisionStub();
    auth = fakeAuthState();
    sandbox = createSandbox({ credentials: auth.credentials, sessions: auth.sessions });
    server = await spawnServer(sandbox, {
      CHAT_ENDPOINT_URL: gw.url,
      CHAT_API_KEY: 'stub-key',
      CHAT_MODEL: 'stub-model',
    });
  });
  after(async () => {
    if (server) await server.kill();
    if (gw) await gw.close();
    if (sandbox) cleanupSandbox(sandbox);
  });

  test('a photo is read by vision, recorded as such, and still gated for verification', async () => {
    const r = await upload(server.baseUrl, 'thyroid.png', makePng(64, 64), auth.cookie);
    assert.equal(r.status, 202, r.body);

    const settled = await waitForSettled(sandbox, 'thyroid');
    assert.ok(settled, 'the upload never settled');
    assert.equal(settled.kind, 'report', settled.error || '');
    const { header } = settled;
    assert.equal(header.readBy, 'vision');
    assert.equal(header.verify, 'required', 'a vision read must stay behind the human gate');
    assert.equal(header.status, 'ready');
    assert.equal(header.sourceFormat, 'image');
    assert.deepEqual(header.ocrAttempts, ['vision']);
    assert.equal(header.ocrPsm, null, 'no tesseract rung was used');
    assert.ok(settled.body.includes('TSH 2.1'), 'the digest body must carry the transcript');

    if (HAS_TESSERACT) {
      assert.ok(Array.isArray(header.unwitnessed), 'with tesseract present the witness must run');
      assert.ok(header.unwitnessed.includes('2.1'),
        'a blank witness page cannot corroborate the transcript numbers');
    } else {
      assert.equal(header.unwitnessed, null, 'without tesseract there is no witness line');
    }

    assert.equal(gw.transcriptionCalls(), 1, 'one page, one transcription call');
    const tx = gw.seen.find(isTranscription);
    const parts = tx.messages.at(-1).content;
    assert.equal(parts[0].type, 'text');
    assert.equal(parts[1].type, 'image_url');
    assert.ok(parts[1].image_url.url.startsWith('data:image/png;base64,'));
    assert.equal(tx.max_tokens, 8000, 'the transcription ceiling must reach the wire');

    const comprehension = gw.seen.find(p => !isTranscription(p));
    assert.ok(comprehension, 'the digest pass must still run');
    const userMsg = comprehension.messages.find(m => m.role === 'user');
    assert.match(userMsg.content, /vision model/,
      'comprehension must be told the text came from a vision read');
  });

  test('the envelope exposes provenance and names the next rung', async () => {
    const list = await req(server.baseUrl, '/api/reports', { cookie: auth.cookie });
    assert.equal(list.status, 200);
    const rep = list.json.reports.find(x => x.name.includes('thyroid'));
    assert.ok(rep, 'the vision report must be listed');
    assert.equal(rep.readBy, 'vision');
    assert.equal(rep.nextRead, '3', 'vision already produced this text, so the next rung is psm 3');
    if (HAS_TESSERACT) assert.ok(Array.isArray(rep.unwitnessed));
    else assert.equal(rep.unwitnessed, null);
  });

  test('a seeded header round-trips its witness tokens to the client', async () => {
    fs.writeFileSync(path.join(sandbox, 'reports', 'seeded-witness.md'), [
      '---', 'klebb_ingest: v2', 'source_file: seeded-witness.png', 'source_format: image',
      'ingested_at: 2026-09-06T01:02:03Z', 'archive_path: reports/_archive/seeded-witness.png',
      'status: ready', 'verify: required', 'read_by: vision', 'ocr_attempts: vision',
      'unwitnessed: 7.2 147', '---', '', '# Seeded', '', 'Glucose 7.2 then 147',
    ].join('\n'));
    const list = await req(server.baseUrl, '/api/reports', { cookie: auth.cookie });
    const rep = list.json.reports.find(x => x.name === 'seeded-witness');
    assert.deepEqual(rep.unwitnessed, ['7.2', '147']);
    assert.equal(rep.readBy, 'vision');
  });
});

describe('#680 a text-only model flips the memo once, never per upload', () => {
  let sandbox, server, auth, gw;

  before(async () => {
    gw = await startVisionStub();
    gw.state.rejectImages = true;
    auth = fakeAuthState();
    sandbox = createSandbox({ credentials: auth.credentials, sessions: auth.sessions });
    server = await spawnServer(sandbox, {
      CHAT_ENDPOINT_URL: gw.url,
      CHAT_API_KEY: 'stub-key',
      CHAT_MODEL: 'stub-model',
    });
  });
  after(async () => {
    if (server) await server.kill();
    if (gw) await gw.close();
    if (sandbox) cleanupSandbox(sandbox);
  });

  test('the first upload falls back with the reason recorded; the second never calls out', async () => {
    const first = await upload(server.baseUrl, 'first.png', makePng(48, 48), auth.cookie);
    assert.equal(first.status, 202);
    const settledFirst = await waitForSettled(sandbox, 'first');
    assert.ok(settledFirst, 'first upload never settled');

    if (HAS_TESSERACT) {
      assert.equal(settledFirst.kind, 'report');
      assert.equal(settledFirst.header.readBy, 'tesseract');
      assert.match(String(settledFirst.header.reason), /vision read unavailable/);
      assert.match(String(settledFirst.header.reason), /rejects image input/);
      assert.equal(settledFirst.header.unwitnessed, null,
        'the witness only checks vision reads');
    } else {
      assert.equal(settledFirst.kind, 'failed');
      assert.match(settledFirst.error, /rejects image input/);
      assert.match(settledFirst.error, /local OCR failed/);
    }

    const second = await upload(server.baseUrl, 'second.png', makePng(48, 48), auth.cookie);
    assert.equal(second.status, 202);
    const settledSecond = await waitForSettled(sandbox, 'second');
    assert.ok(settledSecond, 'second upload never settled');

    assert.equal(gw.transcriptionCalls(), 1,
      'the image-rejection memo must stop the second upload paying a failed call');
  });
});

describe('#680 local mode never sends a page image anywhere', () => {
  let sandbox, server, auth, gw;

  before(async () => {
    gw = await startVisionStub();
    auth = fakeAuthState();
    sandbox = createSandbox({ credentials: auth.credentials, sessions: auth.sessions });
    server = await spawnServer(sandbox, {
      KLEBB_OCR_MODE: 'local',
      CHAT_ENDPOINT_URL: gw.url,
      CHAT_API_KEY: 'stub-key',
      CHAT_MODEL: 'stub-model',
    });
  });
  after(async () => {
    if (server) await server.kill();
    if (gw) await gw.close();
    if (sandbox) cleanupSandbox(sandbox);
  });

  test('an image upload makes zero transcription calls in local mode', async () => {
    const r = await upload(server.baseUrl, 'localmode.png', makePng(48, 48), auth.cookie);
    assert.equal(r.status, 202);
    const settled = await waitForSettled(sandbox, 'localmode');
    assert.ok(settled, 'upload never settled');

    assert.equal(gw.transcriptionCalls(), 0,
      'local mode must keep page images on the box');

    if (HAS_TESSERACT) {
      assert.equal(settled.kind, 'report');
      assert.equal(settled.header.readBy, 'tesseract');
      assert.deepEqual(settled.header.ocrAttempts, ['3']);
    } else {
      assert.equal(settled.kind, 'failed');
      assert.doesNotMatch(settled.error, /vision/,
        'local mode failures must not blame a reader that never ran');
    }
  });
});

describe('#680 an unreachable gateway falls back to local OCR', () => {
  let sandbox, server, auth;

  before(async () => {
    auth = fakeAuthState();
    sandbox = createSandbox({ credentials: auth.credentials, sessions: auth.sessions });
    // The sandbox default CHAT_ENDPOINT_URL points at a dead port: configured,
    // so the vision rung is chosen, and unreachable, so it must fall back.
    server = await spawnServer(sandbox);
  });
  after(async () => {
    if (server) await server.kill();
    if (sandbox) cleanupSandbox(sandbox);
  });

  test('the document survives on the fallback reader with the cause recorded', async () => {
    const r = await upload(server.baseUrl, 'deadgw.png', makePng(48, 48), auth.cookie);
    assert.equal(r.status, 202);
    const settled = await waitForSettled(sandbox, 'deadgw');
    assert.ok(settled, 'upload never settled');

    if (HAS_TESSERACT) {
      assert.equal(settled.kind, 'report');
      assert.equal(settled.header.readBy, 'tesseract');
      assert.match(String(settled.header.reason), /vision read unavailable/);
      assert.match(String(settled.header.reason), /unreachable/);
    } else {
      assert.equal(settled.kind, 'failed');
      assert.match(settled.error, /vision read failed/);
      assert.match(settled.error, /local OCR failed/);
    }
  });
});
