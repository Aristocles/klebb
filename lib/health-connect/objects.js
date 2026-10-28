// SPDX-License-Identifier: AGPL-3.0-only
'use strict';

const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { DB_FILE } = require('../../config/paths');
const ENV = require('../../config/env');
const { HARD_LIMITS, decodeMessage, decodeAssembledPayload } = require('./protocol');
const { HistoryError, streamKey, frontier, withHistoryTransaction,
  commitBatchInTransaction } = require('./history');
const OBJECT_LIMITS = Object.freeze({ ...HARD_LIMITS,
  maxObjectBytes: Math.min(HARD_LIMITS.maxObjectBytes, ENV.HEALTH_CONNECT_STAGING_MAX_BYTES) });
const TTL = 86400000;
const SWEEP_INTERVAL = 300000;
const { objectTables: tables } = require('./schema');
const refuse = (status, code) => { throw new HistoryError(status, code); };
const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
// Metadata compares values, independent of JSON member order. The actual
// reconstructed payload and its digest always retain the original exact bytes.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const declaration = frame => Object.fromEntries(['binding', 'recordType', 'batchId',
  'sequence', 'identity', 'objectId', 'objectDigest', 'partCount', 'totalBytes']
  .map(key => [key, frame[key]]));
function schema(db, create = true) {
  const found = db.prepare("SELECT name, sql FROM sqlite_schema WHERE type='table' "
    + "AND name GLOB 'health_object_*'").all();
  if (!found.length) {
    if (!create) return false;
    for (const sql of Object.values(tables)) db.exec(sql);
    db.exec('CREATE INDEX health_object_expiry ON health_object_staging (expires_at)');
  } else {
    for (const [name, sql] of Object.entries(tables)) {
      if (found.find(row => row.name === name)?.sql !== sql) refuse(503, 'storage-unavailable');
    }
  }
  return true;
}
function expire(db) {
  db.prepare('DELETE FROM health_object_staging WHERE expires_at <= ?').run(Date.now());
}
function eligible(db, frame, key) {
  const acknowledged = frontier(db, key, frame.binding, frame.recordType);
  const used = db.prepare('SELECT sequence FROM health_batch_receipts WHERE stream_key = ? '
    + 'AND (sequence = ? OR batch_id = ?)').get(key, frame.sequence, frame.batchId);
  if (used || BigInt(frame.sequence) <= BigInt(acknowledged)) refuse(409, 'conflict');
  if (BigInt(frame.sequence) !== BigInt(acknowledged) + 1n) refuse(409, 'sequence-gap');
}
function original(db, frame, key) {
  const rows = db.prepare('SELECT * FROM health_object_receipts WHERE stream_key = ? '
    + 'AND (sequence = ? OR batch_id = ?)').all(key, frame.sequence, frame.batchId);
  if (!rows.length) return null;
  if (rows.length !== 1) refuse(409, 'conflict');
  const row = rows[0];
  let saved;
  try {
    if (Buffer.byteLength(row.declaration_json) > 16384 ||
        Buffer.byteLength(row.parts_json) > 32768) refuse(503, 'storage-unavailable');
    saved = decodeMessage(JSON.stringify({ version: 1, kind: 'object-finalise',
      ...JSON.parse(row.declaration_json), parts: JSON.parse(row.parts_json) }),
    { binding: frame.binding, categories: [frame.recordType] });
  } catch { refuse(503, 'storage-unavailable'); }
  if (row.sequence !== saved.sequence || row.batch_id !== saved.batchId) {
    refuse(503, 'storage-unavailable');
  }
  if (!same(declaration(saved), declaration(frame))) refuse(409, 'conflict');
  if (frame.kind === 'object-finalise' && !same(saved.parts, frame.parts)) refuse(409, 'conflict');
  if (frame.kind === 'object-part') {
    const part = saved.parts[frame.partIndex];
    if (part.digest !== frame.partDigest ||
        part.bytes !== Buffer.from(frame.partBase64, 'base64').length) refuse(409, 'conflict');
  }
  const acknowledged = frontier(db, key, frame.binding, frame.recordType);
  const batch = db.prepare('SELECT * FROM health_batch_receipts WHERE stream_key = ? AND sequence = ?')
    .get(key, frame.sequence);
  let receipt;
  try {
    receipt = decodeMessage(batch?.receipt_json, { binding: frame.binding, categories: [frame.recordType] });
  } catch { refuse(503, 'storage-unavailable'); }
  if (receipt.kind !== 'durable-receipt' || receipt.recordType !== frame.recordType ||
      receipt.sequence !== frame.sequence || receipt.batchId !== frame.batchId ||
      receipt.payloadDigest !== frame.objectDigest || batch.batch_id !== frame.batchId ||
      batch.payload_digest !== frame.objectDigest ||
      BigInt(acknowledged) < BigInt(frame.sequence)) refuse(503, 'storage-unavailable');
  return receipt;
}
function partReceipt(frame) {
  return { version: 1, kind: 'object-part-receipt', ...declaration(frame),
    partIndex: frame.partIndex, partDigest: frame.partDigest,
    partBytes: Buffer.from(frame.partBase64, 'base64').length };
}
function stagePart(frame) {
  return withHistoryTransaction(db => {
    schema(db);
    const key = streamKey(frame.binding, frame.recordType);
    if (original(db, frame, key)) return partReceipt(frame);
    expire(db);
    eligible(db, frame, key);
    const header = declaration(frame);
    const text = JSON.stringify(header);
    let staged = db.prepare('SELECT * FROM health_object_staging WHERE stream_key = ?').get(key);
    if (staged && !same(JSON.parse(staged.declaration_json), header)) refuse(409, 'conflict');
    if (!staged) {
      const reserved = db.prepare('SELECT coalesce(sum(reservation_bytes), 0) AS bytes '
        + 'FROM health_object_staging').get().bytes;
      if (!Number.isSafeInteger(reserved) || reserved < 0) refuse(503, 'storage-unavailable');
      if (reserved + frame.totalBytes > ENV.HEALTH_CONNECT_STAGING_MAX_BYTES) {
        refuse(503, 'storage-unavailable');
      }
      const now = Date.now();
      db.prepare('INSERT INTO health_object_staging '
        + '(stream_key, declaration_json, created_at, expires_at, reservation_bytes) VALUES (?, ?, ?, ?, ?)')
        .run(key, text, now, now + TTL, frame.totalBytes);
      staged = { created_at: now, expires_at: now + TTL, reservation_bytes: frame.totalBytes };
    }
    if (staged.reservation_bytes !== frame.totalBytes ||
        !Number.isSafeInteger(staged.created_at) || staged.expires_at !== staged.created_at + TTL) {
      refuse(503, 'storage-unavailable');
    }
    const bytes = Buffer.from(frame.partBase64, 'base64');
    const existing = db.prepare('SELECT length(part_bytes) AS bytes, part_digest FROM health_object_parts '
      + 'WHERE stream_key = ? AND part_index = ?').get(key, frame.partIndex);
    if (existing) {
      if (!Number.isSafeInteger(existing.bytes) || existing.bytes < 1 ||
          existing.bytes > HARD_LIMITS.maxBytes || existing.bytes > frame.totalBytes) {
        refuse(503, 'storage-unavailable');
      }
      const stored = db.prepare('SELECT part_bytes FROM health_object_parts WHERE stream_key = ? '
        + 'AND part_index = ?').get(key, frame.partIndex).part_bytes;
      if (sha(stored) !== existing.part_digest) refuse(503, 'storage-unavailable');
      if (existing.part_digest !== frame.partDigest || !Buffer.from(stored).equals(bytes)) {
        refuse(409, 'conflict');
      }
    } else {
      const storedBytes = db.prepare('SELECT coalesce(sum(length(part_bytes)), 0) AS bytes '
        + 'FROM health_object_parts WHERE stream_key = ?').get(key).bytes;
      if (storedBytes + bytes.length > frame.totalBytes) refuse(409, 'conflict');
      db.prepare('INSERT INTO health_object_parts (stream_key, part_index, part_bytes, part_digest) '
        + 'VALUES (?, ?, ?, ?)').run(key, frame.partIndex, bytes, frame.partDigest);
    }
    const receipt = partReceipt(frame);
    decodeMessage(JSON.stringify(receipt), { binding: frame.binding, categories: [frame.recordType] });
    return receipt;
  });
}
function finaliseObject(frame) {
  return withHistoryTransaction(db => {
    schema(db);
    const key = streamKey(frame.binding, frame.recordType);
    const saved = original(db, frame, key);
    if (saved) return saved;
    expire(db);
    eligible(db, frame, key);
    const staged = db.prepare('SELECT * FROM health_object_staging WHERE stream_key = ?').get(key);
    if (!staged) refuse(409, 'missing-parts');
    if (!same(JSON.parse(staged.declaration_json), declaration(frame))) refuse(409, 'conflict');
    if (staged.reservation_bytes !== frame.totalBytes ||
        !Number.isSafeInteger(staged.created_at) || staged.expires_at !== staged.created_at + TTL) {
      refuse(503, 'storage-unavailable');
    }
    const sizes = db.prepare('SELECT part_index, length(part_bytes) AS bytes FROM health_object_parts '
      + 'WHERE stream_key = ? ORDER BY part_index').all(key);
    if (sizes.length < frame.partCount) refuse(409, 'missing-parts');
    if (sizes.length !== frame.partCount || sizes.some((part, index) =>
      part.part_index !== index || !Number.isSafeInteger(part.bytes) ||
      part.bytes < 1 || part.bytes > HARD_LIMITS.maxBytes)) {
      refuse(503, 'storage-unavailable');
    }
    for (const part of sizes) {
      if (part.bytes !== frame.parts[part.part_index].bytes) {
        const row = db.prepare('SELECT part_bytes, part_digest FROM health_object_parts '
          + 'WHERE stream_key = ? AND part_index = ?').get(key, part.part_index);
        if (sha(row.part_bytes) !== row.part_digest) refuse(503, 'storage-unavailable');
        refuse(409, 'conflict');
      }
    }
    // Materialise at most one declared object. Check real BLOB lengths before
    // allocating, then copy one bounded part at a time instead of loading all.
    const whole = Buffer.alloc(frame.totalBytes);
    let offset = 0;
    for (const part of frame.parts) {
      const row = db.prepare('SELECT part_bytes, part_digest FROM health_object_parts '
        + 'WHERE stream_key = ? AND part_index = ?').get(key, part.index);
      if (sha(row.part_bytes) !== row.part_digest) refuse(503, 'storage-unavailable');
      if (row.part_digest !== part.digest) refuse(409, 'conflict');
      whole.set(row.part_bytes, offset);
      offset += row.part_bytes.length;
    }
    if (offset !== frame.totalBytes) refuse(503, 'storage-unavailable');
    if (sha(whole) !== frame.objectDigest) refuse(400, 'digest-mismatch');
    const payload = decodeAssembledPayload(whole, declaration(frame), { binding: frame.binding,
      categories: [frame.recordType], limits: OBJECT_LIMITS });
    const receipt = commitBatchInTransaction(db, payload, frame.objectDigest);
    db.prepare('INSERT INTO health_object_receipts '
      + '(stream_key, sequence, batch_id, declaration_json, parts_json) VALUES (?, ?, ?, ?, ?)')
      .run(key, frame.sequence, frame.batchId, staged.declaration_json, JSON.stringify(frame.parts));
    db.prepare('DELETE FROM health_object_staging WHERE stream_key = ?').run(key);
    return receipt;
  });
}
let timer;
function sweep() {
  // Do not create a database or health tables merely because a timer fired.
  let db;
  try {
    if (!fs.statSync(DB_FILE).isFile()) refuse(503, 'storage-unavailable');
    db = new DatabaseSync(DB_FILE, { readOnly: true });
    db.exec('PRAGMA busy_timeout=5000');
    if (!schema(db, false)) return;
  } finally { if (db) db.close(); }
  withHistoryTransaction(writer => { schema(writer); expire(writer); });
}
function startObjectCleanup(isBlocked = () => false) {
  stopObjectCleanup();
  const run = () => {
    if (isBlocked()) return;
    try { sweep(); } catch { console.warn('[health-connect] object cleanup unavailable'); }
  };
  run();
  timer = setInterval(run, SWEEP_INTERVAL);
  timer.unref();
}
function stopObjectCleanup() {
  if (timer) clearInterval(timer);
  timer = undefined;
}
module.exports = { OBJECT_LIMITS, stagePart, finaliseObject, startObjectCleanup, stopObjectCleanup };
