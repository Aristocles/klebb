// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/imageprep.test.js
// Image preparation for the vision reader (#679): dimension sniffing without
// a decoder, the pass-through/downscale/unpreparable decision, and the ffmpeg
// downscale itself where the binary exists.
//
// Pure-function and fs-only; no spawnServer in this file.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  prepareImage, sniffDimensions, toDataUrl, hasFfmpeg,
  VISION_LONG_EDGE, PASS_THROUGH_MAX_BYTES,
} = require('../ingest/extractors/imageprep');
const { makePng } = require('./helpers/binary-fixtures');

function which(bin) {
  return spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin]).status === 0;
}
const HAS_FFMPEG = which('ffmpeg');

// A minimal JPEG header stream: SOI, the given app/table segments, one SOF0
// carrying the dimensions. Enough for the sniffer, which never decodes.
function makeJpegHeader(width, height, { fillBytes = 0, exifPadding = 0, omitSof = false } = {}) {
  const parts = [Buffer.from([0xff, 0xd8])];
  if (fillBytes) parts.push(Buffer.alloc(fillBytes, 0xff));
  parts.push(Buffer.from([0xff, 0xe0, 0x00, 0x10]),
    Buffer.from('JFIF\0', 'ascii'), Buffer.from([1, 1, 0, 0, 1, 0, 1, 0, 0]));
  if (exifPadding) {
    const seg = Buffer.alloc(exifPadding + 2);
    seg.writeUInt16BE(exifPadding + 2, 0);
    parts.push(Buffer.from([0xff, 0xe1]), seg);
  }
  if (!omitSof) {
    const sof = Buffer.alloc(4 + 15);
    sof[0] = 0xff; sof[1] = 0xc0;
    sof.writeUInt16BE(17, 2);
    sof[4] = 8;
    sof.writeUInt16BE(height, 5);
    sof.writeUInt16BE(width, 7);
    sof[9] = 3;
    parts.push(sof);
  }
  parts.push(Buffer.from([0xff, 0xda, 0x00, 0x04, 0x01, 0x00]));
  parts.push(Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}

describe('#679 dimension sniffing', () => {
  test('reads PNG dimensions from IHDR', () => {
    assert.deepEqual(sniffDimensions(makePng(8, 8)), { width: 8, height: 8, type: 'png' });
    assert.deepEqual(sniffDimensions(makePng(2000, 4)), { width: 2000, height: 4, type: 'png' });
  });

  test('reads JPEG dimensions from the SOF frame header', () => {
    assert.deepEqual(sniffDimensions(makeJpegHeader(640, 480)), { width: 640, height: 480, type: 'jpeg' });
  });

  test('walks past an APP1 segment (EXIF sits before the frame header)', () => {
    assert.deepEqual(sniffDimensions(makeJpegHeader(1200, 900, { exifPadding: 512 })),
      { width: 1200, height: 900, type: 'jpeg' });
  });

  test('tolerates fill bytes between segments', () => {
    assert.deepEqual(sniffDimensions(makeJpegHeader(64, 32, { fillBytes: 3 })),
      { width: 64, height: 32, type: 'jpeg' });
  });

  test('gives up rather than scan compressed data when no SOF appears', () => {
    assert.equal(sniffDimensions(makeJpegHeader(64, 32, { omitSof: true })), null);
  });

  test('returns null for non-image bytes', () => {
    assert.equal(sniffDimensions(Buffer.from('definitely not an image')), null);
    assert.equal(sniffDimensions(Buffer.alloc(0)), null);
    assert.equal(sniffDimensions(null), null);
  });
});

describe('#679 prepareImage decision', () => {
  let tmp;
  before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'klebb-imageprep-')); });
  after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

  const write = (name, buf) => {
    const abs = path.join(tmp, name);
    fs.writeFileSync(abs, buf);
    return abs;
  };

  test('an already-small image passes through untouched', async () => {
    const abs = write('small.png', makePng(8, 8));
    const r = await prepareImage(abs, tmp, { ffmpeg: false });
    assert.equal(r.ok, true);
    assert.equal(r.path, abs);
    assert.equal(r.prepared, false);
    assert.equal(r.mediaType, 'image/png');
  });

  test('media type comes from the bytes, not the extension', async () => {
    const abs = write('mislabeled.png', makeJpegHeader(100, 100));
    const r = await prepareImage(abs, tmp, { ffmpeg: false });
    assert.equal(r.ok, true);
    assert.equal(r.mediaType, 'image/jpeg');
  });

  test('an oversized image without ffmpeg is unpreparable, with the size named', async () => {
    const abs = write('big.png', makePng(VISION_LONG_EDGE + 432, 4));
    const r = await prepareImage(abs, tmp, { ffmpeg: false });
    assert.equal(r.ok, false);
    assert.match(r.reason, /2000x4/);
    assert.match(r.reason, /ffmpeg/);
  });

  test('unsniffable bytes never pass through', async () => {
    const abs = write('garbage.jpg', Buffer.from('junk that is not an image'));
    const r = await prepareImage(abs, tmp, { ffmpeg: false });
    assert.equal(r.ok, false);
    assert.match(r.reason, /dimensions could not be read/);
  });

  test('a small-pixel but huge-byte file does not pass through', async () => {
    const abs = write('padded.png',
      Buffer.concat([makePng(8, 8), Buffer.alloc(PASS_THROUGH_MAX_BYTES, 0)]));
    const r = await prepareImage(abs, tmp, { ffmpeg: false });
    assert.equal(r.ok, false);
  });

  test('a missing file reports rather than throws', async () => {
    const r = await prepareImage(path.join(tmp, 'nope.png'), tmp, { ffmpeg: false });
    assert.equal(r.ok, false);
    assert.match(r.reason, /could not read image/);
  });

  test('ffmpeg probe answers without throwing either way', () => {
    assert.equal(hasFfmpeg(), HAS_FFMPEG);
  });

  test('ffmpeg downscales to the long-edge ceiling', { skip: !HAS_FFMPEG }, async () => {
    const abs = write('wide.png', makePng(2000, 50));
    const r = await prepareImage(abs, tmp);
    assert.equal(r.ok, true);
    assert.equal(r.prepared, true);
    assert.equal(r.mediaType, 'image/jpeg');
    assert.notEqual(r.path, abs);
    const dims = sniffDimensions(fs.readFileSync(r.path));
    assert.ok(dims, 'prepared output must be a sniffable JPEG');
    assert.equal(Math.max(dims.width, dims.height), VISION_LONG_EDGE);
  });

  test('ffmpeg never upscales a small original it re-encodes', { skip: !HAS_FFMPEG }, async () => {
    // Small pixels + padded bytes forces the re-encode path for a tiny image.
    const abs = write('padded-small.png',
      Buffer.concat([makePng(100, 60), Buffer.alloc(PASS_THROUGH_MAX_BYTES, 0)]));
    const r = await prepareImage(abs, tmp);
    assert.equal(r.ok, true);
    const dims = sniffDimensions(fs.readFileSync(r.path));
    assert.ok(dims.width <= 100 && dims.height <= 60,
      `expected no upscale, got ${dims.width}x${dims.height}`);
  });
});

describe('#679 toDataUrl', () => {
  test('round-trips the bytes under the stated media type', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'klebb-dataurl-'));
    try {
      const png = makePng(8, 8);
      const abs = path.join(tmp, 'x.png');
      fs.writeFileSync(abs, png);
      const url = toDataUrl(abs, 'image/png');
      assert.ok(url.startsWith('data:image/png;base64,'));
      const decoded = Buffer.from(url.slice('data:image/png;base64,'.length), 'base64');
      assert.deepEqual(decoded, png);
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    }
  });
});
