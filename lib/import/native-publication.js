// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const { DatabaseSync } = require('node:sqlite');
const { DB_FILE } = require('../../config/paths');
const { nativeTables, restorePublicationTables } = require('../health-connect/schema');
const { nativeRetained, authorityRetained } = require('./target-native');
const { assertOwnerApproval, OwnerApprovalError } = require('./owner-approval');
const { decodeJson, nativeKey, HARD_LIMITS } = require('../health-connect/protocol');

const prepared = new WeakMap();
const VERSION = 1;
const MAX_BYTES = 16777216;
const MAX_ENTRY_BYTES = 1048576;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const FAMILIES = ['catalog', 'records', 'sourcePolicies', 'tombstones', 'suppressions'];
const COUNT_KEYS = ['sources', 'records', 'sourcePolicies', 'tombstones', 'suppressions'];
const TYPED_FAMILIES = [...FAMILIES, 'deletionGuards'];
const TYPED_COUNT_KEYS = [...COUNT_KEYS, 'deletionGuards'];
const controlVersion = options => options && options.controlProfileVersion === 2 ? 2 : VERSION;
class PublicationError extends Error {
  constructor(status, code, publication) {
    super(code); this.status = status; this.code = code;
    if (publication) this.publication = publication;
  }
}
const invalid = () => { throw new PublicationError(400, 'IMPORT_PUBLICATION_INVALID'); };
const unavailable = () => { throw new PublicationError(503, 'storage-unavailable'); };
const nonfresh = () => { throw new PublicationError(409, 'IMPORT_PUBLICATION_TARGET_NOT_FRESH'); };
const hash = text => 'sha256:' + crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const text = value => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= MAX_ENTRY_BYTES;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function keys(value, required, optional = []) {
  if (!object(value) || !required.every(key => Object.hasOwn(value, key)) ||
      Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) invalid();
}
function boundedArray(value, maximum) {
  if (!Array.isArray(value) || value.length > maximum) invalid();
}
function boundedJSON(value) {
  let encoded;
  try { encoded = JSON.stringify(value); } catch { invalid(); }
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > MAX_BYTES) invalid();
  return encoded;
}
function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function snapshot(inventory, version = VERSION) {
  const families = version === 2 ? TYPED_FAMILIES : FAMILIES;
  keys(inventory, families);
  if (version === 2) validateFamilies(inventory, false, version);
  const copy = {};
  for (const name of families) copy[name] = inventory[name];
  return JSON.parse(boundedJSON(copy));
}
function counts(value, descriptors = false, version = VERSION) {
  const result = { sources: value.catalog.sources.length,
    records: (descriptors ? value.recordDescriptors : value.records).length,
    sourcePolicies: value.sourcePolicies.length, tombstones: value.tombstones.length,
    suppressions: value.suppressions.length };
  if (version === 2) result.deletionGuards = value.deletionGuards.length;
  return result;
}
function typedIdentity(identity, catalog, sources) {
  if (!Array.isArray(identity) || identity.length !== 4 ||
      identity[0] !== catalog.logicalTenantId || !sources.has(identity[1])) invalid();
  try {
    return nativeKey({ tenantId: identity[0], sourceStoreId: identity[1],
      recordType: identity[2], nativeRecordId: identity[3] });
  } catch { invalid(); }
}
const positiveSequence = value => typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value) &&
  BigInt(value) <= 9223372036854775807n;
function typedProvenance(key, sequence, identity) {
  if (typeof key !== 'string' || Buffer.byteLength(key) > 8192 || !positiveSequence(sequence)) invalid();
  let parsed;
  try { parsed = decodeJson(key); } catch { invalid(); }
  if (!Array.isArray(parsed) || parsed.length !== 7 ||
      parsed.some(value => typeof value !== 'string' || !value.length || [...value].length > 256) ||
      !(parsed[5] === '0' || positiveSequence(parsed[5])) || parsed[0] !== identity[0] ||
      parsed[2] !== identity[1] || parsed[4] !== identity[2] || JSON.stringify(parsed) !== key) invalid();
}
function typedUtc(value) {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4}|-\d{4,10}|\+\d{5,10})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d{1,9})?Z$/.exec(value);
  if (!match || Buffer.byteLength(value) > 64) return false;
  const year = BigInt(match[1]), month = Number(match[2]), day = Number(match[3]);
  const leap = year % 4n === 0n && (year % 100n !== 0n || year % 400n === 0n);
  return year >= -1000000000n && year <= 1000000000n && month >= 1 && month <= 12 &&
    day >= 1 && day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}
function typedOffset(value) {
  if (value === null || value === 'Z') return true;
  const match = typeof value === 'string' && /^[-+](\d{2}):([0-5]\d)(?::([0-5]\d))?$/.exec(value);
  return !!match && Number(match[1]) <= 18 &&
    (Number(match[1]) < 18 || (Number(match[2]) === 0 && Number(match[3] || 0) === 0));
}
function typedFootprint(value) {
  if (value === null) return;
  if (typeof value !== 'string' || Buffer.byteLength(value) > 2048) invalid();
  let parsed;
  try { parsed = decodeJson(value); } catch { invalid(); }
  if (parsed?.kind === 'instant' && Object.keys(parsed).join(',') === 'kind,time,zoneOffset' &&
      typedUtc(parsed.time) && typedOffset(parsed.zoneOffset)) return;
  if (parsed?.kind === 'interval' && Object.keys(parsed).join(',') ===
      'kind,startTime,endTime,startZoneOffset,endZoneOffset' && typedUtc(parsed.startTime) &&
      typedUtc(parsed.endTime) && typedOffset(parsed.startZoneOffset) && typedOffset(parsed.endZoneOffset)) return;
  invalid();
}
function validateTypedControls(value, catalog, sources) {
  boundedArray(value.tombstones, 10000); boundedArray(value.deletionGuards, 10000);
  const tombstones = new Map(), guards = new Set();
  for (const control of value.tombstones) {
    keys(control, ['identity', 'sourceStreamKey', 'sourceSequence']);
    const key = typedIdentity(control.identity, catalog, sources);
    typedProvenance(control.sourceStreamKey, control.sourceSequence, control.identity);
    if (tombstones.has(key)) invalid();
    tombstones.set(key, control);
  }
  for (const control of value.deletionGuards) {
    keys(control, ['identity', 'sourceDeleted', 'userSuppressed', 'sourceStreamKey', 'sourceSequence', 'footprintJson']);
    const key = typedIdentity(control.identity, catalog, sources);
    if (![0, 1].includes(control.sourceDeleted) || ![0, 1].includes(control.userSuppressed) ||
        !(control.sourceDeleted || control.userSuppressed) || guards.has(key)) invalid();
    guards.add(key);
    if (control.sourceDeleted === 1) {
      typedProvenance(control.sourceStreamKey, control.sourceSequence, control.identity);
      const tombstone = tombstones.get(key);
      if (tombstone && (tombstone.sourceStreamKey !== control.sourceStreamKey ||
          tombstone.sourceSequence !== control.sourceSequence)) invalid();
    } else if (control.sourceStreamKey !== null || control.sourceSequence !== null) invalid();
    typedFootprint(control.footprintJson);
  }
}
function validateFamilies(value, descriptors = false, version = VERSION) {
  keys(value, descriptors ? ['catalog', 'recordDescriptors', 'sourcePolicies', 'tombstones', 'suppressions'] :
    version === 2 ? TYPED_FAMILIES : FAMILIES);
  const catalog = value.catalog;
  keys(catalog, ['version', 'logicalTenantId', 'sources']);
  if (catalog.version !== version || typeof catalog.logicalTenantId !== 'string' || !UUID.test(catalog.logicalTenantId)) invalid();
  boundedArray(catalog.sources, 128);
  const sources = new Map();
  for (const source of catalog.sources) {
    keys(source, ['sourceStoreId', 'provider', 'policyRef']);
    if (typeof source.sourceStoreId !== 'string' || !UUID.test(source.sourceStoreId) || source.provider !== 'health-connect-native' ||
        !text(source.policyRef) || sources.has(source.sourceStoreId)) invalid();
    sources.set(source.sourceStoreId, source);
  }
  boundedArray(value.sourcePolicies, 128);
  const policies = new Map();
  for (const policy of value.sourcePolicies) {
    keys(policy, ['id', 'sourceStoreId', 'sharing', 'retainCommittedHistory', 'priorGenerationProvenance']);
    if (!text(policy.id) || !sources.has(policy.sourceStoreId) || policies.has(policy.id) ||
        sources.get(policy.sourceStoreId).policyRef !== policy.id ||
        !['stopped', 'enabled'].includes(policy.sharing) || typeof policy.retainCommittedHistory !== 'boolean' ||
        typeof policy.priorGenerationProvenance !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(policy.priorGenerationProvenance)) invalid();
    policies.set(policy.id, policy);
  }
  if (policies.size !== sources.size || [...sources.values()].some(source => !policies.has(source.policyRef))) invalid();
  const records = descriptors ? value.recordDescriptors : value.records;
  boundedArray(records, 10000);
  const identities = new Set();
  const fields = ['identity', 'nativeKeyJson', 'serializerId', 'serializerVersion', 'dataFamily',
    'projection', 'expectedUtf8Bytes', 'expectedRecordDigest'];
  for (const record of records) {
    keys(record, descriptors ? fields : [...fields, 'recordJson'], ['label']);
    if (!Array.isArray(record.identity) || record.identity.length !== 4 ||
        !record.identity.every(text) || record.identity[0] !== catalog.logicalTenantId ||
        !sources.has(record.identity[1]) || record.nativeKeyJson !== JSON.stringify(record.identity) ||
        identities.has(record.nativeKeyJson) || record.serializerId !== 'health-connect-record' ||
        record.serializerVersion !== 1 || (Object.hasOwn(record, 'label') && !text(record.label)) ||
        record.dataFamily !== 'ordinary' || record.projection !== 'raw-only' ||
        !Number.isSafeInteger(record.expectedUtf8Bytes) || record.expectedUtf8Bytes < 1 ||
        record.expectedUtf8Bytes > MAX_ENTRY_BYTES || !DIGEST.test(record.expectedRecordDigest)) invalid();
    if (version === 2 && typedIdentity(record.identity, catalog, sources) !== record.nativeKeyJson) invalid();
    identities.add(record.nativeKeyJson);
    if (!descriptors) {
      if (typeof record.recordJson !== 'string' || Buffer.byteLength(record.recordJson) !== record.expectedUtf8Bytes ||
          hash(record.recordJson) !== record.expectedRecordDigest) invalid();
      try { if (!object(JSON.parse(record.recordJson))) invalid(); } catch { invalid(); }
    }
  }
  if (version === 2) validateTypedControls(value, catalog, sources);
  else {
    boundedArray(value.tombstones, 10000);
    const tombstones = new Set();
    for (const control of value.tombstones) {
      keys(control, ['tenantId', 'sourceStoreId', 'nativeRecordId', 'knownType', 'reason']);
      const key = JSON.stringify([control.tenantId, control.sourceStoreId, control.knownType, control.nativeRecordId]);
      if (control.tenantId !== catalog.logicalTenantId || !sources.has(control.sourceStoreId) ||
          !text(control.nativeRecordId) || !(control.knownType === null || text(control.knownType)) ||
          control.reason !== 'source-delete' || tombstones.has(key)) invalid();
      tombstones.add(key);
    }
  }
  boundedArray(value.suppressions, 10000);
  for (const control of value.suppressions) {
    keys(control, ['sourceStoreId', 'type', 'startInclusive', 'endExclusive', 'explicitReimportAllowed']);
    if (!sources.has(control.sourceStoreId) || !text(control.type) ||
        typeof control.startInclusive !== 'string' || typeof control.endExclusive !== 'string' ||
        !Number.isFinite(Date.parse(control.startInclusive)) || !Number.isFinite(Date.parse(control.endExclusive)) ||
        Date.parse(control.startInclusive) >= Date.parse(control.endExclusive) || control.explicitReimportAllowed !== false) invalid();
  }
}
function validateEnvelope(envelope, actual, version = VERSION) {
  const countKeys = version === 2 ? TYPED_COUNT_KEYS : COUNT_KEYS;
  keys(envelope, ['version', 'counts', 'sha256']); keys(envelope.counts, countKeys);
  if (envelope.version !== version || !DIGEST.test(envelope.sha256) ||
      countKeys.some(key => !Number.isSafeInteger(envelope.counts[key]) || envelope.counts[key] !== actual[key])) invalid();
}
function preparePublication(baseApproval, inventory, envelope) {
  const binding = assertOwnerApproval(baseApproval);
  const decoded = Buffer.isBuffer(inventory) ? decodeOrdinaryHistory(inventory, envelope) : null;
  const copied = snapshot(decoded ? decoded.inventory : inventory);
  validateFamilies(copied);
  const envelopeJSON = decoded ? decoded.envelopeJSON : boundedJSON(envelope);
  const footer = JSON.parse(envelopeJSON);
  validateEnvelope(footer, counts(copied));
  const inputJSON = decoded ? decoded.inputJSON : boundedJSON(copied);
  if (footer.sha256 !== hash(inputJSON)) invalid();
  const token = Object.freeze({});
  prepared.set(token, { baseApproval, binding, inventory: freeze(copied), envelope: freeze(footer),
    inputJSON, envelopeJSON });
  return token;
}
function encodeOrdinaryHistory(inventory, options) {
  const version = controlVersion(options), copied = snapshot(inventory, version);
  validateFamilies(copied, false, version);
  const inputJSON = boundedJSON(copied), inputBytes = Buffer.from(inputJSON, 'utf8');
  const envelopeJSON = boundedJSON({ version, counts: counts(copied, false, version), sha256: hash(inputBytes) });
  return { inputBytes, footerBytes: Buffer.from(envelopeJSON, 'utf8') };
}
function decodeOrdinaryHistory(inputBytes, footerBytes, options) {
  const version = controlVersion(options);
  if (!Buffer.isBuffer(inputBytes) || !Buffer.isBuffer(footerBytes) ||
      inputBytes.length > MAX_BYTES || footerBytes.length > MAX_BYTES) invalid();
  const input = Buffer.from(inputBytes), footerInput = Buffer.from(footerBytes);
  let inputJSON, envelopeJSON, envelope;
  try {
    const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    inputJSON = utf8.decode(input); envelopeJSON = utf8.decode(footerInput);
    envelope = JSON.parse(envelopeJSON);
  } catch { invalid(); }
  if (!object(envelope)) invalid();
  validateEnvelope(envelope, envelope.counts, version);
  if (hash(input) !== envelope.sha256) invalid();
  let inventory;
  try { inventory = JSON.parse(inputJSON); } catch { invalid(); }
  const copied = snapshot(inventory, version);
  validateFamilies(copied, false, version); validateEnvelope(envelope, counts(copied, false, version), version);
  if (boundedJSON(copied) !== inputJSON ||
      boundedJSON({ version, counts: counts(copied, false, version), sha256: envelope.sha256 }) !== envelopeJSON) invalid();
  return { inputJSON, envelopeJSON, inventory: copied, envelope };
}
function metadata(inventory) {
  return { catalog: inventory.catalog,
    recordDescriptors: inventory.records.map(record => Object.fromEntries(
      Object.entries(record).filter(([key]) => key !== 'recordJson'))),
    sourcePolicies: inventory.sourcePolicies, tombstones: inventory.tombstones, suppressions: inventory.suppressions };
}
function publicationTables(db) {
  return db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE name IN ('health_restore_publication','health_restore_source_owners')").all();
}
function storedTextEncoding(db) {
  const value = db.prepare('PRAGMA encoding').get().encoding;
  const encoding = { 'UTF-8': 'utf-8', 'UTF-16le': 'utf-16le', 'UTF-16be': 'utf-16be' }[value];
  if (!encoding) unavailable();
  return encoding;
}
function storedTextRows(db, table, required, nullable, encoding, tail = '', integers = []) {
  const columns = [...required, ...nullable];
  const projection = columns.map(column => `typeof(${column}) AS __type_${column}, CAST(${column} AS BLOB) AS __bytes_${column}`);
  projection.push(...integers.map(column => `typeof(${column}) AS __type_${column}`));
  const rows = db.prepare(`SELECT *, ${projection.join(', ')} FROM ${table}${tail}`).all();
  const decoder = new TextDecoder(encoding, { fatal: true, ignoreBOM: true });
  return rows.map(row => {
    const decoded = { ...row };
    for (const column of columns) {
      const type = row[`__type_${column}`], bytes = row[`__bytes_${column}`];
      if (type === 'null' && nullable.includes(column) && row[column] === null && bytes === null) {
        decoded[column] = null;
      } else {
        if (type !== 'text' || !(bytes instanceof Uint8Array) || bytes.byteLength > MAX_BYTES * 2) unavailable();
        try { decoded[column] = decoder.decode(bytes); } catch { unavailable(); }
        if (Buffer.byteLength(decoded[column], 'utf8') > MAX_BYTES) unavailable();
      }
      delete decoded[`__type_${column}`]; delete decoded[`__bytes_${column}`];
    }
    for (const column of integers) {
      if (row[`__type_${column}`] !== 'integer') unavailable();
      delete decoded[`__type_${column}`];
    }
    return decoded;
  });
}
function storedHeader(db, encoding) {
  const rows = storedTextRows(db, 'health_restore_publication',
    ['publication_id', 'tenant_id', 'instance_id', 'restore_epoch', 'metadata_json', 'metadata_sha256', 'envelope_json'],
    [], encoding, '', ['singleton', 'version']);
  if (rows.length !== 1) unavailable();
  return rows[0];
}
function storedTypedControls(db, catalog, encoding) {
  const identityColumns = ['tenant_id', 'source_store_id', 'record_type', 'native_record_id'];
  const identity = row => identityColumns.map(column => row[column]);
  const maximumStoredBytes = encoding === 'utf-8' ? MAX_BYTES : MAX_BYTES * 2;
  const readFamily = (table, required, nullable, integers = []) => {
    const fields = [...required, ...nullable];
    const sum = fields.map(column => `COALESCE(length(CAST(${column} AS BLOB)),0)`).join(' + ');
    const size = db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(${sum}),0) AS bytes FROM ${table}`).get();
    if (!Number.isSafeInteger(size.count) || size.count < 0 || size.count > 10000 ||
        !Number.isSafeInteger(size.bytes) || size.bytes < 0 || size.bytes > maximumStoredBytes) unavailable();
    const rows = storedTextRows(db, table, required, nullable, encoding, ' LIMIT 10001', integers);
    if (rows.length !== size.count) unavailable();
    return rows;
  };
  const tombstones = readFamily('health_tombstones', [...identityColumns, 'stream_key', 'sequence'], [])
    .map(row => ({ identity: identity(row), sourceStreamKey: row.stream_key, sourceSequence: row.sequence }));
  const version = db.prepare('SELECT version FROM health_schema_version').get().version;
  const deletionGuards = version === 1 ? [] : readFamily('health_deletion_guards', identityColumns,
    ['source_stream_key', 'source_sequence', 'footprint_json'], ['source_deleted', 'user_suppressed'])
    .map(row => ({ identity: identity(row), sourceDeleted: row.source_deleted, userSuppressed: row.user_suppressed,
      sourceStreamKey: row.source_stream_key, sourceSequence: row.source_sequence, footprintJson: row.footprint_json }));
  const compare = (left, right) => {
    for (let index = 0; index < 4; index++) {
      const order = Buffer.compare(Buffer.from(left.identity[index], 'utf8'), Buffer.from(right.identity[index], 'utf8'));
      if (order) return order;
    }
    return 0;
  };
  const controls = { tombstones, deletionGuards };
  try {
    validateTypedControls(controls, catalog, new Set(catalog.sources.map(source => source.sourceStoreId)));
    tombstones.sort(compare); deletionGuards.sort(compare);
    boundedJSON(controls); // Escaped logical UTF-8 fragment, independently bounded from the header.
  } catch { unavailable(); }
  return controls;
}
function readInSnapshot(db, encoding) {
  const tables = publicationTables(db);
  if (!tables.length) return null;
  if (tables.length !== 2 || tables.some(row => row.type !== 'table' || restorePublicationTables[row.name] !== row.sql)) unavailable();
  nativeRetained(db); // Exact required/optional schemas, indexes and integrity; no original-row immutability claim.
  const sizes = db.prepare('SELECT length(CAST(metadata_json AS BLOB)) AS metadata_bytes, length(CAST(envelope_json AS BLOB)) AS envelope_bytes FROM health_restore_publication').all();
  if (sizes.length !== 1 || !Number.isSafeInteger(sizes[0].metadata_bytes) || !Number.isSafeInteger(sizes[0].envelope_bytes) ||
      sizes[0].metadata_bytes > MAX_BYTES * (encoding && encoding !== 'utf-8' ? 2 : 1) ||
      sizes[0].envelope_bytes > MAX_BYTES * (encoding && encoding !== 'utf-8' ? 2 : 1)) unavailable();
  const rows = db.prepare('SELECT * FROM health_restore_publication').all();
  if (rows.length !== 1) unavailable();
  const row = encoding ? storedHeader(db, encoding) : rows[0];
  if (row.singleton !== 1 || row.version !== VERSION ||
      ![row.publication_id, row.tenant_id, row.instance_id, row.restore_epoch].every(value => typeof value === 'string' && UUID.test(value)) ||
      typeof row.metadata_json !== 'string' || Buffer.byteLength(row.metadata_json) > MAX_BYTES ||
      typeof row.envelope_json !== 'string' || Buffer.byteLength(row.envelope_json) > MAX_BYTES ||
      !DIGEST.test(row.metadata_sha256) || hash(row.metadata_json) !== row.metadata_sha256) unavailable();
  let meta, envelope;
  try {
    meta = JSON.parse(row.metadata_json); envelope = JSON.parse(row.envelope_json);
    validateFamilies(meta, true); validateEnvelope(envelope, counts(meta, true));
  } catch { unavailable(); }
  if (meta.catalog.logicalTenantId !== row.tenant_id) unavailable();
  const ownerSize = db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(length(CAST(tenant_id AS BLOB)) + length(CAST(source_store_id AS BLOB)) + length(CAST(owner_id AS BLOB))),0) AS bytes FROM health_restore_source_owners').get();
  if (ownerSize.count > 128 || ownerSize.bytes > MAX_BYTES * (encoding && encoding !== 'utf-8' ? 2 : 1)) unavailable();
  const owners = encoding ? storedTextRows(db, 'health_restore_source_owners',
    ['tenant_id', 'source_store_id', 'owner_id'], [], encoding, ' ORDER BY source_store_id LIMIT 129') :
    db.prepare('SELECT tenant_id,source_store_id,owner_id FROM health_restore_source_owners ORDER BY source_store_id LIMIT 129').all();
  const expected = new Set(meta.catalog.sources.map(source => source.sourceStoreId));
  if (owners.length !== expected.size || owners.some(owner => owner.tenant_id !== row.tenant_id ||
      !expected.delete(owner.source_store_id) || !text(owner.owner_id)) || expected.size) unavailable();
  return { version: VERSION, publicationId: row.publication_id, tenantId: row.tenant_id,
    instanceId: row.instance_id, restoreEpoch: row.restore_epoch, metadataSha256: row.metadata_sha256,
    counts: envelope.counts, sources: owners.map(owner => ({ sourceStoreId: owner.source_store_id, ownerId: owner.owner_id })) };
}
function readPublication(dbFile = DB_FILE, options) {
  const ordinaryBytes = !!options && options.initialOrdinaryBytes === true;
  const typedControls = !!options && options.initialTypedControls === true;
  const sourcePolicyAuthority = !!options && options.initialSourcePolicyAuthority === true;
  let saved;
  if (ordinaryBytes || typedControls || sourcePolicyAuthority || (options && Object.hasOwn(options, 'initialPreparedToken'))) {
    saved = options.initialPreparedToken && prepared.get(options.initialPreparedToken);
    if (!saved) throw new OwnerApprovalError(409, 'IMPORT_APPROVAL_REQUIRED');
    const current = assertOwnerApproval(saved.baseApproval);
    if (current !== saved.binding || path.resolve(dbFile) !== path.resolve(current.selectedDbFile)) {
      throw new OwnerApprovalError(409, 'IMPORT_APPROVAL_REQUIRED');
    }
  }
  if (sourcePolicyAuthority && (options.controlProfileVersion !== 3 || ordinaryBytes || typedControls)) invalid();
  // This opt-in guard does not turn legacy metadata into complete policy authority.
  if (sourcePolicyAuthority) throw new PublicationError(409, 'IMPORT_SOURCE_POLICY_UNKNOWN');
  if (typedControls && (options.controlProfileVersion !== 2 || ordinaryBytes)) invalid();
  let db, transaction = false, ordinaryOutput, typedOutput;
  try {
    let stat;
    try { stat = fs.lstatSync(dbFile); } catch (error) { if (error.code === 'ENOENT' && !saved) return null; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink()) unavailable();
    db = new DatabaseSync(dbFile, { readOnly: true });
    db.exec('PRAGMA busy_timeout=5000'); db.exec('BEGIN'); transaction = true;
    const encoding = typedControls ? storedTextEncoding(db) : undefined;
    const result = readInSnapshot(db, encoding);
    if (saved) {
      if (!result) unavailable();
      let original, footer;
      try {
        original = JSON.parse(saved.inputJSON); footer = JSON.parse(saved.envelopeJSON);
        validateFamilies(original); validateEnvelope(footer, counts(original));
        if (hash(saved.inputJSON) !== footer.sha256) unavailable();
      } catch { unavailable(); }
      const originalHeader = db.prepare('SELECT * FROM health_restore_publication').get();
      const header = encoding ? storedHeader(db, encoding) : originalHeader;
      if (header.tenant_id !== original.catalog.logicalTenantId ||
          header.metadata_json !== boundedJSON(metadata(original)) || header.envelope_json !== saved.envelopeJSON ||
          result.sources.some(source => source.ownerId !== saved.binding.ownerId)) unavailable();
      const size = db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(length(CAST(record_json AS BLOB))),0) AS bytes FROM health_records').get();
      if (size.count !== original.records.length || size.bytes > MAX_BYTES * (encoding && encoding !== 'utf-8' ? 2 : 1)) unavailable();
      const rows = encoding ? storedTextRows(db, 'health_records',
        ['tenant_id', 'source_store_id', 'record_type', 'native_record_id', 'serializer_id', 'data_family', 'projection', 'record_json'],
        [], encoding, ' LIMIT 10001', ['serializer_version']) :
        db.prepare('SELECT * FROM health_records LIMIT 10001').all();
      const byKey = new Map(rows.map(row => [JSON.stringify([row.tenant_id,row.source_store_id,row.record_type,row.native_record_id]), row]));
      if (rows.length !== original.records.length || byKey.size !== original.records.length) unavailable();
      for (const record of original.records) {
        const row = byKey.get(record.nativeKeyJson);
        if (!row || row.record_json !== record.recordJson || Buffer.byteLength(row.record_json, 'utf8') !== record.expectedUtf8Bytes ||
            hash(row.record_json) !== record.expectedRecordDigest || row.serializer_id !== record.serializerId ||
            row.serializer_version !== record.serializerVersion || row.data_family !== record.dataFamily ||
            row.projection !== record.projection) unavailable();
      }
      if (ordinaryBytes) {
        const source = JSON.parse(header.metadata_json);
        const records = source.recordDescriptors.map((descriptor, index) => {
          const row = byKey.get(descriptor.nativeKeyJson);
          const identity = [row.tenant_id, row.source_store_id, row.record_type, row.native_record_id];
          const values = { ...descriptor, identity, nativeKeyJson: JSON.stringify(identity),
            serializerId: row.serializer_id, serializerVersion: row.serializer_version,
            dataFamily: row.data_family, projection: row.projection, recordJson: row.record_json };
          // Trusted input supplies field order only; every output value comes from the SQL snapshot.
          return Object.fromEntries(Object.keys(original.records[index]).map(key => [key, values[key]]));
        });
        const inventory = { catalog: source.catalog, records, sourcePolicies: source.sourcePolicies,
          tombstones: source.tombstones, suppressions: source.suppressions };
        validateFamilies(inventory);
        ordinaryOutput = { publication: result, inputBytes: Buffer.from(boundedJSON(inventory), 'utf8'),
          footerBytes: Buffer.from(header.envelope_json, 'utf8') };
      }
      if (typedControls) typedOutput = { publication: result, controls: storedTypedControls(db, original.catalog, encoding) };
      if (assertOwnerApproval(saved.baseApproval) !== saved.binding ||
          path.resolve(dbFile) !== path.resolve(saved.binding.selectedDbFile)) {
        throw new OwnerApprovalError(409, 'IMPORT_APPROVAL_REQUIRED');
      }
    }
    db.exec('COMMIT'); transaction = false;
    return typedControls ? typedOutput : ordinaryBytes ? ordinaryOutput : result;
  } catch (error) {
    if (transaction) try { db.exec('ROLLBACK'); } catch {}
    if (error instanceof PublicationError || error instanceof OwnerApprovalError) throw error;
    unavailable();
  } finally { if (db) db.close(); }
}
function sterileCache(targetHome) {
  if (authorityRetained(targetHome)) nonfresh();
  const filename = path.join(targetHome, 'credentials', 'health-connect.json');
  let fd;
  try {
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > HARD_LIMITS.maxBytes) unavailable();
    fd = fs.openSync(filename, 'r');
    const bytes = Buffer.alloc(HARD_LIMITS.maxBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = fs.readSync(fd, bytes, length, bytes.length - length, null);
      if (!read) break;
      length += read;
    }
    const state = decodeJson(bytes.subarray(0, length));
    keys(state, ['version', 'tenantId', 'instanceId', 'restoreEpoch', 'grants', 'connectors']);
    if (state.version !== VERSION || ![state.tenantId, state.instanceId, state.restoreEpoch].every(value => typeof value === 'string' && UUID.test(value)) ||
        !Array.isArray(state.grants) || !Array.isArray(state.connectors)) unavailable();
    if (state.grants.length || state.connectors.length) nonfresh();
    return { tenantId: state.tenantId, instanceId: state.instanceId, restoreEpoch: state.restoreEpoch };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error instanceof PublicationError) throw error;
    unavailable();
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function freshUUID(excluded) {
  for (let attempt = 0; attempt < 16; attempt++) {
    const id = crypto.randomUUID();
    if (!excluded.includes(id)) return id;
  }
  unavailable();
}
function publishPreparedPublication(token) {
  const saved = token && prepared.get(token);
  if (!saved) throw new OwnerApprovalError(409, 'IMPORT_APPROVAL_REQUIRED');
  const current = assertOwnerApproval(saved.baseApproval);
  if (current !== saved.binding) throw new OwnerApprovalError(409, 'IMPORT_APPROVAL_REQUIRED');
  const dbFile = path.resolve(current.selectedDbFile);
  let db, transaction = false, committed = false, result, failure;
  try {
    const stat = fs.lstatSync(dbFile);
    if (!stat.isFile() || stat.isSymbolicLink()) unavailable();
    const cache = sterileCache(current.targetHome);
    db = new DatabaseSync(dbFile);
    db.exec('PRAGMA busy_timeout=5000'); db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA synchronous=FULL'); db.exec('PRAGMA foreign_keys=ON');
    if (db.prepare('PRAGMA journal_mode').get().journal_mode !== 'wal' ||
        db.prepare('PRAGMA synchronous').get().synchronous !== 2) unavailable();
    db.exec('BEGIN IMMEDIATE'); transaction = true;
    if (publicationTables(db).length || nativeRetained(db)) nonfresh();
    const present = db.prepare("SELECT 1 FROM sqlite_schema WHERE name='health_schema_version'").get();
    if (!present) {
      for (const sql of Object.values(nativeTables)) db.exec(sql);
      db.exec('CREATE INDEX health_receipt_sequence_order ON health_batch_receipts (stream_key, length(sequence), sequence)');
      db.prepare('INSERT INTO health_schema_version (version) VALUES (1)').run();
    }
    for (const sql of Object.values(restorePublicationTables)) db.exec(sql);
    const put = db.prepare('INSERT INTO health_records (tenant_id,source_store_id,record_type,native_record_id,serializer_id,serializer_version,data_family,projection,record_json) VALUES (?,?,?,?,?,?,?,?,?)');
    for (const record of saved.inventory.records) put.run(...record.identity, record.serializerId,
      record.serializerVersion, record.dataFamily, record.projection, record.recordJson);
    const putOwner = db.prepare('INSERT INTO health_restore_source_owners (tenant_id,source_store_id,owner_id) VALUES (?,?,?)');
    for (const source of saved.inventory.catalog.sources) putOwner.run(saved.inventory.catalog.logicalTenantId, source.sourceStoreId, current.ownerId);
    const metaJSON = boundedJSON(metadata(saved.inventory));
    const publicationId = crypto.randomUUID();
    const excluded = cache ? [cache.instanceId, cache.restoreEpoch] : [];
    const instanceId = freshUUID(excluded), restoreEpoch = freshUUID([...excluded, instanceId]);
    db.prepare('INSERT INTO health_restore_publication (singleton,version,publication_id,tenant_id,instance_id,restore_epoch,metadata_json,metadata_sha256,envelope_json) VALUES (1,1,?,?,?,?,?,?,?)')
      .run(publicationId, saved.inventory.catalog.logicalTenantId, instanceId, restoreEpoch,
        metaJSON, hash(metaJSON), boundedJSON(saved.envelope));
    result = readInSnapshot(db);
    const rawSize = db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(length(CAST(record_json AS BLOB))),0) AS bytes FROM health_records').get();
    if (rawSize.count !== saved.inventory.records.length || rawSize.bytes > MAX_BYTES) invalid();
    const raw = db.prepare('SELECT * FROM health_records LIMIT 10001').all();
    if (raw.length !== saved.inventory.records.length) invalid();
    const byKey = new Map(raw.map(row => [JSON.stringify([row.tenant_id,row.source_store_id,row.record_type,row.native_record_id]), row]));
    for (const record of saved.inventory.records) {
      const row = byKey.get(record.nativeKeyJson);
      if (!row || row.record_json !== record.recordJson || hash(row.record_json) !== record.expectedRecordDigest ||
          row.serializer_id !== record.serializerId || row.serializer_version !== record.serializerVersion ||
          row.data_family !== record.dataFamily || row.projection !== record.projection) invalid();
    }
    if (assertOwnerApproval(saved.baseApproval) !== current || path.resolve(current.selectedDbFile) !== dbFile) {
      throw new OwnerApprovalError(409, 'IMPORT_APPROVAL_REQUIRED');
    }
    if (JSON.stringify(sterileCache(current.targetHome)) !== JSON.stringify(cache)) nonfresh();
    db.exec('COMMIT'); transaction = false; committed = true;
  } catch (error) {
    if (transaction) try { db.exec('ROLLBACK'); } catch {}
    failure = committed ? new PublicationError(503, 'COMMITTED_PENDING_RECOVERY', result) :
      error instanceof PublicationError || error instanceof OwnerApprovalError ? error :
      new PublicationError(503, 'storage-unavailable');
  } finally {
    if (db) try { db.close(); } catch {
      if (committed) failure = new PublicationError(503, 'COMMITTED_PENDING_RECOVERY', result);
      else if (!failure) failure = new PublicationError(503, 'storage-unavailable');
    }
  }
  if (failure) throw failure;
  return result;
}
module.exports = { preparePublication, publishPreparedPublication, readPublication, PublicationError,
  encodeOrdinaryHistory, decodeOrdinaryHistory };
