// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// manifests/path.js
// Tiny equality-only path language for addressing rows inside a manifest's
// data block. Pure: no I/O, no registry coupling.
//
// Grammar:
//   path     := segment ('.' segment)*
//   segment  := identifier ('[' filter ']')?
//   filter   := identifier '=' literal
//   literal  := "..." | '...' | number | true | false
//
// The reserved filter key 'index' against an integer literal is interpreted
// as an array index when the parent is an array. Any other use of 'index'
// (string literal, parent is object) falls through to a normal property
// match, so cards storing {index: "foo"} still work.
//
// Empty input string parses to an empty segment list; resolvePath then
// returns the root data value unchanged.

class BadPath extends Error {
  constructor(message, position, hint) {
    super(message);
    this.name = 'BadPath';
    this.code = 'BAD_PATH';
    this.position = position;
    if (hint) this.hint = hint;
  }
}

class NoMatch extends Error {
  constructor(message, segmentIndex) {
    super(message);
    this.name = 'NoMatch';
    this.code = 'NO_MATCH';
    this.segmentIndex = segmentIndex;
  }
}

class Ambiguous extends Error {
  constructor(message, count, segmentIndex) {
    super(message);
    this.name = 'Ambiguous';
    this.code = 'AMBIGUOUS';
    this.count = count;
    this.segmentIndex = segmentIndex;
  }
}

class WrongType extends Error {
  constructor(message, segmentIndex) {
    super(message);
    this.name = 'WrongType';
    this.code = 'WRONG_TYPE';
    this.segmentIndex = segmentIndex;
  }
}

const IDENT_START = /[A-Za-z_]/;
const IDENT_REST = /[A-Za-z0-9_\-]/;
const DIGIT = /[0-9]/;

// Parse a path string into an array of segments. Each segment is
// { name: string, filter: null | {by: string, value: string|number|boolean} }.
// Throws BadPath on any grammar error.
function parsePath(input) {
  if (input === undefined || input === null) {
    throw new BadPath('path is required', 0, 'pass an empty string for root, or a segment like "items"');
  }
  if (typeof input !== 'string') {
    throw new BadPath('path must be a string', 0);
  }
  if (input.length === 0) return [];

  const s = input;
  let i = 0;
  const segments = [];

  function peek() { return i < s.length ? s[i] : null; }
  function advance() { return s[i++]; }
  function expect(ch) {
    if (peek() !== ch) {
      throw new BadPath(`expected '${ch}' at position ${i}, got ${describeChar(peek())}`, i);
    }
    advance();
  }
  function describeChar(c) {
    if (c === null) return 'end of input';
    return `'${c}'`;
  }

  function readIdent() {
    if (!IDENT_START.test(peek() || '')) {
      throw new BadPath(`expected identifier at position ${i}, got ${describeChar(peek())}`, i,
        'identifiers start with a letter or underscore');
    }
    const start = i;
    while (peek() && IDENT_REST.test(peek())) advance();
    return s.slice(start, i);
  }

  function readLiteral() {
    const c = peek();
    if (c === '"' || c === "'") return readString(c);
    if (c === '-' || (c && DIGIT.test(c))) return readNumber();
    // bare identifier literal (true/false only)
    if (c && IDENT_START.test(c)) {
      const start = i;
      const word = readIdent();
      if (word === 'true') return true;
      if (word === 'false') return false;
      throw new BadPath(`unknown bare literal '${word}' at position ${start}`, start,
        'literals must be quoted strings, numbers, true, or false');
    }
    throw new BadPath(`expected literal at position ${i}, got ${describeChar(c)}`, i,
      'literals are quoted strings, numbers, true, or false');
  }

  function readString(quote) {
    const start = i;
    advance(); // consume opening quote
    let out = '';
    while (true) {
      const c = peek();
      if (c === null) {
        throw new BadPath(`unterminated string starting at position ${start}`, start);
      }
      if (c === quote) { advance(); return out; }
      if (c === '\\') {
        advance();
        const esc = peek();
        if (esc === null) {
          throw new BadPath(`dangling backslash at end of string starting at position ${start}`, start);
        }
        if (esc === 'n') out += '\n';
        else if (esc === 't') out += '\t';
        else if (esc === 'r') out += '\r';
        else out += esc; // \\, \", \', \?, etc.
        advance();
        continue;
      }
      out += c;
      advance();
    }
  }

  function readNumber() {
    const start = i;
    if (peek() === '-') advance();
    let sawDigit = false;
    while (peek() && DIGIT.test(peek())) { advance(); sawDigit = true; }
    if (peek() === '.') {
      advance();
      while (peek() && DIGIT.test(peek())) { advance(); sawDigit = true; }
    }
    if (!sawDigit) {
      throw new BadPath(`malformed number at position ${start}`, start);
    }
    const text = s.slice(start, i);
    const n = Number(text);
    if (!Number.isFinite(n)) {
      throw new BadPath(`malformed number '${text}' at position ${start}`, start);
    }
    return n;
  }

  function readFilterBody() {
    // assumes leading '[' is at peek(); advances past the closing ']'
    advance();
    const by = readIdent();
    if (peek() !== '=') {
      throw new BadPath(`expected '=' after filter key at position ${i}`, i,
        "filters look like [key=value], e.g. [name=\"BPC-157\"]");
    }
    advance();
    const value = readLiteral();
    if (peek() !== ']') {
      throw new BadPath(`expected ']' to close filter at position ${i}, got ${describeChar(peek())}`, i);
    }
    advance();
    return { by, value };
  }

  function readSegment(allowLeadingFilter) {
    let name = '';
    let filter = null;
    if (allowLeadingFilter && peek() === '[') {
      // Root-array filter: [k=v] with no property step. Only allowed as
      // the first segment so callers can address elements of an array-
      // typed data block directly.
      filter = readFilterBody();
      return { name, filter };
    }
    name = readIdent();
    if (peek() === '[') {
      filter = readFilterBody();
    }
    return { name, filter };
  }

  segments.push(readSegment(true));
  while (peek() === '.') {
    advance();
    segments.push(readSegment(false));
  }
  if (i !== s.length) {
    throw new BadPath(`unexpected ${describeChar(peek())} at position ${i}`, i,
      "segments are separated by '.', filters by '[k=v]'");
  }
  return segments;
}

// Resolve a parsed path against a data value. Returns
//   { container, key, value }
// where container[key] === value, or container/key are null for the root.
//
// Options:
//   allowMultiple: if true, returns { matches: [{container, key, value}, ...] }
//                  instead of throwing AMBIGUOUS.
//
// Throws NoMatch / Ambiguous / WrongType. The caller decides whether to
// catch (e.g. update_row should always treat AMBIGUOUS as an error;
// read_manifest_rows may pass allowMultiple:true).
function resolvePath(data, segments, opts) {
  const options = opts || {};
  if (!Array.isArray(segments)) {
    throw new TypeError('segments must be an array (call parsePath first)');
  }
  if (segments.length === 0) {
    return { container: null, key: null, value: data };
  }

  let container = null;
  let key = null;
  let current = data;

  for (let idx = 0; idx < segments.length; idx++) {
    const seg = segments[idx];
    const stepIntoProperty = seg.name !== '';
    if (stepIntoProperty) {
      if (current === null || current === undefined) {
        throw new NoMatch(`segment '${seg.name}' traverses through ${current === null ? 'null' : 'undefined'}`, idx);
      }
      if (typeof current !== 'object') {
        throw new WrongType(`segment '${seg.name}' expects an object/array but found ${typeof current}`, idx);
      }
      if (Array.isArray(current)) {
        throw new WrongType(`segment '${seg.name}' expects an object property but found an array`, idx);
      }
      if (!Object.prototype.hasOwnProperty.call(current, seg.name)) {
        throw new NoMatch(`property '${seg.name}' not found`, idx);
      }
      container = current;
      key = seg.name;
      current = current[seg.name];
    }

    if (seg.filter) {
      const label = seg.name === '' ? '' : seg.name;
      const matches = applyFilter(current, seg.filter, idx);
      if (matches.length === 0) {
        throw new NoMatch(`${label}[${describeFilter(seg.filter)}] matched no rows`, idx);
      }
      if (matches.length > 1 && !options.allowMultiple) {
        throw new Ambiguous(
          `${label}[${describeFilter(seg.filter)}] matched ${matches.length} rows`,
          matches.length,
          idx,
        );
      }
      if (options.allowMultiple && idx === segments.length - 1) {
        return { matches };
      }
      const m = matches[0];
      container = m.container;
      key = m.key;
      current = m.value;
    }
  }

  return { container, key, value: current };
}

function applyFilter(arr, filter, segmentIndex) {
  if (!Array.isArray(arr)) {
    throw new WrongType(`filter [${describeFilter(filter)}] expects an array but found ${describeNonArray(arr)}`, segmentIndex);
  }
  // Special-case: index=<integer> against an array.
  if (filter.by === 'index' && Number.isInteger(filter.value)) {
    const n = filter.value;
    if (n < 0 || n >= arr.length) {
      return [];
    }
    return [{ container: arr, key: n, value: arr[n] }];
  }
  const out = [];
  for (let n = 0; n < arr.length; n++) {
    const row = arr[n];
    if (row !== null && typeof row === 'object' && !Array.isArray(row) &&
        Object.prototype.hasOwnProperty.call(row, filter.by) &&
        row[filter.by] === filter.value) {
      out.push({ container: arr, key: n, value: row });
    }
  }
  return out;
}

function describeFilter(f) {
  let v;
  if (typeof f.value === 'string') v = JSON.stringify(f.value);
  else v = String(f.value);
  return `${f.by}=${v}`;
}

function describeNonArray(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array'; // unreachable but safe
  return typeof v;
}

module.exports = {
  parsePath,
  resolvePath,
  BadPath,
  NoMatch,
  Ambiguous,
  WrongType,
};
