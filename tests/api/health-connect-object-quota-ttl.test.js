// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture, pair, restart, close, post, failure, stage, finalise,
  coldReadNative, coldReadObjects, makeObject, noAuthority, BASE, PART, TYPE, req, product } =
  require('../helpers/health-connect-object-test-fixture.cjs');
const A = 1049872;
const P = 524288;
const DAY = 86400000;
const HOUR = 3600000;
const CLOCK_BASE = 1800000000000;
const savedHistory = snapshot => {
  const { logicalNativeDump, ...history } = snapshot;
  return history; // Diagnostic dump also includes intentionally cleaned staging BLOBs.
};
async function scopedClock(data) {
  data.clockPath = path.join(data.home, 'object-clock-control.json');
  data.observationPath = path.join(data.home, 'object-clock-observations.jsonl');
  data.clock = { now: CLOCK_BASE, tick: 0 };
  data.clockRevision = 0;
  fs.writeFileSync(data.clockPath, JSON.stringify(data.clock), { mode: 0o600 });
  const preload = path.join(__dirname, '../helpers/health-connect-object-clock-preload.cjs')
    .replaceAll('\\', '/');
  await restart(data, { ...data.extraEnv, NODE_OPTIONS: `--require "${preload}"`,
    INDEPENDENT_OBJECT_PRODUCT_ROOT: product,
    INDEPENDENT_OBJECT_CLOCK_CONTROL: data.clockPath,
    INDEPENDENT_OBJECT_CLOCK_OBSERVATIONS: data.observationPath });
}
function events(data) {
  const text = fs.existsSync(data.observationPath) ?
    fs.readFileSync(data.observationPath, 'utf8') : '';
  const completed = text.slice(0, text.lastIndexOf('\n') + 1);
  return completed.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}
function clock(data, now, trigger = false, freeze) {
  data.clock = { now, tick: data.clock.tick + (trigger ? 1 : 0),
    ...(freeze === undefined ? {} : { freeze }) };
  const revision = ++data.clockRevision;
  assert.ok(revision > 0 && revision < 32, 'bounded synthetic clock publications');
  const target = data.clockPath + `.revision-${String(revision).padStart(4, '0')}.json`;
  const next = target + '.next';
  assert.equal(path.dirname(target), data.home);
  assert.equal(path.dirname(next), data.home);
  assert.equal(fs.existsSync(target), false, 'published clock revisions are immutable');
  fs.writeFileSync(next, JSON.stringify(data.clock), { mode: 0o600, flag: 'wx' });
  fs.renameSync(next, target);
}
async function completedSweep(data, tick) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const observed = events(data);
    assert.equal(observed.some(event => event.kind === 'registered-sweep-failed'), false);
    if (observed.some(event => event.kind === 'registered-sweep-complete' && event.tick === tick)) {
      assert.ok(observed.some(event => event.kind === 'registered-sweep' && event.delay === 300000));
      assert.ok(observed.some(event => event.kind === 'registered-sweep-fired' &&
        event.tick === tick && event.delay === 300000));
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('actual registered cleanup callback did not complete within bounded time');
}
function objectSnapshot(snapshot, object) {
  const actual = snapshot.objects.find(row => row.declaration.objectId === object.header.objectId);
  assert.ok(actual);
  assert.deepEqual(actual.declaration, object.header);
  assert.equal(actual.reservationBytes, A);
  assert.deepEqual(actual.parts, [object.manifest[0]]);
  assert.equal(actual.expiresAt - actual.createdAt, DAY);
  return actual;
}
async function advertisedBound(data, expected) {
  const response = await req(data.server.baseUrl, `${BASE}/v1/capabilities`, { headers: data.headers });
  assert.equal(response.status, 200);
  assert.equal(response.json.limits.maxObjectBytes, expected);
  assert.equal(response.json.limits.maxBytes, 1048576);
}
test('empty configured cap is an intrinsic inclusive object bound; exact-cap duplicate/restart never double-reserves',
  async () => {
    for (const [cap, status] of [[1049871, 400], [1049872, 200]]) {
      const data = await fixture({ HEALTH_CONNECT_STAGING_MAX_BYTES: String(cap) });
      try {
        await advertisedBound(data, cap);
        const object = makeObject(data.binding);
        assert.equal(object.header.totalBytes, A);
        const nativeBefore = coldReadNative(data.home);
        const before = coldReadObjects(data.home);
        if (status === 400) {
          failure(await post(data, PART, object.partFrames[0]), 400, 'limit-exceeded', data);
          assert.deepEqual(coldReadObjects(data.home), before);
          assert.deepEqual(coldReadNative(data.home), nativeBefore);
        } else {
          await stage(data, object, [0]);
          const accepted = coldReadObjects(data.home);
          assert.equal(accepted.aggregateReservedBytes, A);
          assert.equal(accepted.physicalPayloadBytes, P);
          assert.equal(accepted.physicalPartCount, 1);
          objectSnapshot(accepted, object);
          await restart(data);
          await stage(data, object, [0]);
          assert.deepEqual(coldReadObjects(data.home), accepted);
          assert.deepEqual(savedHistory(coldReadNative(data.home)), savedHistory(nativeBefore));
        }
      } finally { await close(data); }
    }
  });
test('distinct-stream declared reservations enforce one-byte occupied shortage and accept the exact inclusive aggregate cap',
  async () => {
    for (const [cap, secondStatus] of [[2099743, 503], [2099744, 200]]) {
      const data = await fixture({ HEALTH_CONNECT_STAGING_MAX_BYTES: String(cap) });
      try {
        const second = await pair(data);
        assert.notEqual(second.binding.sourceStoreId, data.binding.sourceStoreId);
        const firstObject = makeObject(data.binding, { objectId: 'quota-first' });
        const secondObject = makeObject(second.binding, { objectId: 'quota-second' });
        assert.equal(firstObject.header.totalBytes, A);
        assert.equal(secondObject.header.totalBytes, A);
        await stage(data, firstObject, [0]);
        const before = coldReadObjects(data.home);
        const nativeBefore = coldReadNative(data.home);
        assert.equal(before.aggregateReservedBytes, A);
        if (secondStatus === 503) {
          failure(await post(data, PART, secondObject.partFrames[0], second.headers),
            503, 'storage-unavailable', data);
          assert.deepEqual(coldReadObjects(data.home), before);
          assert.deepEqual(coldReadNative(data.home), nativeBefore);
          assert.ok(P * 2 < cap, 'physical bytes fit; independent declared reservation totals do not');
        } else {
          await stage(data, secondObject, [0], second.headers);
          const after = coldReadObjects(data.home);
          assert.equal(after.objects.length, 2);
          assert.equal(after.aggregateReservedBytes, 2099744);
          assert.equal(after.physicalPayloadBytes, 1048576);
          assert.equal(after.physicalPartCount, 2);
          objectSnapshot(after, firstObject);
          objectSnapshot(after, secondObject);
          assert.deepEqual(savedHistory(coldReadNative(data.home)), savedHistory(nativeBefore));
        }
      } finally { await close(data); }
    }
  });
async function expiryFixture() {
  const data = await fixture({ HEALTH_CONNECT_STAGING_MAX_BYTES: '2099744' });
  try {
    await scopedClock(data);
    const second = await pair(data);
    const committed = await pair(data);
    const replacement = await pair(data);
    const committedObject = makeObject(committed.binding,
      { objectId: 'ttl-committed', batchId: 'ttl-committed-batch', paddingCount: 128 });
    await stage(data, committedObject, undefined, committed.headers);
    await finalise(data, committedObject, committed.headers);
    const firstObject = makeObject(data.binding, { objectId: 'ttl-first' });
    await stage(data, firstObject, [0]);
    const first = objectSnapshot(coldReadObjects(data.home), firstObject);
    assert.equal(first.createdAt, CLOCK_BASE, 'staging source alone receives the fixed synthetic clock');
    assert.equal(first.expiresAt, CLOCK_BASE + DAY);
    clock(data, CLOCK_BASE + HOUR);
    const secondObject = makeObject(second.binding, { objectId: 'ttl-second' });
    await stage(data, secondObject, [0], second.headers);
    const secondSnapshot = objectSnapshot(coldReadObjects(data.home), secondObject);
    assert.equal(secondSnapshot.createdAt, CLOCK_BASE + HOUR);
    return Object.assign(data, { second, replacement, committedObject,
      firstObject, secondObject, firstStage: first, secondStage: secondSnapshot,
      saved: savedHistory(coldReadNative(data.home)),
      compact: coldReadObjects(data.home).committedDeclarations });
  } catch (error) { await close(data); throw error; }
}
function preservedAfterExpiry(data, snapshot) {
  assert.equal(snapshot.objects.length, 1);
  assert.deepEqual(snapshot.objects[0], data.secondStage);
  assert.equal(snapshot.aggregateReservedBytes, A);
  assert.equal(snapshot.physicalPartCount, 1);
  assert.equal(snapshot.physicalPayloadBytes, P);
  assert.deepEqual(snapshot.committedDeclarations, data.compact);
  assert.deepEqual(savedHistory(coldReadNative(data.home)), data.saved);
  noAuthority(snapshot.compactText, data);
}
test('actual five-minute registered sweep respects import freeze then expires the absolute duplicate-unextended stage only',
  async () => {
    const data = await expiryFixture();
    try {
      clock(data, CLOCK_BASE + DAY - 1);
      await stage(data, data.firstObject, [0]);
      assert.deepEqual(objectSnapshot(coldReadObjects(data.home), data.firstObject), data.firstStage);
      const beforeFreeze = coldReadObjects(data.home);
      clock(data, CLOCK_BASE + DAY, true, true);
      await completedSweep(data, 1);
      assert.ok(events(data).some(event => event.kind === 'test-freeze-engaged'));
      assert.deepEqual(coldReadObjects(data.home), beforeFreeze,
        'healthy timer must not delete stage BLOBs during actual import freeze');
      clock(data, CLOCK_BASE + DAY, true, false);
      await completedSweep(data, 2);
      assert.ok(events(data).some(event => event.kind === 'test-freeze-released'));
      preservedAfterExpiry(data, coldReadObjects(data.home));
    } finally { await close(data); }
  });
test('startup cleanup removes expired physical BLOB/reservation and preserves unexpired other stream and committed history',
  async () => {
    const data = await expiryFixture();
    try {
      await data.server.kill(); data.server = null;
      clock(data, CLOCK_BASE + DAY);
      await restart(data);
      // spawnServer observes the listener announcement, before awaited data-plane
      // boot settles. This read-only API waits for the actual boot gate; it does
      // not run staging admission or the object expiry writer itself.
      await advertisedBound(data, 2099744);
      preservedAfterExpiry(data, coldReadObjects(data.home));
    } finally { await close(data); }
  });
test('pre-admission expiry releases reservation before admitting an unchanged eligible other stream at the exact budget',
  async () => {
    const data = await expiryFixture();
    try {
      const replacementObject = makeObject(data.replacement.binding, { objectId: 'ttl-replacement' });
      const blockedBefore = coldReadObjects(data.home);
      failure(await post(data, PART, replacementObject.partFrames[0], data.replacement.headers),
        503, 'storage-unavailable', data);
      assert.deepEqual(coldReadObjects(data.home), blockedBefore);
      clock(data, CLOCK_BASE + DAY);
      await stage(data, replacementObject, [0], data.replacement.headers);
      const after = coldReadObjects(data.home);
      assert.equal(after.objects.length, 2);
      assert.equal(after.aggregateReservedBytes, 2099744);
      assert.equal(after.physicalPartCount, 2);
      assert.equal(after.physicalPayloadBytes, 1048576);
      assert.equal(after.objects.some(row => row.declaration.objectId === 'ttl-first'), false);
      assert.deepEqual(objectSnapshot(after, data.secondObject), data.secondStage);
      assert.equal(objectSnapshot(after, replacementObject).createdAt, CLOCK_BASE + DAY);
      assert.deepEqual(after.committedDeclarations, data.compact);
      assert.deepEqual(savedHistory(coldReadNative(data.home)), data.saved);
    } finally { await close(data); }
  });
