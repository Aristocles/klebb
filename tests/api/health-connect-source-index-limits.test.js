// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  fixture, restart, ownerStatus, ownerRebuild, noAuthority, TARGET, TABLE_NAMES,
  IDS, STREAMS, STATUS_BYTES, snapshot, publication, initialPublished, stop, finish,
  queued, failedLimit, seedInventory, expectedInventoryHash, seedStreams,
  expectedFrontierHash, expectedEncodedStatusBytes, coldCurrent, sandboxFile, database,
} = require('../helpers/health-connect-source-index-limits-fixture.cjs');

test('fresh paired instance with no saved native history returns empty status without derived initialisation',
  { timeout: 20000 }, async () => {
    const data = await fixture();
    try {
      const before = snapshot(data);
      assert.equal(before.schema.some(row => TABLE_NAMES.includes(row.name)), false);
      const response = await ownerStatus(data);
      noAuthority(response.body, data);
      assert.equal(response.status, 200);
      assert.deepEqual(response.json, { target: TARGET, sources: [] });
      assert.deepEqual(snapshot(data), before);
      assert.equal(snapshot(data).schema.some(row => TABLE_NAMES.includes(row.name)), false);
    } finally { await finish(data); }
  });

for (const defect of ['absent-retained-catalogue', 'partial-derived-schema',
  'partial-native-schema']) {
  test(`${defect} returns unavailable without creating or repairing saved state`,
    { timeout: 25000 }, async () => {
      const data = await fixture();
      try {
        await initialPublished(data);
        await stop(data);
        const catalogue = sandboxFile(data, 'credentials', 'health-connect-policy.json');
        if (defect === 'absent-retained-catalogue') {
          assert.equal(fs.existsSync(catalogue), true);
          fs.unlinkSync(catalogue);
          assert.equal(fs.existsSync(catalogue), false);
        } else {
          database(data, false, db => db.exec(defect === 'partial-derived-schema' ?
            'DROP TABLE health_source_index_frontiers' : 'DROP TABLE health_projection_outbox'));
        }
        const before = snapshot(data);
        await restart(data);
        assert.deepEqual(snapshot(data), before);
        for (const request of [() => ownerStatus(data), () => ownerRebuild(data)]) {
          const response = await request();
          noAuthority(response.body, data);
          assert.equal(response.status, defect === 'absent-retained-catalogue' ? 409 : 503);
          assert.equal(response.json.code, defect === 'absent-retained-catalogue' ?
            'IMPORT_SOURCE_POLICY_UNKNOWN' : 'storage-unavailable');
          assert.deepEqual(snapshot(data), before);
          if (defect === 'absent-retained-catalogue') {
            assert.equal(fs.existsSync(catalogue), false, 'missing catalogue stays absent');
          } else {
            assert.equal(snapshot(data).schema.some(row => row.name ===
              (defect === 'partial-derived-schema' ?
                'health_source_index_frontiers' : 'health_projection_outbox')), false);
          }
        }
      } finally { await finish(data); }
    });
}
