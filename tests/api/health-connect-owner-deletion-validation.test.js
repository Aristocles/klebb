// SPDX-License-Identifier: AGPL-3.0-only
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const O = require('../helpers/health-connect-owner-deletion-fixture.cjs');
const { F } = O;

test('U08 owner apply rejects non-string revision before any storage or catalogue effect',
  { timeout: 60000 }, async () => {
    const data = await O.fixture();
    try {
      const identities = O.selected();
      const expected = O.expected(data, data.beta, identities);
      const inputs = [
        [expected.content.digest],
        { toString: expected.content.digest },
        null,
        12,
        true,
      ];
      for (const revision of inputs) {
        const before = F.coldRead(data.home);
        const catalogue = O.catalogueDigest(data);
        const copies = F.copies(data);
        const response = await F.request(data, O.APPLY, {
          method: 'POST',
          browser: true,
          body: { sourceStoreId: data.beta.binding.sourceStoreId, identities, revision },
        });
        // Establish the actual refusal's safety before classifying its status.
        assert.deepEqual(F.coldRead(data.home), before);
        assert.equal(O.catalogueDigest(data), catalogue);
        assert.deepEqual(F.copies(data), copies);
        F.failure(response, 400, 'invalid-message', data);
      }
    } finally { await F.close(data); }
  });
