// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Real bounded HTTP body observation; freeze uses the existing product gate.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const home = path.resolve(process.env.HEALTH_HOME || '');
assert.ok(home.startsWith(path.resolve(os.tmpdir()) + path.sep) &&
  path.basename(home).startsWith('eh-test-'));
const latch = path.resolve(process.env.INDEPENDENT_INDEX_MIDBODY_LATCH || '');
assert.equal(path.dirname(latch), home);
const action = process.env.INDEPENDENT_INDEX_MIDBODY_ACTION;
assert.ok(['observe', 'freeze'].includes(action));
const route = '/api/connectors/health-connect/projections/rebuild';
const emit = http.Server.prototype.emit;
http.Server.prototype.emit = function (event, ...args) {
  const message = args[0];
  if (event === 'request' && message.method === 'POST' && message.url === route) {
    const original = message[Symbol.asyncIterator].bind(message);
    message[Symbol.asyncIterator] = async function* () {
      let first = true;
      for await (const chunk of original()) {
        if (first) {
          first = false;
          if (action === 'freeze') require(path.join(process.env.INDEPENDENT_PRODUCT_ROOT, 'lib/import/freeze'))
            .engage('synthetic-source-index-midbody');
          fs.writeFileSync(latch, JSON.stringify({
            phase: 'rebuild-first-body-chunk-consumed-before-request-end', route,
            bytes: chunk.length, action,
          }), { encoding: 'utf8', mode: 0o600 });
        }
        yield chunk;
      }
    };
  }
  return Reflect.apply(emit, this, [event, ...args]);
};
