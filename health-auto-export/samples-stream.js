// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// health-auto-export/samples-stream.js
//
// Incremental reader for an HAE push-history file, either the modern
// {"version":1,"pushes":[...]} shape or the legacy bare-array form the drain
// has always accepted. Yields one parsed push at a time, so peak memory is
// proportional to the largest push rather than the file: a real restore fed
// a samples.json of tens of MB into a container with a 256 MB cap, and the
// whole-file JSON.parse (plus per-sample string binds) blew the heap. The
// validator's per-file size cap is not the guard for this; an in-cap file
// can still exceed a small container's heap (#632).
//
// The scanner is JSON-aware only as far as it must be to navigate: string
// and escape state (so a "]}," inside a value cannot end an element) and
// bracket depth (so nested arrays/objects stay inside their push). Each
// element is then genuinely JSON.parse'd, so a malformed push is caught.
// Header values other than pushes (version etc) are balance-checked and
// skipped, not re-parsed. A caller that needs a header value (the import
// validator gates on version, #639) passes opts.onHeader(key, value):
// value is { kind: 'scalar' | 'string', text } with text re-parseable as
// JSON, or { kind: 'complex' } for objects, arrays, and anything over the
// capture cap, so a hostile header can never be buffered whole.
//
// Errors carry a code the drain dispatches on:
//   SAMPLES_STREAM_NO_PUSHES  valid-looking JSON with no pushes[] array
//   SAMPLES_STREAM_INVALID    structurally broken, or an element that does
//                             not parse: the drain's rename-aside path
// Filesystem errors propagate raw (same code family the old readFileSync
// produced), and the drain treats them as unreadable too.

'use strict';

const fsp = require('fs/promises');
const { StringDecoder } = require('string_decoder');

const CHUNK_SIZE = 64 * 1024;
const HEADER_CAP = 256;

// A top-level scalar (valid JSON, but nothing to stream) must report
// NO_PUSHES like the old whole-file parse did, which needs a real parse. A
// scalar posing as a push history is pathological above this size, and
// buffering without a cap would reopen the exact hole this module closes.
const SCALAR_CAP = 1024 * 1024;

class SamplesStreamError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const invalid = (msg) => new SamplesStreamError('SAMPLES_STREAM_INVALID', msg);
const noPushes = () => new SamplesStreamError('SAMPLES_STREAM_NO_PUSHES', 'no pushes[] array');

function isWs(c) {
  return c === ' ' || c === '\n' || c === '\r' || c === '\t';
}

// Async generator over the pushes. The file handle is opened and closed
// here, and an async finally defers error propagation until the close has
// completed, so the caller can rename the file the moment next() settles
// (Windows refuses to rename a file with an open handle).
async function* streamPushes(file, opts = {}) {
  const chunkSize = opts.chunkSize || CHUNK_SIZE;
  const fh = await fsp.open(file, 'r');
  const decoder = new StringDecoder('utf8');
  const buf = Buffer.alloc(chunkSize);

  // Modes: start, header (expect key or }), key, colon, value-start, skip,
  // skip-string, skip-scalar, after-value, elements, element, end, scalar.
  let mode = 'start';
  let bare = false;
  let sawPushes = false;
  let key = '';
  let keyEscape = false;
  let skipDepth = 0;
  let inString = false;
  let escape = false;
  let elDepth = 0;
  let elemParts = null;
  let elemStart = 0;
  let scalarParts = null;
  let scalarLen = 0;
  let pos = 0;
  let ordinal = 0;

  const capture = typeof opts.onHeader === 'function';
  let hdrKey = null;
  let hdrParts = null;
  let hdrLen = 0;
  let hdrOver = false;
  const beginHeader = (over) => {
    if (!capture) return;
    hdrKey = key;
    hdrOver = over;
    hdrParts = over ? null : [];
    hdrLen = 0;
  };
  const hdrPush = (s) => {
    if (!capture || hdrOver) return;
    hdrLen += s.length;
    if (hdrLen > HEADER_CAP) { hdrOver = true; hdrParts = null; return; }
    hdrParts.push(s);
  };
  const emitHeader = (kind) => {
    if (!capture || hdrKey === null) return;
    const value = hdrOver
      ? { kind: 'complex' }
      : kind === 'string'
        ? { kind, text: `"${hdrParts.join('')}"` }
        : { kind, text: hdrParts.join('').trim() };
    const k = hdrKey;
    hdrKey = null;
    hdrParts = null;
    opts.onHeader(k, value);
  };

  try {
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, chunkSize, null);
      if (bytesRead === 0) break;
      const chunk = decoder.write(buf.subarray(0, bytesRead));
      if (elemParts) elemStart = 0;

      if (mode === 'scalar') {
        scalarLen += chunk.length;
        if (scalarLen > SCALAR_CAP) throw invalid('not a push-history shape');
        scalarParts.push(chunk);
        continue;
      }

      for (let i = 0; i < chunk.length; i++, pos++) {
        const c = chunk[i];

        if (mode === 'element') {
          if (inString) {
            if (escape) escape = false;
            else if (c === '\\') escape = true;
            else if (c === '"') inString = false;
            continue;
          }
          if (c === '"') { inString = true; continue; }
          if (c === '{' || c === '[') { elDepth += 1; continue; }
          if (c === '}' || c === ']') {
            if (elDepth === 0) {
              if (c === '}') throw invalid(`unexpected "}" at character ${pos}`);
              // "]" at element depth 0 closes the pushes array.
            } else {
              elDepth -= 1;
              continue;
            }
          } else if (!(c === ',' && elDepth === 0)) {
            continue;
          }
          // The element ended at this "," or "]".
          elemParts.push(chunk.slice(elemStart, i));
          const text = elemParts.join('');
          elemParts = null;
          ordinal += 1;
          let value;
          try {
            value = JSON.parse(text);
          } catch (e) {
            throw invalid(`push ${ordinal} does not parse: ${e.message}`);
          }
          mode = c === ']' ? (bare ? 'end' : 'after-value') : 'elements';
          yield value;
          continue;
        }

        if (mode === 'elements') {
          if (isWs(c)) continue;
          if (c === ']') { mode = bare ? 'end' : 'after-value'; continue; }
          mode = 'element';
          elDepth = 0;
          inString = false;
          escape = false;
          elemParts = [];
          elemStart = i;
          if (c === '"') inString = true;
          else if (c === '{' || c === '[') elDepth = 1;
          else if (c === '}') throw invalid(`unexpected "}" at character ${pos}`);
          continue;
        }

        if (mode === 'skip') {
          if (inString) {
            if (escape) escape = false;
            else if (c === '\\') escape = true;
            else if (c === '"') inString = false;
            continue;
          }
          if (c === '"') inString = true;
          else if (c === '{' || c === '[') skipDepth += 1;
          else if (c === '}' || c === ']') {
            skipDepth -= 1;
            if (skipDepth === 0) { emitHeader('complex'); mode = 'after-value'; }
            else if (skipDepth < 0) throw invalid(`unbalanced "${c}" at character ${pos}`);
          }
          continue;
        }

        if (mode === 'skip-string') {
          if (escape) { escape = false; hdrPush(c); continue; }
          if (c === '\\') { escape = true; hdrPush(c); continue; }
          if (c === '"') { emitHeader('string'); mode = 'after-value'; continue; }
          hdrPush(c);
          continue;
        }

        if (mode === 'skip-scalar') {
          if (isWs(c)) { emitHeader('scalar'); mode = 'after-value'; continue; }
          if (c === ',') { emitHeader('scalar'); mode = 'header'; continue; }
          if (c === '}') {
            emitHeader('scalar');
            if (!sawPushes) throw noPushes();
            mode = 'end';
            continue;
          }
          hdrPush(c);
          continue;
        }

        if (mode === 'after-value') {
          if (isWs(c)) continue;
          if (c === ',') { mode = 'header'; continue; }
          if (c === '}') {
            if (!sawPushes) throw noPushes();
            mode = 'end';
            continue;
          }
          throw invalid(`unexpected "${c}" at character ${pos}`);
        }

        if (mode === 'header') {
          if (isWs(c)) continue;
          if (c === '"') { mode = 'key'; key = ''; keyEscape = false; continue; }
          if (c === '}') {
            if (!sawPushes) throw noPushes();
            mode = 'end';
            continue;
          }
          throw invalid(`unexpected "${c}" at character ${pos}`);
        }

        if (mode === 'key') {
          if (keyEscape) { key += c; keyEscape = false; continue; }
          if (c === '\\') { keyEscape = true; continue; }
          if (c === '"') { mode = 'colon'; continue; }
          key += c;
          continue;
        }

        if (mode === 'colon') {
          if (isWs(c)) continue;
          if (c === ':') { mode = 'value-start'; continue; }
          throw invalid(`expected ":" at character ${pos}`);
        }

        if (mode === 'value-start') {
          if (isWs(c)) continue;
          if (key === 'pushes') {
            if (c !== '[') throw noPushes();
            sawPushes = true;
            mode = 'elements';
            continue;
          }
          if (c === '{' || c === '[') { mode = 'skip'; skipDepth = 1; inString = false; escape = false; beginHeader(true); }
          else if (c === '"') { mode = 'skip-string'; escape = false; beginHeader(false); }
          else if (c === ',' || c === '}' || c === ']') throw invalid(`unexpected "${c}" at character ${pos}`);
          else { mode = 'skip-scalar'; beginHeader(false); hdrPush(c); }
          continue;
        }

        if (mode === 'end') {
          if (isWs(c)) continue;
          throw invalid(`trailing content at character ${pos}`);
        }

        // mode === 'start'
        if (isWs(c)) continue;
        if (c === '[') { bare = true; mode = 'elements'; continue; }
        if (c === '{') { bare = false; mode = 'header'; continue; }
        mode = 'scalar';
        scalarParts = [chunk.slice(i)];
        scalarLen = chunk.length - i;
        if (scalarLen > SCALAR_CAP) throw invalid('not a push-history shape');
        break;
      }

      if (elemParts) elemParts.push(chunk.slice(elemStart));
    }

    if (mode === 'scalar') {
      try {
        JSON.parse(scalarParts.join(''));
      } catch (e) {
        throw invalid(e.message);
      }
      throw noPushes();
    }
    if (mode === 'start') throw invalid('unexpected end of file');
    if (mode !== 'end') throw invalid('unexpected end of file');
  } finally {
    await fh.close();
  }
}

module.exports = { streamPushes, SamplesStreamError, CHUNK_SIZE };
