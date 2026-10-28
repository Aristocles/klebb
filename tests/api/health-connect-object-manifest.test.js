// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { fixture, close, post, failure, stage, finalise, makeObject,
  coldReadNative, coldReadObjects, committedNative, purgedWithReceipt, FINAL } =
  require('../helpers/health-connect-object-test-fixture.cjs');

test('valid dense caller manifest with changed part sizes conflicts without altering intact physical bytes or history',
  async () => {
    const data = await fixture();
    try {
      const object = makeObject(data.binding);
      await stage(data, object);
      const nativeBefore = coldReadNative(data.home);
      const objectsBefore = coldReadObjects(data.home);
      assert.ok(objectsBefore.partDigestEvidence.every(part => part.matches));
      assert.deepEqual(objectsBefore.objects[0].parts.map(part => part.bytes),
        [524288, 524288, 1296]);
      const changed = structuredClone(object.finalise);
      changed.parts[0].bytes = 524287;
      changed.parts[1].bytes = 524289;
      assert.equal(changed.parts.reduce((sum, part) => sum + part.bytes, 0), 1049872);
      assert.deepEqual(changed.parts.map(part => part.index), [0, 1, 2]);
      assert.deepEqual(changed.parts.map(part => part.digest),
        object.manifest.map(part => part.digest));
      failure(await post(data, FINAL, changed), 409, 'conflict', data);
      assert.deepEqual(coldReadNative(data.home), nativeBefore);
      assert.deepEqual(coldReadObjects(data.home), objectsBefore);
      await finalise(data, object);
      committedNative(data, object);
      purgedWithReceipt(data, object);
    } finally { await close(data); }
  });

test('actual saved BLOB truncation remains storage failure with unchanged corrupt bytes and no native effects',
  async () => {
    const data = await fixture();
    let writer;
    try {
      const object = makeObject(data.binding);
      await stage(data, object);
      writer = new DatabaseSync(path.join(data.home, 'db', 'klebb.db'));
      const row = writer.prepare('SELECT stream_key, part_bytes FROM health_object_parts WHERE part_index=0')
        .get();
      assert.equal(row.part_bytes.length, 524288);
      const truncated = Buffer.from(row.part_bytes).subarray(0, 524287);
      writer.prepare('UPDATE health_object_parts SET part_bytes=? WHERE stream_key=? AND part_index=0')
        .run(truncated, row.stream_key);
      writer.close(); writer = null;
      const nativeBefore = coldReadNative(data.home);
      const corrupted = coldReadObjects(data.home);
      assert.equal(corrupted.objects[0].parts[0].bytes, 524287);
      assert.equal(corrupted.partDigestEvidence[0].matches, false);
      assert.equal(corrupted.partDigestEvidence[0].storedDigest, object.manifest[0].digest);
      failure(await post(data, FINAL, object.finalise), 503, 'storage-unavailable', data);
      assert.deepEqual(coldReadNative(data.home), nativeBefore);
      assert.deepEqual(coldReadObjects(data.home), corrupted);
    } finally { if (writer) writer.close(); await close(data); }
  });
