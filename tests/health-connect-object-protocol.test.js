// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { decodeMessage, decodeAssembledPayload } = require('../lib/health-connect/protocol');
const vectors = require('./fixtures/health-connect/object-protocol-v1.json');
for (const vector of vectors.cases) {
  test(vector.id, () => {
    const text = vector.construction ? vector.construction.prefix +
      'P'.repeat(vector.construction.paddingCount) + vector.construction.suffix : vector.wire;
    const bytes = vector.wireHex ? Buffer.from(vector.wireHex, 'hex') : Buffer.from(text);
    assert.equal(bytes.length, vector.expectedUtf8Bytes);
    const action = () => {
      if (vector.mode === 'receipt') return decodeMessage(bytes, vector.context);
      if (vector.mode === 'assembled') return decodeAssembledPayload(bytes, vector.declaration, vector.context);
      const payloadDigest = 'sha256:' + createHash('sha256').update(bytes).digest('hex');
      return decodeMessage(JSON.stringify({ version: 1, kind: 'batch',
        payloadJson: text, payloadDigest }), vector.context);
    };
    if (vector.expected.accepted) {
      const result = action();
      assert.ok(Object.isFrozen(result));
    } else {
      assert.throws(action, error => {
        assert.equal(error.code, vector.expected.code);
        return true;
      });
    }
  });
}
