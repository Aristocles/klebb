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

const deflateRaw = promisify(zlib.deflateRaw);

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

function finish(stream) {
  return new Promise((resolve, reject) => {
    stream.end((err) => (err ? reject(err) : resolve()));
  });
}

async function writeZip(destFile, entries) {
  const stream = fs.createWriteStream(destFile);
  const written = [];
  let offset = 0;
  try {
    for await (const { name, sourcePath } of entries) {
      checkName(name);
      if (written.length >= MAX_UINT16) {
        throw zipError('ZIP_TOO_BIG', `entry count exceeds ${MAX_UINT16 - 1}`);
      }
      const data = await fsp.readFile(sourcePath);
      const { mtime } = await fsp.stat(sourcePath);
      const deflated = await deflateRaw(data);
      const useDeflate = deflated.length < data.length;
      const body = useDeflate ? deflated : data;
      const nameBytes = Buffer.from(name, 'utf8');
      const { time, date } = dosDateTime(mtime);
      const entry = {
        nameBytes,
        flags: /^[\x20-\x7e]*$/.test(name) ? 0 : UTF8_FLAG,
        method: useDeflate ? METHOD_DEFLATE : METHOD_STORE,
        dosTime: time,
        dosDate: date,
        crc32: zlib.crc32(data),
        compressedSize: body.length,
        uncompressedSize: data.length,
        localOffset: offset,
      };
      const header = localHeader(entry);
      if (data.length > MAX_UINT32 ||
          offset + header.length + body.length > MAX_UINT32) {
        throw zipError('ZIP_TOO_BIG',
          `archive would exceed 4GB at entry: ${name}`);
      }
      await write(stream, header);
      await write(stream, body);
      offset += header.length + body.length;
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
    throw err;
  }
}

module.exports = { writeZip };
