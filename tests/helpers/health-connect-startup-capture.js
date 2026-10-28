// SPDX-License-Identifier: AGPL-3.0-only
// Child-test preload only: observe startup through shutdown without a product hook.
'use strict';
const fs = require('node:fs');
const file = process.env.KLEBB_TEST_AUTHORITY_LOG_PATH;
if (!file) throw new Error('Test-only authority log capture requires its isolated file.');
// Append so a harmless harness port retry cannot erase an earlier startup.
fs.appendFileSync(file, '[test authority capture installed]\n', { mode: 0o600 });
for (const stream of [process.stdout, process.stderr]) {
  const original = stream.write;
  stream.write = function (chunk, encoding, callback) {
    const data = ArrayBuffer.isView(chunk)
      ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
      : Buffer.from(String(chunk), typeof encoding === 'string' ? encoding : 'utf8');
    fs.appendFileSync(file, data);
    return original.call(this, chunk, encoding, callback);
  };
}
