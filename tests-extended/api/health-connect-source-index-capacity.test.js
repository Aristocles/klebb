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
} = require('../../tests/helpers/health-connect-source-index-limits-fixture.cjs');

test('inclusive 100000 typed identities publish; 100001 separately fails without losing history or prior target',
  { timeout: 90000 }, async () => {
    const data = await fixture();
    try {
      await initialPublished(data);
      await stop(data);
      seedInventory(data, 3, IDS);
      const seeded = snapshot(data);
      assert.equal(seeded.records, 99999);
      assert.equal(seeded.tombstones, 1);
      assert.equal(seeded.tables.health_batch_receipts.count, 1);
      assert.equal(seeded.tables.health_projection_outbox.count, 1);
      await restart(data);
      // The explicit fixture changes source rows without claiming another native ACK.
      await queued(data);
      const complete = await coldCurrent(data, IDS, 1, expectedInventoryHash(data, IDS),
        expectedFrontierHash(data, 1));
      assert.equal(complete.nativeHash, seeded.nativeHash);
      assert.deepEqual(complete.legacy, seeded.legacy);
      const visible = await ownerStatus(data);
      noAuthority(visible.body, data);
      assert.equal(visible.status, 200);
      assert.equal(visible.json.sources[0].saved.records, 99999);
      assert.equal(visible.json.sources[0].saved.tombstones, 1);
      assert.equal(visible.json.sources[0].published.records, 99999);
      assert.equal(visible.json.sources[0].published.tombstones, 1);
      assert.equal(visible.json.sources[0].state, 'current');

      await stop(data);
      seedInventory(data, IDS, IDS + 1);
      const over = snapshot(data);
      assert.equal(over.records, 100000);
      assert.equal(over.tombstones, 1);
      assert.deepEqual(publication(over), publication(complete));
      await restart(data);
      await queued(data);
      const failed = await failedLimit(data);
      assert.equal(failed.json.sources[0].saved.records, 100000);
      assert.equal(failed.json.sources[0].saved.tombstones, 1);
      assert.equal(failed.json.sources[0].published.records, 99999);
      const after = snapshot(data);
      assert.equal(after.nativeHash, over.nativeHash);
      assert.deepEqual(publication(after), publication(complete));
    } finally { await finish(data); }
  });

test('inclusive 1000 complete streams publish; 1001 is failed with null incomplete saved vector',
  { timeout: 45000 }, async () => {
    const data = await fixture();
    try {
      await initialPublished(data);
      await stop(data);
      seedStreams(data, 1, STREAMS);
      const seeded = snapshot(data);
      assert.equal(seeded.streams, 1000);
      assert.equal(seeded.tables.health_batch_receipts.count, 1000);
      assert.equal(seeded.tables.health_projection_outbox.count, 1000);
      assert.ok(expectedEncodedStatusBytes(data, STREAMS) <= STATUS_BYTES);
      await restart(data);
      const complete = await coldCurrent(data, 3, STREAMS, expectedInventoryHash(data, 3),
        expectedFrontierHash(data, STREAMS));
      assert.equal(complete.nativeHash, seeded.nativeHash);
      const status = await ownerStatus(data);
      noAuthority(status.body, data);
      assert.equal(status.status, 200);
      assert.equal(status.json.sources[0].saved.streams, 1000);
      assert.equal(status.json.sources[0].saved.complete, true);
      assert.equal(status.json.sources[0].saved.frontiers.length, 1000);
      assert.equal(status.json.sources[0].published.frontiers.length, 1000);

      await stop(data);
      seedStreams(data, STREAMS, STREAMS + 1);
      const over = snapshot(data);
      assert.equal(over.streams, 1001);
      await restart(data);
      const failed = await failedLimit(data);
      assert.equal(failed.json.sources[0].saved.streams, 1001);
      assert.equal(failed.json.sources[0].saved.complete, false);
      assert.equal(failed.json.sources[0].saved.frontiers, null);
      assert.equal(failed.json.sources[0].published.frontiers.length, 1000);
      const after = snapshot(data);
      assert.equal(after.nativeHash, over.nativeHash);
      assert.deepEqual(publication(after), publication(complete));
    } finally { await finish(data); }
  });

test('1000 valid long stream bindings exceed the status byte budget and refuse status/rebuild before effects',
  { timeout: 45000 }, async () => {
    const healthyClock = require('../../tests/fixtures/health-connect/fixed-child-clock-inputs-v1.json').base;
    const clockPreload = path.resolve(__dirname, '../../tests/helpers/health-connect-fixed-child-clock-preload.cjs');
    const clockEnv = {
      NODE_OPTIONS: `--require=${JSON.stringify(clockPreload)}`,
      INDEPENDENT_FIXED_CHILD_CLOCK: String(healthyClock.milliseconds),
    };
    const data = await fixture(clockEnv, healthyClock.milliseconds);
    try {
      await initialPublished(data, healthyClock.milliseconds);
      await stop(data);
      seedStreams(data, 1, STREAMS, true);
      const seeded = snapshot(data);
      assert.equal(seeded.streams, 1000);
      const expectedBytes = expectedEncodedStatusBytes(data, STREAMS, true);
      assert.ok(expectedBytes > 1048576, 'independent exact approved status layout exceeds 1 MiB');
      await restart(data);
      const current = await coldCurrent(data, 3, STREAMS, expectedInventoryHash(data, 3),
        expectedFrontierHash(data, STREAMS, true));
      assert.equal(current.nativeHash, seeded.nativeHash);
      for (const request of [() => ownerStatus(data), () => ownerRebuild(data)]) {
        const before = snapshot(data);
        const response = await request();
        noAuthority(response.body, data);
        assert.equal(response.status, 413);
        assert.equal(response.json.target, TARGET);
        assert.equal(response.json.code, 'limit-exceeded');
        assert.equal(response.json.retryable, false);
        assert.ok(Buffer.byteLength(response.body, 'utf8') <= STATUS_BYTES);
        assert.deepEqual(snapshot(data), before, 'each overflow refusal queues no work');
      }
    } finally { await finish(data); }
  });
