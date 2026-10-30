// SPDX-License-Identifier: AGPL-3.0-only
'use strict';

const { createHash } = require('node:crypto');
const ENV = require('../../config/env');
const { nativeKey, decodeJson, validateObjectDeclaration } = require('./protocol');
const { HistoryError, readHistorySnapshot } = require('./history');
const { validateMigrationSchema } = require('./guard-migration');
const admission = require('./deletion-admission');
const index = require('./source-index');
const { materialize } = require('./owner-deletion');
const { instant } = require('./selection-time');
const refuse = (status = 503, code = 'storage-unavailable') => { throw new HistoryError(status, code); };
const ordinal = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const columns = id => [id.tenantId, id.sourceStoreId, id.recordType, id.nativeRecordId];
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const uuid = value => typeof value === 'string' && value.length === 36 &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const type = value => typeof value === 'string' && !value.includes('\n') &&
  /^[A-Z][A-Za-z0-9]{0,95}$/.test(value);
function set(value, cap, valid) {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length < 1 || value.length > cap ||
      !value.every(valid) || new Set(value).size !== value.length) refuse(400, 'invalid-message');
  return [...value].sort(ordinal);
}
function validate(boundary, input, ownerId) {
  if (!exact(input, ['sourceStoreIds', 'recordTypes', 'period', 'cutoff'])) refuse(400, 'invalid-message');
  const sourceStoreIds = set(input.sourceStoreIds, 128, uuid);
  const recordTypes = set(input.recordTypes, 100, type);
  const requested = input.period;
  if (requested !== null && (!exact(requested, ['startTime', 'endTime']) ||
      instant(requested.startTime, true) === null || instant(requested.endTime, true) === null ||
      instant(requested.startTime) >= instant(requested.endTime))) refuse(400, 'invalid-message');
  const period = requested === null ? null : { startTime: requested.startTime, endTime: requested.endTime };
  const now = new Date().toISOString().replace(/\.(\d+)Z$/, (_, digits) => {
    const fraction = digits.replace(/0+$/, '');
    return (fraction ? '.' + fraction : '') + 'Z';
  });
  const cutoff = input.cutoff === null ? now : input.cutoff;
  if (instant(cutoff, true) === null || instant(cutoff) > instant(now)) refuse(400, 'invalid-message');
  const owned = new Set(boundary.sources.filter(source => source.ownerId === ownerId)
    .map(source => source.sourceStoreId));
  const sources = sourceStoreIds === null ? [...owned].sort(ordinal) : sourceStoreIds;
  if (sources.length > 128) refuse(413, 'limit-exceeded');
  if (sources.some(source => !owned.has(source))) refuse(403, 'scope-mismatch');
  return { selector: { sourceStoreIds, recordTypes, period, cutoff }, sources };
}
function discover(db, boundary, sources, types, version, objects) {
  let total = 0;
  const result = [], typeJson = types === null ? null : JSON.stringify(types);
  for (const sourceStoreId of sources) {
    const tables = ['health_records', 'health_tombstones'];
    if (version === 2) tables.push('health_deletion_guards');
    const queries = tables.map(table => `SELECT record_type,native_record_id FROM ${table} `
      + 'WHERE tenant_id=? AND source_store_id=?');
    const args = tables.flatMap(() => [boundary.tenantId, sourceStoreId]);
    if (objects) {
      queries.push("SELECT json_extract(declaration_json,'$.recordType') AS record_type,"
        + "json_extract(declaration_json,'$.identity.nativeRecordId') AS native_record_id "
        + "FROM health_object_staging WHERE (json_extract(declaration_json,'$.binding.tenantId')=? "
        + "AND json_extract(declaration_json,'$.binding.sourceStoreId')=?) OR "
        + "(json_extract(declaration_json,'$.identity.tenantId')=? "
        + "AND json_extract(declaration_json,'$.identity.sourceStoreId')=?)");
      args.push(boundary.tenantId, sourceStoreId, boundary.tenantId, sourceStoreId);
      // The identity and binding must agree; do not let a wrong outer type hide it.
      queries.push(queries.at(-1).replace("'$.recordType'", "'$.identity.recordType'"));
      args.push(boundary.tenantId, sourceStoreId, boundary.tenantId, sourceStoreId);
    }
    const scope = `FROM (${queries.join(' UNION ')}) WHERE (? IS NULL OR `
      + 'record_type IN (SELECT value FROM json_each(?)))';
    total += db.prepare(`SELECT count(*) AS n ${scope}`).get(...args, typeJson, typeJson).n;
    if (total > 1000) refuse(413, 'limit-exceeded');
    // Bound identity TEXT before bringing any candidate into JavaScript.
    const rows = db.prepare("SELECT CASE WHEN typeof(record_type)='text' AND "
      + 'length(CAST(record_type AS BLOB))<=96 THEN record_type END AS record_type,'
      + "CASE WHEN typeof(native_record_id)='text' AND length(CAST(native_record_id AS BLOB))<=1024 "
      + 'THEN native_record_id END AS native_record_id,'
      + 'CASE WHEN length(CAST(record_type AS BLOB))<=96 THEN CAST(record_type AS BLOB) END AS type_bytes,'
      + 'CASE WHEN length(CAST(native_record_id AS BLOB))<=1024 THEN CAST(native_record_id AS BLOB) '
      + `END AS id_bytes ${scope}`).all(...args, typeJson, typeJson);
    for (const row of rows) {
      const id = { tenantId: boundary.tenantId, sourceStoreId,
        recordType: row.record_type, nativeRecordId: row.native_record_id };
      try { nativeKey(id); } catch { refuse(); }
      if (Buffer.compare(Buffer.from(id.recordType), row.type_bytes) ||
          Buffer.compare(Buffer.from(id.nativeRecordId), row.id_bytes)) refuse();
      result.push(id);
    }
  }
  return result.sort((a, b) => ordinal(a.sourceStoreId, b.sourceStoreId) ||
    ordinal(a.recordType, b.recordType) || ordinal(a.nativeRecordId, b.nativeRecordId));
}
function footprint(db, id) {
  const { guard } = admission.authority(db, id, refuse);
  const ordered = period => {
    if (period?.kind === 'instant' && instant(period.time) === null) refuse();
    if (period?.kind === 'interval' && (instant(period.startTime) === null ||
        instant(period.endTime) === null || instant(period.startTime) >= instant(period.endTime))) refuse();
  };
  const retained = guard?.footprint_json == null ? null : JSON.parse(guard.footprint_json);
  ordered(retained);
  const current = db.prepare('SELECT 1 FROM health_records WHERE tenant_id=? AND source_store_id=? '
    + 'AND record_type=? AND native_record_id=?').get(...columns(id));
  const value = current ? admission.footprint(db, id, refuse, true) : null;
  const period = current ? value === null ? null : JSON.parse(value) : retained;
  ordered(period);
  return period;
}
function declarations(db, id) {
  // Validate bounded declaration metadata even when a date cannot select its payload.
  const rows = db.prepare("SELECT CASE WHEN typeof(stream_key)='text' AND "
    + 'length(CAST(stream_key AS BLOB))<=8192 THEN stream_key END AS stream_key,'
    + `declaration_json,created_at,expires_at,reservation_bytes FROM health_object_staging WHERE ${admission.selection}`)
    .iterate(...columns(id), ...columns(id));
  for (const row of rows) {
    let header;
    try { header = decodeJson(row.declaration_json); validateObjectDeclaration(header); }
    catch { refuse(); }
    const b = header.binding;
    if (nativeKey(header.identity) !== nativeKey(id) || row.stream_key !== JSON.stringify([
      b.tenantId, b.instanceId, b.sourceStoreId, b.installationId,
      header.recordType, b.generation, b.restoreEpoch]) ||
        row.reservation_bytes !== header.totalBytes || !Number.isSafeInteger(row.created_at) ||
        row.expires_at !== row.created_at + 86400000) refuse();
  }
}
function selected(period, window) {
  if (window === null) return true;
  if (period === null) refuse(409, 'scope-incomplete');
  const start = instant(window.startTime), end = instant(window.endTime);
  return period.kind === 'instant' ? start <= instant(period.time) && instant(period.time) < end :
    start < instant(period.endTime) && instant(period.startTime) < end;
}
function preflight(db, identities, objects) {
  let rawBytes = 0, objectCount = 0, partCount = 0, partBytes = 0;
  const raw = db.prepare('SELECT length(CAST(record_json AS BLOB)) AS bytes FROM health_records '
    + 'WHERE tenant_id=? AND source_store_id=? AND record_type=? AND native_record_id=?');
  const count = objects && db.prepare(`SELECT count(*) AS n FROM health_object_staging WHERE ${admission.selection}`);
  const physical = objects && db.prepare('SELECT count(*) AS n,coalesce(sum(length(part_bytes)),0) AS bytes '
    + `FROM health_object_parts WHERE stream_key IN (SELECT stream_key FROM health_object_staging WHERE ${admission.selection})`);
  for (const id of identities) {
    rawBytes += raw.get(...columns(id))?.bytes || 0;
    if (objects) {
      const scope = [...columns(id), ...columns(id)], parts = physical.get(...scope);
      objectCount += count.get(...scope).n; partCount += parts.n; partBytes += parts.bytes;
    }
  }
  if (rawBytes > 67108864 || objectCount > 1000 || partCount > 128000 ||
      partBytes > ENV.HEALTH_CONNECT_STAGING_MAX_BYTES) refuse(413, 'limit-exceeded');
}
function preview(boundary, input, ownerId) {
  const { selector, sources } = validate(boundary, input, ownerId);
  return readHistorySnapshot((db, present) => {
    try {
      if (!present) refuse();
      validateMigrationSchema(db);
      const version = db.prepare('SELECT version FROM health_schema_version').get().version;
      index.sources(db, boundary);
      index.schema(db); // An absent optional publication is allowed; a partial one is not.
      const objects = admission.objectStorage(db, refuse);
      if (objects && db.prepare("SELECT 1 FROM health_object_staging WHERE typeof(declaration_json)!='text' "
          + 'OR length(CAST(declaration_json AS BLOB))>16384 OR NOT json_valid(declaration_json) LIMIT 1').get()) refuse();
      // Validate metadata before scoped discovery can omit an unclassifiable saved row.
      if (objects) for (const row of db.prepare("SELECT CASE WHEN typeof(stream_key)='text' AND "
          + 'length(CAST(stream_key AS BLOB))<=8192 THEN stream_key END AS stream_key,'
          + 'declaration_json FROM health_object_staging').iterate()) {
        const header = decodeJson(row.declaration_json);
        validateObjectDeclaration(header);
        const b = header.binding;
        if (row.stream_key !== JSON.stringify([b.tenantId, b.instanceId, b.sourceStoreId,
          b.installationId, header.recordType, b.generation, b.restoreEpoch])) refuse();
      }
      // Validate all full source vectors before a date-incomplete candidate can refuse.
      const emptyPlans = new Map(sources.map(sourceStoreId => [sourceStoreId,
        materialize(db, true, boundary, { sourceStoreId }, [], false)]));
      const candidates = discover(db, boundary, sources, selector.recordTypes, version, objects);
      const footprints = new Map(), identities = [];
      for (const id of candidates) {
        if (objects) declarations(db, id);
        const known = footprint(db, id);
        if (selected(known, selector.period)) {
          identities.push(id); footprints.set(nativeKey(id), known);
        }
      }
      if (identities.length > 100) refuse(413, 'limit-exceeded');
      preflight(db, identities, objects); // Aggregate every source before raw/part materialization.
      const states = [], selection = [], effects = { newlyUserSuppressed: 0, removedRecords: 0,
        removedStagedObjects: 0, removedParts: 0, removedPartBytes: 0 };
      for (const sourceStoreId of sources) {
        const ids = identities.filter(id => id.sourceStoreId === sourceStoreId);
        const plan = ids.length ? materialize(db, true, boundary, { sourceStoreId }, ids, false) :
          emptyPlans.get(sourceStoreId);
        const vector = index.vectorRows(plan.saved).map(row =>
          [row.stream_key, row.record_type, row.acknowledged_sequence]).sort((a, b) => ordinal(a[0], b[0]));
        states.push([sourceStoreId, vector, plan.states]);
        selection.push({ sourceStoreId, identities: plan.states.map((state, position) => ({
          recordType: state[0], nativeRecordId: state[1],
          sourceDeleted: state[3] !== null || state[4]?.[0] === 1, userSuppressed: state[4]?.[1] === 1,
          currentRecord: state[2] !== null, footprint: footprints.get(nativeKey(ids[position])),
        })) });
        for (const key of Object.keys(effects)) effects[key] += plan.effects[key];
      }
      const array = ['health-connect-user-delete-selection', 1, boundary.tenantId, ownerId,
        boundary.restoreEpoch, version, [selector.sourceStoreIds, selector.recordTypes,
          selector.period === null ? null : [selector.period.startTime, selector.period.endTime], selector.cutoff], states];
      const revision = 'sha256:' + createHash('sha256').update(JSON.stringify(array)).digest('hex');
      boundary.check();
      return { version: 1, kind: 'deletion-selection-preview', selector,
        resolvedSourceStoreIds: sources, revision, selection, effects };
    } catch (error) {
      if (error instanceof HistoryError) throw error;
      refuse();
    }
  });
}

module.exports = { preview };
