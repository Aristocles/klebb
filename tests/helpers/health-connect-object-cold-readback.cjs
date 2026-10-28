// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Independent cold SQLite reader. No product parser/cache/storage imports.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const sha = bytes => 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex');
const names = ['health_object_staging', 'health_object_parts', 'health_object_receipts'];
const json = text => {
  assert.equal(typeof text, 'string', 'persisted object metadata is original JSON text');
  return JSON.parse(text);
};
function key(declaration) {
  const binding = declaration.binding;
  assert.ok(binding && typeof binding === 'object');
  return JSON.stringify([binding.tenantId, binding.instanceId, binding.sourceStoreId,
    binding.installationId, declaration.recordType, binding.generation, binding.restoreEpoch]);
}
function coldReadObjects(home) {
  const absolute = path.resolve(home);
  assert.ok(absolute.startsWith(path.resolve(os.tmpdir()) + path.sep) &&
    path.basename(absolute).startsWith('eh-test-'), 'cold reader requires its synthetic sandbox');
  const filename = path.join(absolute, 'db', 'klebb.db');
  assert.ok(fs.statSync(filename).isFile(), 'never create a missing cold database');
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=5000');
    db.exec('BEGIN');
    const found = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND "
      + "name IN ('health_object_staging','health_object_parts','health_object_receipts')")
      .all().map(row => row.name);
    if (found.length === 0) {
      db.exec('COMMIT');
      return { objects: [], committedDeclarations: [], aggregateReservedBytes: 0,
        physicalPartCount: 0, physicalPayloadBytes: 0,
        partDigestEvidence: [], compactText: '{}' };
    }
    assert.equal(found.length, 3, 'a partial object schema cannot be reported as empty staging');
    for (const name of names) assert.ok(found.includes(name));
    const staging = db.prepare('SELECT * FROM health_object_staging ORDER BY stream_key').all();
    const parts = db.prepare('SELECT * FROM health_object_parts ORDER BY stream_key, part_index').all();
    const receipts = db.prepare('SELECT * FROM health_object_receipts '
      + 'ORDER BY stream_key, length(sequence), sequence').all();
    const physical = parts.map(row => {
      assert.ok(row.part_bytes instanceof Uint8Array,
        'each physically persisted part is an actual SQLite BLOB');
      assert.ok(Number.isSafeInteger(row.part_index) && row.part_index >= 0);
      const bytes = Buffer.from(row.part_bytes);
      return { streamKey: row.stream_key, index: row.part_index, bytes: bytes.length,
        digest: sha(bytes), storedDigest: row.part_digest };
    });
    for (const part of physical) {
      assert.ok(staging.some(row => row.stream_key === part.streamKey),
        'an orphan physical BLOB cannot disappear from the cold result');
      assert.ok(part.bytes > 0);
    }
    const objects = staging.map(row => {
      const declaration = json(row.declaration_json);
      assert.equal(key(declaration), row.stream_key, 'physical stage belongs to its declared stream');
      for (const field of ['created_at', 'expires_at', 'reservation_bytes']) {
        assert.ok(Number.isSafeInteger(row[field]), 'persisted timestamps/capacity retain exact integers');
      }
      assert.ok(row.reservation_bytes > 0);
      return { declaration, createdAt: row.created_at, expiresAt: row.expires_at,
        reservationBytes: row.reservation_bytes,
        parts: physical.filter(part => part.streamKey === row.stream_key)
          .map(({ index, bytes, digest }) => ({ index, bytes, digest })) };
    });
    const committedDeclarations = receipts.map(row => {
      const declaration = json(row.declaration_json);
      assert.equal(key(declaration), row.stream_key);
      assert.equal(declaration.sequence, row.sequence);
      assert.equal(declaration.batchId, row.batch_id);
      return { declaration, parts: json(row.parts_json) };
    });
    const aggregateReservedBytes = staging.reduce((sum, row) => sum + row.reservation_bytes, 0);
    const physicalPayloadBytes = physical.reduce((sum, part) => sum + part.bytes, 0);
    assert.ok(Number.isSafeInteger(aggregateReservedBytes));
    assert.ok(Number.isSafeInteger(physicalPayloadBytes));
    // Read metadata independently, retaining any unexpected metadata columns for
    // credential assertions while deliberately excluding the raw BLOB archive.
    const compactParts = parts.map(row => {
      const { part_bytes, ...metadata } = row;
      return metadata;
    });
    const compactText = JSON.stringify({ staging, parts: compactParts, receipts });
    const result = { objects, committedDeclarations, aggregateReservedBytes,
      physicalPartCount: physical.length, physicalPayloadBytes,
      partDigestEvidence: physical.map(part => ({ streamKey: part.streamKey, index: part.index,
        storedDigest: part.storedDigest, observedDigest: part.digest,
        matches: part.storedDigest === part.digest })),
      compactText };
    db.exec('COMMIT');
    return result;
  } finally { db.close(); }
}
module.exports = { coldReadObjects };
