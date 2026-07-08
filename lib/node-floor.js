// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// lib/node-floor.js
// Fail fast, with a clear message, on a Node older than the floor the embedded
// datastore needs. node:sqlite is unflagged from Node 22.13; on anything older
// the first datastore.open() throws ERR_UNKNOWN_BUILTIN_MODULE deep in boot,
// which reads as a crash rather than "your Node is too old". Check up front.

'use strict';

const MIN_MAJOR = 22;
const MIN_MINOR = 13;

// Parse a "v22.13.1" / "22.13.1" version string to [major, minor]. Returns
// null if it doesn't look like a version (never blocks boot on a parse miss).
function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)/.exec(String(v || ''));
  if (!m) return null;
  return [Number(m[1]), Number(m[2])];
}

function meetsFloor(version) {
  const parsed = parseVersion(version);
  if (!parsed) return true;
  const [major, minor] = parsed;
  if (major > MIN_MAJOR) return true;
  if (major < MIN_MAJOR) return false;
  return minor >= MIN_MINOR;
}

// Throw with an operator-readable message when the running Node is below the
// floor. Called at the top of server.js before anything opens the datastore.
function assertNodeFloor(version = process.version) {
  if (meetsFloor(version)) return;
  throw new Error(
    `Klebb requires Node >= ${MIN_MAJOR}.${MIN_MINOR} (the embedded datastore uses the built-in `
    + `node:sqlite module, unflagged from ${MIN_MAJOR}.${MIN_MINOR}). This process is running `
    + `${version}. Upgrade Node and restart.`,
  );
}

module.exports = { assertNodeFloor, meetsFloor, MIN_MAJOR, MIN_MINOR };
