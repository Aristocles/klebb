// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// ingest/extractors/docx.js
// Text out of a .docx with no dependencies.
//
// A .docx is a ZIP holding word/document.xml, and node's zlib inflates the
// entries, so this needs no library. Two things make the hand-rolled reader
// worth its lines:
//
//   1. It reads the ZIP CENTRAL DIRECTORY from the end of the buffer rather
//      than walking local file headers forward. A local header may carry
//      zeroed sizes with the real values in a trailing data descriptor, so
//      trusting it is the classic read-the-wrong-bytes bug. The central
//      directory always has the true sizes.
//   2. It is a parser sitting at an upload boundary, which makes zip-bomb
//      resistance a requirement rather than a nicety: a 40 KB entry can
//      declare gigabytes of output. Both the declared size (checked before
//      inflating) and the actual output (capped during) are bounded.
//
// Pre-2007 binary .doc is a completely different format and stays unsupported.

const fs = require('fs');
const zlib = require('zlib');

const MAX_UNCOMPRESSED = 30 * 1024 * 1024;

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;

// The End Of Central Directory record sits at the very end, unless there is a
// trailing comment (up to 64 KB), so scan backwards for its signature.
function _findEocd(buf) {
  const minPos = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

function _readCentralDirectory(buf) {
  const eocd = _findEocd(buf);
  if (eocd < 0) throw new Error('not a ZIP archive (no end-of-central-directory record)');
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);

  const entries = [];
  for (let i = 0; i < count; i++) {
    if (offset + 46 > buf.length) throw new Error('malformed ZIP: central directory runs past end of file');
    if (buf.readUInt32LE(offset) !== CD_SIG) throw new Error('malformed ZIP: bad central-directory signature');
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const uncompressedSize = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.slice(offset + 46, offset + 46 + nameLen).toString('utf8');
    entries.push({ name, method, compressedSize, uncompressedSize, localOffset });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// The compressed bytes still have to be located via the local header, but only
// for its variable-length name/extra fields: the sizes come from the central
// directory entry, which is the point.
function _entryData(buf, entry) {
  const lo = entry.localOffset;
  if (lo + 30 > buf.length) throw new Error('malformed ZIP: local header runs past end of file');
  if (buf.readUInt32LE(lo) !== 0x04034b50) throw new Error('malformed ZIP: bad local-header signature');
  const nameLen = buf.readUInt16LE(lo + 26);
  const extraLen = buf.readUInt16LE(lo + 28);
  const start = lo + 30 + nameLen + extraLen;
  const end = start + entry.compressedSize;
  if (end > buf.length) throw new Error('malformed ZIP: entry data runs past end of file');
  return buf.slice(start, end);
}

function _inflate(entry, data) {
  // Refuse on the declared size before spending any memory. maxOutputLength
  // below is the real backstop (a bomb can lie here), but rejecting early
  // gives the honest-but-huge case a clear message.
  if (entry.uncompressedSize > MAX_UNCOMPRESSED) {
    throw new Error(`document too large (declares ${entry.uncompressedSize} bytes of ${entry.name})`);
  }
  if (entry.method === 0) return data;
  if (entry.method !== 8) throw new Error(`unsupported ZIP compression method ${entry.method}`);
  try {
    return zlib.inflateRawSync(data, { maxOutputLength: MAX_UNCOMPRESSED });
  } catch (e) {
    // zlib reports the cap as a buffer-length error; say what actually
    // happened rather than passing that through.
    if (/maxOutputLength|buffer/i.test(e.message)) {
      throw new Error('document too large (decompressed output exceeds 30 MB)');
    }
    throw new Error(`could not decompress ${entry.name}: ${e.message}`);
  }
}

function _decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    // Last: an &amp;lt; in the source must not become a literal <.
    .replace(/&amp;/g, '&');
}

// Word's model: a paragraph (w:p) holds runs, and the text lives in w:t
// elements inside them. Runs join with no separator (they are mid-sentence
// formatting splits, so a space would corrupt words); paragraphs join with a
// newline.
//
// Tables flatten to runs of cell text. Fine for a letter, poor for a lab
// table, which is the same limitation tesseract has on a scan of one.
function documentXmlToText(xml) {
  const paragraphs = String(xml).split(/<\/w:p>/);
  const lines = [];
  for (const p of paragraphs) {
    let line = '';
    const re = /<w:(t|tab|br|cr)(?:\s[^>]*)?(\/?)>/g;
    let m;
    // Tracks how far a failed close-tag search already got. Without it, an
    // opening <w:t> with no matching </w:t> made every subsequent iteration
    // rescan to the end of the paragraph, which is quadratic: a 1.6 KB file of
    // repeated <w:t> blocked the event loop for minutes, and because a file is
    // only archived AFTER extraction succeeds, the boot drain re-enqueued it on
    // every restart. Once a search from position X finds nothing, no search
    // from a later position can find anything either, so the rest of the
    // paragraph has no more text to yield.
    let noCloseFrom = Infinity;
    while ((m = re.exec(p)) !== null) {
      const tag = m[1];
      const selfClosing = m[2] === '/';
      if (tag === 'tab') { line += '\t'; continue; }
      if (tag === 'br' || tag === 'cr') { line += '\n'; continue; }
      if (selfClosing) continue;
      if (re.lastIndex >= noCloseFrom) break;
      const close = p.indexOf('</w:t>', re.lastIndex);
      if (close === -1) { noCloseFrom = re.lastIndex; break; }
      line += _decodeEntities(p.slice(re.lastIndex, close));
      re.lastIndex = close + 6;
    }
    lines.push(line);
  }
  // Collapse runs of blank paragraphs (Word emits plenty) but keep one, so
  // paragraph breaks survive.
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

async function extractDocx(absPath) {
  const buf = fs.readFileSync(absPath);
  const entries = _readCentralDirectory(buf);
  const doc = entries.find(e => e.name === 'word/document.xml');
  if (!doc) throw new Error('not a Word document (no word/document.xml)');
  const xml = _inflate(doc, _entryData(buf, doc)).toString('utf8');
  return { text: documentXmlToText(xml) };
}

module.exports = { extractDocx, documentXmlToText, MAX_UNCOMPRESSED };
