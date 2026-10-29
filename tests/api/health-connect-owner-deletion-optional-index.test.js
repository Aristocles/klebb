// SPDX-License-Identifier: AGPL-3.0-only
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const O = require('../helpers/health-connect-owner-deletion-fixture.cjs');
const { F } = O;

function removeOptionalIndex(data) {
  // Disclosed synthetic storage control after real workers have published.
  // A restart would make the existing worker recreate this optional component.
  // Keep the live server and take all refusal snapshots after this control.
  const filename = path.join(data.home, 'db', 'klebb.db');
  assert.equal(fs.lstatSync(filename).isFile(), true);
  const db = new DatabaseSync(filename);
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; BEGIN IMMEDIATE');
    for (const name of [
      'health_source_index_frontiers', 'health_source_index', 'health_source_index_state',
    ]) {
      assert.ok(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name));
      db.exec(`DROP TABLE ${name}`);
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  } finally { db.close(); }
}

test('U14 absent optional index permits readonly preview but refuses stream deletion without repair',
  { timeout: 60000 }, async () => {
    const data = await O.fixture();
    try {
      const identities = O.selected();
      const original = O.expected(data, data.beta, identities);
      removeOptionalIndex(data);
      const before = F.coldRead(data.home);
      assert.equal(before.derived.schema.length, 0);
      const expected = O.expected(data, data.beta, identities, before);
      assert.equal(expected.content.digest, original.content.digest,
        'derived publication state is not a revision input');
      O.assertPreview(await O.preview(data, data.beta, identities), expected, data);
      assert.deepEqual(F.coldRead(data.home), before);
      await O.stableFailure(data, () =>
        O.apply(data, data.beta, identities, expected.content.digest), 503, 'storage-unavailable');
    } finally { await F.close(data); }
  });

test('U14 zero-stream owner suppression leaves an absent optional index absent',
  { timeout: 60000 }, async () => {
    const data = await O.fixture();
    try {
      const zero = await O.pair(data, 'optional-zero', F.TYPES);
      const identities = O.selected('owner-optional-zero');
      removeOptionalIndex(data);
      const before = F.coldRead(data.home);
      assert.equal(before.derived.schema.length, 0);
      const expected = O.expected(data, zero, identities, before);
      assert.deepEqual(expected.preview.effects, {
        newlyUserSuppressed: 1, removedRecords: 0, removedStagedObjects: 0,
        removedParts: 0, removedPartBytes: 0,
      });
      O.assertPreview(await O.preview(data, zero, identities), expected, data);
      assert.deepEqual(F.coldRead(data.home), before);
      O.assertApply(await O.apply(data, zero, identities, expected.content.digest), expected, data, false);
      const after = F.coldRead(data.home);
      O.assertUserEffect(before, after, zero, F.TYPE, 'owner-optional-zero', null);
      O.assertReferences(before, after);
      assert.deepEqual(after.derived, before.derived);
    } finally { await F.close(data); }
  });
