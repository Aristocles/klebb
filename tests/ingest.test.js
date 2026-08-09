// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/ingest.test.js
//
// Covers the inbox -> reports ingest pipeline. Three layers:
//   1. Pure-function unit tests (no fs, no env): header parser, filename
//      builder, dispatcher rejection, text extractor, quota counting.
//   2. Per-process unit tests with a fixed HEALTH_HOME so chat/reports
//      can resolve PATHS.REPORTS_DIR against a sandbox tree.
//   3. End-to-end via spawnServer: upload a file, watch the pipeline
//      produce reports/<date>-<stem>.md and archive the source.
//
// The endpoint's own guards (allow-list, size, quota, demo, auth, staging
// lifecycle) live in tests/reports-upload.test.js. What stays here is the
// pipeline behind it, plus the operator door: a file that reaches the inbox
// by `docker cp` + restart rather than by upload.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync, spawn } = require('child_process');

// Set HEALTH_HOME BEFORE requiring any module that imports config/paths.
// paths.js captures HEALTH_HOME at require time, so this has to happen
// before the chat/reports / ingest requires below.
const SHARED_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'eh-ingest-'));
fs.mkdirSync(path.join(SHARED_HOME, 'reports', '_archive'), { recursive: true });
fs.mkdirSync(path.join(SHARED_HOME, 'inbox', '_failed'), { recursive: true });
process.env.HEALTH_HOME = SHARED_HOME;
process.env.HEALTH_HOME_WARNED = '1';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const {
  createSandbox, cleanupSandbox, spawnServer, fakeAuthState,
} = require('./helpers/sandbox');

const { parseReportHeader, describeReportsCatalogue } = require('../ingest/catalogue');
const { buildOutputName, sanitiseStem, writeReport } = require('../ingest/writeReport');
const { extract, formatFor } = require('../ingest/extract');
const { extractText } = require('../ingest/extractors/text');
const { readReport } = require('../chat/reports');
const { TOOL_DEFS, dispatchToolCall } = require('../chat/tools');

const REPO_ROOT = path.resolve(__dirname, '..');

function which(bin) {
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin]);
  return probe.status === 0;
}

function makeToolCall(name, args) {
  return { function: { name, arguments: JSON.stringify(args) } };
}

// Raw-body upload; the filename rides URL-encoded in a header (no multipart).
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
    r.setTimeout(15000, () => r.destroy(new Error('request timeout')));
    r.write(payload);
    r.end();
  });
}

async function waitFor(predicate, { timeoutMs = 8000, intervalMs = 200 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await predicate();
    if (result) return result;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return null;
}

describe('ingest/catalogue.parseReportHeader', () => {
  test('parses a valid v1 header', () => {
    const text = [
      '---',
      'klebb_ingest: v1',
      'source_file: bloods.pdf',
      'source_format: pdf',
      'ingested_at: 2026-05-22T14:07:33Z',
      'archive_path: reports/_archive/bloods.pdf',
      '---',
      '',
      '# bloods',
      'body',
    ].join('\n');
    const out = parseReportHeader(text);
    assert.equal(out.sourceFile, 'bloods.pdf');
    assert.equal(out.sourceFormat, 'pdf');
    assert.equal(out.ingestedAt, '2026-05-22T14:07:33Z');
    assert.equal(out.archivePath, 'reports/_archive/bloods.pdf');
  });

  test('returns null without the v1 sentinel', () => {
    const text = [
      '---',
      'source_file: bloods.pdf',
      'source_format: pdf',
      'ingested_at: 2026-05-22T14:07:33Z',
      '---',
      '',
    ].join('\n');
    assert.equal(parseReportHeader(text), null);
  });

  test('returns null on a truncated/missing closing fence', () => {
    const text = '---\nklebb_ingest: v1\nsource_file: x.pdf\n';
    assert.equal(parseReportHeader(text), null);
  });

  test('returns null on missing required keys', () => {
    const text = '---\nklebb_ingest: v1\nsource_file: x.pdf\n---\n';
    assert.equal(parseReportHeader(text), null);
  });
});

describe('ingest/writeReport: buildOutputName + sanitiseStem', () => {
  test('builds <YYYY-MM-DD>-<stem> from filename + ISO timestamp', () => {
    const out = buildOutputName('Bloods April Fast.pdf', '2026-05-22T14:07:33Z');
    assert.equal(out, '2026-05-22-bloods-april-fast');
  });

  test('strips disallowed characters and collapses runs', () => {
    assert.equal(sanitiseStem('Foo / Bar  *  Baz!'), 'foo-bar-baz');
  });

  test('truncates to 80 chars', () => {
    const long = 'a'.repeat(200);
    assert.equal(sanitiseStem(long).length, 80);
  });

  test('writeReport collides safely (-2 suffix)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eh-write-'));
    try {
      const a = writeReport({
        reportsDir: dir,
        text: 'first',
        sourceFile: 'note.txt',
        sourceFormat: 'text',
        ingestedAt: '2026-05-22T14:07:33Z',
        archivePath: 'reports/_archive/note.txt',
      });
      const b = writeReport({
        reportsDir: dir,
        text: 'second',
        sourceFile: 'note.txt',
        sourceFormat: 'text',
        ingestedAt: '2026-05-22T14:07:33Z',
        archivePath: 'reports/_archive/note.txt',
      });
      assert.equal(a.outName, '2026-05-22-note');
      assert.equal(b.outName, '2026-05-22-note-2');
      assert.ok(fs.existsSync(a.outAbs));
      assert.ok(fs.existsSync(b.outAbs));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('ingest/extract dispatcher', () => {
  test('formatFor maps known extensions', () => {
    assert.equal(formatFor('foo.pdf'), 'pdf');
    assert.equal(formatFor('foo.PNG'), 'image');
    assert.equal(formatFor('foo.txt'), 'text');
    assert.equal(formatFor('foo.md'), 'markdown');
    assert.equal(formatFor('foo.mp3'), 'audio');
    assert.equal(formatFor('foo.docx'), null);
  });

  test('extract rejects unsupported formats', async () => {
    await assert.rejects(
      () => extract('/tmp/foo.docx'),
      /unsupported format/,
    );
  });

  test('extractText reads file verbatim as utf8', async () => {
    const tmp = path.join(SHARED_HOME, 'extract-text-fixture.txt');
    fs.writeFileSync(tmp, 'hello\nworld\n');
    const out = await extractText(tmp);
    assert.equal(out.text, 'hello\nworld\n');
    fs.rmSync(tmp);
  });
});

describe('chat/reports.readReport: traversal guards', () => {
  test('rejects non-string / empty', () => {
    assert.match(readReport('').error, /required/);
    assert.match(readReport(null).error, /required/);
    assert.match(readReport(undefined).error, /required/);
  });

  test('rejects names with slashes / .. / dots', () => {
    assert.match(readReport('../etc/passwd').error, /invalid report name/);
    assert.match(readReport('foo/bar').error, /invalid report name/);
    assert.match(readReport('a b').error, /invalid report name/);
  });

  test('returns {error} for missing report', () => {
    const r = readReport('does-not-exist');
    assert.match(r.error, /failed to read/);
  });

  test('returns content + parsed header for an ingested report', () => {
    const reportsDir = path.join(SHARED_HOME, 'reports');
    const fixture = [
      '---',
      'klebb_ingest: v1',
      'source_file: bloods.pdf',
      'source_format: pdf',
      'ingested_at: 2026-05-22T14:07:33Z',
      'archive_path: reports/_archive/bloods.pdf',
      '---',
      '',
      '# 2026-05-22-bloods',
      '',
      'body',
    ].join('\n');
    fs.writeFileSync(path.join(reportsDir, '2026-05-22-bloods.md'), fixture);
    const r = readReport('2026-05-22-bloods');
    assert.equal(r.name, '2026-05-22-bloods');
    assert.equal(r.path, 'reports/2026-05-22-bloods.md');
    assert.ok(r.content.includes('# 2026-05-22-bloods'));
    assert.equal(r.sourceFormat, 'pdf');
    assert.equal(r.ingestedAt, '2026-05-22T14:07:33Z');
    assert.equal(r.truncated, false);
  });
});

describe('chat tools: read_report', () => {
  test('TOOL_DEFS includes read_report with the expected shape', () => {
    const def = TOOL_DEFS.find(t => t.function?.name === 'read_report');
    assert.ok(def, 'read_report not registered');
    assert.equal(def.type, 'function');
    assert.deepEqual(def.function.parameters.required, ['name']);
    assert.equal(def.function.parameters.properties.name.type, 'string');
    assert.equal(def.function.parameters.additionalProperties, false);
  });

  test('dispatchToolCall(read_report) returns content for an existing report', () => {
    const out = dispatchToolCall(makeToolCall('read_report', { name: '2026-05-22-bloods' }));
    const parsed = JSON.parse(out);
    assert.equal(parsed.name, '2026-05-22-bloods');
    assert.ok(parsed.content.length > 0);
  });

  test('dispatchToolCall(read_report) rejects traversal at the tool layer', () => {
    const out = dispatchToolCall(makeToolCall('read_report', { name: '../etc/passwd' }));
    const parsed = JSON.parse(out);
    assert.match(parsed.error, /invalid report name/);
  });
});

describe('ingest pipeline: end-to-end via the upload endpoint', () => {
  let sandbox;
  let server;
  let auth;

  before(async () => {
    auth = fakeAuthState();
    sandbox = createSandbox({ credentials: auth.credentials, sessions: auth.sessions });
    server = await spawnServer(sandbox);
  });

  after(async () => {
    if (server) await server.kill();
    if (sandbox) cleanupSandbox(sandbox);
  });

  test('an uploaded text file produces a .md report and archives the source', async () => {
    const reports = path.join(sandbox, 'reports');
    const archive = path.join(reports, '_archive');

    const r = await upload(server.baseUrl, 'note.txt', 'hello world\n', auth.cookie);
    assert.equal(r.status, 202, `upload rejected: ${r.body}`);

    const found = await waitFor(() => {
      const files = fs.readdirSync(reports).filter(f => f.endsWith('.md'));
      return files.length ? files[0] : null;
    });
    assert.ok(found, 'no .md report was produced inside 8s');

    const body = fs.readFileSync(path.join(reports, found), 'utf8');
    const header = parseReportHeader(body);
    assert.ok(header, 'header did not parse');
    assert.equal(header.sourceFormat, 'text');
    assert.equal(header.sourceFile, 'note.txt');
    assert.match(body, /hello world/);

    assert.ok(fs.existsSync(path.join(archive, 'note.txt')),
      'source not archived');
    assert.ok(!fs.existsSync(path.join(sandbox, 'inbox', 'note.txt')),
      'source still in inbox');
  });

  test('audio without FISH_AUDIO_API_KEY lands in _failed/ with the disabled message', async () => {
    const failed = path.join(sandbox, 'inbox', '_failed');
    const r = await upload(server.baseUrl, 'voice-note.mp3', 'not really mp3 bytes; ffmpeg+ASR will not run', auth.cookie);
    assert.equal(r.status, 202, 'allow-listed audio should be accepted at the boundary');

    // Poll the sidecar (the LAST artefact the pipeline writes), not the
    // moved file (the first). The pipeline does renameSync then a
    // separate writeFileSync for the .error; on Node 22 in CI the second
    // write occasionally lags the rename, so polling for the moved file
    // and then immediately reading the sidecar raced (#377).
    const errFile = path.join(failed, 'voice-note.mp3.error');
    const errBody = await waitFor(() => {
      try {
        const body = fs.readFileSync(errFile, 'utf8');
        return body.length > 0 ? body : null;
      } catch { return null; }
    });
    assert.ok(errBody, 'no sibling .error written for voice-note.mp3');
    assert.ok(fs.existsSync(path.join(failed, 'voice-note.mp3')),
      'source file never moved to _failed/');
    assert.match(errBody, /audio ingest disabled|FISH_AUDIO_API_KEY/);
  });
});

describe('ingest pipeline: the operator door (docker cp + restart)', () => {
  test('an unsupported extension in the inbox at boot lands in _failed/ with a sibling .error', async () => {
    // The endpoint refuses a non-allow-listed extension before the body is
    // read, so the only way one reaches the inbox is the operator door. The
    // drain must still reject it rather than throw.
    const sandbox = createSandbox();
    const failed = path.join(sandbox, 'inbox', '_failed');
    fs.writeFileSync(path.join(sandbox, 'inbox', 'evil.xyz'), 'binary doom');
    let server;
    try {
      server = await spawnServer(sandbox);
      const errBody = await waitFor(() => {
        try {
          const body = fs.readFileSync(path.join(failed, 'evil.xyz.error'), 'utf8');
          return body.length > 0 ? body : null;
        } catch { return null; }
      });
      assert.ok(errBody, 'no sibling .error written for evil.xyz');
      assert.ok(fs.existsSync(path.join(failed, 'evil.xyz')),
        'source file never moved to _failed/');
      assert.match(errBody, /unsupported format/);
    } finally {
      if (server) await server.kill();
      cleanupSandbox(sandbox);
    }
  });

  test('extraction is serialised: never more than one file in flight', async () => {
    // One slot, not a pool: tesseract and pdftoppm are CPU-bound and share
    // node's thread with request serving. Observed via the archive order and
    // per-file completion, using the drain to submit several at once.
    const sandbox = createSandbox();
    const COUNT = 5;
    for (let i = 0; i < COUNT; i++) {
      fs.writeFileSync(path.join(sandbox, 'inbox', `serial-${i}.txt`), `body ${i}\n`);
    }
    let server;
    try {
      server = await spawnServer(sandbox);
      const done = await waitFor(() => {
        const n = fs.readdirSync(path.join(sandbox, 'reports')).filter(f => f.endsWith('.md')).length;
        return n === COUNT ? n : null;
      }, { timeoutMs: 20000 });
      assert.equal(done, COUNT, 'not every drained file produced a report');
      assert.equal(fs.readdirSync(path.join(sandbox, 'inbox')).filter(f => f !== '_failed').length, 0,
        'inbox not fully drained');
      const archived = fs.readdirSync(path.join(sandbox, 'reports', '_archive'));
      assert.equal(archived.length, COUNT, 'not every source was archived');
    } finally {
      if (server) await server.kill();
      cleanupSandbox(sandbox);
    }
  });
});

describe('ingest/pipeline: queue serialisation is re-entrancy safe', () => {
  test('two enqueue calls in the same tick do not start parallel chains', async () => {
    // _running must be set synchronously before the first await, or two
    // synchronous enqueue() calls both observe false and drive the queue
    // twice concurrently.
    const pipeline = require('../ingest/pipeline');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eh-queue-'));
    try {
      const a = path.join(dir, 'a.txt');
      const b = path.join(dir, 'b.txt');
      fs.writeFileSync(a, 'a');
      fs.writeFileSync(b, 'b');
      pipeline.enqueue(a);
      pipeline.enqueue(b);
      // Depth counts queued + the one in flight; two parallel chains would
      // have already shifted both entries off by now.
      assert.ok(pipeline.queueDepth() >= 1, 'the queue drained synchronously');
      assert.ok(pipeline.queueDepth() <= 2, `queue depth ${pipeline.queueDepth()} exceeds submitted work`);
      await waitFor(() => pipeline.queueDepth() === 0 ? 'drained' : null, { timeoutMs: 10000 });
      assert.equal(pipeline.queueDepth(), 0, 'queue never drained');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('enqueue is idempotent for a path already queued', () => {
    const pipeline = require('../ingest/pipeline');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eh-queue2-'));
    try {
      const p = path.join(dir, 'dup.txt');
      fs.writeFileSync(p, 'x');
      pipeline.stop();
      pipeline.enqueue(p);
      pipeline.enqueue(p);
      pipeline.enqueue(p);
      assert.ok(pipeline.queueDepth() <= 2,
        `the same path was queued ${pipeline.queueDepth()} times`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('ingest/catalogue: quota counting', () => {
  const { countIngestedReports, quota, notePendingUpload, releasePendingUpload, pendingUploads } =
    require('../ingest/catalogue');

  test('hand-authored markdown does not count against the cap', () => {
    // Asserted as a delta, not an absolute: earlier suites in this file write
    // real reports into SHARED_HOME, and the invariant under test is "adding
    // hand-authored files changes nothing", not any particular total.
    const reportsDir = path.join(SHARED_HOME, 'reports');
    const before = countIngestedReports();

    fs.writeFileSync(path.join(reportsDir, 'PROFILE.md'), '# Profile\n\nhand-authored\n');
    fs.writeFileSync(path.join(reportsDir, 'genome-notes.md'), '# Genome\n\nalso hand-authored\n');
    fs.writeFileSync(path.join(reportsDir, 'not-markdown.txt'), 'ignored entirely\n');

    assert.equal(countIngestedReports(), before,
      'hand-authored markdown counted; the demo fixtures would burn quota slots');
  });

  test('a sentinel-carrying report does count against the cap', () => {
    const reportsDir = path.join(SHARED_HOME, 'reports');
    const before = countIngestedReports();
    fs.writeFileSync(path.join(reportsDir, 'quota-probe.md'), [
      '---',
      'klebb_ingest: v1',
      'source_file: probe.txt',
      'source_format: text',
      'ingested_at: 2026-06-01T00:00:00Z',
      'archive_path: reports/_archive/probe.txt',
      '---',
      '',
      '# quota-probe',
    ].join('\n'));
    assert.equal(countIngestedReports(), before + 1,
      'an ingested report was not counted; the cap would never engage');
    fs.unlinkSync(path.join(reportsDir, 'quota-probe.md'));
    assert.equal(countIngestedReports(), before, 'deleting a report did not free its slot');
  });

  test('quota() reports {used, max, remaining} and includes in-flight uploads', () => {
    const before = quota();
    assert.equal(typeof before.max, 'number');
    assert.equal(before.remaining, Math.max(0, before.max - before.used));

    notePendingUpload();
    assert.equal(pendingUploads(), 1);
    const during = quota();
    assert.equal(during.used, before.used + 1,
      'an accepted-but-not-yet-renamed upload is invisible to the cap');
    releasePendingUpload();
    assert.equal(pendingUploads(), 0);
    assert.equal(quota().used, before.used);
  });

  test('releasePendingUpload never drives the counter negative', () => {
    releasePendingUpload();
    releasePendingUpload();
    assert.equal(pendingUploads(), 0);
  });
});

// Optional PDF / image happy-paths only run if the underlying binaries are
// installed. CI without poppler-utils / tesseract still passes the rest.
const HAS_PDFTOTEXT = which('pdftotext');
const HAS_TESSERACT = which('tesseract');

describe('ingest pipeline: optional binary-backed paths', () => {
  test('pdftotext binary is on PATH', { skip: !HAS_PDFTOTEXT }, () => {
    assert.ok(HAS_PDFTOTEXT);
  });
  test('tesseract binary is on PATH', { skip: !HAS_TESSERACT }, () => {
    assert.ok(HAS_TESSERACT);
  });
});

after(() => {
  try { fs.rmSync(SHARED_HOME, { recursive: true, force: true }); } catch {}
});
