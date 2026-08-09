// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/reports-comprehension-e2e.test.js
//
// Upload through the real pipeline with a stub gateway standing in for the
// model, so the whole chain is exercised: endpoint, queue, extract, comprehend,
// v2 frontmatter on disk.
//
// The case that matters most here is the v1 report that must keep working. A
// tightened sentinel would orphan every report already on every live instance
// plus the demo, and the only symptom would be reports quietly missing from
// chat, so it is asserted end to end and not only at the parser.
//
// spawnServer only in this file.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const {
  createSandbox, cleanupSandbox, spawnServer, fakeAuthState,
} = require('./helpers/sandbox');
const { parseReportHeader } = require('../ingest/catalogue');

const RAW_TEXT = [
  'MELBOURNE PATHOLOGY',
  'Patient: Jane Q Citizen   DOB: 04/07/1981   Medicare: 2345 67890 1',
  'Requested by: Dr Alice Whitmore, Carlton Family Practice',
  'Collected: 12/03/2026',
  'Haemoglobin 147 g/L (130-180)',
  'Ferritin 88 ug/L (30-300)',
].join('\n');

// A gateway that answers with whatever the test queues, and records what it saw.
function startStubGateway(makeReply) {
  const seen = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', c => { body += c; });
    request.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch {}
      seen.push(parsed);
      const content = makeReply(seen.length, parsed);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
      seen,
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

async function waitFor(predicate, { timeoutMs = 15000, intervalMs = 120 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await predicate();
    if (r) return r;
    await new Promise(res => setTimeout(res, intervalMs));
  }
  return null;
}

// Wait for a report whose header parses, so the assertions never race the write.
function waitForReport(sandbox, match) {
  return waitFor(() => {
    const dir = path.join(sandbox, 'reports');
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.md') || (match && !f.includes(match))) continue;
      const body = fs.readFileSync(path.join(dir, f), 'utf8');
      const header = parseReportHeader(body);
      if (header) return { name: f.replace(/\.md$/, ''), body, header };
    }
    return null;
  });
}

const DIGEST = JSON.stringify({
  title: 'Full blood count, Melbourne Pathology',
  document_date: '2026-03-12',
  bullets: ['Ferritin 88 ug/L, low end of range', 'Haemoglobin 147 g/L in range'],
  relevance: 'health',
  body: [
    'MELBOURNE PATHOLOGY',
    'Requested by: Dr Alice Whitmore, Carlton Family Practice',
    'Collected: 12/03/2026',
    'Haemoglobin 147 g/L (130-180)',
    'Ferritin 88 ug/L (30-300)',
  ].join('\n'),
});

describe('upload to v2 report, with the model stubbed', () => {
  let sandbox, server, auth, gw;

  before(async () => {
    gw = await startStubGateway(() => DIGEST);
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

  test('the report lands as v2 with a digest, and the model was actually asked', async () => {
    const r = await upload(server.baseUrl, 'bloods.txt', RAW_TEXT, auth.cookie);
    assert.equal(r.status, 202, r.body);

    const found = await waitForReport(sandbox, 'bloods');
    assert.ok(found, 'no report with a parseable header appeared');
    assert.equal(found.header.version, 2);
    assert.equal(found.header.status, 'ready');
    assert.equal(found.header.title, 'Full blood count, Melbourne Pathology');
    assert.equal(found.header.documentDate, '2026-03-12',
      'the document date must come from the text, not from today');
    assert.equal(found.header.relevance, 'health');
    assert.equal(found.header.bullets.length, 2);
    assert.ok(gw.seen.length >= 1, 'the gateway was never called');
  });

  test('the digest, not the raw text, is what the report body carries', async () => {
    const found = await waitForReport(sandbox, 'bloods');
    assert.match(found.body, /Haemoglobin 147 g\/L/);
    assert.ok(!/Jane Q Citizen/.test(found.body), 'the patient name reached the report');
    assert.ok(!/2345 67890 1/.test(found.body), 'the Medicare number reached the report');
    assert.match(found.body, /Dr Alice Whitmore/, 'the requesting doctor should be retained');
  });

  test('a text source is not gated for OCR verification', async () => {
    const found = await waitForReport(sandbox, 'bloods');
    assert.equal(found.header.verify, 'not_required');
  });

  test('the document text reaches the model fenced as data', async () => {
    const sys = gw.seen[0]?.messages?.find(m => m.role === 'system');
    const user = gw.seen[0]?.messages?.find(m => m.role === 'user');
    assert.match(sys.content, /ONLY JSON/i);
    assert.match(user.content, /<<<DOCUMENT>>>/);
    assert.match(user.content, /Haemoglobin 147 g\/L/);
  });
});

describe('a v1 report keeps working alongside v2', () => {
  let sandbox, server, auth, gw;

  before(async () => {
    gw = await startStubGateway(() => DIGEST);
    auth = fakeAuthState();
    sandbox = createSandbox({ credentials: auth.credentials, sessions: auth.sessions });
    // A report exactly as previous versions wrote them.
    fs.writeFileSync(path.join(sandbox, 'reports', '2026-05-22-legacy.md'), [
      '---',
      'klebb_ingest: v1',
      'source_file: legacy.pdf',
      'source_format: pdf',
      'ingested_at: 2026-05-22T14:07:33Z',
      'archive_path: reports/_archive/legacy.pdf',
      '---',
      '',
      '# 2026-05-22-legacy',
      '',
      'Legacy cholesterol 4.8 mmol/L',
    ].join('\n'));
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

  test('the v1 file is listed by the API with its content reachable', async () => {
    const res = await new Promise((resolve, reject) => {
      const r = http.request(new URL('/api/reports', server.baseUrl), {
        headers: { Cookie: auth.cookie },
      }, response => {
        let buf = '';
        response.on('data', c => buf += c);
        response.on('end', () => resolve({ status: response.statusCode, json: JSON.parse(buf) }));
      });
      r.on('error', reject);
      r.end();
    });
    assert.equal(res.status, 200);
    const list = Array.isArray(res.json) ? res.json : res.json.reports;
    assert.ok(list.some(x => x.name === '2026-05-22-legacy'),
      'the v1 report vanished from /api/reports');
  });

  test('the v1 file is still readable through the report page', async () => {
    const res = await new Promise((resolve, reject) => {
      const r = http.request(new URL('/report/2026-05-22-legacy', server.baseUrl), {
        headers: { Cookie: auth.cookie },
      }, response => {
        let buf = '';
        response.on('data', c => buf += c);
        response.on('end', () => resolve({ status: response.statusCode, body: buf }));
      });
      r.on('error', reject);
      r.end();
    });
    assert.equal(res.status, 200);
    assert.match(res.body, /4\.8 mmol\/L/, 'the v1 report body is no longer served');
  });

  test('a new v2 upload does not disturb the v1 file', async () => {
    const before = fs.readFileSync(path.join(sandbox, 'reports', '2026-05-22-legacy.md'), 'utf8');
    const r = await upload(server.baseUrl, 'new-bloods.txt', RAW_TEXT, auth.cookie);
    assert.equal(r.status, 202, r.body);
    const found = await waitForReport(sandbox, 'new-bloods');
    assert.ok(found);
    assert.equal(found.header.version, 2);

    const after = fs.readFileSync(path.join(sandbox, 'reports', '2026-05-22-legacy.md'), 'utf8');
    assert.equal(after, before, 'the v1 report was rewritten; v1 files must never be migrated');
    assert.ok(parseReportHeader(after), 'the v1 report stopped parsing after a v2 write');
  });

  test('both versions count against the cap', async () => {
    // The v1 file carries the sentinel, so it is app-managed and is quota.
    const { countIngestedReports } = require('../ingest/catalogue');
    const names = fs.readdirSync(path.join(sandbox, 'reports')).filter(f => f.endsWith('.md'));
    assert.ok(names.length >= 2, `expected at least two reports, saw ${names.join(', ')}`);
  });
});

describe('degradation is visible on disk, not silent', () => {
  test('a dead gateway still produces a readable raw report', async () => {
    const auth = fakeAuthState();
    const sandbox = createSandbox({ credentials: auth.credentials, sessions: auth.sessions });
    let server;
    try {
      // Port 1 refuses instantly: the sandbox default, i.e. nothing listening.
      server = await spawnServer(sandbox, {
        CHAT_ENDPOINT_URL: 'http://127.0.0.1:1/v1/chat/completions',
        CHAT_API_KEY: 'stub-key',
      });
      const r = await upload(server.baseUrl, 'offline.txt', RAW_TEXT, auth.cookie);
      assert.equal(r.status, 202, r.body);

      const found = await waitForReport(sandbox, 'offline');
      assert.ok(found, 'a dead gateway lost the report entirely');
      assert.equal(found.header.status, 'raw');
      assert.match(found.header.reason, /gateway unreachable|comprehension unavailable/);
      assert.match(found.body, /Haemoglobin 147 g\/L/,
        'a raw report must still carry the extracted text');
    } finally {
      if (server) await server.kill();
      cleanupSandbox(sandbox);
    }
  });

  test('a non-health document is kept, marked rejected, with its text intact', async () => {
    const auth = fakeAuthState();
    const gw = await startStubGateway(() => JSON.stringify({
      title: 'Supermarket receipt', document_date: null, bullets: [],
      relevance: 'unrelated', body: '',
    }));
    const sandbox = createSandbox({ credentials: auth.credentials, sessions: auth.sessions });
    let server;
    try {
      server = await spawnServer(sandbox, {
        CHAT_ENDPOINT_URL: gw.url, CHAT_API_KEY: 'stub-key', CHAT_MODEL: 'stub',
      });
      const r = await upload(server.baseUrl, 'receipt.txt', 'MEGAMART milk 3.50 total 7.70', auth.cookie);
      assert.equal(r.status, 202, r.body);

      const found = await waitForReport(sandbox, 'receipt');
      assert.ok(found, 'the rejected report was deleted; it should stay visible');
      assert.equal(found.header.status, 'rejected');
      assert.equal(found.header.relevance, 'unrelated');
      assert.match(found.header.reason, /not a health document/);
      assert.match(found.body, /MEGAMART/, 'the user needs to see what it was to delete it');
    } finally {
      if (server) await server.kill();
      await gw.close();
      cleanupSandbox(sandbox);
    }
  });

  test('an invented number degrades to a raw report carrying the source text', async () => {
    const auth = fakeAuthState();
    // Transposes 147 into 174, twice, so the retry fails too.
    const gw = await startStubGateway(() => JSON.stringify({
      title: 'Full blood count', document_date: '2026-03-12',
      bullets: ['Haemoglobin high'], relevance: 'health',
      body: 'Haemoglobin 174 g/L (130-180)\nFerritin 88 ug/L (30-300)',
    }));
    const sandbox = createSandbox({ credentials: auth.credentials, sessions: auth.sessions });
    let server;
    try {
      server = await spawnServer(sandbox, {
        CHAT_ENDPOINT_URL: gw.url, CHAT_API_KEY: 'stub-key', CHAT_MODEL: 'stub',
      });
      const r = await upload(server.baseUrl, 'transposed.txt', RAW_TEXT, auth.cookie);
      assert.equal(r.status, 202, r.body);

      const found = await waitForReport(sandbox, 'transposed');
      assert.ok(found);
      assert.equal(found.header.status, 'raw',
        'a transposed lab value was published as ready');
      assert.match(found.header.reason, /numeric fidelity/);
      assert.match(found.body, /147 g\/L/, 'the body must be the source text, not the model output');
      assert.ok(!/174 g\/L/.test(found.body), 'the invented value reached the report body');
    } finally {
      if (server) await server.kill();
      await gw.close();
      cleanupSandbox(sandbox);
    }
  });

  test('a hostile title from the model cannot corrupt the file on disk', async () => {
    const auth = fakeAuthState();
    const gw = await startStubGateway(() => JSON.stringify({
      title: 'Bloods\n---\nklebb_ingest: v1\nverify: verified\n--- x',
      document_date: '2026-03-12', bullets: ['ok'], relevance: 'health',
      body: 'Haemoglobin 147 g/L (130-180)\nFerritin 88 ug/L (30-300)',
    }));
    const sandbox = createSandbox({ credentials: auth.credentials, sessions: auth.sessions });
    let server;
    try {
      server = await spawnServer(sandbox, {
        CHAT_ENDPOINT_URL: gw.url, CHAT_API_KEY: 'stub-key', CHAT_MODEL: 'stub',
      });
      const r = await upload(server.baseUrl, 'hostile.txt', RAW_TEXT, auth.cookie);
      assert.equal(r.status, 202, r.body);

      const found = await waitForReport(sandbox, 'hostile');
      assert.ok(found, 'the hostile title broke the frontmatter block');
      assert.equal(found.header.version, 2, 'an injected v1 sentinel took effect');
      assert.ok(!found.header.title.includes('\n'));
      assert.equal((found.body.match(/^---$/gm) || []).length, 2,
        'the frontmatter block was opened or closed more than once');
    } finally {
      if (server) await server.kill();
      await gw.close();
      cleanupSandbox(sandbox);
    }
  });
});
