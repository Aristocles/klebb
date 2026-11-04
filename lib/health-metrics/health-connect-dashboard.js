// SPDX-License-Identifier: AGPL-3.0-only
'use strict';

const crypto = require('node:crypto');
const sourcePolicy = require('../health-connect/source-policy');
const { HistoryError, frontier } = require('../health-connect/history');
const { decodeJson, HARD_LIMITS } = require('../health-connect/protocol');
const { authority: deletionAuthority } = require('../health-connect/deletion-admission');
const { instant } = require('../health-connect/selection-time');
const { LIMITS } = require('../health-connect/source-index');
const { mergePatch } = require('../../manifests/merge-patch');
const display = require('./display');
const publication = require('../import/native-publication');
const { assertImportActor } = require('../import/owner-approval');

class DashboardError extends HistoryError {}
const fail = (status, code) => { throw new DashboardError(status, code); };
const unavailable = () => fail(503, 'storage-unavailable');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SHA = /^sha256:[a-f0-9]{64}$/;
const TYPES = Object.freeze({ WeightRecord: 'body_mass', StepsRecord: 'step_count' });
const FIELDS = ['tenantId', 'sourceStoreId', 'recordType', 'switchDate', 'dataOrigin', 'timeZone', 'mappingVersion'];
const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));
const scalar = (value, max = 256) => typeof value === 'string' && value.length > 0
  && [...value].length <= max && !/[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(value);
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
  && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
const uint = value => typeof value === 'string' && /^(0|[1-9]\d{0,18})$/.test(value)
  && BigInt(value) <= 9223372036854775807n;
const clone = value => JSON.parse(JSON.stringify(value));

// Configuration selects a view. It grants neither collection nor read authority.
function selection(manifest) {
  const value = manifest?.meta?.healthConnectDisplay;
  if (value === undefined || value === null) return null;
  if (!exact(value, FIELDS) || !UUID.test(value.tenantId) || !UUID.test(value.sourceStoreId)
      || !Object.hasOwn(TYPES, value.recordType) || !validDate(value.switchDate)
      || !scalar(value.dataOrigin) || !scalar(value.timeZone, 80) || value.mappingVersion !== 1
      || manifest.meta?.ingest?.source !== 'hae' || manifest.meta.ingest.metric !== TYPES[value.recordType]) {
    fail(422, 'invalid-display-selection');
  }
  try { new Intl.DateTimeFormat('en-CA', { timeZone: value.timeZone }).format(0); }
  catch { fail(422, 'invalid-display-selection'); }
  return clone(value);
}
function assertSource(scope, choice) {
  const current = sourcePolicy.snapshot(scope);
  const source = current.sources.find(value => value.sourceStoreId === choice.sourceStoreId);
  if (current.tenantId !== choice.tenantId || !source
      || !source.categories.some(category => category.recordType === choice.recordType)) {
    fail(403, 'scope-mismatch');
  }
  // The genuine normal READ has checked ownership and closure. Stopped/retired
  // collection does not remove the owner's committed display history.
  return current;
}
function validatePatch(actor, manifest, patch) {
  const next = { ...manifest, meta: Object.hasOwn(patch, 'meta')
    ? mergePatch(manifest.meta, patch.meta) : manifest.meta };
  const before = selection(manifest), after = selection(next);
  for (const choice of [before, after].filter(Boolean)) {
    sourcePolicy.withReadAuthority(actor, scope => assertSource(scope, choice), { tenantId: choice.tenantId });
  }
  return after;
}
// Return configuration choices, never raw records or collection authority.
function availableSources(actor) {
  return sourcePolicy.withReadAuthority(actor, (scope, db) => {
    if (!db || typeof db.prepare !== 'function') unavailable();
    const policies = sourcePolicy.snapshot(scope).sourcePolicies;
    if (!Array.isArray(policies)) unavailable();
    const sources = new Map();
    let records = 0;
    const query = db.prepare("SELECT CASE WHEN serializer_id='health-connect-record' "
      + "AND serializer_version=1 AND data_family='ordinary' AND projection='raw-only' "
      + 'THEN 1 END AS supported, '
      + "CASE WHEN typeof(record_json)='text' AND length(CAST(record_json AS BLOB))<=? "
      + 'THEN CASE WHEN json_valid(record_json) '
      + "THEN CASE WHEN json_type(record_json,'$.metadata.dataOrigin.packageName')='text' "
      + "THEN json_extract(record_json,'$.metadata.dataOrigin.packageName') END END END AS data_origin "
      + 'FROM health_records WHERE tenant_id=? AND source_store_id=? AND record_type=? '
      + 'ORDER BY native_record_id LIMIT ?');
    for (const policy of policies) {
      for (const source of policy.sources) {
        for (const category of source.categories) {
          if (!Object.hasOwn(TYPES, category.recordType)) continue;
          for (const row of query.iterate(HARD_LIMITS.maxBytes, policy.tenantId,
              source.sourceStoreId, category.recordType, LIMITS.identities + 1)) {
            if (++records > LIMITS.identities) fail(413, 'limit-exceeded');
            if (row.supported !== 1 || !scalar(row.data_origin)) unavailable();
            const choice = { tenantId: policy.tenantId, sourceStoreId: source.sourceStoreId,
              recordType: category.recordType, dataOrigin: row.data_origin };
            sources.set(JSON.stringify(Object.values(choice)), choice);
            if (sources.size > LIMITS.sources) fail(413, 'limit-exceeded');
          }
        }
      }
    }
    const result = { sources: [...sources.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([, source]) => source) };
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > LIMITS.statusBytes) fail(413, 'limit-exceeded');
    return result;
  }, { ownerWide: true });
}

function localDate(nanoseconds, timeZone) {
  let milliseconds = nanoseconds / 1000000n;
  if (nanoseconds < 0n && nanoseconds % 1000000n !== 0n) milliseconds--;
  if (milliseconds < -8640000000000000n || milliseconds > 8640000000000000n) {
    fail(409, 'unsupported-display-date');
  }
  const date = new Date(Number(milliseconds));
  if (date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) fail(409, 'unsupported-display-date');
  const values = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date).map(part => [part.type, part.value]));
  const result = `${values.year.padStart(4, '0')}-${values.month}-${values.day}`;
  if (!validDate(result)) fail(409, 'unsupported-display-date');
  return result;
}
function hashValue(hash, kind, value) { hash.update(JSON.stringify([kind, value]) + '\n'); }
function readControls(db, choice, hash) {
  const args = [choice.tenantId, choice.sourceStoreId, choice.recordType];
  const identities = new Set();
  const add = id => {
    if (!scalar(id)) unavailable();
    if (identities.has(id)) return;
    identities.add(id);
    if (identities.size > LIMITS.identities) fail(413, 'limit-exceeded');
    const control = deletionAuthority(db, { tenantId: args[0], sourceStoreId: args[1],
      recordType: args[2], nativeRecordId: id }, fail);
    hashValue(hash, 'control', [id, control]);
  };
  const idColumn = "CASE WHEN typeof(native_record_id)='text' "
    + 'AND length(CAST(native_record_id AS BLOB))<=1024 THEN native_record_id END AS native_record_id';
  for (const row of db.prepare(`SELECT ${idColumn} FROM health_tombstones `
      + 'WHERE tenant_id=? AND source_store_id=? AND record_type=? ORDER BY native_record_id').iterate(...args)) {
    add(row.native_record_id);
  }
  if (db.prepare('SELECT version FROM health_schema_version').get()?.version === 2) {
    for (const row of db.prepare(`SELECT ${idColumn} FROM health_deletion_guards `
        + 'WHERE tenant_id=? AND source_store_id=? AND record_type=? ORDER BY native_record_id').iterate(...args)) {
      add(row.native_record_id);
    }
  }
  return identities;
}
function readFrontier(db, choice, hash) {
  let saved = false, count = 0;
  const rows = db.prepare("SELECT CASE WHEN typeof(stream_key)='text' "
    + 'AND length(CAST(stream_key AS BLOB))<=8192 THEN stream_key END AS stream_key, '
    + "CASE WHEN typeof(record_type)='text' AND length(record_type)<=96 THEN record_type END AS record_type, "
    + "CASE WHEN typeof(acknowledged_sequence)='text' AND length(acknowledged_sequence)<=19 "
    + 'THEN acknowledged_sequence END AS acknowledged_sequence FROM health_streams '
    + "WHERE json_extract(stream_key,'$[0]')=? AND json_extract(stream_key,'$[2]')=? "
    + 'AND record_type=? ORDER BY stream_key').iterate(choice.tenantId, choice.sourceStoreId, choice.recordType);
  for (const row of rows) {
    if (++count > LIMITS.streams) fail(413, 'limit-exceeded');
    const key = decodeJson(row.stream_key);
    if (!Array.isArray(key) || key.length !== 7 || key.some(value => typeof value !== 'string')
        || JSON.stringify(key) !== row.stream_key || key[0] !== choice.tenantId
        || key[2] !== choice.sourceStoreId || key[4] !== choice.recordType
        || !uint(row.acknowledged_sequence)) unavailable();
    const binding = { tenantId: key[0], instanceId: key[1], sourceStoreId: key[2],
      installationId: key[3], generation: key[5], restoreEpoch: key[6] };
    if (frontier(db, row.stream_key, binding, choice.recordType) !== row.acknowledged_sequence) unavailable();
    if (row.acknowledged_sequence !== '0') saved = true;
    hashValue(hash, 'frontier', row);
  }
  return saved;
}
function nativeRows(db, choice, hash, blocked) {
  const days = new Map();
  let count = 0;
  const rows = db.prepare("SELECT CASE WHEN typeof(native_record_id)='text' "
    + 'AND length(CAST(native_record_id AS BLOB))<=1024 THEN native_record_id END AS native_record_id, '
    + "CASE WHEN serializer_id='health-connect-record' THEN 'health-connect-record' END AS serializer_id, "
    + 'CASE WHEN serializer_version=1 THEN 1 END AS serializer_version, '
    + "CASE WHEN data_family='ordinary' THEN 'ordinary' END AS data_family, "
    + "CASE WHEN projection='raw-only' THEN 'raw-only' END AS projection, "
    + "CASE WHEN typeof(record_json)='text' AND length(CAST(record_json AS BLOB))<=? THEN record_json END AS record_json "
    + 'FROM health_records WHERE tenant_id=? AND source_store_id=? AND record_type=? ORDER BY native_record_id')
    .iterate(HARD_LIMITS.maxBytes, choice.tenantId, choice.sourceStoreId, choice.recordType);
  for (const row of rows) {
    if (++count > LIMITS.identities) fail(413, 'limit-exceeded');
    if (!scalar(row.native_record_id) || row.serializer_id !== 'health-connect-record'
        || row.serializer_version !== 1 || row.data_family !== 'ordinary' || row.projection !== 'raw-only'
        || typeof row.record_json !== 'string') unavailable();
    const record = decodeJson(row.record_json);
    if (!record || typeof record !== 'object' || Array.isArray(record)
        || record.metadata?.id !== row.native_record_id || !scalar(record.metadata?.dataOrigin?.packageName)) unavailable();
    hashValue(hash, 'record', row);
    if (blocked.has(row.native_record_id) || record.metadata.dataOrigin.packageName !== choice.dataOrigin) continue;
    const start = instant(choice.recordType === 'WeightRecord' ? record.time : record.startTime);
    const end = choice.recordType === 'StepsRecord' ? instant(record.endTime) : null;
    if (start === null || (choice.recordType === 'StepsRecord' && (end === null || end <= start))) unavailable();
    const date = localDate(start, choice.timeZone);
    if (choice.recordType === 'StepsRecord' && localDate(end - 1n, choice.timeZone) !== date) {
      fail(409, 'unsupported-display-interval');
    }
    if (date < choice.switchDate) continue;
    const value = display.mapHealthConnectRow(choice.recordType, record, date, choice.mappingVersion);
    if (!value) fail(409, 'unrepresentable-display-value');
    if (!days.has(date)) days.set(date, []);
    days.get(date).push({ start, end, id: row.native_record_id, value });
  }
  const result = [];
  for (const date of [...days.keys()].sort()) {
    const items = days.get(date).sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : a.id.localeCompare(b.id));
    if (choice.recordType === 'WeightRecord') result.push(items.at(-1).value);
    else {
      let total = 0n, end = null;
      for (const item of items) {
        if (end !== null && item.start < end) fail(409, 'unsupported-display-overlap');
        end = item.end;
        total += BigInt(item.value.count);
      }
      if (total > BigInt(Number.MAX_SAFE_INTEGER)) fail(409, 'unrepresentable-display-value');
      result.push({ date, count: Number(total) });
    }
  }
  return { rows: result, recordCount: count };
}

// Publish the current response only. Raw native history and the HAE datastore
// remain separate; there is no delayed projection writer to overwrite a delete.
function view(actor, manifest, options = {}) {
  const choice = selection(manifest);
  if (!choice) return { data: manifest.data };
  if (options.expectedRevision !== undefined && !SHA.test(options.expectedRevision)) fail(400, 'invalid-projection-revision');
  const legacy = manifest.data === null || manifest.data === undefined ? [] : clone(manifest.data);
  if (!Array.isArray(legacy)) unavailable();
  return sourcePolicy.withReadAuthority(actor, (scope, db) => {
    if (!db || typeof db.prepare !== 'function') unavailable();
    const current = assertSource(scope, choice);
    return compose(db, choice, legacy, current, options);
  }, { tenantId: choice.tenantId });
}

function compose(db, choice, legacy, current, options) {
  const hash = crypto.createHash('sha256');
  hashValue(hash, 'selection', choice);
  hashValue(hash, 'policy', current);
  hashValue(hash, 'hae', legacy);
  const blocked = readControls(db, choice, hash);
  const saved = readFrontier(db, choice, hash);
  const native = nativeRows(db, choice, hash, blocked);
  if (!saved && (native.recordCount || blocked.size)) unavailable();
  const result = display.selectDisplayRows(TYPES[choice.recordType], legacy, native.rows, choice.switchDate);
  const retained = new Map(legacy.map(row => [row.date, row]));
  const data = result.rows.map((row, index) => result.selectedSources[index].source === 'hae'
    ? clone(retained.get(row.date)) : row);
  const revision = 'sha256:' + hash.digest('hex');
  if (options.expectedRevision !== undefined && options.expectedRevision !== revision) fail(409, 'stale-projection');
  return { data, projection: { state: saved ? 'saved' : 'pending', revision,
    selectedSources: result.selectedSources, nativeCompleteness: 'unverified' } };
}

function historicalCurrent(db, importActor, choice) {
  const current = publication.readManagedHistorical(db, importActor);
  const ownerId = assertImportActor(importActor);
  if (current && current.publication.counts.suppressions !== 0) fail(409, 'unsupported-display-control');
  if (!current || !current.publication.sources.some(source => source.tenantId === choice.tenantId
      && source.sourceStoreId === choice.sourceStoreId && source.ownerId === ownerId)) fail(403, 'scope-mismatch');
  const selected = db.prepare('SELECT 1 AS present FROM health_source_policy_state p '
    + 'JOIN health_source_policy_sources s ON s.tenant_id=p.tenant_id '
    + 'JOIN health_source_policy_categories c ON c.tenant_id=s.tenant_id AND c.source_store_id=s.source_store_id '
    + "WHERE p.tenant_id=? AND p.owner_id=? AND p.knowledge='COMPLETE' "
    + "AND s.source_store_id=? AND s.owner_id=? AND s.knowledge='COMPLETE' "
    + "AND s.retain_committed_history=1 AND s.lifecycle IN ('active','retired') "
    + "AND c.record_type=? AND c.sharing IN ('enabled','stopped')")
    .get(choice.tenantId, ownerId, choice.sourceStoreId, ownerId, choice.recordType);
  if (!selected) fail(403, 'scope-mismatch');
  return current.publication;
}

// Uses the existing approved import actor and genuine read transaction.
// This read does not restore live grants, readiness or collection permission.
function viewHistorical(db, importActor, manifest, options = {}) {
  const choice = selection(manifest);
  if (!choice) return { data: manifest.data };
  if (options.expectedRevision !== undefined && !SHA.test(options.expectedRevision)) fail(400, 'invalid-projection-revision');
  const legacy = manifest.data === null || manifest.data === undefined ? [] : clone(manifest.data);
  if (!Array.isArray(legacy)) unavailable();
  const current = historicalCurrent(db, importActor, choice);
  const result = compose(db, choice, legacy, current, options);
  assertImportActor(importActor);
  return result;
}

function validateHistoricalPatch(db, importActor, manifest, patch) {
  const next = { ...manifest, meta: Object.hasOwn(patch, 'meta')
    ? mergePatch(manifest.meta, patch.meta) : manifest.meta };
  const before = selection(manifest), after = selection(next);
  for (const choice of [before, after].filter(Boolean)) historicalCurrent(db, importActor, choice);
  assertImportActor(importActor);
  return after;
}

module.exports = { DashboardError, selection, validatePatch, view, viewHistorical, validateHistoricalPatch, availableSources };
