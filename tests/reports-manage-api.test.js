// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/reports-manage-api.test.js
//
// The /api/reports envelope and the three management actions.
//
// The traversal cases here are permanent rather than incidental: archive_path
// lives in a file the user can edit, so it is untrusted input, and the source
// endpoint streams bytes based on it.
//
// spawnServer only in this file.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const {
  createSandbox, cleanupSandbox, spawnServer, req, fakeAuthState,
} = require('./helpers/sandbox');

function request(baseUrl, pathname, { method = 'GET', cookie = null, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request(new URL(pathname, baseUrl), {
      method,
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString('utf8')); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, buffer: buf, body: buf.toString('utf8'), json });
      });
    });
    r.on('error', reject);
    r.setTimeout(15000, () => r.destroy(new Error('request timeout')));
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

// Write a v2 report plus its archived original.
function seedV2(root, name, over = {}) {
  const o = {
    sourceFile: `${name}.png`,
    sourceFormat: 'image',
    status: 'ready',
    verify: 'required',
    title: `Report ${name}`,
    documentDate: '2026-03-12',
    relevance: 'health',
    ocrPsm: 3,
    bullets: ['Ferritin 88 ug/L'],
    withSource: true,
    ...over,
  };
  const lines = [
    '---',
    'klebb_ingest: v2',
    `source_file: ${o.sourceFile}`,
    `source_format: ${o.sourceFormat}`,
    'ingested_at: 2026-08-09T01:02:03Z',
    `archive_path: reports/_archive/${o.sourceFile}`,
    `status: ${o.status}`,
    `verify: ${o.verify}`,
  ];
  if (o.title) lines.push(`title: ${o.title}`);
  if (o.documentDate) lines.push(`document_date: ${o.documentDate}`);
  if (o.relevance) lines.push(`relevance: ${o.relevance}`);
  if (o.readBy) lines.push(`read_by: ${o.readBy}`);
  if (Number.isInteger(o.ocrPsm)) lines.push(`ocr_psm: ${o.ocrPsm}`);
  if (o.ocrAttempts) lines.push(`ocr_attempts: ${o.ocrAttempts}`);
  if (o.reason) lines.push(`reason: ${o.reason}`);
  if (o.bullets?.length) {
    lines.push('bullets:');
    for (const b of o.bullets) lines.push(`  - ${b}`);
  }
  lines.push('---', '', `# ${o.title || name}`, '', 'Haemoglobin 147 g/L (130-180)');
  fs.writeFileSync(path.join(root, 'reports', `${name}.md`), lines.join('\n'));
  if (o.withSource) {
    fs.writeFileSync(path.join(root, 'reports', '_archive', o.sourceFile), 'PNGDATA');
  }
  return name;
}

function seedHandAuthored(root, name) {
  fs.writeFileSync(path.join(root, 'reports', `${name}.md`),
    `# Hand written notes\n\nCholesterol 4.8 mmol/L\n`);
  return name;
}

describe('GET /api/reports envelope', () => {
  let sandbox, server, auth;

  before(async () => {
    auth = fakeAuthState();
    sandbox = createSandbox({ credentials: auth.credentials, sessions: auth.sessions });
    seedV2(sandbox, '2026-08-01-bloods', { documentDate: '2026-03-12' });
    seedV2(sandbox, '2026-08-02-scan', { documentDate: '2026-07-01', verify: 'verified' });
    seedHandAuthored(sandbox, 'genome-notes');
    // Internal files must stay excluded.
    fs.writeFileSync(path.join(sandbox, 'reports', 'PROFILE.md'), '# Profile\n');
    // Failed, with a reason.
    fs.writeFileSync(path.join(sandbox, 'inbox', '_failed', 'broken.pdf'), 'x');
    fs.writeFileSync(path.join(sandbox, 'inbox', '_failed', 'broken.pdf.error'),
      '2026-08-09T00:00:00Z\nextraction failed: pdftotext exit 1\n');
    server = await spawnServer(sandbox, { KLEBB_REPORTS_MAX: '9' });
    // The "server running" line the harness waits for is printed BEFORE the
    // boot drain runs, so a file written the instant spawnServer resolves gets
    // swept up by the drain. Wait the drain out, then seed the in-flight file,
    // so the assertion is about the envelope reporting an inbox file rather
    // than about a race with the queue.
    await new Promise(res => setTimeout(res, 600));
    fs.writeFileSync(path.join(sandbox, 'inbox', 'pending.pdf'), 'x');
  });

  after(async () => {
    if (server) await server.kill();
    if (sandbox) cleanupSandbox(sandbox);
  });

  test('returns quota, reports, processing and failed', async () => {
    const r = await request(server.baseUrl, '/api/reports', { cookie: auth.cookie });
    assert.equal(r.status, 200);
    assert.ok(r.json.quota, 'no quota block');
    assert.equal(r.json.quota.max, 9);
    assert.ok(Array.isArray(r.json.reports));
    assert.ok(Array.isArray(r.json.processing));
    assert.ok(Array.isArray(r.json.failed));
  });

  test('a report carries its digest, state and source flags', async () => {
    const r = await request(server.baseUrl, '/api/reports', { cookie: auth.cookie });
    const rep = r.json.reports.find(x => x.name === '2026-08-01-bloods');
    assert.ok(rep, 'the seeded report is missing');
    assert.equal(rep.title, 'Report 2026-08-01-bloods');
    assert.equal(rep.date, '2026-03-12', 'the document date should win over the filename date');
    assert.equal(rep.sourceFormat, 'image');
    assert.equal(rep.status, 'ready');
    assert.equal(rep.verify, 'required');
    assert.deepEqual(rep.bullets, ['Ferritin 88 ug/L']);
    assert.equal(rep.url, '/report/2026-08-01-bloods');
    assert.equal(rep.hasSource, true);
    assert.equal(rep.managed, true);
  });

  test('a hand-authored file is ready, ungated and not app-managed', async () => {
    const r = await request(server.baseUrl, '/api/reports', { cookie: auth.cookie });
    const rep = r.json.reports.find(x => x.name === 'genome-notes');
    assert.ok(rep, 'a hand-authored report disappeared from the list');
    assert.equal(rep.status, 'ready');
    assert.equal(rep.verify, 'not_required', 'a hand-authored file must never be gated');
    assert.deepEqual(rep.bullets, []);
    assert.equal(rep.managed, false, 'a hand-authored file is not app-managed');
    assert.equal(rep.title, 'Hand written notes', 'the title should come from the h1');
  });

  test('internal files stay excluded', async () => {
    const r = await request(server.baseUrl, '/api/reports', { cookie: auth.cookie });
    assert.ok(!r.json.reports.some(x => x.name === 'PROFILE'), 'PROFILE.md leaked into the list');
  });

  test('reports are newest-first by document date', async () => {
    const r = await request(server.baseUrl, '/api/reports', { cookie: auth.cookie });
    const dated = r.json.reports.filter(x => x.date).map(x => x.date);
    const sorted = [...dated].sort((a, b) => b.localeCompare(a));
    assert.deepEqual(dated, sorted, 'reports are not ordered newest-first');
  });

  test('in-flight files appear as processing', async () => {
    const r = await request(server.baseUrl, '/api/reports', { cookie: auth.cookie });
    assert.ok(r.json.processing.some(p => p.filename === 'pending.pdf'));
  });

  test('failures are surfaced with their reason, not left in the log only', async () => {
    const r = await request(server.baseUrl, '/api/reports', { cookie: auth.cookie });
    const f = r.json.failed.find(x => x.filename === 'broken.pdf');
    assert.ok(f, 'a failed file is invisible to the UI');
    assert.match(f.reason, /pdftotext exit 1/);
  });

  test('hand-authored files do not consume quota', async () => {
    const r = await request(server.baseUrl, '/api/reports', { cookie: auth.cookie });
    // Two sentinel'd reports + one inbox file = 3. The hand-authored file and
    // PROFILE.md are free.
    assert.equal(r.json.quota.used, 3,
      `expected 3 quota slots used, got ${r.json.quota.used}`);
  });

  test('the list requires a session', async () => {
    const r = await request(server.baseUrl, '/api/reports');
    assert.ok(r.status === 401 || r.status === 403, `expected 401/403, got ${r.status}`);
  });
});

describe('GET /api/reports/:name/source', () => {
  let sandbox, server, auth;

  before(async () => {
    auth = fakeAuthState();
    sandbox = createSandbox({ credentials: auth.credentials, sessions: auth.sessions });
    seedV2(sandbox, 'with-source');
    seedV2(sandbox, 'no-source', { withSource: false });
    seedHandAuthored(sandbox, 'hand-written');
    server = await spawnServer(sandbox);
  });

  after(async () => {
    if (server) await server.kill();
    if (sandbox) cleanupSandbox(sandbox);
  });

  test('serves the archived original inline and uncached', async () => {
    const r = await request(server.baseUrl, '/api/reports/with-source/source', { cookie: auth.cookie });
    assert.equal(r.status, 200);
    assert.equal(r.body, 'PNGDATA');
    assert.match(r.headers['content-type'], /image\/png/);
    assert.match(r.headers['content-disposition'], /inline/);
    assert.match(r.headers['cache-control'], /no-store/,
      'the original still carries the patient identifiers and must not be cached');
  });

  test('404 when the report has no archived original', async () => {
    const r = await request(server.baseUrl, '/api/reports/no-source/source', { cookie: auth.cookie });
    assert.equal(r.status, 404);
  });

  test('404 for a hand-authored report', async () => {
    const r = await request(server.baseUrl, '/api/reports/hand-written/source', { cookie: auth.cookie });
    assert.equal(r.status, 404);
  });

  test('404 for a report that does not exist', async () => {
    const r = await request(server.baseUrl, '/api/reports/nope/source', { cookie: auth.cookie });
    assert.equal(r.status, 404);
  });

  test('a relative traversal in archive_path is refused, not served', async () => {
    // archive_path comes from a file the user can edit, so it is untrusted.
    //
    // The target is a real file one level up from the archive dir (a sibling of
    // reports/, inside HEALTH_HOME) rather than something far away: a distant
    // path gets clamped at the filesystem root by resolve() and would 404 even
    // with no containment check at all, so the test would pass while proving
    // nothing. `../` from reports/_archive lands in reports/, which genuinely
    // exists and genuinely must not be readable through this endpoint.
    const reachable = path.join(sandbox, 'reports', 'sibling-secret.txt');
    fs.writeFileSync(reachable, 'TOP SECRET');
    try {
      fs.writeFileSync(path.join(sandbox, 'reports', 'evil-rel.md'), [
        '---',
        'klebb_ingest: v2',
        'source_file: x.png',
        'source_format: image',
        'ingested_at: 2026-08-09T00:00:00Z',
        'archive_path: ../sibling-secret.txt',
        'status: ready',
        'verify: required',
        '---',
        '',
        '# evil',
      ].join('\n'));
      const r = await request(server.baseUrl, '/api/reports/evil-rel/source', { cookie: auth.cookie });
      assert.equal(r.status, 404, 'a traversal path was served');
      assert.ok(!r.body.includes('TOP SECRET'), 'bytes from outside the archive were served');
    } finally {
      try { fs.unlinkSync(reachable); } catch {}
    }
  });

  test('an absolute path in archive_path is refused, not served', async () => {
    const secret = path.join(os.tmpdir(), `klebb-abs-secret-${Date.now()}.txt`);
    fs.writeFileSync(secret, 'ABSOLUTE SECRET');
    try {
      fs.writeFileSync(path.join(sandbox, 'reports', 'evil-abs.md'), [
        '---',
        'klebb_ingest: v2',
        'source_file: x.png',
        'source_format: image',
        'ingested_at: 2026-08-09T00:00:00Z',
        `archive_path: ${secret}`,
        'status: ready',
        'verify: required',
        '---',
        '',
        '# evil',
      ].join('\n'));
      const r = await request(server.baseUrl, '/api/reports/evil-abs/source', { cookie: auth.cookie });
      assert.equal(r.status, 404, 'an absolute path was served');
      assert.ok(!r.body.includes('ABSOLUTE SECRET'), 'bytes from outside the archive were served');
    } finally {
      try { fs.unlinkSync(secret); } catch {}
    }
  });

  test('a traversal in the report NAME is refused', async () => {
    const r = await request(server.baseUrl, '/api/reports/..%2F..%2Fetc%2Fpasswd/source', { cookie: auth.cookie });
    assert.equal(r.status, 404);
  });

  test('the source requires a session', async () => {
    const r = await request(server.baseUrl, '/api/reports/with-source/source');
    assert.ok(r.status === 401 || r.status === 403, `expected 401/403, got ${r.status}`);
    assert.ok(!r.body.includes('PNGDATA'), 'the original was served without a session');
  });
});

describe('GET /api/reports/:name/text', () => {
  let sandbox, server, auth;

  before(async () => {
    auth = fakeAuthState();
    sandbox = createSandbox({ credentials: auth.credentials, sessions: auth.sessions });
    seedV2(sandbox, 'text-view');
    seedHandAuthored(sandbox, 'hand-written');
    server = await spawnServer(sandbox);
  });

  after(async () => {
    if (server) await server.kill();
    if (sandbox) cleanupSandbox(sandbox);
  });

  test('serves the extracted text with no frontmatter and no heading', async () => {
    // This is the pane a human checks lab values in, so leaking our own header
    // into it is worse than cosmetic: it buries the numbers being verified.
    const r = await request(server.baseUrl, '/api/reports/text-view/text', { cookie: auth.cookie });
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /text\/plain/);
    assert.match(r.body, /Haemoglobin 147 g\/L/);
    assert.ok(!r.body.includes('klebb_ingest'), 'the frontmatter sentinel leaked into the text');
    assert.ok(!r.body.includes('source_format'), 'frontmatter keys leaked into the text');
    assert.ok(!r.body.includes('verify:'), 'frontmatter keys leaked into the text');
    assert.ok(!/^#\s/m.test(r.body), 'the h1 heading leaked into the text');
  });

  test('is not cached: it carries the extracted content', async () => {
    const r = await request(server.baseUrl, '/api/reports/text-view/text', { cookie: auth.cookie });
    assert.match(r.headers['cache-control'], /no-store/);
  });

  test('works on a hand-authored report too', async () => {
    const r = await request(server.baseUrl, '/api/reports/hand-written/text', { cookie: auth.cookie });
    assert.equal(r.status, 200);
    assert.match(r.body, /Cholesterol 4\.8 mmol\/L/);
    assert.ok(!/^#\s/m.test(r.body));
  });

  test('404 on a missing report, and a traversal is refused', async () => {
    assert.equal((await request(server.baseUrl, '/api/reports/nope/text', { cookie: auth.cookie })).status, 404);
    const t = await request(server.baseUrl, '/api/reports/..%2F..%2Fetc%2Fpasswd/text', { cookie: auth.cookie });
    assert.equal(t.status, 404);
  });

  test('requires a session', async () => {
    const r = await request(server.baseUrl, '/api/reports/text-view/text');
    assert.ok(r.status === 401 || r.status === 403, `expected 401/403, got ${r.status}`);
    assert.ok(!r.body.includes('Haemoglobin'), 'report text was served without a session');
  });
});

describe('the rendered report page links back to Reports', () => {
  let sandbox, server, auth;

  before(async () => {
    auth = fakeAuthState();
    sandbox = createSandbox({ credentials: auth.credentials, sessions: auth.sessions });
    seedV2(sandbox, 'link-check');
    server = await spawnServer(sandbox);
  });

  after(async () => {
    if (server) await server.kill();
    if (sandbox) cleanupSandbox(sandbox);
  });

  test('the back link goes to /reports, not the dashboard', async () => {
    // The page is only ever reached FROM the Reports view, so sending the reader
    // to the dashboard loses their place.
    const r = await request(server.baseUrl, '/report/link-check', { cookie: auth.cookie });
    assert.equal(r.status, 200);
    assert.match(r.body, /href="\/reports"/, 'the back link does not point at /reports');
    assert.match(r.body, /Back to Reports/);
    assert.ok(!/Back to Dashboard/.test(r.body), 'the old dashboard link is still there');
  });
});

describe('POST /api/reports/:name/verify', () => {
  let sandbox, server, auth;

  before(async () => {
    auth = fakeAuthState();
    sandbox = createSandbox({ credentials: auth.credentials, sessions: auth.sessions });
    seedV2(sandbox, 'needs-check', { verify: 'required' });
    seedV2(sandbox, 'text-report', { sourceFormat: 'text', verify: 'not_required', withSource: false });
    seedHandAuthored(sandbox, 'hand-written');
    server = await spawnServer(sandbox);
  });

  after(async () => {
    if (server) await server.kill();
    if (sandbox) cleanupSandbox(sandbox);
  });

  test('flips required to verified, rewriting only that line', async () => {
    const before = fs.readFileSync(path.join(sandbox, 'reports', 'needs-check.md'), 'utf8');
    const r = await request(server.baseUrl, '/api/reports/needs-check/verify', {
      method: 'POST', cookie: auth.cookie,
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.verify, 'verified');

    const after = fs.readFileSync(path.join(sandbox, 'reports', 'needs-check.md'), 'utf8');
    assert.match(after, /^verify: verified$/m);
    assert.ok(!/^verify: required$/m.test(after));
    // Everything else byte-identical: the digest, the bullets and the body all
    // survive a verify.
    assert.equal(
      after.replace(/^verify: verified$/m, 'verify: required'),
      before,
      'verify changed more than the verify line',
    );
  });

  test('is idempotent', async () => {
    const r = await request(server.baseUrl, '/api/reports/needs-check/verify', {
      method: 'POST', cookie: auth.cookie,
    });
    assert.equal(r.status, 200, 'a second verify should not error');
    assert.equal(r.json.verify, 'verified');
  });

  test('409 on a report that never needed verification', async () => {
    const r = await request(server.baseUrl, '/api/reports/text-report/verify', {
      method: 'POST', cookie: auth.cookie,
    });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /does not need OCR verification/);
  });

  test('403 on a hand-authored report', async () => {
    const r = await request(server.baseUrl, '/api/reports/hand-written/verify', {
      method: 'POST', cookie: auth.cookie,
    });
    assert.equal(r.status, 403);
  });

  test('404 on a missing report', async () => {
    const r = await request(server.baseUrl, '/api/reports/nope/verify', {
      method: 'POST', cookie: auth.cookie,
    });
    assert.equal(r.status, 404);
  });

  test('requires a session', async () => {
    const r = await request(server.baseUrl, '/api/reports/needs-check/verify', { method: 'POST' });
    assert.ok(r.status === 401 || r.status === 403, `expected 401/403, got ${r.status}`);
  });
});

describe('POST /api/reports/:name/reprocess', () => {
  let sandbox, server, auth;

  before(async () => {
    auth = fakeAuthState();
    sandbox = createSandbox({ credentials: auth.credentials, sessions: auth.sessions });
    seedV2(sandbox, 'rp-text', { sourceFile: 'rp-text.txt', sourceFormat: 'text', verify: 'not_required' });
    fs.writeFileSync(path.join(sandbox, 'reports', '_archive', 'rp-text.txt'), 'Haemoglobin 147 g/L\n');
    seedV2(sandbox, 'rp-orphan', { withSource: false });
    seedHandAuthored(sandbox, 'hand-written');
    server = await spawnServer(sandbox);
  });

  after(async () => {
    if (server) await server.kill();
    if (sandbox) cleanupSandbox(sandbox);
  });

  test('accepts and does NOT create a duplicate report', async () => {
    const before = fs.readdirSync(path.join(sandbox, 'reports')).filter(f => f.endsWith('.md'));
    const r = await request(server.baseUrl, '/api/reports/rp-text/reprocess', {
      method: 'POST', cookie: auth.cookie, body: {},
    });
    assert.equal(r.status, 202, r.body);
    assert.equal(r.json.accepted, true);

    // Let the queue settle, then confirm the listing length is unchanged: a
    // reprocess that allocated a fresh name would leave rp-text-2 behind.
    await new Promise(res => setTimeout(res, 2500));
    const after = fs.readdirSync(path.join(sandbox, 'reports')).filter(f => f.endsWith('.md'));
    assert.deepEqual(after.sort(), before.sort(),
      'reprocess created a duplicate report instead of overwriting');
    assert.ok(fs.existsSync(path.join(sandbox, 'reports', '_archive', 'rp-text.txt')),
      'reprocess consumed the archived original');
  });

  test('an explicit psm is echoed back as a tesseract rung', async () => {
    const r = await request(server.baseUrl, '/api/reports/rp-text/reprocess', {
      method: 'POST', cookie: auth.cookie, body: { psm: 6 },
    });
    assert.equal(r.status, 202);
    assert.equal(r.json.psm, 6);
    assert.equal(r.json.reader, 'tesseract');
  });

  test('an explicit vision reader is honoured', async () => {
    const r = await request(server.baseUrl, '/api/reports/rp-text/reprocess', {
      method: 'POST', cookie: auth.cookie, body: { reader: 'vision' },
    });
    assert.equal(r.status, 202);
    assert.equal(r.json.reader, 'vision');
    assert.equal(r.json.psm, null);
  });

  test('without a rung it takes the first untried one on the ladder', async () => {
    // A legacy report knows only its recorded psm; with a gateway configured
    // (the sandbox sets CHAT_ENDPOINT_URL) the untried vision rung comes first.
    seedV2(sandbox, 'rp-rung', { sourceFile: 'rp-rung.png', sourceFormat: 'image', ocrPsm: 3 });
    const r = await request(server.baseUrl, '/api/reports/rp-rung/reprocess', {
      method: 'POST', cookie: auth.cookie, body: {},
    });
    assert.equal(r.status, 202, r.body);
    assert.equal(r.json.reader, 'vision', 'an untried vision rung outranks the psm walk');
    assert.equal(r.json.psm, null);

    // Once vision has produced text, the walk resumes where the psms left off.
    seedV2(sandbox, 'rp-walk', {
      sourceFile: 'rp-walk.png', sourceFormat: 'image',
      readBy: 'tesseract', ocrPsm: 3, ocrAttempts: 'vision 3',
    });
    const walk = await request(server.baseUrl, '/api/reports/rp-walk/reprocess', {
      method: 'POST', cookie: auth.cookie, body: {},
    });
    assert.equal(walk.json.reader, 'tesseract');
    assert.equal(walk.json.psm, 6, 'vision and 3 already produced text, so the next rung is 6');

    // And once every rung has been tried, the bottom one is a fixed point.
    seedV2(sandbox, 'rp-top', {
      sourceFile: 'rp-top.png', sourceFormat: 'image',
      readBy: 'tesseract', ocrPsm: 4, ocrAttempts: 'vision 3 6 4',
    });
    const top = await request(server.baseUrl, '/api/reports/rp-top/reprocess', {
      method: 'POST', cookie: auth.cookie, body: {},
    });
    assert.equal(top.json.psm, 4, 'the exhausted ladder should saturate, not wrap');
    assert.equal(top.json.reader, 'tesseract');
  });

  test('404 with a clear message when the original is gone, and the report survives', async () => {
    const r = await request(server.baseUrl, '/api/reports/rp-orphan/reprocess', {
      method: 'POST', cookie: auth.cookie, body: {},
    });
    assert.equal(r.status, 404);
    assert.match(r.json.error, /no longer available/);
    assert.ok(fs.existsSync(path.join(sandbox, 'reports', 'rp-orphan.md')),
      'a failed reprocess deleted the report');
  });

  test('403 on a hand-authored report', async () => {
    const r = await request(server.baseUrl, '/api/reports/hand-written/reprocess', {
      method: 'POST', cookie: auth.cookie, body: {},
    });
    assert.equal(r.status, 403);
  });

  test('requires a session', async () => {
    const r = await request(server.baseUrl, '/api/reports/rp-text/reprocess', { method: 'POST' });
    assert.ok(r.status === 401 || r.status === 403, `expected 401/403, got ${r.status}`);
  });
});

describe('DELETE /api/reports/:name', () => {
  let sandbox, server, auth;

  before(async () => {
    auth = fakeAuthState();
    sandbox = createSandbox({ credentials: auth.credentials, sessions: auth.sessions });
    seedV2(sandbox, 'doomed');
    seedHandAuthored(sandbox, 'hand-written');
    server = await spawnServer(sandbox, { KLEBB_REPORTS_MAX: '2' });
  });

  after(async () => {
    if (server) await server.kill();
    if (sandbox) cleanupSandbox(sandbox);
  });

  test('removes the report AND the archived original, and reports the new quota', async () => {
    assert.ok(fs.existsSync(path.join(sandbox, 'reports', '_archive', 'doomed.png')));
    const r = await request(server.baseUrl, '/api/reports/doomed', {
      method: 'DELETE', cookie: auth.cookie,
    });
    assert.equal(r.status, 200, r.body);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.removedSource, true);
    assert.equal(typeof r.json.used, 'number');

    assert.ok(!fs.existsSync(path.join(sandbox, 'reports', 'doomed.md')));
    assert.deepEqual(fs.readdirSync(path.join(sandbox, 'reports', '_archive')), [],
      'an orphan was left in the archive, so the quota slot never truly freed');
  });

  test('the freed slot is usable', async () => {
    const r = await request(server.baseUrl, '/api/reports', { cookie: auth.cookie });
    assert.equal(r.json.quota.used, 0, 'deleting did not free the slot');
    assert.equal(r.json.quota.remaining, 2);
  });

  test('403 on a hand-authored report, and the file survives', async () => {
    const r = await request(server.baseUrl, '/api/reports/hand-written', {
      method: 'DELETE', cookie: auth.cookie,
    });
    assert.equal(r.status, 403);
    assert.match(r.json.error, /authored by hand/);
    assert.ok(fs.existsSync(path.join(sandbox, 'reports', 'hand-written.md')),
      'a hand-authored file was deleted');
  });

  test('404 on a missing report', async () => {
    const r = await request(server.baseUrl, '/api/reports/nope', {
      method: 'DELETE', cookie: auth.cookie,
    });
    assert.equal(r.status, 404);
  });

  test('a traversal in the name is refused', async () => {
    const r = await request(server.baseUrl, '/api/reports/..%2F..%2Fetc%2Fpasswd', {
      method: 'DELETE', cookie: auth.cookie,
    });
    assert.ok(r.status === 400 || r.status === 404, `expected 400/404, got ${r.status}`);
  });

  test('requires a session', async () => {
    const r = await request(server.baseUrl, '/api/reports/hand-written', { method: 'DELETE' });
    assert.ok(r.status === 401 || r.status === 403, `expected 401/403, got ${r.status}`);
  });
});

describe('demo mode gates every mutating report route', () => {
  let sandbox, server, cookie;

  before(async () => {
    sandbox = createSandbox();
    seedV2(sandbox, 'demo-report');
    server = await spawnServer(sandbox, { KLEBB_DEMO: '1' });
    const login = await req(server.baseUrl, '/auth/demo-login', { method: 'POST' });
    const setCookie = login.headers['set-cookie'];
    cookie = Array.isArray(setCookie) ? setCookie[0].split(';')[0] : null;
  });

  after(async () => {
    if (server) await server.kill();
    if (sandbox) cleanupSandbox(sandbox);
  });

  test('the list still works (reading is fine in the demo)', async () => {
    const r = await request(server.baseUrl, '/api/reports', { cookie });
    assert.equal(r.status, 200);
    assert.ok(r.json.reports.length >= 1);
  });

  test('verify is 403', async () => {
    const r = await request(server.baseUrl, '/api/reports/demo-report/verify', { method: 'POST', cookie });
    assert.equal(r.status, 403);
    assert.match(r.json.error, /demo mode/i);
  });

  test('reprocess is 403', async () => {
    const r = await request(server.baseUrl, '/api/reports/demo-report/reprocess', {
      method: 'POST', cookie, body: {},
    });
    assert.equal(r.status, 403);
    assert.match(r.json.error, /demo mode/i);
  });

  test('delete is 403, and the report survives', async () => {
    const r = await request(server.baseUrl, '/api/reports/demo-report', { method: 'DELETE', cookie });
    assert.equal(r.status, 403);
    assert.match(r.json.error, /demo mode/i);
    assert.ok(fs.existsSync(path.join(sandbox, 'reports', 'demo-report.md')),
      'a demo visitor deleted a report');
  });
});
