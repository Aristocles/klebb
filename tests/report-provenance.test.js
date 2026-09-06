// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/report-provenance.test.js
// Reader provenance in the report header (#680): writeReport and
// parseReportHeader agree byte-for-byte on read_by / ocr_attempts /
// unwitnessed, and describeReport exposes them to the client.
//
// Pure-function and fs-only; no spawnServer in this file.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { writeReport } = require('../ingest/writeReport');
const { parseReportHeader } = require('../ingest/catalogue');
const { describeReport } = require('../lib/reports-api');

describe('#680 provenance fields round-trip', () => {
  let dir;
  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klebb-prov-')); });
  after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  const write = (fields) => {
    const { outAbs } = writeReport({
      reportsDir: dir,
      version: 2,
      text: 'TSH 2.1 mIU/L',
      sourceFile: `${fields.name || 'r'}.png`,
      sourceFormat: 'image',
      ingestedAt: '2026-09-06T01:02:03Z',
      archivePath: 'reports/_archive/r.png',
      status: 'ready',
      verify: 'required',
      title: 'Thyroid panel',
      ...fields,
    });
    return parseReportHeader(fs.readFileSync(outAbs, 'utf8'));
  };

  test('a vision read with an uncorroborated number round-trips', () => {
    const h = write({
      name: 'v1', readBy: 'vision', ocrAttempts: ['vision'], unwitnessed: ['2.1', '147'],
    });
    assert.equal(h.readBy, 'vision');
    assert.deepEqual(h.ocrAttempts, ['vision']);
    assert.deepEqual(h.unwitnessed, ['2.1', '147']);
    assert.equal(h.ocrPsm, null);
  });

  test('a fully corroborated read records none and parses to an empty list', () => {
    const h = write({ name: 'v2', readBy: 'vision', ocrAttempts: ['vision'], unwitnessed: [] });
    assert.deepEqual(h.unwitnessed, []);
  });

  test('no witness means no line, parsed back as null', () => {
    const h = write({ name: 'v3', readBy: 'vision', ocrAttempts: ['vision'], unwitnessed: null });
    assert.equal(h.unwitnessed, null);
  });

  test('a tesseract read keeps its psm and carries the walked ladder', () => {
    const h = write({
      name: 't1', readBy: 'tesseract', ocrPsm: 6, ocrAttempts: ['vision', '3', '6'],
    });
    assert.equal(h.readBy, 'tesseract');
    assert.equal(h.ocrPsm, 6);
    assert.deepEqual(h.ocrAttempts, ['vision', '3', '6']);
  });

  test('junk never reaches the header lines', () => {
    const h = write({
      name: 'junk',
      readBy: 'something-else',
      ocrAttempts: ['vision', 'DROP TABLE', '3\nstatus: ready'],
      unwitnessed: ['2.1', 'NaN;rm -rf', '..7'],
    });
    assert.equal(h.readBy, null, 'an unknown reader must not be written');
    assert.deepEqual(h.ocrAttempts, ['vision'], 'non-label attempts are dropped');
    assert.deepEqual(h.unwitnessed, ['2.1', '..7'], 'only digit/dot tokens survive');
  });

  test('a legacy header without the new keys parses to the old shape', () => {
    const h = write({ name: 'legacy', ocrPsm: 3 });
    assert.equal(h.readBy, null);
    assert.deepEqual(h.ocrAttempts, []);
    assert.equal(h.unwitnessed, null);
  });
});

describe('#680 describeReport exposure', () => {
  const describeFor = (headerLines, body = 'Haemoglobin 147 g/L') => describeReport('x', [
    '---', 'klebb_ingest: v2', 'source_file: x.png', 'source_format: image',
    'ingested_at: 2026-09-06T01:02:03Z', 'archive_path: reports/_archive/x.png',
    'status: ready', 'verify: required', ...headerLines, '---', '', body,
  ].join('\n'));

  test('readBy, unwitnessed and the next rung reach the client', () => {
    const d = describeFor(['read_by: vision', 'ocr_attempts: vision', 'unwitnessed: 2.1 147']);
    assert.equal(d.readBy, 'vision');
    assert.deepEqual(d.unwitnessed, ['2.1', '147']);
    assert.equal(d.nextRead, '3', 'vision already produced text, so the next rung is psm 3');
  });

  test('an exhausted ladder reports the bottom rung whatever the gateway state', () => {
    const d = describeFor(['read_by: tesseract', 'ocr_psm: 4', 'ocr_attempts: vision 3 6 4']);
    assert.equal(d.nextRead, '4');
  });

  test('formats that never need reading have no next rung', () => {
    const d = describeReport('t', [
      '---', 'klebb_ingest: v2', 'source_file: t.txt', 'source_format: text',
      'ingested_at: 2026-09-06T01:02:03Z', 'archive_path: reports/_archive/t.txt',
      'status: ready', 'verify: not_required', '---', '', 'notes',
    ].join('\n'));
    assert.equal(d.nextRead, null);
    assert.equal(d.readBy, null);
    assert.equal(d.unwitnessed, null);
  });
});
