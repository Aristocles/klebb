// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Synthetic child-only observation; no product route/header/clock bypass.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const home = path.resolve(process.env.HEALTH_HOME || '');
assert.ok(home.startsWith(path.resolve(os.tmpdir()) + path.sep) &&
  path.basename(home).startsWith('eh-test-'));
const latch = path.resolve(process.env.INDEPENDENT_MID_BODY_LATCH || '');
assert.equal(path.dirname(latch), home);
const mode = process.env.INDEPENDENT_MID_BODY_ACTION;
assert.ok(['observe', 'freeze', 'admission-observe'].includes(mode));
const originalEmit = http.Server.prototype.emit;
http.Server.prototype.emit = function (event, ...args) {
  const message = args[0];
  if (event === 'request' && message.method === 'POST' &&
      (mode === 'admission-observe' ?
      ['/api/connectors/health-connect/pairing-grants', '/api/connectors/health-connect/v1/pairing/exchange']
        .includes(message.url) : message.url === '/api/connectors/health-connect/v1/batches')) {
    const original = message[Symbol.asyncIterator].bind(message);
    message[Symbol.asyncIterator] = async function* () {
      let first = true;
      for await (const chunk of original()) {
        if (first) {
          first = false;
          if (mode === 'freeze') {
            require(path.join(process.env.INDEPENDENT_PRODUCT_ROOT, 'lib/import/freeze'))
              .engage('synthetic-midbody-review');
          }
          const pending = latch + '.pending';
          fs.writeFileSync(pending, JSON.stringify({
            phase: mode === 'admission-observe' ?
              'admission-iterator-consumed-first-chunk-before-request-end' :
              'batch-iterator-consumed-first-chunk-before-request-end',
            bytes: chunk.length,
            action: mode,
          }), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
          fs.renameSync(pending, latch);
        }
        yield chunk;
      }
    };
  }
  return Reflect.apply(originalEmit, this, [event, ...args]);
};
