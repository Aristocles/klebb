// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// lib/datastore/shape.js
// Lossless bidirectional mapping between a card's data value and flat row
// containers. Pure functions, no IO.
//
//   decompose(value)  -> { shape, containers, rest }
//   reconstruct(...)  -> value
//
// The invariant, sealed by tests/datastore-shape.test.js over every shipped
// fixture: reconstruct(decompose(x)) deep-equals x, including after every
// piece has been through JSON.stringify/parse (how rows are stored). The
// fidelity target is JSON.stringify-equivalence — the same normalisation
// every manifest file write already applies.
//
// Mapping rules:
//   array  -> one container named 'rows', one element per row, order = index.
//   object -> each top-level key holding an array becomes a container of
//             that name; all remaining keys form a single rest document.
//             `shape.keys` records every key in original order with its
//             classification, so reconstruct rebuilds the exact structure
//             even when a container has zero rows.
//   null   -> nothing stored; reconstructs to null.
//   other  -> a single-row container named '__doc__' holding the value.

'use strict';

const DATE_PREFIX_RE = /^\d{4}-\d{2}-\d{2}/;

// Assigning to a literal '__proto__' key mutates the prototype instead of
// creating the property, silently dropping data that JSON.parse accepts.
function setKey(obj, key, value) {
  if (key === '__proto__') {
    Object.defineProperty(obj, key, {
      value, writable: true, enumerable: true, configurable: true,
    });
  } else {
    obj[key] = value;
  }
}

function hasKey(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

// Returns { shape, containers, rest }. Containers and rest share references
// with the input (no clone): callers consume the result synchronously.
function decompose(value) {
  if (value === null || value === undefined) {
    return { shape: { kind: 'null' }, containers: {}, rest: null };
  }
  if (Array.isArray(value)) {
    return { shape: { kind: 'array' }, containers: { rows: value }, rest: null };
  }
  if (typeof value === 'object') {
    const keys = [];
    const containers = {};
    let rest = null;
    for (const name of Object.keys(value)) {
      const v = value[name];
      if (Array.isArray(v)) {
        keys.push({ name, container: true });
        setKey(containers, name, v);
      } else {
        keys.push({ name, container: false });
        if (rest === null) rest = {};
        setKey(rest, name, v);
      }
    }
    return { shape: { kind: 'object', keys }, containers, rest };
  }
  return { shape: { kind: 'doc' }, containers: { __doc__: [value] }, rest: null };
}

// Rebuilds the data value. A container absent from `containers` reconstructs
// as [] (zero rows stored means an empty array, a valid state). A missing
// rest key or doc row is corruption, not emptiness: throw loudly.
function reconstruct({ shape, containers = {}, rest = null }) {
  const kind = shape && shape.kind;
  if (kind === 'null') return null;
  if (kind === 'array') {
    return hasKey(containers, 'rows') ? containers.rows : [];
  }
  if (kind === 'doc') {
    const doc = containers.__doc__;
    if (!Array.isArray(doc) || doc.length !== 1) {
      throw new Error('reconstruct: doc shape requires exactly one __doc__ row');
    }
    return doc[0];
  }
  if (kind === 'object') {
    const out = {};
    for (const { name, container } of shape.keys) {
      if (container) {
        setKey(out, name, hasKey(containers, name) ? containers[name] : []);
      } else {
        if (rest === null || !hasKey(rest, name)) {
          throw new Error(`reconstruct: rest document is missing key "${name}"`);
        }
        setKey(out, name, rest[name]);
      }
    }
    return out;
  }
  throw new Error(`reconstruct: unknown shape kind: ${JSON.stringify(kind)}`);
}

// Extracts the YYYY-MM-DD prefix of a row's `date` string, verbatim: no
// parsing, no timezone maths. Null when absent, non-string, or unmatched
// (a real live card has an entry with date: '').
function rowDate(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const d = row.date;
  if (typeof d !== 'string' || !DATE_PREFIX_RE.test(d)) return null;
  return d.slice(0, 10);
}

module.exports = { decompose, reconstruct, rowDate };
