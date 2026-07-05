// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/qr-encoder.test.js
// The vendored QR encoder (public/js/lib/qr.js) backs the add-a-device
// invite QR in Settings > Security. Pure maths, no browser APIs, so it runs
// under Node directly. Structural invariants only: full decode validation
// needs a camera-grade decoder, which is not worth a test dependency; the
// spec constants asserted here (size, finder/timing patterns, format bits)
// are what scanners key on, and any RS/masking regression breaks them.

const { test, describe, before } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { pathToFileURL } = require('url');

let qrMatrix, qrSvg;

before(async () => {
  const mod = await import(pathToFileURL(
    path.resolve(__dirname, '..', 'public', 'js', 'lib', 'qr.js')).href);
  qrMatrix = mod.qrMatrix;
  qrSvg = mod.qrSvg;
});

describe('#482 qr encoder', () => {
  test('version scales with content length; size = 4v + 17', () => {
    assert.equal(qrMatrix('x').length, 21, 'version 1');
    const url = 'https://wren.klebb.app/register?code=wren-1a2b3c4d';
    assert.equal(qrMatrix(url).length, 33, '50 bytes -> version 4');
    assert.equal(qrMatrix('A'.repeat(106)).length, 41, 'capacity edge -> version 6');
  });

  test('rejects content beyond version-6 capacity', () => {
    assert.throws(() => qrMatrix('A'.repeat(107)), /too long/i);
  });

  test('matrix is square and fully boolean (no unfilled modules)', () => {
    const m = qrMatrix('https://example.klebb.app/register?code=user-12345678');
    for (const row of m) {
      assert.equal(row.length, m.length);
      for (const cell of row) assert.equal(typeof cell, 'boolean');
    }
  });

  test('finder patterns sit in three corners', () => {
    const m = qrMatrix('klebb');
    const size = m.length;
    const checkFinder = (r, c) => {
      for (let i = 0; i < 7; i++) {
        assert.equal(m[r][c + i], true, `finder top edge at ${r},${c + i}`);
        assert.equal(m[r + 6][c + i], true, 'finder bottom edge');
        assert.equal(m[r + i][c], true, 'finder left edge');
        assert.equal(m[r + i][c + 6], true, 'finder right edge');
      }
      assert.equal(m[r + 3][c + 3], true, 'finder centre');
      assert.equal(m[r + 1][c + 1], false, 'finder inner ring');
    };
    checkFinder(0, 0);
    checkFinder(0, size - 7);
    checkFinder(size - 7, 0);
  });

  test('timing patterns alternate along row/column 6', () => {
    const m = qrMatrix('klebb');
    const size = m.length;
    for (let i = 8; i < size - 8; i++) {
      assert.equal(m[6][i], i % 2 === 0, `row timing at ${i}`);
      assert.equal(m[i][6], i % 2 === 0, `column timing at ${i}`);
    }
  });

  test('dark module is set', () => {
    const m = qrMatrix('klebb');
    assert.equal(m[m.length - 8][8], true);
  });

  test('encoding is deterministic', () => {
    const a = qrMatrix('https://x.klebb.app/register?code=x-11112222');
    const b = qrMatrix('https://x.klebb.app/register?code=x-11112222');
    assert.deepEqual(a, b);
  });

  test('different content produces different matrices', () => {
    const a = qrMatrix('https://x.klebb.app/register?code=x-11112222');
    const b = qrMatrix('https://x.klebb.app/register?code=x-33334444');
    assert.notDeepEqual(a, b);
  });

  test('qrSvg renders a viewBoxed SVG with a quiet zone', () => {
    const svg = qrSvg('https://x.klebb.app/register?code=x-11112222');
    assert.match(svg, /^<svg /);
    assert.match(svg, /viewBox="0 0 41 41"/); // v4 (33 modules) + 2*4 quiet
    assert.match(svg, /aria-label="QR code"/);
    assert.match(svg, /<path d="M/);
  });
});
