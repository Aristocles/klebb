// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/reports-hardening.test.js
//
// Regressions for the defects an adversarial review of the reports feature
// confirmed (#550). Each of these is a real failure that reproduced on the
// merged code, so each test is written to fail if its fix is reverted.
//
// spawnServer only in this file.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const {
  createSandbox, cleanupSandbox, spawnServer, fakeAuthState,
} = require('./helpers/sandbox');
const { parseReportHeader } = require('../ingest/catalogue');
const { documentXmlToText } = require('../ingest/extractors/docx');

function request(baseUrl, pathname, { method = 'GET', cookie = null, body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request(new URL(pathname, baseUrl), {
      method,
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
    }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body: buf, json });
      });
    });
    r.on('error', reject);
    r.setTimeout(20000, () => r.destroy(new Error('request timeout')));
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

function upload(baseUrl, filename, payload, { cookie = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    const r = http.request(new URL('/api/reports/upload', baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': data.length,
        'X-Klebb-Filename': encodeURIComponent(filename),
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
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
    r.write(data);
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

function reportsIn(root) {
  return fs.readdirSync(path.join(root, 'reports')).filter(f => f.endsWith('.md'));
}

function seedV2(root, name, over = {}) {
  const o = {
    sourceFile: `${name}.png`, sourceFormat: 'image', status: 'ready',
    verify: 'required', title: `Report ${name}`, documentDate: '2026-03-12',
    bullets: ['Ferritin 88 ug/L'], withSource: true, ocrPsm: 3, ...over,
  };
  const lines = [
    '---', 'klebb_ingest: v2',
    `source_file: ${o.sourceFile}`,
    `source_format: ${o.sourceFormat}`,
    'ingested_at: 2026-08-09T01:02:03Z',
    `archive_path: reports/_archive/${o.sourceFile}`,
    `status: ${o.status}`, `verify: ${o.verify}`,
  ];
  if (o.title) lines.push(`title: ${o.title}`);
  if (o.documentDate) lines.push(`document_date: ${o.documentDate}`);
  if (Number.isInteger(o.ocrPsm)) lines.push(`ocr_psm: ${o.ocrPsm}`);
  if (o.bullets?.length) {
    lines.push('bullets:');
    for (const b of o.bullets) lines.push(`  - ${b}`);
  }
  lines.push('---', '', `# ${o.title || name}`, '', 'Haemoglobin 147 g/L (130-180)');
  fs.writeFileSync(path.join(root, 'reports', `${name}.md`), lines.join('\n'));
  if (o.withSource) {
    fs.writeFileSync(path.join(root, 'reports', '_archive', o.sourceFile), o.sourceBytes || 'ORIGINALBYTES');
  }
  return name;
}

describe('docx text scan is linear, not quadratic', () => {
  test('a paragraph of unclosed w:t tags does not block the event loop', () => {
    // Measured on the merged code: 40k tags took 11.8s, and it scaled
    // quadratically to minutes. The file is only archived AFTER extraction
    // succeeds, so the boot drain re-enqueued the poison file on every restart.
    const xml = '<w:p>' + '<w:t>'.repeat(200_000) + '</w:p>';
    const started = Date.now();
    documentXmlToText(xml);
    const ms = Date.now() - started;
    assert.ok(ms < 3000,
      `200k unclosed tags took ${ms}ms; the scan is still superlinear and can wedge the instance`);
  });

  test('scaling is not quadratic', () => {
    const time = (n) => {
      const xml = '<w:p>' + '<w:t>'.repeat(n) + '</w:p>';
      const t = Date.now();
      documentXmlToText(xml);
      return Date.now() - t;
    };
    time(20_000);
    const small = Math.max(time(20_000), 1);
    const large = Math.max(time(160_000), 1);
    // 8x the input. Quadratic would be ~64x; allow generous headroom for a
    // noisy machine while still catching a return to O(n^2).
    assert.ok(large / small < 20,
      `8x input produced a ${(large / small).toFixed(1)}x slowdown (${small}ms -> ${large}ms)`);
  });

  test('normal documents still extract correctly', () => {
    assert.equal(
      documentXmlToText('<w:p><w:r><w:t>Dear Doctor,</w:t></w:r></w:p>'
        + '<w:p><w:r><w:t>Ferritin </w:t><w:t>88 ug/L</w:t></w:r></w:p>'),
      'Dear Doctor,\nFerritin 88 ug/L');
    assert.equal(
      documentXmlToText('<w:p><w:r><w:t>Iron</w:t><w:tab/><w:t>88</w:t><w:br/><w:t>next</w:t></w:r></w:p>'),
      'Iron\t88\nnext');
  });
});

describe('a failed reprocess must not destroy the archived original', () => {
  let sandbox, server, auth;

  before(async () => {
    auth = fakeAuthState();
    sandbox = createSandbox({ credentials: auth.credentials, sessions: auth.sessions });
    // An archived original whose extraction will fail: a .docx that is not a zip.
    seedV2(sandbox, 'doomed-retry', {
      sourceFile: 'doomed-retry.docx', sourceFormat: 'docx', verify: 'not_required',
      sourceBytes: 'this is definitely not a zip archive',
    });
    server = await spawnServer(sandbox);
  });

  after(async () => {
    if (server) await server.kill();
    if (sandbox) cleanupSandbox(sandbox);
  });

  test('the original survives, and the report still points at it', async () => {
    // On the merged code processOne called _moveToFailed(absPath) on an
    // extraction failure. During a reprocess absPath IS the archived original,
    // so a failed retry moved the user's only copy of the document into
    // inbox/_failed/: the compare view broke and no later reprocess could work.
    const archived = path.join(sandbox, 'reports', '_archive', 'doomed-retry.docx');
    assert.ok(fs.existsSync(archived), 'precondition: the original should be seeded');

    const r = await request(server.baseUrl, '/api/reports/doomed-retry/reprocess', {
      method: 'POST', cookie: auth.cookie, body: {},
    });
    assert.equal(r.status, 202, r.body);

    // Let the queue run the doomed extraction.
    await new Promise(res => setTimeout(res, 3000));

    assert.ok(fs.existsSync(archived),
      'the archived original was destroyed by a failed reprocess');
    assert.ok(!fs.existsSync(path.join(sandbox, 'inbox', '_failed', 'doomed-retry.docx')),
      'the archived original was moved into _failed/');
    assert.ok(fs.existsSync(path.join(sandbox, 'reports', 'doomed-retry.md')),
      'the report itself was lost by a failed reprocess');

    // And the source endpoint still resolves, so the compare view is intact.
    const src = await request(server.baseUrl, '/api/reports/doomed-retry/source', { cookie: auth.cookie });
    assert.equal(src.status, 200, 'the compare view lost its original after a failed reprocess');
  });
});

describe('a reprocess with no gateway keeps the digest it already had', () => {
  let sandbox, server, auth;

  before(async () => {
    auth = fakeAuthState();
    sandbox = createSandbox({ credentials: auth.credentials, sessions: auth.sessions });
    seedV2(sandbox, 'keepme', {
      sourceFile: 'keepme.txt', sourceFormat: 'text', verify: 'not_required',
      title: 'Full blood count, Melbourne Pathology',
      bullets: ['Ferritin 88 ug/L, low end of range'],
      sourceBytes: 'Haemoglobin 147 g/L (130-180)\nFerritin 88 ug/L (30-300)\n',
    });
    // Gateway pointed at a dead port: comprehension will degrade to raw.
    server = await spawnServer(sandbox, {
      CHAT_ENDPOINT_URL: 'http://127.0.0.1:1/v1/chat/completions',
    });
  });

  after(async () => {
    if (server) await server.kill();
    if (sandbox) cleanupSandbox(sandbox);
  });

  test('the title and bullets survive a re-read that could not be summarised', async () => {
    // Otherwise: the user asks to re-read a document, the gateway happens to be
    // down, and they silently lose the summary they already had.
    const r = await request(server.baseUrl, '/api/reports/keepme/reprocess', {
      method: 'POST', cookie: auth.cookie, body: {},
    });
    assert.equal(r.status, 202, r.body);

    const after = await waitFor(() => {
      const h = parseReportHeader(fs.readFileSync(path.join(sandbox, 'reports', 'keepme.md'), 'utf8'));
      return h && /previous summary kept/.test(h.reason || '') ? h : null;
    });
    assert.ok(after, 'the reprocess never completed, or it did not preserve the digest');
    assert.equal(after.title, 'Full blood count, Melbourne Pathology',
      'the existing title was replaced with nothing');
    assert.deepEqual(after.bullets, ['Ferritin 88 ug/L, low end of range'],
      'the existing bullets were lost');
    assert.match(after.reason, /could not be summarised/);
  });
});

describe('uploads of the same filename do not collide', () => {
  let sandbox, server, auth;

  before(async () => {
    auth = fakeAuthState();
    sandbox = createSandbox({ credentials: auth.credentials, sessions: auth.sessions });
    server = await spawnServer(sandbox);
  });

  after(async () => {
    if (server) await server.kill();
    if (sandbox) cleanupSandbox(sandbox);
  });

  test('two sequential uploads of one filename keep two distinct originals', async () => {
    // The archive name was the raw basename, so the second upload silently
    // overwrote the first report's original: the older report's compare view
    // then showed the NEWER document, and reprocessing it re-read the wrong file.
    const a = await upload(server.baseUrl, 'results.txt', 'FIRST DOCUMENT haemoglobin 147\n', { cookie: auth.cookie });
    assert.equal(a.status, 202, a.body);
    await waitFor(() => reportsIn(sandbox).length >= 1 ? true : null);
    await new Promise(res => setTimeout(res, 500));

    const b = await upload(server.baseUrl, 'results.txt', 'SECOND DOCUMENT ferritin 88\n', { cookie: auth.cookie });
    assert.equal(b.status, 202, b.body);
    await waitFor(() => reportsIn(sandbox).length >= 2 ? true : null);
    await new Promise(res => setTimeout(res, 500));

    const archived = fs.readdirSync(path.join(sandbox, 'reports', '_archive'));
    assert.equal(archived.length, 2,
      `expected two archived originals, found ${archived.join(', ')}`);
    const bodies = archived.map(f => fs.readFileSync(path.join(sandbox, 'reports', '_archive', f), 'utf8'));
    assert.ok(bodies.some(t => t.includes('FIRST DOCUMENT')), 'the first original was overwritten');
    assert.ok(bodies.some(t => t.includes('SECOND DOCUMENT')), 'the second original is missing');
  });

  test('concurrent uploads of one filename do not interleave into a hybrid file', async () => {
    // A shared .part path let two request bodies write into the same staging
    // file, producing one corrupt file with bytes from both documents.
    const big = (marker) => marker.repeat(20_000);
    const [x, y] = await Promise.all([
      upload(server.baseUrl, 'race.txt', big('AAAA'), { cookie: auth.cookie }),
      upload(server.baseUrl, 'race.txt', big('BBBB'), { cookie: auth.cookie }),
    ]);
    assert.equal(x.status, 202, x.body);
    assert.equal(y.status, 202, y.body);

    await waitFor(() => {
      const inbox = fs.readdirSync(path.join(sandbox, 'inbox')).filter(f => f !== '_failed');
      return inbox.length === 0 ? true : null;
    });

    const archived = fs.readdirSync(path.join(sandbox, 'reports', '_archive'))
      .filter(f => f.startsWith('race'));
    assert.equal(archived.length, 2, `expected two race originals, got ${archived.join(', ')}`);
    for (const f of archived) {
      const text = fs.readFileSync(path.join(sandbox, 'reports', '_archive', f), 'utf8');
      const mixed = text.includes('AAAA') && text.includes('BBBB');
      assert.ok(!mixed, `${f} contains bytes from both uploads: the staging path was shared`);
    }
  });
});

describe('_failed/ does not lose a second failure of the same name', () => {
  test('two failures of one filename both survive with their reasons', async () => {
    const sandbox = createSandbox();
    // Two unsupported files with the same name, arriving via the operator door.
    fs.writeFileSync(path.join(sandbox, 'inbox', 'bad.xyz'), 'first failure');
    let server;
    try {
      server = await spawnServer(sandbox);
      await waitFor(() => fs.existsSync(path.join(sandbox, 'inbox', '_failed', 'bad.xyz.error')) ? true : null);
      // A second file of the same name, dropped after the first has failed.
      fs.writeFileSync(path.join(sandbox, 'inbox', 'bad.xyz'), 'second failure');
      await server.kill();
      server = await spawnServer(sandbox);
      await waitFor(() => {
        const failed = fs.readdirSync(path.join(sandbox, 'inbox', '_failed'))
          .filter(f => f.endsWith('.xyz'));
        return failed.length >= 2 ? failed : null;
      });
      const failed = fs.readdirSync(path.join(sandbox, 'inbox', '_failed')).filter(f => f.endsWith('.xyz'));
      assert.equal(failed.length, 2,
        `the second failure overwrote the first: ${failed.join(', ')}`);
      const bodies = failed.map(f => fs.readFileSync(path.join(sandbox, 'inbox', '_failed', f), 'utf8'));
      assert.ok(bodies.some(t => t.includes('first failure')), 'the first failed file was destroyed');
      assert.ok(bodies.some(t => t.includes('second failure')), 'the second failed file is missing');
    } finally {
      if (server) await server.kill();
      cleanupSandbox(sandbox);
    }
  });
});

describe('mutating report routes reject a foreign origin', () => {
  let sandbox, server, auth;
  const FOREIGN = { Origin: 'https://evil.example.com' };

  before(async () => {
    auth = fakeAuthState();
    sandbox = createSandbox({ credentials: auth.credentials, sessions: auth.sessions });
    seedV2(sandbox, 'csrf-target');
    server = await spawnServer(sandbox);
  });

  after(async () => {
    if (server) await server.kill();
    if (sandbox) cleanupSandbox(sandbox);
  });

  test('upload is refused, and nothing reaches disk', async () => {
    // SameSite=Lax does not stop a sibling subdomain fetching with the session
    // cookie, which is why the sibling feedback route already has this guard.
    const before = reportsIn(sandbox).length;
    const r = await upload(server.baseUrl, 'csrf.txt', 'should not land', {
      cookie: auth.cookie, headers: FOREIGN,
    });
    assert.equal(r.status, 403, r.body);
    assert.match(r.json.error, /origin not allowed/);
    assert.equal(fs.readdirSync(path.join(sandbox, 'inbox')).filter(f => f !== '_failed').length, 0);
    assert.equal(reportsIn(sandbox).length, before);
  });

  test('delete is refused, and the report survives', async () => {
    const r = await request(server.baseUrl, '/api/reports/csrf-target', {
      method: 'DELETE', cookie: auth.cookie, headers: FOREIGN,
    });
    assert.equal(r.status, 403);
    assert.match(r.json.error, /origin not allowed/);
    assert.ok(fs.existsSync(path.join(sandbox, 'reports', 'csrf-target.md')),
      'a cross-origin request deleted a report');
  });

  test('verify and reprocess are refused', async () => {
    for (const suffix of ['verify', 'reprocess']) {
      const r = await request(server.baseUrl, `/api/reports/csrf-target/${suffix}`, {
        method: 'POST', cookie: auth.cookie, body: {}, headers: FOREIGN,
      });
      assert.equal(r.status, 403, `${suffix} allowed a foreign origin`);
    }
    // The gate did not fire, so the report is untouched.
    const h = parseReportHeader(fs.readFileSync(path.join(sandbox, 'reports', 'csrf-target.md'), 'utf8'));
    assert.equal(h.verify, 'required');
  });

  test('the instance own origin is still allowed', async () => {
    const r = await request(server.baseUrl, '/api/reports/csrf-target/verify', {
      method: 'POST', cookie: auth.cookie, body: {},
      headers: { Origin: server.baseUrl },
    });
    assert.equal(r.status, 200, `the real origin was rejected: ${r.body}`);
  });
});

describe('the report HTML page cannot execute embedded script', () => {
  let sandbox, server, auth;

  before(async () => {
    auth = fakeAuthState();
    sandbox = createSandbox({ credentials: auth.credentials, sessions: auth.sessions });
    server = await spawnServer(sandbox, {
      // Dead gateway, so the uploaded text reaches the report body verbatim,
      // which is the path that makes a document's own content untrusted.
      CHAT_ENDPOINT_URL: 'http://127.0.0.1:1/v1/chat/completions',
    });
  });

  after(async () => {
    if (server) await server.kill();
    if (sandbox) cleanupSandbox(sandbox);
  });

  test('a script tag in an uploaded document is rendered inert', async () => {
    const payload = 'Haemoglobin 147 g/L\n<script>window.__pwned=1</script>\n'
      + '<img src=x onerror="window.__pwned=2">\n';
    const r = await upload(server.baseUrl, 'xss.txt', payload, { cookie: auth.cookie });
    assert.equal(r.status, 202, r.body);

    const name = await waitFor(() => reportsIn(sandbox).find(f => f.includes('xss')) || null);
    assert.ok(name, 'the upload never produced a report');
    const reportName = name.replace(/\.md$/, '');

    const page = await request(server.baseUrl, `/report/${reportName}`, { cookie: auth.cookie });
    assert.equal(page.status, 200);

    // Assert on live markup, not on substrings: "onerror=" still appears in the
    // response as escaped TEXT (&lt;img ... onerror=&quot;...&quot;&gt;), which
    // is exactly the desired outcome. What must not exist is a real tag.
    const body = page.body;
    // Everything from the document's own content sits inside the rendered
    // article; the page shell legitimately contains its own <style> etc.
    assert.ok(!/<script>window\.__pwned/.test(body),
      'an executable script tag from a document reached the rendered page');
    assert.ok(!/<img[^>]*onerror/i.test(body),
      'a live img tag with an event handler reached the rendered page');
    // The text is still readable, just inert.
    assert.match(body, /&lt;script&gt;/);
    assert.match(body, /&lt;img/);
    assert.match(body, /147/);
  });

  test('the page carries a restrictive CSP and no-store', async () => {
    const name = await waitFor(() => reportsIn(sandbox).find(f => f.includes('xss')) || null);
    const page = await request(server.baseUrl, `/report/${name.replace(/\.md$/, '')}`, { cookie: auth.cookie });
    const csp = page.headers['content-security-policy'];
    assert.ok(csp, 'the report page has no CSP');
    assert.match(csp, /default-src 'none'/);
    // Defence in depth: even a sanitiser slip cannot reach the network, and the
    // archived original is the only artefact still holding patient identifiers.
    assert.ok(!/connect-src/.test(csp) || /connect-src 'none'/.test(csp));
    assert.match(page.headers['cache-control'] || '', /no-store/);
    assert.equal(page.headers['x-content-type-options'], 'nosniff');
  });

  test('markdown still renders', async () => {
    const r = await upload(server.baseUrl, 'md-render.md', '# Heading\n\n- one\n- two\n', { cookie: auth.cookie });
    assert.equal(r.status, 202, r.body);
    const name = await waitFor(() => reportsIn(sandbox).find(f => f.includes('md-render')) || null);
    const page = await request(server.baseUrl, `/report/${name.replace(/\.md$/, '')}`, { cookie: auth.cookie });
    assert.match(page.body, /<li>/, 'markdown lists no longer render');
  });
});

describe('an underscore-prefixed upload name cannot hide from the pipeline', () => {
  test('the file is either renamed to something visible or refused', async () => {
    const auth = fakeAuthState();
    const sandbox = createSandbox({ credentials: auth.credentials, sessions: auth.sessions });
    let server;
    try {
      server = await spawnServer(sandbox);
      const r = await upload(server.baseUrl, '_hidden.txt', 'invisible content', { cookie: auth.cookie });
      if (r.status === 202) {
        // Accepted: it must actually get processed rather than sitting in the
        // inbox forever, invisible to the drain, the quota and the UI.
        const landed = await waitFor(() => reportsIn(sandbox).length >= 1 ? true : null, { timeoutMs: 12000 });
        assert.ok(landed, 'an accepted upload was never processed: the name is invisible to the pipeline');
        assert.equal(fs.readdirSync(path.join(sandbox, 'inbox')).filter(f => f !== '_failed').length, 0,
          'the file is stuck in the inbox, invisible to the drain');
      } else {
        assert.equal(r.status, 400, `expected 202 or 400, got ${r.status}: ${r.body}`);
      }
    } finally {
      if (server) await server.kill();
      cleanupSandbox(sandbox);
    }
  });
});
