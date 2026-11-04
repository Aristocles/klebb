// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const O = require('../tests/helpers/health-connect-owner-deletion-fixture.cjs');
const { F } = O;
const ids = O.selected;
const baselineOptions = { timeout: 60000 };

const stagingBounds = [
  { id: 'parts128000', objectCount: 1000, partsPerObject: 128, accepted: true },
  { id: 'parts128001', objectCount: 1000, partsPerObject: 128, extraPart: true, accepted: false },
];
for (const input of stagingBounds) {
  test(`U13 original stopped staging inventory ${input.id} checks actual BLOB counts and bytes`,
    baselineOptions, async () => {
      const data = await O.fixture();
      try {
        // Real routed PART obtains the existing schema before disclosed stopped
        // replacement. No fabricated native ACK or invalid connector catalogue.
        const template = F.object(data.beta, { paddingCount: 0 });
        await F.stage(data, data.beta, template, [0]);
        await F.stop(data);
        await F.control(data, { command: 'bulk-stage', header: template.header, ...input });
        // Saved4097 is deliberately above the NEW configured4096 cap; initial
        // native admission does not become the owner-deletion test's refusal.
        await F.restart(data, { ...data.extraEnv, ...(input.cap ?
          { HEALTH_CONNECT_STAGING_MAX_BYTES: String(input.cap) } : {}) });
        await F.capabilities(data);
        const before = F.coldRead(data.home);
        assert.equal(F.rows(before, 'health_object_staging').length, input.objectCount);
        const parts = input.objectPartSizes ? 2 : input.objectCount * input.partsPerObject + (input.extraPart ? 1 : 0);
        assert.equal(before.physical.length, parts);
        for (const part of before.physical) {
          assert.equal(part.actual.type, 'blob'); assert.equal(part.actual.digest, part.savedDigest.value);
        }
        if (input.cap) assert.equal(before.physical.reduce((sum, row) => sum + row.actual.bytes, 0),
          input.accepted ? 4096 : 4097);
        if (input.accepted) {
          const expected = O.expected(data, data.beta, ids(), before);
          assert.equal(expected.preview.effects.removedStagedObjects, input.objectCount);
          assert.equal(expected.preview.effects.removedParts, parts);
          O.assertPreview(await O.preview(data, data.beta, ids()), expected, data);
          assert.deepEqual(F.coldRead(data.home), before);
          O.assertApply(await O.apply(data, data.beta, ids(), expected.content.digest), expected, data);
          await O.waitOwnedCurrent(data, data.beta, 0);
          const after = F.coldRead(data.home);
          assert.equal(after.physical.length, 0); assert.deepEqual(F.rows(after, 'health_object_staging'), []);
          O.assertReferences(before, after);
        } else await O.stableFailure(data, () => O.preview(data, data.beta, ids()), 413, 'limit-exceeded');
      } finally { await F.close(data); }
    });
}
