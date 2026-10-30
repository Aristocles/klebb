// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Disclosed test-only clock/body witnesses and selected startup-worker isolation.
// No response, authority, SQL, selector or storage result is replaced.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const Module = require('node:module');
const http = require('node:http');
const directory = path.resolve(process.env.SELECTION_PREVIEW_OBSERVATIONS || '');
assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
assert.ok(path.basename(directory).startsWith('eh-selection-observer-'));
assert.equal(fs.lstatSync(directory).isSymbolicLink(), false);
const route = '/api/connectors/health-connect/deletions/selection-preview';
let sequence = 0;
function witness(value) {
  const filename = path.join(directory, `${process.pid}-${++sequence}.json`), temporary = filename + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify({ pid: process.pid, eventSequence: sequence, ...value }), { flag: 'wx', mode: 0o600 });
  fs.renameSync(temporary, filename); // Only complete closed records are consumed.
}
const load = Module._load;
const wrapped = new WeakSet();
Module._load = function(request, parent, isMain) {
  const result = load.apply(this, arguments);
  if (request.endsWith('source-index-worker') || request.endsWith('source-index-worker.js')) {
    const filename = Module._resolveFilename(request, parent);
    const sourceDigest = crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
    assert.ok(['01a9162466ea85a43f5ba342de59b578f3f8903e6d534232757e49d613e7e245',
      '11531734f6a9da4deb227a86eb2bb80299b553a3e960f8bfb776c9b1f63e13d8'].includes(sourceDigest));
    if (!wrapped.has(result)) {
      wrapped.add(result);
      const start = result.startSourceIndex;
      result.startSourceIndex = function(...args) {
        if (!fs.existsSync(path.join(directory, 'pause-startup'))) return start.apply(this, args);
        assert.equal(fs.readFileSync(path.join(directory, 'pause-startup'), 'utf8'), 'controlled-restart-only');
        const stopped = result.stopSourceIndex();
        assert.equal(stopped, undefined, 'pinned actual stop completes synchronously before witness');
        witness({ kind: 'actual-worker-stop-returned-before-startup-suppression', sourceSha256:
          sourceDigest, canonicalSourceSha256: '11531734f6a9da4deb227a86eb2bb80299b553a3e960f8bfb776c9b1f63e13d8' });
        return stopped;
      };
    }
  }
  return result;
};
const RealDate = Date;
function clock() {
  const filename = path.join(directory, 'clock');
  if (!fs.existsSync(filename)) return RealDate.now();
  const text = fs.readFileSync(filename, 'utf8'), value = RealDate.parse(text);
  assert.ok(Number.isFinite(value)); return value;
}
class SelectionTestDate extends RealDate {
  constructor(...args) { super(...(args.length ? args : [clock()])); }
  static now() { return clock(); }
}
global.Date = SelectionTestDate;
const emit = http.Server.prototype.emit;
http.Server.prototype.emit = function(event, request, ...rest) {
  if (event === 'request' && request.url === route && request.method === 'POST') {
    request.once('data', bytes => witness({ kind: 'actual-first-selection-body-chunk', bytes: bytes.length }));
  }
  return emit.call(this, event, request, ...rest);
};
