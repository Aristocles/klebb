// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/reports-upload.test.js
//
// POST /api/reports/upload: the guards, the quota, the staging-file
// lifecycle, and the single-slot queue. Every failure case asserts on the
// specific error text AND on which directory the file landed in, because
// several of these paths return the same status for different reasons: a
// test that only checks "not 2xx" passes with the guard deleted.
//
// spawnServer only in this file (no fresh-require registry tests): mixing the
// two leaves the runner hanging even when every test passes.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const {
  createSandbox, cleanupSandbox, spawnServer, req, fakeAuthState,
} = require('./helpers/sandbox');

const { ALLOWED_UPLOAD_EXTS, EXT_TO_FORMAT } = require('../ingest/extract');

// Raw-body upload. Returns { status, json }. `filename` is encoded here so
// the tests exercise the same contract the browser client uses.
function upload(baseUrl, filename, body, { cookie = null, encoded = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL('/api/reports/upload', baseUrl);
    const payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const r = http.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': payload.length,
        'X-Klebb-Filename': encoded !== null ? encoded : encodeURIComponent(filename),
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
    r.setTimeout(15000, () => r.destroy(new Error('request timeout')));
    r.write(payload);
    r.end();
  });
}

async function waitFor(predicate, { timeoutMs = 10000, intervalMs = 100 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await predicate();
    if (result) return result;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return null;
}

function reportsIn(root) {
  return fs.readdirSync(path.join(root, 'reports')).filter(f => f.endsWith('.md'));
}

function inboxIn(root) {
  return fs.readdirSync(path.join(root, 'inbox')).filter(f => f !== '_failed');
}

// A report file carrying the ingest sentinel, for seeding quota state without
// running the pipeline.
function seedIngestedReport(root, name) {
  const body = [
    '---',
    'klebb_ingest: v1',
    `source_file: ${name}.txt`,
    'source_format: text',
    'ingested_at: 2026-05-22T14:07:33Z',
    `archive_path: reports/_archive/${name}.txt`,
    '---',
    '',
    `# ${name}`,
    '',
    'seeded',
  ].join('\n');
  fs.writeFileSync(path.join(root, 'reports', `${name}.md`), body);
}

describe('reports upload: allow-list is the dispatcher key set', () => {
  test('ALLOWED_UPLOAD_EXTS and EXT_TO_FORMAT are the same set', () => {
    const allowed = [...ALLOWED_UPLOAD_EXTS].sort();
    const dispatched = Object.keys(EXT_TO_FORMAT).sort();
    assert.deepEqual(allowed, dispatched,
      'upload allow-list drifted from the extractor dispatcher: an extension ' +
      'the endpoint accepts and the pipeline rejects presents to the user as ' +
      '"upload succeeded then the file vanished"');
  });

  test('every allow-listed extension is lower-case and dot-prefixed', () => {
    for (const ext of ALLOWED_UPLOAD_EXTS) {
      assert.equal(ext, ext.toLowerCase(), `${ext} is not lower-case`);
      assert.ok(ext.startsWith('.'), `${ext} is not dot-prefixed`);
    }
  });
});

describe('reports upload: authenticated happy path + guards', () => {
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

  test('a .txt upload returns 202 and produces a report + archived original', async () => {
    const r = await upload(server.baseUrl, 'bloods.txt', 'haemoglobin 147 g/L\n', { cookie: auth.cookie });
    assert.equal(r.status, 202, `expected 202, got ${r.status}: ${r.body}`);
    assert.equal(r.json.accepted, true);
    assert.equal(r.json.filename, 'bloods.txt');
    assert.equal(typeof r.json.used, 'number');
    assert.equal(typeof r.json.max, 'number');

    const found = await waitFor(() => {
      const files = reportsIn(sandbox);
      return files.length ? files[0] : null;
    });
    assert.ok(found, 'no .md report produced');
    const body = fs.readFileSync(path.join(sandbox, 'reports', found), 'utf8');
    assert.match(body, /haemoglobin 147 g\/L/);

    assert.ok(fs.existsSync(path.join(sandbox, 'reports', '_archive', 'bloods.txt')),
      'original not archived');
    assert.equal(inboxIn(sandbox).length, 0, 'inbox not drained');
  });

  test('no .part staging file survives a completed upload', async () => {
    const strays = fs.readdirSync(path.join(sandbox, 'inbox')).filter(f => f.endsWith('.part'));
    assert.deepEqual(strays, [], 'staging file left behind after a clean upload');
  });

  test('an unsupported extension is refused with the extension echoed, and nothing reaches disk', async () => {
    const before = inboxIn(sandbox).length;
    const r = await upload(server.baseUrl, 'payload.exe', 'MZ\x90\x00'.repeat(100), { cookie: auth.cookie });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /\.exe is not supported/);
    assert.equal(inboxIn(sandbox).length, before, 'refused file reached the inbox');
    const strays = fs.readdirSync(path.join(sandbox, 'inbox')).filter(f => f.endsWith('.part'));
    assert.deepEqual(strays, [], 'refused file was staged before rejection');
  });

  test('a missing X-Klebb-Filename header is a 400 naming the header', async () => {
    const r = await new Promise((resolve, reject) => {
      const rq = http.request(new URL('/api/reports/upload', server.baseUrl), {
        method: 'POST',
        headers: { 'Content-Length': 3, Cookie: auth.cookie },
      }, res => {
        let buf = '';
        res.on('data', c => buf += c);
        res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(buf) }));
      });
      rq.on('error', reject);
      rq.end('abc');
    });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /X-Klebb-Filename/);
  });

  test('a filename that sanitises to nothing is a 400', async () => {
    const r = await upload(server.baseUrl, 'ignored', '...', {
      cookie: auth.cookie,
      encoded: encodeURIComponent('---.txt'),
    });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /empty after sanitising/);
  });

  test('a traversal attempt lands as a sanitised name inside the inbox, never outside HEALTH_HOME', async () => {
    const escapee = path.join(path.dirname(sandbox), 'passwd.txt');
    try { fs.unlinkSync(escapee); } catch {}

    const r = await upload(server.baseUrl, 'x', 'root:x:0:0\n', {
      cookie: auth.cookie,
      encoded: encodeURIComponent('../../passwd.txt'),
    });
    assert.equal(r.status, 202, `expected the sanitised name to be accepted, got ${r.body}`);
    assert.equal(r.json.filename, 'passwd.txt', 'path segments were not stripped');
    assert.ok(!fs.existsSync(escapee), 'wrote outside HEALTH_HOME');

    const found = await waitFor(() => reportsIn(sandbox).find(f => f.includes('passwd')) || null);
    assert.ok(found, 'sanitised upload never produced a report');
    assert.ok(found.startsWith('20'), 'report name is not date-prefixed');
  });

  test('a non-URL-encoded high-byte filename does not crash the endpoint', async () => {
    // Node rejects invalid latin-1 header values before we see them; the
    // contract is that the client encodes. Assert the endpoint answers with a
    // clean 400 rather than a 500 when the value is not decodable.
    const r = await upload(server.baseUrl, 'x', 'body', {
      cookie: auth.cookie,
      encoded: '%E0%A4%A',
    });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /URL-encoded/);
  });

  test('a 15 MB+ body is refused with 413 and leaves no staging file', async () => {
    const big = Buffer.alloc(16 * 1024 * 1024, 0x41);
    const r = await upload(server.baseUrl, 'huge.txt', big, { cookie: auth.cookie });
    assert.equal(r.status, 413, `expected 413, got ${r.status}: ${r.body}`);
    assert.match(r.json.error, /15 MB/);
    assert.equal(r.json.maxBytes, 15 * 1024 * 1024);

    const strays = await waitFor(() => {
      const s = fs.readdirSync(path.join(sandbox, 'inbox')).filter(f => f.endsWith('.part'));
      return s.length === 0 ? 'clean' : null;
    }, { timeoutMs: 5000 });
    assert.equal(strays, 'clean', 'staging file left behind after a size-cap rejection');
    assert.ok(!reportsIn(sandbox).some(f => f.includes('huge')),
      'oversized upload produced a report');
  });

  test('an empty body is refused with 400', async () => {
    const r = await upload(server.baseUrl, 'nothing.txt', '', { cookie: auth.cookie });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /empty upload/);
  });

  test('an abort mid-body leaves no .part orphan', async () => {
    // Wait out any staging file still being cleaned up by an earlier case
    // (the unlink is deferred until the write handle closes).
    const clear = await waitFor(() => {
      const s = fs.readdirSync(path.join(sandbox, 'inbox')).filter(f => f.endsWith('.part'));
      return s.length === 0 ? 'clear' : null;
    }, { timeoutMs: 5000 });
    assert.equal(clear, 'clear', 'precondition: inbox still has a stray .part');

    await new Promise((resolve) => {
      const rq = http.request(new URL('/api/reports/upload', server.baseUrl), {
        method: 'POST',
        headers: {
          'Content-Length': 4 * 1024 * 1024,
          'X-Klebb-Filename': encodeURIComponent('aborted.txt'),
          Cookie: auth.cookie,
        },
      });
      rq.on('error', () => resolve());
      // Write a slice, then kill the socket without finishing the declared body.
      rq.write(Buffer.alloc(64 * 1024, 0x42));
      setTimeout(() => { rq.destroy(); resolve(); }, 150);
    });

    const clean = await waitFor(() => {
      const s = fs.readdirSync(path.join(sandbox, 'inbox')).filter(f => f.endsWith('.part'));
      return s.length === 0 ? 'clean' : null;
    }, { timeoutMs: 6000 });
    assert.equal(clean, 'clean', 'aborted upload left a .part orphan in inbox/');
    assert.ok(!reportsIn(sandbox).some(f => f.includes('aborted')),
      'aborted upload produced a report');
  });

  test('audio without an ASR key fails in the extractor, not at the allow-list', async () => {
    // .mp3 IS allow-listed, so a "not 2xx" assertion would pass for the wrong
    // reason. Assert the endpoint accepted it (202) and that the pipeline
    // moved it to _failed/ with the extractor's own disabled message.
    const r = await upload(server.baseUrl, 'memo.mp3', 'not really mp3 bytes', { cookie: auth.cookie });
    assert.equal(r.status, 202, 'allow-listed audio should be accepted at the boundary');

    const errFile = path.join(sandbox, 'inbox', '_failed', 'memo.mp3.error');
    const errBody = await waitFor(() => {
      try {
        const b = fs.readFileSync(errFile, 'utf8');
        return b.length ? b : null;
      } catch { return null; }
    });
    assert.ok(errBody, 'no sibling .error for memo.mp3');
    assert.match(errBody, /audio ingest disabled|FISH_AUDIO_API_KEY/);
    assert.ok(fs.existsSync(path.join(sandbox, 'inbox', '_failed', 'memo.mp3')),
      'failed source never moved to _failed/');
  });
});

describe('reports upload: session gate', () => {
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

  test('an upload without a session cookie is refused and writes nothing', async () => {
    const r = await upload(server.baseUrl, 'sneaky.txt', 'unauthenticated');
    assert.ok(r.status === 401 || r.status === 403,
      `expected 401/403 without a session, got ${r.status}: ${r.body}`);
    assert.equal(inboxIn(sandbox).length, 0, 'unauthenticated upload reached the inbox');
    assert.deepEqual(reportsIn(sandbox), [], 'unauthenticated upload produced a report');
  });
});

describe('reports upload: demo mode', () => {
  let sandbox, server;

  before(async () => {
    sandbox = createSandbox();
    server = await spawnServer(sandbox, { KLEBB_DEMO: '1' });
  });

  after(async () => {
    if (server) await server.kill();
    if (sandbox) cleanupSandbox(sandbox);
  });

  test('upload is 403 in demo mode and writes nothing', async () => {
    // Demo auto-deploys on every publish, so a missing gate ships to the
    // public demo immediately.
    const login = await req(server.baseUrl, '/auth/demo-login', { method: 'POST' });
    const setCookie = login.headers['set-cookie'];
    const cookie = Array.isArray(setCookie) ? setCookie[0].split(';')[0] : null;

    const r = await upload(server.baseUrl, 'demo.txt', 'should not land', { cookie });
    assert.equal(r.status, 403, `expected 403 in demo mode, got ${r.status}: ${r.body}`);
    assert.match(r.json.error, /demo mode/i);
    assert.equal(inboxIn(sandbox).length, 0, 'demo upload reached the inbox');
    assert.deepEqual(reportsIn(sandbox), [], 'demo upload produced a report');
  });
});

describe('reports upload: the cap', () => {
  let sandbox, server, auth;

  before(async () => {
    auth = fakeAuthState();
    sandbox = createSandbox({ credentials: auth.credentials, sessions: auth.sessions });
    // Cap of 2 with 2 already seeded: the next upload must be refused.
    seedIngestedReport(sandbox, '2026-05-01-one');
    seedIngestedReport(sandbox, '2026-05-02-two');
    // Hand-authored markdown must NOT count, or the demo's fixtures would
    // burn slots and a PROFILE.md would be quota.
    fs.writeFileSync(path.join(sandbox, 'reports', 'PROFILE.md'), '# Profile\n\nhand-authored\n');
    fs.writeFileSync(path.join(sandbox, 'reports', 'notes.md'), '# Notes\n\nalso hand-authored\n');
    server = await spawnServer(sandbox, { KLEBB_REPORTS_MAX: '2' });
  });

  after(async () => {
    if (server) await server.kill();
    if (sandbox) cleanupSandbox(sandbox);
  });

  test('at the cap, an upload is refused with 409 carrying {used, max}', async () => {
    const r = await upload(server.baseUrl, 'third.txt', 'over the line', { cookie: auth.cookie });
    assert.equal(r.status, 409, `expected 409, got ${r.status}: ${r.body}`);
    assert.match(r.json.error, /cap reached \(2\)/);
    assert.equal(r.json.max, 2);
    assert.equal(r.json.used, 2,
      'hand-authored markdown counted against the cap (only sentinel-carrying files should)');
    assert.equal(inboxIn(sandbox).length, 0, 'refused-at-cap upload reached the inbox');
  });

  test('deleting an ingested report frees a slot', async () => {
    fs.unlinkSync(path.join(sandbox, 'reports', '2026-05-01-one.md'));
    const r = await upload(server.baseUrl, 'now-fits.txt', 'under the line', { cookie: auth.cookie });
    assert.equal(r.status, 202, `expected 202 after freeing a slot, got ${r.body}`);
    const found = await waitFor(() => reportsIn(sandbox).find(f => f.includes('now-fits')) || null);
    assert.ok(found, 'upload after freeing a slot never produced a report');
  });
});

describe('reports upload: concurrent uploads cannot exceed the cap', () => {
  let sandbox, server, auth;

  before(async () => {
    auth = fakeAuthState();
    sandbox = createSandbox({ credentials: auth.credentials, sessions: auth.sessions });
    server = await spawnServer(sandbox, { KLEBB_REPORTS_MAX: '3' });
  });

  after(async () => {
    if (server) await server.kill();
    if (sandbox) cleanupSandbox(sandbox);
  });

  test('six uploads fired at once against a cap of 3 produce at most 3 reports', async () => {
    // Without the in-flight reservation, requests racing at used == max-1 all
    // pass the pre-check (a .part file is invisible to the inbox count) and
    // land max+1 reports.
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        upload(server.baseUrl, `race-${i}.txt`, `body ${i}\n`, { cookie: auth.cookie })),
    );
    const accepted = results.filter(r => r.status === 202).length;
    const refused = results.filter(r => r.status === 409).length;
    assert.equal(accepted + refused, 6, `unexpected statuses: ${results.map(r => r.status).join(',')}`);
    assert.ok(accepted <= 3, `${accepted} uploads accepted against a cap of 3`);
    assert.ok(refused >= 3, `only ${refused} refused; the cap did not hold`);

    // Settle, then confirm on disk.
    await waitFor(() => inboxIn(sandbox).length === 0 ? 'drained' : null, { timeoutMs: 15000 });
    assert.ok(reportsIn(sandbox).length <= 3,
      `${reportsIn(sandbox).length} reports on disk against a cap of 3`);
  });
});

describe('reports upload: boot drain', () => {
  test('drain enforces the cap and moves overflow to _failed/ with an actionable reason', async () => {
    const sandbox = createSandbox();
    // Pre-seed the inbox as `docker cp` + restart would.
    for (const n of ['a', 'b', 'c', 'd']) {
      fs.writeFileSync(path.join(sandbox, 'inbox', `${n}.txt`), `content ${n}\n`);
    }
    let server;
    try {
      server = await spawnServer(sandbox, { KLEBB_REPORTS_MAX: '2' });
      const settled = await waitFor(() => {
        const done = reportsIn(sandbox).length;
        const failed = fs.readdirSync(path.join(sandbox, 'inbox', '_failed'))
          .filter(f => f.endsWith('.txt')).length;
        return (done + failed) === 4 ? { done, failed } : null;
      }, { timeoutMs: 15000 });
      assert.ok(settled, 'boot drain never settled');
      assert.equal(settled.done, 2, 'drain ingested more than the cap');
      assert.equal(settled.failed, 2, 'over-cap files did not land in _failed/');

      const errFiles = fs.readdirSync(path.join(sandbox, 'inbox', '_failed'))
        .filter(f => f.endsWith('.error'));
      assert.equal(errFiles.length, 2);
      const reason = fs.readFileSync(path.join(sandbox, 'inbox', '_failed', errFiles[0]), 'utf8');
      assert.match(reason, /report cap reached \(2\)/);
      assert.match(reason, /delete a report and re-upload/);
    } finally {
      if (server) await server.kill();
      cleanupSandbox(sandbox);
    }
  });

  test('a stray .part in the inbox is skipped by the drain, not ingested', async () => {
    const sandbox = createSandbox();
    fs.writeFileSync(path.join(sandbox, 'inbox', '.orphan.txt.part'), 'half an upload');
    fs.writeFileSync(path.join(sandbox, 'inbox', 'real.txt'), 'a whole file\n');
    let server;
    try {
      server = await spawnServer(sandbox);
      const found = await waitFor(() => reportsIn(sandbox).find(f => f.includes('real')) || null);
      assert.ok(found, 'the real file was not ingested');
      assert.ok(!reportsIn(sandbox).some(f => f.includes('orphan')),
        'a .part staging file was ingested as a report');
      assert.ok(fs.existsSync(path.join(sandbox, 'inbox', '.orphan.txt.part')),
        'the drain consumed the .part file instead of leaving it');
    } finally {
      if (server) await server.kill();
      cleanupSandbox(sandbox);
    }
  });
});
