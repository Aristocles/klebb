// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// ingest/extractors/imageprep.js
// Bound an image before it is sent to a vision-capable gateway model.
//
// The original upload never goes over the wire. Anything past ~1568 px on the
// long edge is downscaled server-side by every current vision model anyway, so
// a larger payload buys zero fidelity while risking the gateway's request
// limits; a phone photo re-encoded to a 1568 px JPEG is a few hundred KB. The
// downscale itself is ffmpeg's job (already shipped for audio); when ffmpeg is
// absent, a small original passes through untouched and a large one is
// reported unpreparable so the caller can fall back to local OCR.

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const VISION_LONG_EDGE = 1568;
// Pass-through ceiling for an already-small original. Base64 inflates by a
// third, and the payload has to clear whatever body limit the gateway path
// enforces, so this stays comfortably under typical per-image caps.
const PASS_THROUGH_MAX_BYTES = 4 * 1024 * 1024;
// A prepared JPEG larger than this means the re-encode failed at its one job.
const PREPARED_MAX_BYTES = 5 * 1024 * 1024;
// Dimension headers live near the front of the file; EXIF blocks can push a
// JPEG's frame header past small offsets but not past this.
const SNIFF_BYTES = 256 * 1024;

const SPAWN_TIMEOUT_MS = 60_000;

// --- dimension sniffing (pure JS, no decoder) ---

function _sniffPng(buf) {
  if (buf.length < 24) return null;
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) if (buf[i] !== sig[i]) return null;
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), type: 'png' };
}

// Walk JPEG segments to the first SOF frame header. C4 (Huffman), C8
// (extension) and CC (arithmetic tables) share the SOF numbering block but
// carry no dimensions, hence the exclusions.
function _isSofMarker(m) {
  return m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
}

function _sniffJpeg(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 3 < buf.length) {
    if (buf[i] !== 0xff) return null;
    // Fill bytes: consecutive FFs pad out to the real marker.
    while (i + 3 < buf.length && buf[i + 1] === 0xff) i++;
    const marker = buf[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    // Entropy-coded data or end of image before any frame header: give up
    // rather than scan compressed bytes for marker look-alikes.
    if (marker === 0xda || marker === 0xd9) return null;
    if (i + 4 > buf.length) return null;
    const segLen = buf.readUInt16BE(i + 2);
    if (segLen < 2) return null;
    if (_isSofMarker(marker)) {
      if (i + 9 > buf.length) return null;
      return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5), type: 'jpeg' };
    }
    i += 2 + segLen;
  }
  return null;
}

function sniffDimensions(buf) {
  if (!Buffer.isBuffer(buf)) return null;
  return _sniffPng(buf) || _sniffJpeg(buf);
}

function _readHead(absPath, bytes) {
  const fd = fs.openSync(absPath, 'r');
  try {
    const buf = Buffer.alloc(Math.min(bytes, fs.fstatSync(fd).size));
    fs.readSync(fd, buf, 0, buf.length, 0);
    return buf;
  } finally {
    fs.closeSync(fd);
  }
}

// --- ffmpeg ---

let _ffmpegProbe = null;
function hasFfmpeg() {
  if (_ffmpegProbe === null) {
    const probe = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    _ffmpegProbe = !probe.error;
  }
  return _ffmpegProbe;
}

function _run(bin, args, timeoutMs = SPAWN_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
    });
    let stderr = '';
    proc.stderr.on('data', c => { if (stderr.length < 4000) stderr += c.toString(); });
    proc.on('error', e => reject(new Error(`${bin} spawn failed: ${e.message}`)));
    proc.on('close', (code, signal) => {
      if (signal === 'SIGKILL') {
        return reject(new Error(`${bin} timed out after ${Math.round(timeoutMs / 1000)}s and was killed`));
      }
      if (code !== 0) return reject(new Error(`${bin} exit ${code}: ${stderr.slice(-300)}`));
      resolve();
    });
  });
}

// Expression form rather than computed numbers so it also covers a file whose
// dimensions could not be sniffed: never upscales, bounds the long edge, and
// -2 keeps the minor axis even. The single quotes are for ffmpeg's own
// filtergraph parser (the args never pass through a shell).
const SCALE_FILTER =
  "scale='if(gte(iw,ih),min(iw,1568),-2)':'if(gte(iw,ih),-2,min(ih,1568))'";

function _mediaTypeFor(absPath, dims) {
  if (dims && dims.type === 'png') return 'image/png';
  if (dims && dims.type === 'jpeg') return 'image/jpeg';
  return path.extname(absPath).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg';
}

// Decide what to actually send for one image: the original when it is already
// within bounds, a downscaled JPEG copy in tmpDir when it is not. Never
// throws for a preparation problem; `{ ok: false, reason }` lets the caller
// fall back to local OCR with the reason recorded.
async function prepareImage(absPath, tmpDir, { ffmpeg = hasFfmpeg() } = {}) {
  let size;
  try { size = fs.statSync(absPath).size; } catch (e) {
    return { ok: false, reason: `could not read image: ${e.message}` };
  }
  let dims = sniffDimensions(_readHead(absPath, SNIFF_BYTES));
  if (!dims && size > SNIFF_BYTES) {
    try { dims = sniffDimensions(fs.readFileSync(absPath)); } catch {}
  }

  if (dims && Math.max(dims.width, dims.height) <= VISION_LONG_EDGE && size <= PASS_THROUGH_MAX_BYTES) {
    return { ok: true, path: absPath, mediaType: _mediaTypeFor(absPath, dims), prepared: false };
  }

  if (!ffmpeg) {
    return {
      ok: false,
      reason: dims
        ? `image is ${dims.width}x${dims.height} and ffmpeg is unavailable to downscale it`
        : 'image dimensions could not be read and ffmpeg is unavailable to normalise it',
    };
  }

  const stem = path.basename(absPath).replace(/[^a-zA-Z0-9._-]+/g, '_');
  const out = path.join(tmpDir, `vision-${stem}.jpg`);
  try {
    await _run('ffmpeg', ['-y', '-i', absPath, '-frames:v', '1', '-vf', SCALE_FILTER, '-q:v', '3', out]);
  } catch (e) {
    return { ok: false, reason: `could not prepare image: ${e.message}` };
  }
  let outSize;
  try { outSize = fs.statSync(out).size; } catch (e) {
    return { ok: false, reason: `could not prepare image: ${e.message}` };
  }
  if (outSize === 0 || outSize > PREPARED_MAX_BYTES) {
    return { ok: false, reason: `prepared image came out at ${outSize} bytes` };
  }
  return { ok: true, path: out, mediaType: 'image/jpeg', prepared: true };
}

function toDataUrl(absPath, mediaType) {
  return `data:${mediaType};base64,${fs.readFileSync(absPath).toString('base64')}`;
}

module.exports = {
  prepareImage,
  sniffDimensions,
  toDataUrl,
  hasFfmpeg,
  SCALE_FILTER,
  VISION_LONG_EDGE,
  PASS_THROUGH_MAX_BYTES,
  PREPARED_MAX_BYTES,
  SNIFF_BYTES,
};
