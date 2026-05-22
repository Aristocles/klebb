// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/ingest.test.js
//
// Covers the inbox -> reports ingest pipeline. Three layers:
//   1. Pure-function unit tests (no fs, no env): header parser, filename
//      builder, dispatcher rejection, text extractor.
//   2. Per-process unit tests with a fixed HEALTH_HOME so chat/reports
//      can resolve PATHS.REPORTS_DIR against a sandbox tree.
//   3. End-to-end via spawnServer: drop a file into inbox/, watch the
//      pipeline produce reports/<date>-<stem>.md and archive the source.

const fs = require('fs');
const os = require('os');
const path = require('path');
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
  createSandbox, cleanupSandbox, spawnServer,
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

describe('ingest pipeline: end-to-end via spawnServer', () => {
  let sandbox;
  let server;

  before(async () => {
    sandbox = createSandbox();
    server = await spawnServer(sandbox);
  });

  after(async () => {
    if (server) await server.kill();
    if (sandbox) cleanupSandbox(sandbox);
  });

  test('text drop produces a .md report and archives the source', async () => {
    const inbox = path.join(sandbox, 'inbox');
    const reports = path.join(sandbox, 'reports');
    const archive = path.join(reports, '_archive');
    const src = path.join(inbox, 'note.txt');
    fs.writeFileSync(src, 'hello world\n');

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
    assert.ok(!fs.existsSync(src), 'source still in inbox');
  });

  test('unsupported extension lands in _failed/ with a sibling .error', async () => {
    const inbox = path.join(sandbox, 'inbox');
    const failed = path.join(inbox, '_failed');
    const src = path.join(inbox, 'evil.docx');
    fs.writeFileSync(src, 'binary doom');

    const moved = await waitFor(() => {
      return fs.existsSync(path.join(failed, 'evil.docx')) ? true : null;
    });
    assert.ok(moved, 'evil.docx never moved to _failed/');

    const errFile = path.join(failed, 'evil.docx.error');
    assert.ok(fs.existsSync(errFile), 'no sibling .error written');
    const errBody = fs.readFileSync(errFile, 'utf8');
    assert.match(errBody, /unsupported format/);
  });

  test('audio drop without FISH_AUDIO_API_KEY lands in _failed/ with the disabled message', async () => {
    const inbox = path.join(sandbox, 'inbox');
    const failed = path.join(inbox, '_failed');
    const src = path.join(inbox, 'voice-note.mp3');
    fs.writeFileSync(src, 'not really mp3 bytes; ffmpeg+ASR will not run');

    const moved = await waitFor(() => {
      return fs.existsSync(path.join(failed, 'voice-note.mp3')) ? true : null;
    });
    assert.ok(moved, 'voice-note.mp3 never moved to _failed/');

    const errBody = fs.readFileSync(path.join(failed, 'voice-note.mp3.error'), 'utf8');
    assert.match(errBody, /audio ingest disabled|FISH_AUDIO_API_KEY/);
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
