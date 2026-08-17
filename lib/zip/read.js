// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// lib/zip/read.js
// Vendored central-directory-driven zip reader for import uploads.
// Stdlib only (node:fs, node:zlib): a hostile archive arrives over HTTP,
// so keeping the parser in-repo removes a supply-chain surface and lets
// every refusal carry a stable code the caller maps to findings.
//
//   const zip = await openZip(filePath, { maxEntries, maxEntryBytes,
//                                         maxTotalBytes });
//   zip.entries()            -> [{ name, isDirectory, size,
//                                  compressedSize, method, crc32 }]
//   await zip.extractTo(destDir)
//   await zip.close()
//
// openZip validates the whole central directory eagerly and refuses:
//   ZIP_ZIP64      zip64 EOCD/locator in the tail window, 0xFFFF entry
//                  counts, 0xFFFFFFFF sizes/offsets, or a 0x0001 extra field
//   ZIP_ENCRYPTED  general-purpose bit 0
//   ZIP_METHOD     compression method other than store (0) or deflate (8)
//   ZIP_SYMLINK    Unix symlink external attributes
//   ZIP_NAME       backslashes, absolute paths, drive letters, dot-dot
//                  segments, control characters, empty segments
//   ZIP_CAP        an option cap tripped (the message names which)
//   ZIP_BAD        structurally broken archive
// extractTo verifies content and throws ZIP_SIZE (declared uncompressed
// size is a lie, either direction; inflation aborts the moment output
// exceeds it) or ZIP_CRC (central-directory CRC-32 mismatch). It writes
// into a temp sibling and renames on success, so a refused extraction
// leaves nothing at destDir. Sizes/CRCs come from the central directory;
// the local header is read only to locate the data (its extra field length
// can legitimately differ from the central one).

'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { promisify } = require('node:util');

const inflateRaw = promisify(zlib.inflateRaw);

const EOCD_SIG = 0x06054b50;      // PK\x05\x06
const ZIP64_EOCD_SIG = 0x06064b50; // PK\x06\x06
const ZIP64_LOC_SIG = 0x07064b50;  // PK\x06\x07
const CEN_SIG = 0x02014b50;       // PK\x01\x02
const LOC_SIG = 0x04034b50;       // PK\x03\x04
const EOCD_MIN = 22;
const EOCD_WINDOW = EOCD_MIN + 0xFFFF; // 65557: max comment length behind it
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

function zipError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function safeName(raw) {
  if (raw.length === 0) throw zipError('ZIP_NAME', 'empty entry name');
  if (raw.includes('\\')) {
    throw zipError('ZIP_NAME', `backslash in entry name: ${raw}`);
  }
  for (const ch of raw) {
    const c = ch.codePointAt(0);
    if (c < 0x20 || c === 0x7f) {
      throw zipError('ZIP_NAME', 'control character in entry name');
    }
  }
  if (raw.startsWith('/')) {
    throw zipError('ZIP_NAME', `absolute entry name: ${raw}`);
  }
  if (/^[A-Za-z]:/.test(raw)) {
    throw zipError('ZIP_NAME', `drive letter in entry name: ${raw}`);
  }
  const isDirectory = raw.endsWith('/');
  const body = isDirectory ? raw.slice(0, -1) : raw;
  const segments = body.split('/');
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') {
      throw zipError('ZIP_NAME', `unsafe segment in entry name: ${raw}`);
    }
  }
  return { name: segments.join('/'), isDirectory };
}

function refuseZip64Extra(extra, entryName) {
  let off = 0;
  while (off + 4 <= extra.length) {
    const id = extra.readUInt16LE(off);
    const len = extra.readUInt16LE(off + 2);
    if (id === 0x0001) {
      throw zipError('ZIP_ZIP64', `zip64 extra field on entry: ${entryName}`);
    }
    off += 4 + len;
  }
}

async function readAt(fd, position, length) {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fd.read(buf, 0, length, position);
  if (bytesRead !== length) {
    throw zipError('ZIP_BAD', 'truncated archive');
  }
  return buf;
}

async function findEocd(fd, fileSize) {
  if (fileSize < EOCD_MIN) throw zipError('ZIP_BAD', 'file too small to be a zip');
  const windowLen = Math.min(fileSize, EOCD_WINDOW);
  const window = await readAt(fd, fileSize - windowLen, windowLen);
  for (let i = 0; i + 4 <= window.length; i++) {
    const sig = window.readUInt32LE(i);
    if (sig === ZIP64_EOCD_SIG || sig === ZIP64_LOC_SIG) {
      throw zipError('ZIP_ZIP64', 'zip64 end-of-central-directory record present');
    }
  }
  for (let i = windowLen - EOCD_MIN; i >= 0; i--) {
    if (window.readUInt32LE(i) !== EOCD_SIG) continue;
    const commentLen = window.readUInt16LE(i + 20);
    if (i + EOCD_MIN + commentLen === windowLen) {
      return { buf: window.subarray(i, i + EOCD_MIN) };
    }
  }
  throw zipError('ZIP_BAD', 'no end-of-central-directory record found');
}

function parseCentralDirectory(cd, entryCount) {
  const entries = [];
  let off = 0;
  for (let n = 0; n < entryCount; n++) {
    if (off + 46 > cd.length || cd.readUInt32LE(off) !== CEN_SIG) {
      throw zipError('ZIP_BAD', `bad central-directory entry at record ${n}`);
    }
    const flags = cd.readUInt16LE(off + 8);
    const method = cd.readUInt16LE(off + 10);
    const crc = cd.readUInt32LE(off + 16);
    const compressedSize = cd.readUInt32LE(off + 20);
    const uncompressedSize = cd.readUInt32LE(off + 24);
    const nameLen = cd.readUInt16LE(off + 28);
    const extraLen = cd.readUInt16LE(off + 30);
    const commentLen = cd.readUInt16LE(off + 32);
    const externalAttrs = cd.readUInt32LE(off + 38);
    const localOffset = cd.readUInt32LE(off + 42);
    if (off + 46 + nameLen + extraLen + commentLen > cd.length) {
      throw zipError('ZIP_BAD', `truncated central-directory entry at record ${n}`);
    }
    const rawName = cd.toString('utf8', off + 46, off + 46 + nameLen);
    if (flags & 0x0001) {
      throw zipError('ZIP_ENCRYPTED', `encrypted entry: ${rawName}`);
    }
    if (method !== METHOD_STORE && method !== METHOD_DEFLATE) {
      throw zipError('ZIP_METHOD', `unsupported compression method ${method}: ${rawName}`);
    }
    if (((externalAttrs >>> 16) & 0xF000) === 0xA000) {
      throw zipError('ZIP_SYMLINK', `symlink entry: ${rawName}`);
    }
    if (compressedSize === 0xFFFFFFFF || uncompressedSize === 0xFFFFFFFF ||
        localOffset === 0xFFFFFFFF) {
      throw zipError('ZIP_ZIP64', `zip64 sentinel size/offset on entry: ${rawName}`);
    }
    const extra = cd.subarray(off + 46 + nameLen, off + 46 + nameLen + extraLen);
    refuseZip64Extra(extra, rawName);
    const { name, isDirectory } = safeName(rawName);
    entries.push({
      name, isDirectory, method, crc32: crc,
      compressedSize, uncompressedSize, localOffset,
    });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function openZip(filePath, opts = {}) {
  const {
    maxEntries = Infinity,
    maxEntryBytes = Infinity,
    maxTotalBytes = Infinity,
  } = opts;

  const fd = await fsp.open(filePath, 'r');
  try {
    const { size: fileSize } = await fd.stat();
    const { buf: eocd } = await findEocd(fd, fileSize);
    const entryCount = eocd.readUInt16LE(10);
    const diskEntryCount = eocd.readUInt16LE(8);
    const cdSize = eocd.readUInt32LE(12);
    const cdOffset = eocd.readUInt32LE(16);
    if (entryCount === 0xFFFF || diskEntryCount === 0xFFFF ||
        cdSize === 0xFFFFFFFF || cdOffset === 0xFFFFFFFF) {
      throw zipError('ZIP_ZIP64', 'zip64 sentinel in end-of-central-directory record');
    }
    if (entryCount > maxEntries) {
      throw zipError('ZIP_CAP', `entry count ${entryCount} exceeds maxEntries ${maxEntries}`);
    }
    if (cdOffset + cdSize > fileSize) {
      throw zipError('ZIP_BAD', 'central directory extends past end of file');
    }
    const cd = await readAt(fd, cdOffset, cdSize);
    const entries = parseCentralDirectory(cd, entryCount);

    let totalBytes = 0;
    for (const e of entries) {
      if (e.uncompressedSize > maxEntryBytes) {
        throw zipError('ZIP_CAP',
          `entry ${e.name} declares ${e.uncompressedSize} bytes, exceeds maxEntryBytes ${maxEntryBytes}`);
      }
      totalBytes += e.uncompressedSize;
      if (totalBytes > maxTotalBytes) {
        throw zipError('ZIP_CAP',
          `declared total ${totalBytes} bytes exceeds maxTotalBytes ${maxTotalBytes}`);
      }
    }

    return {
      entries() {
        return entries.map((e) => ({
          name: e.name,
          isDirectory: e.isDirectory,
          size: e.uncompressedSize,
          compressedSize: e.compressedSize,
          method: e.method,
          crc32: e.crc32,
        }));
      },
      async extractTo(destDir) {
        await extractAll(fd, entries, destDir, fileSize);
      },
      close() {
        return fd.close();
      },
    };
  } catch (err) {
    await fd.close().catch(() => {});
    throw err;
  }
}

async function readEntryData(fd, entry, fileSize) {
  if (entry.localOffset + 30 > fileSize) {
    throw zipError('ZIP_BAD', `local header past end of file: ${entry.name}`);
  }
  const local = await readAt(fd, entry.localOffset, 30);
  if (local.readUInt32LE(0) !== LOC_SIG) {
    throw zipError('ZIP_BAD', `bad local header signature: ${entry.name}`);
  }
  const nameLen = local.readUInt16LE(26);
  const extraLen = local.readUInt16LE(28);
  const dataStart = entry.localOffset + 30 + nameLen + extraLen;
  if (dataStart + entry.compressedSize > fileSize) {
    throw zipError('ZIP_BAD', `entry data past end of file: ${entry.name}`);
  }
  const raw = entry.compressedSize === 0
    ? Buffer.alloc(0)
    : await readAt(fd, dataStart, entry.compressedSize);

  let out;
  if (entry.method === METHOD_STORE) {
    out = raw;
  } else {
    try {
      out = await inflateRaw(raw, { maxOutputLength: entry.uncompressedSize });
    } catch (err) {
      if (err.code === 'ERR_BUFFER_TOO_LARGE') {
        throw zipError('ZIP_SIZE',
          `entry ${entry.name} inflates past declared size ${entry.uncompressedSize}`);
      }
      throw zipError('ZIP_BAD', `entry ${entry.name} failed to inflate: ${err.message}`);
    }
  }
  if (out.length !== entry.uncompressedSize) {
    throw zipError('ZIP_SIZE',
      `entry ${entry.name} is ${out.length} bytes, declared ${entry.uncompressedSize}`);
  }
  if (zlib.crc32(out) !== entry.crc32) {
    throw zipError('ZIP_CRC', `CRC-32 mismatch on entry: ${entry.name}`);
  }
  return out;
}

async function extractAll(fd, entries, destDir, fileSize) {
  const resolvedDest = path.resolve(destDir);
  const tempDir = `${resolvedDest}.partial-${crypto.randomBytes(6).toString('hex')}`;
  await fsp.mkdir(tempDir, { recursive: true });
  try {
    for (const entry of entries) {
      const target = path.resolve(tempDir, entry.name);
      if (target !== tempDir && !target.startsWith(tempDir + path.sep)) {
        throw zipError('ZIP_NAME', `entry escapes destination: ${entry.name}`);
      }
      if (entry.isDirectory) {
        await fsp.mkdir(target, { recursive: true });
        continue;
      }
      const data = await readEntryData(fd, entry, fileSize);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, data);
    }
    let destExists = true;
    try {
      const st = await fsp.stat(resolvedDest);
      if (!st.isDirectory() || (await fsp.readdir(resolvedDest)).length > 0) {
        throw zipError('ZIP_BAD', `destination exists and is not empty: ${destDir}`);
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      destExists = false;
    }
    if (destExists) await fsp.rmdir(resolvedDest);
    await fsp.rename(tempDir, resolvedDest);
  } catch (err) {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

module.exports = { openZip };
