// SPDX-License-Identifier: AGPL-3.0-only
'use strict';

const { createHash } = require('node:crypto');
const ENV = require('../../config/env');
const { objectTables } = require('./schema');
const { nativeKey, decodeJson, validateObjectDeclaration, HARD_LIMITS } = require('./protocol');
const columns = id => [id.tenantId, id.sourceStoreId, id.recordType, id.nativeRecordId];
const uint = value => typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value) &&
  BigInt(value) <= 9223372036854775807n;
const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
function objectStorage(db, refuse) {
  const found = db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='table' "
    + "AND name GLOB 'health_object_*'").all();
  if (!found.length) return false;
  const index = db.prepare("SELECT sql FROM sqlite_schema WHERE name='health_object_expiry'").get();
  if (found.length !== 3 || Object.entries(objectTables).some(([name, sql]) =>
    found.find(row => row.name === name)?.sql !== sql) ||
    index?.sql !== 'CREATE INDEX health_object_expiry ON health_object_staging (expires_at)') {
    refuse(503, 'storage-unavailable');
  }
  return true;
}
function provenance(key, sequence, id, refuse) {
  let parsed;
  try { parsed = decodeJson(key); } catch { refuse(503, 'storage-unavailable'); }
  if (!uint(sequence) || !Array.isArray(parsed) || parsed.length !== 7 ||
      parsed.some(value => typeof value !== 'string' || !value.length || [...value].length > 256) ||
      !(parsed[5] === '0' || uint(parsed[5])) || parsed[0] !== id.tenantId || parsed[2] !== id.sourceStoreId ||
      parsed[4] !== id.recordType || JSON.stringify(parsed) !== key) refuse(503, 'storage-unavailable');
}
function utc(value) {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4}|-\d{4,10}|\+\d{5,10})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d{1,9})?Z$/.exec(value);
  if (!match || Buffer.byteLength(value) > 64) return false;
  const year = BigInt(match[1]), month = Number(match[2]), day = Number(match[3]);
  const leap = year % 4n === 0n && (year % 100n !== 0n || year % 400n === 0n);
  return year >= -1000000000n && year <= 1000000000n && month >= 1 && month <= 12 &&
    day >= 1 && day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}
function offset(value) {
  if (value === null || value === 'Z') return true;
  const match = typeof value === 'string' && /^[-+](\d{2}):([0-5]\d)(?::([0-5]\d))?$/.exec(value);
  return !!match && Number(match[1]) <= 18 &&
    (Number(match[1]) < 18 || (Number(match[2]) === 0 && Number(match[3] || 0) === 0));
}
function period(value) {
  if (value?.kind === 'instant' && Object.keys(value).join(',') === 'kind,time,zoneOffset' &&
      utc(value.time) && offset(value.zoneOffset)) return value;
  if (value?.kind === 'interval' && Object.keys(value).join(',') ===
      'kind,startTime,endTime,startZoneOffset,endZoneOffset' && utc(value.startTime) &&
      utc(value.endTime) && offset(value.startZoneOffset) && offset(value.endZoneOffset)) return value;
  return null;
}
function authority(db, id, refuse) {
  const tomb = db.prepare('SELECT CASE WHEN length(CAST(stream_key AS BLOB)) <= 8192 '
    + 'THEN stream_key END AS stream_key, CASE WHEN length(sequence)<=19 THEN sequence END AS sequence '
    + 'FROM health_tombstones WHERE tenant_id=? '
    + 'AND source_store_id=? AND record_type=? AND native_record_id=?').get(...columns(id));
  if (tomb) provenance(tomb.stream_key, tomb.sequence, id, refuse);
  let guard = null;
  if (db.prepare('SELECT version FROM health_schema_version').get().version === 2) {
    guard = db.prepare('SELECT source_deleted,user_suppressed, '
      + 'CASE WHEN length(source_sequence)<=19 THEN source_sequence END AS source_sequence, '
      + 'CASE WHEN length(CAST(footprint_json AS BLOB))<=2048 THEN footprint_json END AS footprint_json, '
      + 'length(CAST(footprint_json AS BLOB)) AS footprint_bytes, '
      + 'length(CAST(source_stream_key AS BLOB)) AS source_key_bytes, '
      + 'CASE WHEN length(CAST(source_stream_key AS BLOB)) <= 8192 THEN source_stream_key END '
      + 'AS source_stream_key FROM health_deletion_guards WHERE tenant_id=? AND source_store_id=? '
      + 'AND record_type=? AND native_record_id=?').get(...columns(id));
    if (guard) {
      if (![0, 1].includes(guard.source_deleted) || ![0, 1].includes(guard.user_suppressed) ||
          !(guard.source_deleted || guard.user_suppressed) || guard.footprint_bytes > 2048 ||
          guard.source_key_bytes > 8192) refuse(503, 'storage-unavailable');
      if (guard.source_deleted === 1) provenance(guard.source_stream_key, guard.source_sequence, id, refuse);
      else if (guard.source_stream_key !== null || guard.source_sequence !== null) refuse(503, 'storage-unavailable');
      if (guard.footprint_json !== null) {
        let parsed;
        try { parsed = decodeJson(guard.footprint_json); } catch { refuse(503, 'storage-unavailable'); }
        if (!period(parsed)) refuse(503, 'storage-unavailable');
      }
    }
  }
  return { tomb, guard };
}
function admit(db, id, refuse) {
  const { tomb, guard } = authority(db, id, refuse);
  if (tomb || guard?.source_deleted || guard?.user_suppressed) refuse(409, 'deletion-suppressed');
}
function footprint(db, id, refuse, strict = false) {
  const names = ['time', 'zoneOffset', 'startTime', 'endTime', 'startZoneOffset', 'endZoneOffset'];
  const projection = names.flatMap(name => [
    `json_type(record_json,'$.${name}') AS ${name}Type`,
    `CASE WHEN json_type(record_json,'$.${name}')='text' AND `
      + `length(CAST(json_extract(record_json,'$.${name}') AS BLOB))<=${name.endsWith('Offset') ? 9 : 64} `
      + `THEN json_extract(record_json,'$.${name}') END AS ${name}`,
  ]).join(',');
  const duplicates = "EXISTS(SELECT 1 FROM json_each(record_json) "
    + "WHERE key IN ('time','zoneOffset','startTime','endTime','startZoneOffset','endZoneOffset') "
    + 'GROUP BY key HAVING count(*)>1) AS ambiguous';
  const row = db.prepare(`SELECT json_type(record_json) AS root,${duplicates},${projection} FROM health_records `
    + 'WHERE tenant_id=? AND source_store_id=? AND record_type=? AND native_record_id=?').get(...columns(id));
  if (!row) return null;
  if (row.root !== 'object' || row.ambiguous) refuse(503, 'storage-unavailable');
  const zone = name => row[name + 'Type'] === null || row[name + 'Type'] === 'null' ? null :
    row[name + 'Type'] === 'text' && row[name] !== null ? row[name] : undefined;
  if (strict && names.some(name => row[name + 'Type'] !== null &&
      (name.endsWith('Offset') ? !offset(zone(name)) : !utc(row[name])))) {
    refuse(503, 'storage-unavailable');
  }
  const candidate = utc(row.time) ? { kind: 'instant', time: row.time, zoneOffset: zone('zoneOffset') } :
    { kind: 'interval', startTime: row.startTime, endTime: row.endTime,
      startZoneOffset: zone('startZoneOffset'), endZoneOffset: zone('endZoneOffset') };
  if (strict && !period(candidate) && ['time', 'startTime', 'endTime'].some(name =>
    row[name + 'Type'] !== null)) refuse(503, 'storage-unavailable');
  return period(candidate) ? JSON.stringify(candidate) : null;
}
const selection = "(json_extract(declaration_json,'$.binding.tenantId')=? AND "
  + "json_extract(declaration_json,'$.binding.sourceStoreId')=? AND json_extract(declaration_json,'$.recordType')=? "
  + "AND json_extract(declaration_json,'$.identity.nativeRecordId')=?) OR "
  + "(json_extract(declaration_json,'$.identity.tenantId')=? AND json_extract(declaration_json,'$.identity.sourceStoreId')=? "
  + "AND json_extract(declaration_json,'$.identity.recordType')=? AND json_extract(declaration_json,'$.identity.nativeRecordId')=?)";
function staging(db, id, refuse, totals, describe = false) {
  const values = [...columns(id), ...columns(id)];
  const objects = db.prepare(`SELECT count(*) AS n FROM health_object_staging WHERE ${selection}`).get(...values).n;
  totals.objects += objects;
  if (totals.objects > 1000) refuse(413, 'limit-exceeded');
  const physical = db.prepare('SELECT count(*) AS n,coalesce(sum(length(part_bytes)),0) AS bytes '
    + `FROM health_object_parts WHERE stream_key IN (SELECT stream_key FROM health_object_staging WHERE ${selection})`)
    .get(...values);
  totals.parts += physical.n; totals.bytes += physical.bytes;
  if (totals.parts > 128000 || totals.bytes > ENV.HEALTH_CONNECT_STAGING_MAX_BYTES) refuse(413, 'limit-exceeded');
  const selected = db.prepare(`SELECT * FROM health_object_staging WHERE ${selection}`).all(...values);
  const sizes = db.prepare('SELECT part_index,typeof(part_bytes) AS kind,length(part_bytes) AS bytes, '
    + 'typeof(part_digest) AS digest_kind,length(CAST(part_digest AS BLOB)) AS digest_bytes '
    + 'FROM health_object_parts WHERE stream_key=? ORDER BY part_index');
  const bytes = db.prepare('SELECT part_bytes,part_digest FROM health_object_parts WHERE stream_key=? AND part_index=?');
  const descriptions = [];
  for (const row of selected) {
    let header;
    try {
      header = decodeJson(row.declaration_json);
      validateObjectDeclaration(header);
    } catch { refuse(503, 'storage-unavailable'); }
    const b = header.binding;
    if (nativeKey(header.identity) !== nativeKey(id) ||
        row.stream_key !== JSON.stringify([b.tenantId, b.instanceId, b.sourceStoreId,
          b.installationId, header.recordType, b.generation, b.restoreEpoch]) ||
        row.reservation_bytes !== header.totalBytes || !Number.isSafeInteger(row.created_at) ||
        row.expires_at !== row.created_at + 86400000) refuse(503, 'storage-unavailable');
    const parts = sizes.all(row.stream_key);
    if (parts.length > header.partCount || parts.some(part => part.kind !== 'blob' ||
        part.digest_kind !== 'text' || part.digest_bytes !== 71 ||
        !Number.isSafeInteger(part.part_index) || part.part_index < 0 || part.part_index >= header.partCount ||
        !Number.isSafeInteger(part.bytes) || part.bytes < 1 || part.bytes > HARD_LIMITS.maxBytes) ||
        parts.reduce((sum, part) => sum + part.bytes, 0) > header.totalBytes) refuse(503, 'storage-unavailable');
    const actualParts = [];
    for (const part of parts) {
      const stored = bytes.get(row.stream_key, part.part_index);
      const digest = sha(stored.part_bytes);
      if (digest !== stored.part_digest) refuse(503, 'storage-unavailable');
      if (describe) actualParts.push([part.part_index, stored.part_bytes.length, digest]);
    }
    if (describe) descriptions.push({ row, header, parts: actualParts });
  }
  return describe ? descriptions : selected.map(row => row.stream_key);
}
function prepareChanges(db, changes, refuse) {
  const operations = new Map(), deleted = new Map(), totals = { objects: 0, parts: 0, bytes: 0 };
  for (const change of changes) {
    const key = nativeKey(change.identity);
    if (operations.has(key) && operations.get(key) !== change.operation) refuse(409, 'conflict');
    operations.set(key, change.operation);
  }
  const objects = objectStorage(db, refuse);
  if (objects && db.prepare("SELECT 1 FROM health_object_staging WHERE typeof(declaration_json)!='text' "
      + 'OR length(CAST(declaration_json AS BLOB))>16384 OR NOT json_valid(declaration_json) LIMIT 1').get()) {
    refuse(503, 'storage-unavailable');
  }
  for (const change of changes) {
    if (change.operation === 'upsert') admit(db, change.identity, refuse);
    else if (!deleted.has(nativeKey(change.identity))) {
      const { guard } = authority(db, change.identity, refuse);
      deleted.set(nativeKey(change.identity), {
        guard, footprint: footprint(db, change.identity, refuse),
        staging: objects ? staging(db, change.identity, refuse, totals) : [],
      });
    }
  }
  return deleted;
}
function sourceDelete(db, id, key, sequence, plan) {
  if (db.prepare('SELECT version FROM health_schema_version').get().version === 2) {
    db.prepare('INSERT INTO health_deletion_guards VALUES (?,?,?,?,1,?,?,?,?) '
      + 'ON CONFLICT (tenant_id,source_store_id,record_type,native_record_id) DO UPDATE SET '
      + 'source_deleted=1,source_stream_key=excluded.source_stream_key,source_sequence=excluded.source_sequence,'
      + 'footprint_json=coalesce(excluded.footprint_json,health_deletion_guards.footprint_json)')
      .run(...columns(id), plan.guard?.user_suppressed || 0, key, sequence, plan.footprint);
  }
  for (const stream of plan.staging) db.prepare('DELETE FROM health_object_staging WHERE stream_key=?').run(stream);
}
module.exports = { objectStorage, admit, prepareChanges, sourceDelete,
  authority, footprint, staging, selection };
