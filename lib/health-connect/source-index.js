// SPDX-License-Identifier: AGPL-3.0-only
'use strict';

const crypto = require('node:crypto');
const { HistoryError, readHistorySnapshot, withHistoryTransaction, frontier } = require('./history');
const TARGET = 'source-index-v1';
const LIMITS = Object.freeze({ identities: 100000, streams: 1000, sources: 1000, statusBytes: 1048576 });
const ATTEMPT_LIMIT = 3;
const { sourceIndexTables: tables } = require('./schema');
const refuse = (status = 503, code = 'storage-unavailable') => { throw new HistoryError(status, code); };
const ordinal = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const digest = rows => 'sha256:' + crypto.createHash('sha256')
  .update(JSON.stringify(rows.map(row => [row.stream_key, row.acknowledged_sequence])
    .sort((a, b) => ordinal(a[0], b[0])))).digest('hex');
const normalise = sql => sql.replace(/\s+/g, ' ').trim();
function schema(db, create = false) {
  const found = db.prepare("SELECT name, sql FROM sqlite_schema WHERE type='table' "
    + "AND name IN ('health_source_index','health_source_index_frontiers','health_source_index_state')").all();
  if (!found.length) {
    if (!create) return false;
    for (const sql of Object.values(tables)) db.exec(sql);
    return true;
  }
  for (const [name, sql] of Object.entries(tables)) {
    if (normalise(found.find(row => row.name === name)?.sql || '') !== normalise(sql)) refuse();
  }
  return true;
}
// Check all saved namespaces, even when a browser owns only a subset. Unknown
// ownership is not an empty source, and an orphan reference cannot be skipped.
function sources(db, boundary) {
  for (const table of ['health_streams', 'health_batch_receipts', 'health_projection_outbox']) {
    if (db.prepare(`SELECT 1 FROM ${table} WHERE NOT json_valid(stream_key) LIMIT 1`).get()) refuse();
  }
  const rows = db.prepare(`SELECT tenant_id, source_store_id FROM health_records
    UNION SELECT tenant_id, source_store_id FROM health_tombstones
    UNION SELECT json_extract(stream_key,'$[0]'), json_extract(stream_key,'$[2]') FROM health_streams
    UNION SELECT json_extract(stream_key,'$[0]'), json_extract(stream_key,'$[2]') FROM health_batch_receipts
    UNION SELECT json_extract(stream_key,'$[0]'), json_extract(stream_key,'$[2]') FROM health_projection_outbox
    LIMIT ?`).all(LIMITS.sources + 1);
  if (rows.length > LIMITS.sources) refuse(413, 'limit-exceeded');
  const owned = new Map((boundary?.sources || []).map(source => [source.sourceStoreId, source.ownerId]));
  for (const row of rows) {
    if (row.tenant_id !== boundary?.tenantId || !owned.has(row.source_store_id)) refuse();
  }
  return rows.map(row => ({ sourceStoreId: row.source_store_id, ownerId: owned.get(row.source_store_id) }))
    .sort((a, b) => ordinal(a.sourceStoreId, b.sourceStoreId));
}
function decodeStream(row, boundary, sourceStoreId) {
  let key;
  try { key = JSON.parse(row.stream_key); } catch { refuse(); }
  if (!Array.isArray(key) || key.length !== 7 || key.some(value => typeof value !== 'string') ||
      key[0] !== boundary.tenantId || key[2] !== sourceStoreId || key[4] !== row.record_type ||
      JSON.stringify(key) !== row.stream_key) refuse();
  return { tenantId: key[0], instanceId: key[1], sourceStoreId: key[2],
    installationId: key[3], generation: key[5], restoreEpoch: key[6] };
}
function verifyReferences(db, row, binding) {
  const acknowledged = frontier(db, row.stream_key, binding, row.record_type);
  if (acknowledged === '0') refuse();
  // Durable ingest stores a canonical receipt. Verify every original reference
  // through this frontier in SQL, without loading an unbounded receipt archive.
  const count = db.prepare('SELECT count(*) AS n FROM health_batch_receipts WHERE stream_key=?')
    .get(row.stream_key).n;
  const jobs = db.prepare('SELECT count(*) AS n FROM health_projection_outbox WHERE stream_key=?')
    .get(row.stream_key).n;
  if (BigInt(count) !== BigInt(acknowledged) || jobs !== count) refuse();
  const invalid = db.prepare(`SELECT 1 FROM health_batch_receipts r
    LEFT JOIN health_projection_outbox j ON j.stream_key=r.stream_key AND j.sequence=r.sequence
    WHERE r.stream_key=? AND (
      r.sequence='' OR r.sequence GLOB '*[^0-9]*' OR substr(r.sequence,1,1)='0'
      OR length(r.sequence)>length(?) OR (length(r.sequence)=length(?) AND r.sequence>?)
      OR length(r.payload_digest)<>71 OR substr(r.payload_digest,1,7)<>'sha256:'
      OR substr(r.payload_digest,8) GLOB '*[^a-f0-9]*'
      OR j.batch_id IS NULL OR j.batch_id<>r.batch_id OR j.payload_digest<>r.payload_digest OR j.state<>'queued'
      OR r.receipt_json<>json_object('version',1,'kind','durable-receipt',
        'binding',json(?),'recordType',?,'sequence',r.sequence,'batchId',r.batch_id,
        'payloadDigest',r.payload_digest)) LIMIT 1`)
    .get(row.stream_key, acknowledged, acknowledged, acknowledged, JSON.stringify(binding), row.record_type);
  if (invalid) refuse();
}
function savedSource(db, boundary, sourceStoreId) {
  const scope = [boundary.tenantId, sourceStoreId];
  const records = db.prepare('SELECT count(*) AS n FROM health_records WHERE tenant_id=? AND source_store_id=?')
    .get(...scope).n;
  const tombstones = db.prepare('SELECT count(*) AS n FROM health_tombstones WHERE tenant_id=? AND source_store_id=?')
    .get(...scope).n;
  const where = "json_extract(stream_key,'$[0]')=? AND json_extract(stream_key,'$[2]')=?";
  const streams = db.prepare(`SELECT count(*) AS n FROM health_streams WHERE ${where}`).get(...scope).n;
  if (streams > LIMITS.streams) return { records, tombstones, streams, frontiers: null, complete: false };
  const rows = db.prepare(`SELECT * FROM health_streams WHERE ${where} ORDER BY stream_key`).all(...scope);
  // References without a saved stream must refuse rather than disappear.
  for (const table of ['health_batch_receipts', 'health_projection_outbox']) {
    if (db.prepare(`SELECT 1 FROM ${table} r WHERE ${where} AND NOT EXISTS
      (SELECT 1 FROM health_streams s WHERE s.stream_key=r.stream_key) LIMIT 1`).get(...scope)) refuse();
  }
  const frontiers = rows.map(row => {
    const binding = decodeStream(row, boundary, sourceStoreId);
    verifyReferences(db, row, binding);
    return { binding, recordType: row.record_type, acknowledgedSequence: row.acknowledged_sequence };
  });
  if ((records + tombstones > 0) && !streams) refuse();
  return { records, tombstones, streams, frontiers, complete: true };
}
function vectorRows(saved) {
  return saved.frontiers.map(item => ({
    stream_key: JSON.stringify([item.binding.tenantId, item.binding.instanceId, item.binding.sourceStoreId,
      item.binding.installationId, item.recordType, item.binding.generation, item.binding.restoreEpoch]),
    record_type: item.recordType, acknowledged_sequence: item.acknowledgedSequence,
  }));
}
function stateRow(db, boundary, sourceStoreId) {
  const row = db.prepare('SELECT * FROM health_source_index_state WHERE tenant_id=? AND source_store_id=?')
    .get(boundary.tenantId, sourceStoreId);
  if (row && (row.target_id !== TARGET || !['queued', 'failed', 'current'].includes(row.state) ||
      !Number.isSafeInteger(row.attempt_count) || row.attempt_count < 0 || row.attempt_count > ATTEMPT_LIMIT ||
      ![null, 'storage-unavailable', 'limit-exceeded'].includes(row.error_code) ||
      (row.next_attempt_at !== null && !Number.isSafeInteger(row.next_attempt_at)) ||
      (row.requested_vector_digest !== null && !/^sha256:[a-f0-9]{64}$/.test(row.requested_vector_digest)))) refuse();
  return row;
}
function publishedSource(db, boundary, sourceStoreId, state) {
  if (!state || state.published_restore_epoch === null) return null;
  if (!Number.isSafeInteger(state.published_at)) refuse();
  const scope = [boundary.tenantId, sourceStoreId];
  const counts = db.prepare(`SELECT entry_kind, count(*) AS n FROM health_source_index
    WHERE tenant_id=? AND source_store_id=? GROUP BY entry_kind`).all(...scope);
  const rows = db.prepare('SELECT stream_key, record_type, acknowledged_sequence FROM health_source_index_frontiers '
    + 'WHERE tenant_id=? AND source_store_id=? ORDER BY stream_key LIMIT ?').all(...scope, LIMITS.streams + 1);
  if (rows.length > LIMITS.streams) refuse(413, 'limit-exceeded');
  return { records: counts.find(row => row.entry_kind === 'record')?.n || 0,
    tombstones: counts.find(row => row.entry_kind === 'tombstone')?.n || 0,
    frontiers: rows.map(row => ({ binding: decodeStream(row, boundary, sourceStoreId),
      recordType: row.record_type, acknowledgedSequence: row.acknowledged_sequence })),
    restoreEpoch: state.published_restore_epoch, publishedAt: new Date(state.published_at).toISOString() };
}
function identitiesCurrent(db, boundary, sourceStoreId) {
  const scope = [boundary.tenantId, sourceStoreId];
  const expected = `SELECT record_type,native_record_id,'record' AS entry_kind FROM health_records
    WHERE tenant_id=? AND source_store_id=? UNION ALL
    SELECT record_type,native_record_id,'tombstone' AS entry_kind FROM health_tombstones
    WHERE tenant_id=? AND source_store_id=?`;
  const actual = 'SELECT record_type,native_record_id,entry_kind FROM health_source_index '
    + 'WHERE tenant_id=? AND source_store_id=?';
  return !db.prepare(`SELECT 1 FROM (SELECT * FROM (${expected}) EXCEPT ${actual}) LIMIT 1`)
    .get(...scope, ...scope, ...scope) &&
    !db.prepare(`SELECT 1 FROM (${actual} EXCEPT SELECT * FROM (${expected})) LIMIT 1`)
      .get(...scope, ...scope, ...scope);
}
function isCurrent(db, sourceStoreId, saved, published, state, boundary) {
  return state?.state === 'current' && saved.complete && published &&
    state.requested_restore_epoch === boundary.restoreEpoch &&
    published.restoreEpoch === boundary.restoreEpoch &&
    state.requested_vector_digest === digest(vectorRows(saved)) &&
    saved.records === published.records && saved.tombstones === published.tombstones &&
    JSON.stringify(saved.frontiers) === JSON.stringify(published.frontiers) &&
    identitiesCurrent(db, boundary, sourceStoreId);
}
function statusIn(db, present, boundary, ownerId) {
  if (!present) return { target: TARGET, sources: [] };
  const hasIndex = schema(db);
  const result = { target: TARGET, sources: [] };
  let bytes = Buffer.byteLength(JSON.stringify(result));
  const selected = sources(db, boundary).filter(source => ownerId === undefined || source.ownerId === ownerId);
  for (const { sourceStoreId } of selected) {
      const saved = savedSource(db, boundary, sourceStoreId);
      const state = hasIndex ? stateRow(db, boundary, sourceStoreId) : null;
      const published = hasIndex ? publishedSource(db, boundary, sourceStoreId, state) : null;
      const sameRequest = state && state.requested_vector_digest === (saved.complete ? digest(vectorRows(saved)) : null) &&
        state.requested_restore_epoch === boundary.restoreEpoch;
      const current = isCurrent(db, sourceStoreId, saved, published, state, boundary);
      const source = { sourceStoreId, state: current ? 'current' : sameRequest && state.state === 'failed' ? 'failed' : 'queued',
        saved, published, currentRestoreEpoch: boundary.restoreEpoch,
        attempts: { count: sameRequest ? state.attempt_count : 0, limit: ATTEMPT_LIMIT,
          nextAt: sameRequest && state.next_attempt_at !== null ? new Date(state.next_attempt_at).toISOString() : null },
        errorCode: sameRequest ? state.error_code : null };
      bytes += Buffer.byteLength(JSON.stringify(source)) + (result.sources.length ? 1 : 0);
      if (bytes > LIMITS.statusBytes) refuse(413, 'limit-exceeded');
      result.sources.push(source);
  }
  return result;
}
function readStatus(boundary, ownerId) {
  return readHistorySnapshot((db, present) => statusIn(db, present, boundary, ownerId));
}
function savedSources(boundary) {
  return readHistorySnapshot((db, present) => present ? sources(db, boundary) : []);
}
function fence(boundary) { boundary?.check?.(); }
function requestState(db, boundary, sourceStoreId, saved, reset) {
  const rows = saved.complete ? vectorRows(saved) : null;
  const requestedDigest = rows ? digest(rows) : null;
  const previous = stateRow(db, boundary, sourceStoreId);
  const same = previous?.requested_restore_epoch === boundary.restoreEpoch &&
    previous.requested_vector_digest === requestedDigest;
  if (previous && same && !reset) return previous;
  db.prepare(`INSERT INTO health_source_index_state (tenant_id,source_store_id,target_id,state,
    requested_restore_epoch,requested_vector_digest,attempt_count,next_attempt_at,error_code,
    published_restore_epoch,published_at) VALUES (?, ?, ?, 'queued', ?, ?, 0, NULL, NULL, NULL, NULL)
    ON CONFLICT(tenant_id,source_store_id) DO UPDATE SET state='queued',
    requested_restore_epoch=excluded.requested_restore_epoch, requested_vector_digest=excluded.requested_vector_digest,
    attempt_count=0, next_attempt_at=NULL, error_code=NULL`)
    .run(boundary.tenantId, sourceStoreId, TARGET, boundary.restoreEpoch, requestedDigest);
  return stateRow(db, boundary, sourceStoreId);
}
function queueRebuild(boundary, ownerId) {
  // Read-only preflight checks scope and encoded limits before any queue effect.
  const initial = readStatus(boundary, ownerId);
  if (!initial.sources.length) return [];
  fence(boundary);
  return withHistoryTransaction(db => {
    const current = statusIn(db, true, boundary, ownerId);
    schema(db, true);
    for (const source of current.sources) requestState(db, boundary, source.sourceStoreId, source.saved, true);
    fence(boundary);
    return current.sources.map(source => source.sourceStoreId);
  });
}
function prepareAttempt(boundary, sourceStoreId) {
  fence(boundary);
  return withHistoryTransaction(db => {
    sources(db, boundary);
    const saved = savedSource(db, boundary, sourceStoreId);
    schema(db, true);
    const previous = stateRow(db, boundary, sourceStoreId);
    if (isCurrent(db, sourceStoreId, saved, publishedSource(db, boundary, sourceStoreId, previous), previous, boundary)) return null;
    const state = requestState(db, boundary, sourceStoreId, saved, false);
    if (state.attempt_count >= ATTEMPT_LIMIT) return null;
    if (state.state === 'failed' && state.error_code === 'limit-exceeded') return null;
    if (state.next_attempt_at !== null && state.next_attempt_at > Date.now()) return state.next_attempt_at;
    db.prepare("UPDATE health_source_index_state SET state='queued',attempt_count=attempt_count+1,"
      + 'next_attempt_at=NULL,error_code=NULL WHERE tenant_id=? AND source_store_id=?')
      .run(boundary.tenantId, sourceStoreId);
    fence(boundary);
    return true;
  });
}
function publishSource(boundary, sourceStoreId) {
  fence(boundary);
  return withHistoryTransaction(db => {
    sources(db, boundary);
    const saved = savedSource(db, boundary, sourceStoreId);
    schema(db);
    const state = stateRow(db, boundary, sourceStoreId);
    if (!state || state.state !== 'queued' || !saved.complete ||
        saved.records + saved.tombstones > LIMITS.identities) refuse(413, 'limit-exceeded');
    const rows = vectorRows(saved);
    if (state.requested_restore_epoch !== boundary.restoreEpoch ||
        state.requested_vector_digest !== digest(rows)) refuse();
    const scope = [boundary.tenantId, sourceStoreId];
    db.prepare('DELETE FROM health_source_index WHERE tenant_id=? AND source_store_id=?').run(...scope);
    for (const [table, kind] of [['health_records', 'record'], ['health_tombstones', 'tombstone']]) {
      db.prepare(`INSERT INTO health_source_index (tenant_id,source_store_id,record_type,native_record_id,entry_kind)
        SELECT tenant_id,source_store_id,record_type,native_record_id,? FROM ${table}
        WHERE tenant_id=? AND source_store_id=?`).run(kind, ...scope);
    }
    db.prepare('DELETE FROM health_source_index_frontiers WHERE tenant_id=? AND source_store_id=?').run(...scope);
    const insert = db.prepare('INSERT INTO health_source_index_frontiers '
      + '(tenant_id,source_store_id,stream_key,record_type,acknowledged_sequence) VALUES (?,?,?,?,?)');
    for (const row of rows) insert.run(...scope, row.stream_key, row.record_type, row.acknowledged_sequence);
    db.prepare("UPDATE health_source_index_state SET state='current',next_attempt_at=NULL,error_code=NULL,"
      + 'published_restore_epoch=?,published_at=? WHERE tenant_id=? AND source_store_id=?')
      .run(boundary.restoreEpoch, Date.now(), ...scope);
    fence(boundary);
    return true;
  });
}
function recordFailure(boundary, sourceStoreId, error) {
  fence(boundary);
  return withHistoryTransaction(db => {
    schema(db);
    const state = stateRow(db, boundary, sourceStoreId);
    if (!state) return null;
    const code = error.code === 'limit-exceeded' ? 'limit-exceeded' : 'storage-unavailable';
    const next = code !== 'limit-exceeded' && state.attempt_count < ATTEMPT_LIMIT ?
      Date.now() + (state.attempt_count === 1 ? 1000 : 5000) : null;
    db.prepare("UPDATE health_source_index_state SET state='failed',next_attempt_at=?,error_code=? "
      + 'WHERE tenant_id=? AND source_store_id=?').run(next, code, boundary.tenantId, sourceStoreId);
    fence(boundary);
    return next;
  });
}
module.exports = { TARGET, LIMITS, ATTEMPT_LIMIT, readStatus, queueRebuild,
  prepareAttempt, publishSource, recordFailure, savedSources };
