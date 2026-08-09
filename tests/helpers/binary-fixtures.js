// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/helpers/binary-fixtures.js
//
// Real binary fixtures, built rather than committed.
//
// The docx builders emit genuine deflate streams and a genuine central
// directory, so the extractor tests exercise the actual parser instead of a
// mock of it, and a test can declare a hostile size or an unsupported method.
// makePng emits a valid PNG for the same reason: a malformed blob would pass
// wherever tesseract is absent and only fail in the container.

const zlib = require('zlib');

// One central-directory-bearing ZIP from { name: Buffer|string } entries.
// `store` writes method 0 (no compression); `declaredSize` overrides the
// uncompressed size field, which is how a zip bomb lies about its output.
function buildZip(files, { store = false, declaredSize = null } = {}) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const data = store ? raw : zlib.deflateRawSync(raw);
    const nameBuf = Buffer.from(name, 'utf8');
    const method = store ? 0 : 8;
    const crc = 0; // Not validated by the extractor; kept zero deliberately.
    const uncompressed = declaredSize === null ? raw.length : declaredSize;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(uncompressed, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(uncompressed, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const localBytes = Buffer.concat(locals);
  const centralBytes = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(localBytes.length, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([localBytes, centralBytes, eocd]);
}

// Word's own markup shape: paragraphs of runs, runs of w:t. `paragraphs` may
// carry raw XML (tabs, breaks, entities) as well as plain text.
function documentXml(paragraphs) {
  const body = paragraphs.map(p => {
    if (p === '') return '<w:p><w:r></w:r></w:p>';
    if (p.startsWith('<')) return `<w:p>${p}</w:p>`;
    return `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`;
  }).join('');
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + `<w:body>${body}</w:body></w:document>`;
}

function makeDocx(paragraphs, opts = {}) {
  return buildZip({
    '[Content_Types].xml': '<?xml version="1.0"?><Types/>',
    'word/document.xml': documentXml(paragraphs),
  }, opts);
}

// A valid blank greyscale PNG, built rather than embedded as base64: a broken
// blob would still "pass" wherever tesseract is absent and only fail in the
// container, which is the trap this whole helper exists to avoid.
function makePng(width = 8, height = 8, grey = 0xff) {
  const zlibLib = zlib;
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  const crc32 = (buf) => {
    let crc = 0xFFFFFFFF;
    for (const b of buf) crc = table[(crc ^ b) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed));
    return Buffer.concat([len, typed, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 0;   // colour type: greyscale
  const rows = [];
  for (let y = 0; y < height; y++) {
    rows.push(Buffer.from([0]));         // filter type: none
    rows.push(Buffer.alloc(width, grey));
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlibLib.deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// A one-page PDF with a real text layer, from lines of text. Written as many
// short lines rather than one long one: a single overlong Td line runs off the
// MediaBox and pdftotext clips it, which silently produces a fixture too thin
// to clear the sparse-text floor.
function makeTextPdf(lines, { fontSize = 9, leading = 12 } = {}) {
  const content = `BT /F1 ${fontSize} Tf 20 780 Td ${leading} TL\n`
    + lines.map(l => `(${String(l).replace(/([()\\])/g, '\\$1')}) Tj T*`).join('\n')
    + '\nET';
  const objs = [
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Resources<</Font<</F1 5 0 R>>>>/Contents 4 0 R>>endobj',
    `4 0 obj<</Length ${content.length}>>stream\n${content}\nendstream endobj`,
    '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj',
  ];
  let body = '%PDF-1.4\n';
  const offsets = [];
  for (const o of objs) { offsets.push(body.length); body += o + '\n'; }
  const xrefAt = body.length;
  body += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
    + offsets.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('')
    + `trailer<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

// A one-page PDF with NO text layer: a single greyscale image painted across
// the page. This is what a scan actually is, and pdftotext returns nothing at
// all from it, so it is the only honest fixture for the OCR fallback.
// `grey` is a width*height buffer of 8-bit samples.
function makeImageOnlyPdf({ width, height, grey }) {
  const img = zlib.deflateSync(grey);
  const cs = 'q 595 0 0 842 0 0 cm /Im0 Do Q';
  const preImage = [
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Resources<</XObject<</Im0 5 0 R>>>>/Contents 4 0 R>>endobj',
    `4 0 obj<</Length ${cs.length}>>stream\n${cs}\nendstream endobj`,
  ];
  const imgHeader = `5 0 obj<</Type/XObject/Subtype/Image/Width ${width}/Height ${height}`
    + `/ColorSpace/DeviceGray/BitsPerComponent 8/Filter/FlateDecode/Length ${img.length}>>stream\n`;

  const parts = [Buffer.from('%PDF-1.4\n', 'latin1')];
  const offsets = [];
  let len = parts[0].length;
  for (const o of preImage) {
    offsets.push(len);
    const b = Buffer.from(o + '\n', 'latin1');
    parts.push(b);
    len += b.length;
  }
  offsets.push(len);
  const hb = Buffer.from(imgHeader, 'latin1');
  const tb = Buffer.from('\nendstream endobj\n', 'latin1');
  parts.push(hb, img, tb);
  len += hb.length + img.length + tb.length;

  const tail = 'xref\n0 6\n0000000000 65535 f \n'
    + offsets.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('')
    + `trailer<</Size 6/Root 1 0 R>>\nstartxref\n${len}\n%%EOF\n`;
  parts.push(Buffer.from(tail, 'latin1'));
  return Buffer.concat(parts);
}

// Parse a binary PGM (P5), which is what `pdftoppm -gray` emits. Used to turn
// a rendered text PDF into the pixels for an image-only one, so the scan
// fixture carries genuinely OCR-able content.
function parsePgm(buf) {
  let p = 0;
  const tok = () => {
    while (p < buf.length && /\s/.test(String.fromCharCode(buf[p]))) p++;
    const start = p;
    while (p < buf.length && !/\s/.test(String.fromCharCode(buf[p]))) p++;
    return buf.slice(start, p).toString();
  };
  const magic = tok();
  if (magic !== 'P5') throw new Error(`expected a P5 PGM, got ${magic}`);
  const width = Number(tok());
  const height = Number(tok());
  tok(); // max value
  p++;   // single whitespace byte before the raster
  return { width, height, grey: buf.slice(p, p + width * height) };
}

module.exports = {
  buildZip,
  documentXml,
  makeDocx,
  makePng,
  makeTextPdf,
  makeImageOnlyPdf,
  parsePgm,
};
