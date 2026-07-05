// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// public/js/lib/qr.js
//
// Minimal QR encoder: byte mode, error-correction level M, versions 1-6
// (106-byte capacity: ample for a register URL; versions 7+ would need the
// version-information blocks this deliberately omits). Returns a 2D boolean
// matrix; the caller renders it (SVG in eh-settings-security).
// Vendored rather than pulled from esm.sh: the register link is a
// credential-granting secret and QR encoding is pure maths, so keeping it
// in-repo removes a supply-chain surface for zero maintenance cost.

// Byte-mode data capacity for EC level M, versions 1..6.
const CAPACITY_M = [14, 26, 42, 62, 84, 106];
// EC structure per version, level M:
// [ecPerBlock, group1Blocks, group1Size, group2Blocks, group2Size]
const EC_M = [
  [10, 1, 16, 0, 0], [16, 1, 28, 0, 0], [26, 1, 44, 0, 0],
  [18, 2, 32, 0, 0], [24, 2, 43, 0, 0], [16, 4, 27, 0, 0],
];
const ALIGNMENT = [
  [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
];

// GF(256) tables for Reed-Solomon.
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function rsGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= EXP[(LOG[poly[j]] + i) % 255];
      next[j + 1] ^= poly[j];
    }
    poly = next;
  }
  return poly;
}

function rsEncode(data, degree) {
  // gen is lowest-degree-first; synthetic division wants second-highest
  // down to the constant, i.e. gen[degree-1-i] against res[i].
  const gen = rsGenerator(degree);
  const res = new Uint8Array(degree);
  for (const byte of data) {
    const factor = byte ^ res[0];
    res.copyWithin(0, 1);
    res[degree - 1] = 0;
    if (factor !== 0) {
      for (let i = 0; i < degree; i++) {
        const g = gen[degree - 1 - i];
        if (g !== 0) res[i] ^= EXP[(LOG[g] + LOG[factor]) % 255];
      }
    }
  }
  return res;
}

function buildCodewords(bytes, version) {
  const [ecLen, g1n, g1s, g2n, g2s] = EC_M[version - 1];
  const dataLen = g1n * g1s + g2n * g2s;

  // Mode indicator (0100 = byte); versions 1-9 use an 8-bit length field.
  const bits = [];
  const push = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >> i) & 1); };
  push(0b0100, 4);
  push(bytes.length, 8);
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, dataLen * 8 - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);

  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    data.push(b);
  }
  const pads = [0xec, 0x11];
  for (let i = 0; data.length < dataLen; i++) data.push(pads[i % 2]);

  // Split into blocks, compute EC per block, then interleave.
  const blocks = [];
  let off = 0;
  for (let i = 0; i < g1n; i++) { blocks.push(data.slice(off, off + g1s)); off += g1s; }
  for (let i = 0; i < g2n; i++) { blocks.push(data.slice(off, off + g2s)); off += g2s; }
  const ecs = blocks.map(b => rsEncode(b, ecLen));

  const out = [];
  const maxData = Math.max(g1s, g2s);
  for (let i = 0; i < maxData; i++) {
    for (const b of blocks) if (i < b.length) out.push(b[i]);
  }
  for (let i = 0; i < ecLen; i++) {
    for (const e of ecs) out.push(e[i]);
  }
  return out;
}

function placeModules(codewords, version) {
  const size = version * 4 + 17;
  const m = Array.from({ length: size }, () => new Array(size).fill(null));

  const setFinder = (r, c) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
        const inOuter = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6 && (dr === 0 || dr === 6 || dc === 0 || dc === 6);
        const inInner = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        m[rr][cc] = inOuter || inInner;
      }
    }
  };
  setFinder(0, 0);
  setFinder(0, size - 7);
  setFinder(size - 7, 0);

  for (let i = 8; i < size - 8; i++) {
    if (m[6][i] === null) m[6][i] = i % 2 === 0;
    if (m[i][6] === null) m[i][6] = i % 2 === 0;
  }

  const centres = ALIGNMENT[version - 1];
  for (const r of centres) {
    for (const c of centres) {
      if (m[r][c] !== null) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          m[r + dr][c + dc] = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
        }
      }
    }
  }

  // Reserve format areas (filled after masking) + the dark module.
  for (let i = 0; i < 9; i++) {
    if (m[8][i] === null) m[8][i] = false;
    if (m[i][8] === null) m[i][8] = false;
  }
  for (let i = 0; i < 8; i++) {
    if (m[8][size - 1 - i] === null) m[8][size - 1 - i] = false;
    if (m[size - 1 - i][8] === null) m[size - 1 - i][8] = false;
  }
  m[size - 8][8] = true;

  // Data placement: two-column zigzag from the bottom-right, skipping col 6.
  const reserved = m.map(row => row.map(v => v !== null));
  let bitIdx = 0;
  const totalBits = codewords.length * 8;
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i;
      for (const c of [col, col - 1]) {
        if (reserved[row][c]) continue;
        let bit = false;
        if (bitIdx < totalBits) {
          bit = ((codewords[bitIdx >> 3] >> (7 - (bitIdx & 7))) & 1) === 1;
        }
        m[row][c] = bit;
        bitIdx++;
      }
    }
    upward = !upward;
  }
  return { m, reserved };
}

// Mask 0 (checkerboard) applied unconditionally: scanners handle any valid
// mask, and skipping the 8-mask penalty scoring keeps this file small.
function applyMaskAndFormat(m, reserved) {
  const size = m.length;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!reserved[r][c] && (r + c) % 2 === 0) m[r][c] = !m[r][c];
    }
  }
  // Format info for EC level M, mask 0: precomputed 15-bit sequence.
  const fmt = 0b101010000010010;
  const bit = i => ((fmt >> (14 - i)) & 1) === 1;
  for (let i = 0; i < 6; i++) m[8][i] = bit(i);
  m[8][7] = bit(6);
  m[8][8] = bit(7);
  m[7][8] = bit(8);
  for (let i = 9; i < 15; i++) m[14 - i][8] = bit(i);
  for (let i = 0; i < 7; i++) m[size - 1 - i][8] = bit(i);
  for (let i = 7; i < 15; i++) m[8][size - 15 + i] = bit(i);
  return m;
}

// Encode text into a QR matrix (array of rows of booleans, true = dark).
// Throws if the text exceeds version-10/M capacity (~213 bytes).
export function qrMatrix(text) {
  const bytes = new TextEncoder().encode(text);
  const version = CAPACITY_M.findIndex(cap => bytes.length <= cap) + 1;
  if (version === 0) throw new Error(`Text too long for QR (max ${CAPACITY_M.at(-1)} bytes)`);
  const codewords = buildCodewords(bytes, version);
  const { m, reserved } = placeModules(codewords, version);
  return applyMaskAndFormat(m, reserved);
}

// Render a matrix to a crisp SVG string (1 module = 1 unit, quiet zone 4).
export function qrSvg(text, { moduleColor = '#000', background = '#fff' } = {}) {
  const m = qrMatrix(text);
  const size = m.length;
  const quiet = 4;
  const total = size + quiet * 2;
  let path = '';
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (m[r][c]) path += `M${c + quiet},${r + quiet}h1v1h-1z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges" role="img" aria-label="QR code">` +
    `<rect width="${total}" height="${total}" fill="${background}"/>` +
    `<path d="${path}" fill="${moduleColor}"/></svg>`;
}
