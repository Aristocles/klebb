// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Synthetic child-only faults. Never load this in a real-data process.
const fs = require('node:fs');
const path = require('node:path');
const authority = path.resolve(process.env.INDEPENDENT_AUTHORITY_FILE);
const marker = process.env.INDEPENDENT_FAULT_MARKER;
const operation = process.env.INDEPENDENT_FAULT;
const original = {
  read: fs.readFileSync, open: fs.openSync, write: fs.writeFileSync,
  rename: fs.renameSync, close: fs.closeSync, fsync: fs.fsyncSync,
};
const descriptors = new Set();
const directories = new Set();
let fired = false;
const samePath = value => typeof value === 'string' && path.resolve(value) === authority;
const temporary = value => typeof value === 'string' &&
  path.resolve(value).startsWith(authority + '.') && value.endsWith('.tmp');
function record() {
  fired = true;
  original.write.call(fs, marker, operation, 'utf8');
}
fs.readFileSync = function (file, ...args) {
  if (!fired && operation === 'freeze-after-entry' && samePath(file)) {
    record();
    require(process.env.INDEPENDENT_FREEZE_MODULE).engage('independent-inflight-freeze');
  }
  return original.read.call(this, file, ...args);
};
fs.openSync = function (file, ...args) {
  const descriptor = original.open.call(this, file, ...args);
  if (temporary(file)) descriptors.add(descriptor);
  if (typeof file === 'string' && path.resolve(file) === path.dirname(authority)) {
    directories.add(descriptor);
  }
  return descriptor;
};
fs.fsyncSync = function (descriptor, ...args) {
  if (!fired && operation === 'directory-fsync-eio' && directories.has(descriptor)) {
    record();
    const error = new Error('synthetic authority directory fsync EIO');
    error.code = 'EIO';
    throw error;
  }
  return original.fsync.call(this, descriptor, ...args);
};
fs.writeFileSync = function (file, ...args) {
  if (!fired && operation === 'write-enospc' && descriptors.has(file)) {
    record();
    const error = new Error('synthetic authority ENOSPC');
    error.code = 'ENOSPC';
    throw error;
  }
  return original.write.call(this, file, ...args);
};
fs.renameSync = function (from, to, ...args) {
  if (!fired && operation === 'rename-eio' && temporary(from) && samePath(to)) {
    record();
    const error = new Error('synthetic authority rename EIO');
    error.code = 'EIO';
    throw error;
  }
  return original.rename.call(this, from, to, ...args);
};
fs.closeSync = function (descriptor, ...args) {
  descriptors.delete(descriptor);
  directories.delete(descriptor);
  return original.close.call(this, descriptor, ...args);
};
