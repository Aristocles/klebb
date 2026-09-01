// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// lib/zip/write.js
// Vendored zip writer for the export download. Stdlib only (node:fs,
// node:zlib). Entries are files already on disk, so per-entry size and
// CRC-32 are known up front and written straight into the local header:
// no data descriptors, which maximises third-party reader compatibility
// (the hosting side extracts with stock tooling). Store (0) is chosen over
// deflate (8) whenever deflate does not shrink the entry. The archive
// streams to a write stream (never whole-archive buffering; per-entry
// buffers only, entries are card-file sized), with an await point between
// entries so the caller's event loop breathes. Refuses past the classic
// format limits (4GB offsets/sizes, 0xFFFF entries) rather than emitting
// zip64.
//
//   const { writeZip } = require('./lib/zip/write');
//   const { entryCount, bytes } = await writeZip(destFile, entries);
//
// entries: an iterable or async iterable of { name, sourcePath }. Names
// use forward slashes; parent directories are implied (no directory
// entries), which every mainstream extractor handles.
// Throws ZIP_TOO_BIG past the format limits and ZIP_NAME for names the
// paired reader (lib/zip/read.js) would refuse.

'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const zlib = require('zlib');
const { promisify } = require('node:util');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const deflateRaw = promisify(zlib.deflateRaw);

// Entries above this stream through a spill file instead of sitting in
// memory whole: samples.json in a real export can be bigger than a small
// container's heap, and the buffered path holds the raw AND deflated copies
// at once (#655). Small entries keep the cheap buffered path.
const SPILL_THRESHOLD = 8 * 1024 * 1024;

const LOC_SIG = 0x04034b50;
const CEN_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const VERSION_NEEDED = 20;
const VERSION_MADE_BY = (3 << 8) | 20; // Unix host: extractors apply the mode bits
const FILE_MODE = 0o100644;
const MAX_UINT16 = 0xFFFF;
const MAX_UINT32 = 0xFFFFFFFF;
const UTF8_FLAG = 0x0800;

function zipError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function checkName(name) {
  if (!name || name.includes('\\') || name.startsWith('/') ||
      /^[A-Za-z]:/.test(name) ||
      name.split('/').some((s) => s === '' || s === '.' || s === '..')) {
    throw zipError('ZIP_NAME', `unsafe entry name: ${name}`);
  }
  for (const ch of name) {
    const c = ch.codePointAt(0);
    if (c < 0x20 || c === 0x7f) {
      throw zipError('ZIP_NAME', `control character in entry name: ${name}`);
    }
  }
}

function dosDateTime(mtime) {
  const d = mtime.getFullYear() < 1980 ? new Date(1980, 0, 1) : mtime;
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

function localHeader(e) {
  const buf = Buffer.alloc(30 + e.nameBytes.length);
  buf.writeUInt32LE(LOC_SIG, 0);
  buf.writeUInt16LE(VERSION_NEEDED, 4);
  buf.writeUInt16LE(e.flags, 6);
  buf.writeUInt16LE(e.method, 8);
  buf.writeUInt16LE(e.dosTime, 10);
  buf.writeUInt16LE(e.dosDate, 12);
  buf.writeUInt32LE(e.crc32, 14);
  buf.writeUInt32LE(e.compressedSize, 18);
  buf.writeUInt32LE(e.uncompressedSize, 22);
  buf.writeUInt16LE(e.nameBytes.length, 26);
  buf.writeUInt16LE(0, 28);
  e.nameBytes.copy(buf, 30);
  return buf;
}

function centralHeader(e) {
  const buf = Buffer.alloc(46 + e.nameBytes.length);
  buf.writeUInt32LE(CEN_SIG, 0);
  buf.writeUInt16LE(VERSION_MADE_BY, 4);
  buf.writeUInt16LE(VERSION_NEEDED, 6);
  buf.writeUInt16LE(e.flags, 8);
  buf.writeUInt16LE(e.method, 10);
  buf.writeUInt16LE(e.dosTime, 12);
  buf.writeUInt16LE(e.dosDate, 14);
  buf.writeUInt32LE(e.crc32, 16);
  buf.writeUInt32LE(e.compressedSize, 20);
  buf.writeUInt32LE(e.uncompressedSize, 24);
  buf.writeUInt16LE(e.nameBytes.length, 28);
  buf.writeUInt16LE(0, 30); // extra length
  buf.writeUInt16LE(0, 32); // comment length
  buf.writeUInt16LE(0, 34); // disk number start
  buf.writeUInt16LE(0, 36); // internal attributes
  buf.writeUInt32LE((FILE_MODE << 16) >>> 0, 38);
  buf.writeUInt32LE(e.localOffset, 42);
  e.nameBytes.copy(buf, 46);
  return buf;
}

function eocd(entryCount, cdSize, cdOffset) {
  const buf = Buffer.alloc(22);
  buf.writeUInt32LE(EOCD_SIG, 0);
  buf.writeUInt16LE(0, 4);
  buf.writeUInt16LE(0, 6);
  buf.writeUInt16LE(entryCount, 8);
  buf.writeUInt16LE(entryCount, 10);
  buf.writeUInt32LE(cdSize, 12);
  buf.writeUInt32LE(cdOffset, 16);
  buf.writeUInt16LE(0, 20);
  return buf;
}

function write(stream, buf) {
  return new Promise((resolve, reject) => {
    stream.write(buf, (err) => (err ? reject(err) : resolve()));
  });
}

// Append a file to the archive stream chunk by chunk, without ending it.
// Resolves the byte count so the caller can refuse an archive whose body
// disagrees with the sizes already written into the local header.
function pipeInto(stream, sourcePath) {
  return new Promise((resolve, reject) => {
    const rs = fs.createReadStream(sourcePath);
    let bytes = 0;
    const onErr = (err) => { rs.destroy(); reject(err); };
    stream.once('error', onErr);
    rs.on('error', onErr);
    rs.on('data', (chunk) => { bytes += chunk.length; });
    rs.on('end', () => { stream.removeListener('error', onErr); resolve(bytes); });
    rs.pipe(stream, { end: false });
  });
}

// Whole-entry buffering: raw and deflated copies coexist, fine for
// card-file-sized entries.
async function bufferedBody(sourcePath) {
  const data = await fsp.readFile(sourcePath);
  const deflated = await deflateRaw(data);
  const useDeflate = deflated.length < data.length;
  return {
    method: useDeflate ? METHOD_DEFLATE : METHOD_STORE,
    crc32: zlib.crc32(data),
    compressedSize: (useDeflate ? deflated : data).length,
    uncompressedSize: data.length,
    body: useDeflate ? deflated : data,
    bodyPath: null,
  };
}

// One streamed pass computes the CRC and deflates into the spill file, so
// the sizes the local header needs up front (this format writes no data
// descriptors) are known without holding the entry in memory. The body then
// streams into the archive from the spill file, or from the source when
// store beats deflate.
async function spilledBody(sourcePath, spillPath) {
  let crc = 0;
  let uncompressed = 0;
  const tap = new Transform({
    transform(chunk, enc, cb) {
      crc = zlib.crc32(chunk, crc);
      uncompressed += chunk.length;
      cb(null, chunk);
    },
  });
  await pipeline(
    fs.createReadStream(sourcePath),
    tap,
    zlib.createDeflateRaw(),
    fs.createWriteStream(spillPath),
  );
  const compressedSize = Number((await fsp.stat(spillPath)).size);
  const useDeflate = compressedSize < uncompressed;
  return {
    method: useDeflate ? METHOD_DEFLATE : METHOD_STORE,
    crc32: crc >>> 0,
    compressedSize: useDeflate ? compressedSize : uncompressed,
    uncompressedSize: uncompressed,
    body: null,
    bodyPath: useDeflate ? spillPath : sourcePath,
  };
}

function finish(stream) {
  return new Promise((resolve, reject) => {
    stream.end((err) => (err ? reject(err) : resolve()));
  });
}

async function writeZip(destFile, entries) {
  const stream = fs.createWriteStream(destFile);
  const spillFile = `${destFile}.spill`;
  const written = [];
  let offset = 0;
  try {
    for await (const { name, sourcePath } of entries) {
      checkName(name);
      if (written.length >= MAX_UINT16) {
        throw zipError('ZIP_TOO_BIG', `entry count exceeds ${MAX_UINT16 - 1}`);
      }
      const { mtime, size } = await fsp.stat(sourcePath);
      const src = size > SPILL_THRESHOLD
        ? await spilledBody(sourcePath, spillFile)
        : await bufferedBody(sourcePath);
      const nameBytes = Buffer.from(name, 'utf8');
      const { time, date } = dosDateTime(mtime);
      const entry = {
        nameBytes,
        flags: /^[\x20-\x7e]*$/.test(name) ? 0 : UTF8_FLAG,
        method: src.method,
        dosTime: time,
        dosDate: date,
        crc32: src.crc32,
        compressedSize: src.compressedSize,
        uncompressedSize: src.uncompressedSize,
        localOffset: offset,
      };
      const header = localHeader(entry);
      if (src.uncompressedSize > MAX_UINT32 ||
          offset + header.length + src.compressedSize > MAX_UINT32) {
        throw zipError('ZIP_TOO_BIG',
          `archive would exceed 4GB at entry: ${name}`);
      }
      await write(stream, header);
      if (src.body) {
        await write(stream, src.body);
      } else {
        // The spilled body is read in a second pass; if the source moved
        // under us since the CRC/size pass, the header already written is a
        // lie and the archive is silently corrupt. Refuse loudly instead.
        const piped = await pipeInto(stream, src.bodyPath);
        if (piped !== src.compressedSize) {
          throw zipError('ZIP_IO',
            `entry body changed while writing (${piped} vs ${src.compressedSize} bytes): ${name}`);
        }
      }
      await fsp.rm(spillFile, { force: true }).catch(() => {});
      offset += header.length + src.compressedSize;
      written.push(entry);
    }

    const cdOffset = offset;
    for (const entry of written) {
      const header = centralHeader(entry);
      offset += header.length;
      await write(stream, header);
    }
    if (offset + 22 > MAX_UINT32) {
      throw zipError('ZIP_TOO_BIG', 'central directory would exceed 4GB');
    }
    await write(stream, eocd(written.length, offset - cdOffset, cdOffset));
    await finish(stream);
    return { entryCount: written.length, bytes: offset + 22 };
  } catch (err) {
    // destroy() does not cancel an open that is still in flight, and a refusal
    // on the first entry gets here before the open has run: node defers the
    // teardown until the descriptor exists, then closes it. Removing the file
    // before that lands lets the late open recreate the partial archive this
    // promises to leave behind (#652), so wait for the descriptor to close.
    const closed = new Promise((resolve) => {
      if (stream.closed) resolve();
      else stream.once('close', resolve);
    });
    stream.destroy();
    await closed;
    await fsp.rm(destFile, { force: true }).catch(() => {});
    await fsp.rm(spillFile, { force: true }).catch(() => {});
    throw err;
  }
}

module.exports = { writeZip };
