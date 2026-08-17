// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// lib/import/freeze.js
// Process-wide write gate for the import wizard. While engaged, every
// mutating API route (and the HAE ingest) is expected to consult frozen()
// and answer 503: the wizard wipes and rebuilds the instance's data plane,
// and a write landing mid-pipeline would either vanish in the wipe or
// corrupt the verify.
//
//   freeze.engage('import')   // throws if already engaged
//   freeze.frozen()           // the reason string, or null
//   freeze.release()          // idempotent; returns whether it was engaged
//
// A second engage() THROWS rather than returning false: two overlapping
// engagers means two concurrent bulk mutations, and the second must fail
// loudly at its call site, not discover a shared gate it silently co-owns
// and then release under the first one's feet.

'use strict';

let _reason = null;

function engage(reason) {
  if (_reason !== null) {
    throw new Error(`write freeze already engaged (${_reason})`);
  }
  _reason = String(reason || 'unspecified');
  return true;
}

function release() {
  const wasEngaged = _reason !== null;
  _reason = null;
  return wasEngaged;
}

function frozen() {
  return _reason;
}

module.exports = { engage, release, frozen };
