// SPDX-License-Identifier: AGPL-3.0-only
'use strict';

const { createHash } = require('node:crypto');
const ENV = require('../../config/env');
const { nativeKey } = require('./protocol');
const { HistoryError, readHistorySnapshot, withHistoryTransaction } = require('./history');
const { validateMigrationSchema } = require('./guard-migration');
const admission = require('./deletion-admission');
const index = require('./source-index');
const refuse = (status = 503, code = 'storage-unavailable') => { throw new HistoryError(status, code); };
const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const ordinal = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const columns = id => [id.tenantId, id.sourceStoreId, id.recordType, id.nativeRecordId];
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const scalarId = value => typeof value === 'string' && [...value].length >= 1 &&
  [...value].length <= 256 && !/[\uD800-\uDFFF]/u.test(value);
function validate(boundary, input, apply) {
  if (!exact(input, apply ? ['sourceStoreId', 'identities', 'revision'] : ['sourceStoreId', 'identities']) ||
      !Array.isArray(input.identities) || input.identities.length < 1 || input.identities.length > 100 ||
      (apply && (typeof input.revision !== 'string' ||
        !/^sha256:[a-f0-9]{64}$/.test(input.revision)))) refuse(400, 'invalid-message');
  const identities = input.identities.map(item => {
    if (!exact(item, ['recordType', 'nativeRecordId'])) refuse(400, 'invalid-message');
    const id = { tenantId: boundary.tenantId, sourceStoreId: input.sourceStoreId, ...item };
    try { nativeKey(id); } catch { refuse(400, 'invalid-message'); }
    return id;
  }).sort((a, b) => ordinal(a.recordType, b.recordType) || ordinal(a.nativeRecordId, b.nativeRecordId));
  if (new Set(identities.map(nativeKey)).size !== identities.length) refuse(400, 'invalid-message');
  return identities;
}
const periodArray = value => value === null ? null : value.kind === 'instant' ?
  ['instant', value.time, value.zoneOffset] :
  ['interval', value.startTime, value.endTime, value.startZoneOffset, value.endZoneOffset];
function declaration(header) {
  const b = header.binding, id = header.identity;
  return [[b.tenantId, b.instanceId, b.sourceStoreId, b.installationId, b.generation, b.restoreEpoch],
    header.recordType, header.batchId, header.sequence,
    [id.tenantId, id.sourceStoreId, id.recordType, id.nativeRecordId],
    header.objectId, header.objectDigest, header.partCount, header.totalBytes];
}
function inspect(db, present, boundary, input, identities, apply) {
  try {
    if (!present) refuse();
    validateMigrationSchema(db);
    const version = db.prepare('SELECT version FROM health_schema_version').get().version;
    if (apply && version !== 2) refuse();
    index.sources(db, boundary);
    const saved = index.savedSource(db, boundary, input.sourceStoreId);
    if (!saved.complete) refuse(413, 'limit-exceeded');
    const vector = index.vectorRows(saved).map(row =>
      [row.stream_key, row.record_type, row.acknowledged_sequence]).sort((a, b) => ordinal(a[0], b[0]));
    const hasIndex = index.schema(db);
    const priorCycle = hasIndex && index.stateRow(db, boundary, input.sourceStoreId);
    if (apply && (saved.streams || priorCycle) && !hasIndex) refuse();
    const objects = admission.objectStorage(db, refuse);
    if (objects && db.prepare("SELECT 1 FROM health_object_staging WHERE typeof(declaration_json)!='text' "
        + 'OR length(CAST(declaration_json AS BLOB))>16384 OR NOT json_valid(declaration_json) LIMIT 1').get()) refuse();
    // Count every selected row before fetching any record or payload BLOB.
    const metadata = db.prepare("SELECT CASE WHEN typeof(serializer_id)='text' "
      + 'AND length(CAST(serializer_id AS BLOB))<=1024 THEN serializer_id END AS serializer_id,'
      + "CASE WHEN typeof(serializer_version)='integer' THEN serializer_version END AS serializer_version,"
      + "CASE WHEN typeof(data_family)='text' AND length(CAST(data_family AS BLOB))<=16 THEN data_family END AS data_family,"
      + "CASE WHEN typeof(projection)='text' AND length(CAST(projection AS BLOB))<=16 THEN projection END AS projection,"
      + 'typeof(record_json) AS kind,'
      + 'length(CAST(record_json AS BLOB)) AS bytes FROM health_records '
      + 'WHERE tenant_id=? AND source_store_id=? AND record_type=? AND native_record_id=?');
    const raw = identities.map(id => metadata.get(...columns(id)));
    for (const row of raw) {
      if (row && (row.kind !== 'text' || !Number.isSafeInteger(row.bytes) || row.bytes < 1 ||
          !scalarId(row.serializer_id) || !Number.isInteger(row.serializer_version) ||
          row.serializer_version < 1 || row.serializer_version > 2147483647 ||
          !['ordinary', 'route', 'medical'].includes(row.data_family) ||
          !['projected', 'raw-only'].includes(row.projection))) refuse();
    }
    if (raw.reduce((sum, row) => sum + (row?.bytes || 0), 0) > 67108864) refuse(413, 'limit-exceeded');
    if (objects) {
      const count = db.prepare(`SELECT count(*) AS n FROM health_object_staging WHERE ${admission.selection}`);
      const parts = db.prepare('SELECT count(*) AS n,coalesce(sum(length(part_bytes)),0) AS bytes '
        + `FROM health_object_parts WHERE stream_key IN (SELECT stream_key FROM health_object_staging WHERE ${admission.selection})`);
      let objectCount = 0, partCount = 0, partBytes = 0;
      for (const id of identities) {
        const scope = [...columns(id), ...columns(id)];
        objectCount += count.get(...scope).n;
        const physical = parts.get(...scope);
        partCount += physical.n; partBytes += physical.bytes;
      }
      if (objectCount > 1000 || partCount > 128000 || partBytes > ENV.HEALTH_CONNECT_STAGING_MAX_BYTES) {
        refuse(413, 'limit-exceeded');
      }
    }
    const readRaw = db.prepare('SELECT record_json FROM health_records WHERE tenant_id=? '
      + 'AND source_store_id=? AND record_type=? AND native_record_id=?');
    const totals = { objects: 0, parts: 0, bytes: 0 };
    const states = identities.map((id, position) => {
      const { tomb, guard } = admission.authority(db, id, refuse);
      const footprintText = admission.footprint(db, id, refuse, true);
      const footprint = footprintText === null ? null : JSON.parse(footprintText);
      const known = guard?.footprint_json == null ? null : JSON.parse(guard.footprint_json);
      const row = raw[position];
      let current = null;
      if (row) {
        // Release the original TEXT after hashing; never parse/restringify it.
        const text = readRaw.get(...columns(id)).record_json;
        if (Buffer.byteLength(text) !== row.bytes) refuse();
        current = [row.serializer_id, row.serializer_version, row.data_family, row.projection,
          row.bytes, sha(text), periodArray(footprint)];
      }
      const staged = objects ? admission.staging(db, id, refuse, totals, true).map(item =>
        [item.row.stream_key, declaration(item.header), item.row.created_at, item.row.expires_at,
          item.row.reservation_bytes, item.parts]).sort((a, b) => ordinal(a[0], b[0])) : [];
      return [id.recordType, id.nativeRecordId, current, tomb ? [tomb.stream_key, tomb.sequence] : null,
        guard ? [guard.source_deleted, guard.user_suppressed, guard.source_stream_key,
          guard.source_sequence, periodArray(known)] : null, staged];
    });
    const selection = identities.map(id => [id.recordType, id.nativeRecordId]);
    const revision = sha(JSON.stringify(['health-connect-user-delete', 1, boundary.tenantId,
      input.sourceStoreId, boundary.restoreEpoch, version, selection, vector, states]));
    const effects = { newlyUserSuppressed: 0, removedRecords: 0,
      removedStagedObjects: 0, removedParts: 0, removedPartBytes: 0 };
    for (const state of states) {
      if (state[4]?.[1] !== 1) effects.newlyUserSuppressed++;
      if (state[2] !== null) effects.removedRecords++;
      for (const staged of state[5]) {
        effects.removedStagedObjects++;
        for (const part of staged[5]) { effects.removedParts++; effects.removedPartBytes += part[1]; }
      }
    }
    return { states, saved, priorCycle, revision, effects };
  } catch (error) {
    if (error instanceof HistoryError) throw error;
    refuse(); // Stored reference/parser/native errors are storage, not bad input.
  }
}
const periodObject = value => value === null ? null : value[0] === 'instant' ?
  { kind: 'instant', time: value[1], zoneOffset: value[2] } :
  { kind: 'interval', startTime: value[1], endTime: value[2], startZoneOffset: value[3], endZoneOffset: value[4] };
function preview(boundary, input) {
  const identities = validate(boundary, input, false);
  return readHistorySnapshot((db, present) => {
    const plan = inspect(db, present, boundary, input, identities, false);
    boundary.check();
    return { version: 1, kind: 'deletion-preview', sourceStoreId: input.sourceStoreId,
      revision: plan.revision, identities: plan.states.map(state => ({
        recordType: state[0], nativeRecordId: state[1], sourceDeleted: state[3] !== null || state[4]?.[0] === 1,
        userSuppressed: state[4]?.[1] === 1, currentRecord: state[2] !== null,
        footprint: periodObject(state[4]?.[4] ?? state[2]?.[6] ?? null),
      })), effects: plan.effects };
  });
}
function apply(boundary, input) {
  const identities = validate(boundary, input, true);
  // Refuse V1/absent/partial stores before opening the owner writer.
  readHistorySnapshot((db, present) => {
    if (!present) refuse();
    validateMigrationSchema(db);
    if (db.prepare('SELECT version FROM health_schema_version').get().version !== 2) refuse();
  });
  boundary.check();
  return withHistoryTransaction(db => {
    const plan = inspect(db, true, boundary, input, identities, true);
    if (plan.revision !== input.revision) refuse(409, 'conflict');
    const changed = Object.values(plan.effects).some(value => value > 0);
    if (changed) {
      const guard = db.prepare('INSERT INTO health_deletion_guards VALUES (?,?,?,?,?,1,?,?,?) '
        + 'ON CONFLICT (tenant_id,source_store_id,record_type,native_record_id) DO UPDATE SET '
        + 'user_suppressed=1,footprint_json=coalesce(health_deletion_guards.footprint_json,excluded.footprint_json)');
      const remove = db.prepare('DELETE FROM health_records WHERE tenant_id=? AND source_store_id=? '
        + 'AND record_type=? AND native_record_id=?');
      const purge = plan.states.some(state => state[5].length) ?
        db.prepare('DELETE FROM health_object_staging WHERE stream_key=?') : null;
      for (let position = 0; position < plan.states.length; position++) {
        const state = plan.states[position], retained = state[4];
        if (retained?.[1] !== 1 || state[2] !== null || state[5].length) {
          const footprint = periodObject(retained?.[4] ?? state[2]?.[6] ?? null);
          guard.run(...columns(identities[position]), retained?.[0] || 0,
            retained?.[2] ?? null, retained?.[3] ?? null, footprint === null ? null : JSON.stringify(footprint));
          remove.run(...columns(identities[position]));
          for (const staged of state[5]) purge.run(staged[0]);
        }
      }
    }
    const projectionQueued = changed && !!(plan.saved.streams || plan.priorCycle);
    if (projectionQueued) index.requestState(db, boundary, input.sourceStoreId, plan.saved, true);
    boundary.check();
    return { version: 1, kind: 'deletion-result', sourceStoreId: input.sourceStoreId,
      revision: plan.revision, effects: plan.effects, projectionQueued };
  }, { existingOnly: true });
}
module.exports = { validate, preview, apply, materialize: inspect };
