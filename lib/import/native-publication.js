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
const controlVersion = options => {
  if (!options || !Object.hasOwn(options, 'controlProfileVersion')) return VERSION;
  if (![1, 2, 3].includes(options.controlProfileVersion)) invalid();
  return options.controlProfileVersion;
};
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
  const families = version === 3 ? MANAGED_FAMILIES : version === 2 ? TYPED_FAMILIES : FAMILIES;
  keys(inventory, families);
  if (version === 2 || version === 3) validateFamilies(inventory, false, version);
  const copy = {};
  for (const name of families) copy[name] = inventory[name];
  return JSON.parse(boundedJSON(copy));
}
function counts(value, descriptors = false, version = VERSION) {
  if (version === 3) return { namespaces: value.catalog.namespaces.length,
    sources: value.catalog.namespaces.reduce((sum, namespace) => sum + namespace.sources.length, 0),
    categories: value.sourcePolicies.reduce((sum, policy) => sum + policy.sources.reduce((n, source) => n + source.categories.length, 0), 0),
    records: value.records.length, streams: value.streams.length, receipts: value.receipts.length,
    projectionOutbox: value.projectionOutbox.length, tombstones: value.tombstones.length,
    deletionGuards: value.deletionGuards.length, suppressions: value.suppressions.length };
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
const MANAGED_FAMILIES = ['catalog', 'records', 'sourcePolicies', 'streams', 'receipts',
  'projectionOutbox', 'tombstones', 'deletionGuards', 'suppressions'];
const MANAGED_COUNT_KEYS = ['namespaces', 'sources', 'categories', 'records', 'streams', 'receipts',
  'projectionOutbox', 'tombstones', 'deletionGuards', 'suppressions'];
const MANAGED_CATEGORIES = new Set(require('../../config/health-connect-categories.json'));
const unsignedSequence = value => value === '0' || positiveSequence(value);
function managedStream(key, namespaces, categories) {
  if (!text(key) || Buffer.byteLength(key) > 8192) invalid();
  let fields;
  try { fields = decodeJson(key); } catch { invalid(); }
  if (!Array.isArray(fields) || fields.length !== 7 ||
      fields.some(value => typeof value !== 'string' || !value.length || [...value].length > 256) ||
      JSON.stringify(fields) !== key || !UUID.test(fields[1]) || !UUID.test(fields[6]) ||
      !namespaces.get(fields[0])?.has(fields[2]) || !unsignedSequence(fields[5])) invalid();
  const category = categories.get(JSON.stringify([fields[0], fields[2], fields[4]]));
  if (!category || BigInt(fields[5]) > BigInt(category.generation)) invalid();
  return fields;
}
function validateManagedFamilies(value) {
  keys(value, MANAGED_FAMILIES);
  const catalog = value.catalog;
  keys(catalog, ['version', 'ownerRef', 'namespaces']);
  if (catalog.version !== 3 || typeof catalog.ownerRef !== 'string' || !UUID.test(catalog.ownerRef)) invalid();
  boundedArray(catalog.namespaces, 128);
  if (!catalog.namespaces.length) invalid();
  const namespaces = new Map(), categories = new Map();
  for (const namespace of catalog.namespaces) {
    keys(namespace, ['tenantId', 'ownerRef', 'sourceCount', 'sources']);
    if (typeof namespace.tenantId !== 'string' || !UUID.test(namespace.tenantId) ||
        namespace.ownerRef !== catalog.ownerRef || namespaces.has(namespace.tenantId)) invalid();
    boundedArray(namespace.sources, 128);
    if (!namespace.sources.length || namespace.sourceCount !== namespace.sources.length) invalid();
    const sources = new Map();
    for (const source of namespace.sources) {
      keys(source, ['sourceStoreId', 'provider', 'policyRef']);
      if (typeof source.sourceStoreId !== 'string' || !UUID.test(source.sourceStoreId) ||
          source.provider !== 'health-connect-native' || !text(source.policyRef) ||
          sources.has(source.sourceStoreId)) invalid();
      sources.set(source.sourceStoreId, source);
    }
    namespaces.set(namespace.tenantId, sources);
  }
  boundedArray(value.sourcePolicies, 128);
  const policies = new Set();
  for (const policy of value.sourcePolicies) {
    keys(policy, ['tenantId', 'ownerRef', 'revision', 'sourceCount', 'sources']);
    const sources = namespaces.get(policy.tenantId);
    if (!sources || policy.ownerRef !== catalog.ownerRef || policies.has(policy.tenantId) ||
        !positiveSequence(policy.revision)) invalid();
    boundedArray(policy.sources, 128);
    if (policy.sourceCount !== policy.sources.length || policy.sources.length !== sources.size) invalid();
    policies.add(policy.tenantId);
    const seen = new Set();
    for (const source of policy.sources) {
      keys(source, ['sourceStoreId', 'policyId', 'lifecycle', 'retainCommittedHistory', 'categoryCount', 'categories']);
      if (!sources.has(source.sourceStoreId) || seen.has(source.sourceStoreId) ||
          source.policyId !== sources.get(source.sourceStoreId).policyRef ||
          !['active', 'retired'].includes(source.lifecycle) ||
          typeof source.retainCommittedHistory !== 'boolean') invalid();
      seen.add(source.sourceStoreId);
      boundedArray(source.categories, 128);
      if (!source.categories.length || source.categoryCount !== source.categories.length) invalid();
      for (const category of source.categories) {
        keys(category, ['recordType', 'sharing', 'generation']);
        const key = JSON.stringify([policy.tenantId, source.sourceStoreId, category.recordType]);
        if (!MANAGED_CATEGORIES.has(category.recordType) || categories.has(key) ||
            !['enabled', 'stopped'].includes(category.sharing) || !positiveSequence(category.generation)) invalid();
        categories.set(key, category);
      }
    }
  }
  if (policies.size !== namespaces.size) invalid();
  boundedArray(value.records, 10000);
  const identities = new Set();
  for (const record of value.records) {
    keys(record, ['identity', 'nativeKeyJson', 'serializerId', 'serializerVersion', 'dataFamily',
      'projection', 'expectedUtf8Bytes', 'expectedRecordDigest', 'recordJson'], ['label']);
    if (!Array.isArray(record.identity) || record.identity.length !== 4 ||
        !record.identity.every(text)) invalid();
    const sources = namespaces.get(record.identity[0]);
    if (!sources || !categories.has(JSON.stringify(record.identity.slice(0, 3))) ||
        typedIdentity(record.identity, { logicalTenantId: record.identity[0] }, sources) !== record.nativeKeyJson ||
        identities.has(record.nativeKeyJson) || record.serializerId !== 'health-connect-record' ||
        record.serializerVersion !== 1 || record.dataFamily !== 'ordinary' || record.projection !== 'raw-only' ||
        (Object.hasOwn(record, 'label') && !text(record.label)) ||
        !Number.isSafeInteger(record.expectedUtf8Bytes) || record.expectedUtf8Bytes < 1 ||
        record.expectedUtf8Bytes > MAX_ENTRY_BYTES || typeof record.recordJson !== 'string' ||
        Buffer.byteLength(record.recordJson) !== record.expectedUtf8Bytes ||
        !DIGEST.test(record.expectedRecordDigest) || hash(record.recordJson) !== record.expectedRecordDigest) invalid();
    try { if (!object(JSON.parse(record.recordJson))) invalid(); } catch { invalid(); }
    identities.add(record.nativeKeyJson);
  }
  boundedArray(value.streams, 10000);
  const streams = new Map();
  for (const stream of value.streams) {
    keys(stream, ['streamKey', 'recordType', 'acknowledgedSequence']);
    const fields = managedStream(stream.streamKey, namespaces, categories);
    if (stream.recordType !== fields[4] || !unsignedSequence(stream.acknowledgedSequence) ||
        streams.has(stream.streamKey)) invalid();
    streams.set(stream.streamKey, stream);
  }
  boundedArray(value.receipts, 10000);
  const receipts = new Map();
  for (const receipt of value.receipts) {
    keys(receipt, ['streamKey', 'sequence', 'batchId', 'payloadDigest', 'receiptJson']);
    const fields = managedStream(receipt.streamKey, namespaces, categories), stream = streams.get(receipt.streamKey);
    const key = JSON.stringify([receipt.streamKey, receipt.sequence]);
    if (!stream || !positiveSequence(receipt.sequence) ||
        BigInt(receipt.sequence) > BigInt(stream.acknowledgedSequence) || receipts.has(key) ||
        !text(receipt.batchId) || !DIGEST.test(receipt.payloadDigest) || !text(receipt.receiptJson)) invalid();
    let original;
    try { original = JSON.parse(receipt.receiptJson); } catch { invalid(); }
    keys(original, ['version', 'kind', 'binding', 'recordType', 'sequence', 'batchId', 'payloadDigest']);
    keys(original.binding, ['tenantId', 'instanceId', 'sourceStoreId', 'installationId', 'generation', 'restoreEpoch']);
    const tuple = [original.binding.tenantId, original.binding.instanceId, original.binding.sourceStoreId,
      original.binding.installationId, original.recordType, original.binding.generation, original.binding.restoreEpoch];
    if (original.version !== 1 || original.kind !== 'durable-receipt' || JSON.stringify(tuple) !== JSON.stringify(fields) ||
        original.sequence !== receipt.sequence || original.batchId !== receipt.batchId ||
        original.payloadDigest !== receipt.payloadDigest) invalid();
    receipts.set(key, receipt);
  }
  for (const stream of streams.values()) {
    if (stream.acknowledgedSequence !== '0' &&
        !receipts.has(JSON.stringify([stream.streamKey, stream.acknowledgedSequence]))) invalid();
  }
  boundedArray(value.projectionOutbox, 10000);
  const projections = new Set();
  for (const projection of value.projectionOutbox) {
    keys(projection, ['streamKey', 'sequence', 'batchId', 'payloadDigest', 'state']);
    const key = JSON.stringify([projection.streamKey, projection.sequence]), receipt = receipts.get(key);
    if (!receipt || projections.has(key) || projection.batchId !== receipt.batchId ||
        projection.payloadDigest !== receipt.payloadDigest || projection.state !== 'queued') invalid();
    projections.add(key);
  }
  boundedArray(value.tombstones, 10000); boundedArray(value.deletionGuards, 10000);
  for (const control of value.tombstones) keys(control, ['identity', 'sourceStreamKey', 'sourceSequence']);
  for (const control of value.deletionGuards) keys(control,
    ['identity', 'sourceDeleted', 'userSuppressed', 'sourceStreamKey', 'sourceSequence', 'footprintJson']);
  for (const namespace of catalog.namespaces) {
    const belongs = control => Array.isArray(control.identity) && control.identity[0] === namespace.tenantId;
    validateTypedControls({ tombstones: value.tombstones.filter(belongs),
      deletionGuards: value.deletionGuards.filter(belongs) },
    { logicalTenantId: namespace.tenantId }, namespaces.get(namespace.tenantId));
  }
  for (const control of [...value.tombstones, ...value.deletionGuards]) {
    if (!Array.isArray(control.identity) || !categories.has(JSON.stringify(control.identity.slice(0, 3)))) invalid();
    if (control.sourceStreamKey !== null) {
      const fields = managedStream(control.sourceStreamKey, namespaces, categories);
      if (fields[0] !== control.identity[0] || fields[2] !== control.identity[1] ||
          fields[4] !== control.identity[2] ||
          !receipts.has(JSON.stringify([control.sourceStreamKey, control.sourceSequence]))) invalid();
    }
  }
  boundedArray(value.suppressions, 10000);
  const suppressions = new Set();
  for (const control of value.suppressions) {
    keys(control, ['tenantId', 'sourceStoreId', 'type', 'startInclusive', 'endExclusive', 'explicitReimportAllowed']);
    const key = boundedJSON(control);
    if (!categories.has(JSON.stringify([control.tenantId, control.sourceStoreId, control.type])) ||
        !typedUtc(control.startInclusive) || !typedUtc(control.endExclusive) ||
        !Number.isFinite(Date.parse(control.startInclusive)) || !Number.isFinite(Date.parse(control.endExclusive)) ||
        Date.parse(control.startInclusive) >= Date.parse(control.endExclusive) ||
        control.explicitReimportAllowed !== false || suppressions.has(key)) invalid();
    suppressions.add(key);
  }
}
function validateFamilies(value, descriptors = false, version = VERSION) {
  if (version === 3) { if (descriptors) invalid(); validateManagedFamilies(value); return; }
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
  const countKeys = version === 3 ? MANAGED_COUNT_KEYS : version === 2 ? TYPED_COUNT_KEYS : COUNT_KEYS;
  keys(envelope, ['version', 'counts', 'sha256']); keys(envelope.counts, countKeys);
  if (envelope.version !== version || !DIGEST.test(envelope.sha256) ||
      countKeys.some(key => !Number.isSafeInteger(envelope.counts[key]) || envelope.counts[key] !== actual[key])) invalid();
}
function preparePublication(baseApproval, inventory, envelope, options) {
  if (options && options.controlProfileVersion === 3) return prepareManagedPublication(baseApproval, inventory, envelope, options);
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
  if (saved.controlProfileVersion === 3) return publishManagedPublication(saved, current);
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
// Profile 3 restores historical rows; it never restores a collection capability.
function prepareManagedPublication(baseApproval, inventory, envelope, options) {
  keys(options, ['controlProfileVersion']);
  const binding = assertOwnerApproval(baseApproval);
  const encoded = Buffer.isBuffer(inventory) ? { inputBytes: inventory, footerBytes: envelope } :
    encodeOrdinaryHistory(inventory, options);
  const decoded = decodeOrdinaryHistory(encoded.inputBytes, encoded.footerBytes, options);
  if (!Buffer.isBuffer(inventory) && boundedJSON(envelope) !== decoded.envelopeJSON) invalid();
  const policyIds = new Set();
  for (const policy of decoded.inventory.sourcePolicies) for (const source of policy.sources) {
    if (policyIds.has(source.policyId)) invalid();
    policyIds.add(source.policyId);
  }
  // These are the existing selected SQL family's limits, not new wire limits.
  if (decoded.inventory.deletionGuards.some(guard => guard.footprintJson !== null &&
      Buffer.byteLength(guard.footprintJson, 'utf8') > 2048)) invalid();
  const token = Object.freeze({});
  prepared.set(token, { baseApproval, binding, controlProfileVersion: 3,
    inventory: freeze(decoded.inventory), envelope: freeze(decoded.envelope),
    inputJSON: decoded.inputJSON, envelopeJSON: decoded.envelopeJSON });
  return token;
}
function historicalRows(inventory, namespaces, ownerId) {
  const identities = record => ({ tenant_id: record.identity[0], source_store_id: record.identity[1],
    record_type: record.identity[2], native_record_id: record.identity[3] });
  const rows = {
    health_records: inventory.records.map(record => ({ ...identities(record),
      serializer_id: record.serializerId, serializer_version: record.serializerVersion,
      data_family: record.dataFamily, projection: record.projection, record_json: record.recordJson })),
    health_streams: inventory.streams.map(row => ({ stream_key: row.streamKey,
      record_type: row.recordType, acknowledged_sequence: row.acknowledgedSequence })),
    health_batch_receipts: inventory.receipts.map(row => ({ stream_key: row.streamKey,
      sequence: row.sequence, batch_id: row.batchId, payload_digest: row.payloadDigest, receipt_json: row.receiptJson })),
    health_projection_outbox: inventory.projectionOutbox.map(row => ({ stream_key: row.streamKey,
      sequence: row.sequence, batch_id: row.batchId, payload_digest: row.payloadDigest, state: row.state })),
    health_tombstones: inventory.tombstones.map(row => ({ ...identities(row),
      stream_key: row.sourceStreamKey, sequence: row.sourceSequence })),
    health_deletion_guards: inventory.deletionGuards.map(row => ({ ...identities(row),
      source_deleted: row.sourceDeleted, user_suppressed: row.userSuppressed,
      source_stream_key: row.sourceStreamKey, source_sequence: row.sourceSequence, footprint_json: row.footprintJson })),
    health_source_policy_state: inventory.sourcePolicies.map(policy => ({ version: 1,
      tenant_id: policy.tenantId, owner_id: ownerId,
      epoch: namespaces.find(namespace => namespace.tenantId === policy.tenantId).restoreEpoch,
      revision: policy.revision, knowledge: 'COMPLETE', source_count: policy.sourceCount })),
    health_source_policy_sources: inventory.sourcePolicies.flatMap(policy => policy.sources.map(source => ({
      tenant_id: policy.tenantId, source_store_id: source.sourceStoreId, owner_id: ownerId,
      policy_id: source.policyId, lifecycle: source.lifecycle, knowledge: 'COMPLETE',
      retain_committed_history: source.retainCommittedHistory ? 1 : 0,
      category_count: source.categoryCount, reconciled_epoch: null }))),
    health_source_policy_categories: inventory.sourcePolicies.flatMap(policy => policy.sources.flatMap(source =>
      source.categories.map(category => ({ tenant_id: policy.tenantId, source_store_id: source.sourceStoreId,
        record_type: category.recordType, sharing: category.sharing, generation: category.generation })))),
    health_restore_source_owners: inventory.catalog.namespaces.flatMap(namespace => namespace.sources.map(source => ({
      tenant_id: namespace.tenantId, source_store_id: source.sourceStoreId, owner_id: ownerId }))),
  };
  return rows;
}
const HISTORICAL_COLUMNS = Object.freeze({
  health_records: [['tenant_id','source_store_id','record_type','native_record_id','serializer_id','data_family','projection','record_json'], [], ['serializer_version']],
  health_streams: [['stream_key','record_type','acknowledged_sequence'], [], []],
  health_batch_receipts: [['stream_key','sequence','batch_id','payload_digest','receipt_json'], [], []],
  health_projection_outbox: [['stream_key','sequence','batch_id','payload_digest','state'], [], []],
  health_tombstones: [['tenant_id','source_store_id','record_type','native_record_id','stream_key','sequence'], [], []],
  health_deletion_guards: [['tenant_id','source_store_id','record_type','native_record_id'],
    ['source_stream_key','source_sequence','footprint_json'], ['source_deleted','user_suppressed']],
  health_source_policy_state: [['tenant_id','owner_id','epoch','revision','knowledge'], [], ['version','source_count']],
  health_source_policy_sources: [['tenant_id','source_store_id','owner_id','policy_id','lifecycle','knowledge'],
    ['reconciled_epoch'], ['retain_committed_history','category_count']],
  health_source_policy_categories: [['tenant_id','source_store_id','record_type','sharing','generation'], [], []],
  health_restore_source_owners: [['tenant_id','source_store_id','owner_id'], [], []],
});
function historicalFamily(db, table, expected, encoding) {
  const [required, nullable, integers] = HISTORICAL_COLUMNS[table];
  const textColumns = [...required, ...nullable], columns = [...textColumns, ...integers];
  const rowBytes = row => textColumns.reduce((sum, column) => sum +
    (row[column] === null ? 0 : Buffer.byteLength(row[column], 'utf8')), 0);
  const limit = expected.reduce((sum, row) => sum + rowBytes(row), 0);
  const perRow = expected.reduce((maximum, row) => Math.max(maximum, rowBytes(row)), 0);
  const sum = textColumns.map(column => `COALESCE(length(CAST(${column} AS BLOB)),0)`).join(' + ');
  const size = db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(${sum}),0) AS bytes,
    COALESCE(MAX(${sum}),0) AS largest FROM ${table}`).get();
  const factor = encoding === 'utf-8' ? 1 : 2;
  if (!Number.isSafeInteger(size.count) || size.count !== expected.length ||
      !Number.isSafeInteger(size.bytes) || size.bytes < 0 || size.bytes > limit * factor ||
      !Number.isSafeInteger(size.largest) || size.largest < 0 || size.largest > perRow * factor) unavailable();
  // Count and physical-byte bounds precede SELECT of any raw TEXT/BLOB value.
  const actual = storedTextRows(db, table, required, nullable, encoding,
    ` LIMIT ${expected.length + 1}`, integers);
  if (actual.length !== expected.length) unavailable();
  const key = row => JSON.stringify(columns.map(column => row[column]));
  const wanted = expected.map(key).sort(), found = actual.map(key).sort();
  if (wanted.some((value, index) => value !== found[index])) unavailable();
}
function archivedUUIDs(inventory) {
  const result = [];
  const visit = value => {
    if (typeof value === 'string' && UUID.test(value)) result.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (object(value)) Object.values(value).forEach(visit);
  };
  visit(inventory);
  // Instance and epoch UUIDs are embedded inside the exact historical tuple.
  for (const stream of inventory.streams) visit(JSON.parse(stream.streamKey));
  return result;
}
function managedHistoricalInSnapshot(db, ownerId) {
  const tables = publicationTables(db);
  if (!tables.length) return null;
  if (tables.length !== 2 || tables.some(row => row.type !== 'table' || restorePublicationTables[row.name] !== row.sql)) unavailable();
  const encoding = storedTextEncoding(db), factor = encoding === 'utf-8' ? 1 : 2;
  const columns = ['publication_id','tenant_id','instance_id','restore_epoch','metadata_json','metadata_sha256','envelope_json'];
  const sum = columns.map(column => `COALESCE(length(CAST(${column} AS BLOB)),0)`).join(' + ');
  const size = db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(${sum}),0) AS bytes,
    COALESCE(MAX(length(CAST(metadata_json AS BLOB))),0) AS metadata_bytes,
    COALESCE(MAX(length(CAST(envelope_json AS BLOB))),0) AS envelope_bytes FROM health_restore_publication`).get();
  if (size.count !== 1 || !Number.isSafeInteger(size.bytes) || size.bytes > (MAX_BYTES * 2 + 512) * factor ||
      !Number.isSafeInteger(size.metadata_bytes) || size.metadata_bytes > MAX_BYTES * factor ||
      !Number.isSafeInteger(size.envelope_bytes) || size.envelope_bytes > MAX_BYTES * factor) unavailable();
  const header = storedHeader(db, encoding);
  if (header.singleton !== 1 || header.version !== 1 ||
      ![header.publication_id,header.tenant_id,header.instance_id,header.restore_epoch].every(value => UUID.test(value)) ||
      !DIGEST.test(header.metadata_sha256) || hash(header.metadata_json) !== header.metadata_sha256) unavailable();
  let metadata;
  try { metadata = JSON.parse(header.metadata_json); } catch { unavailable(); }
  if (metadata.controlProfileVersion !== 3) return null;
  let decoded;
  try {
    keys(metadata, ['controlProfileVersion','inputJSON','envelopeJSON','namespaces']);
    decoded = decodeOrdinaryHistory(Buffer.from(metadata.inputJSON, 'utf8'),
      Buffer.from(metadata.envelopeJSON, 'utf8'), { controlProfileVersion: 3 });
    if (header.envelope_json !== decoded.envelopeJSON) unavailable();
    boundedArray(metadata.namespaces, 128);
    if (metadata.namespaces.length !== decoded.inventory.catalog.namespaces.length) unavailable();
    const excluded = new Set(archivedUUIDs(decoded.inventory));
    metadata.namespaces.forEach((namespace, index) => {
      keys(namespace, ['tenantId','instanceId','restoreEpoch']);
      if (namespace.tenantId !== decoded.inventory.catalog.namespaces[index].tenantId ||
          !UUID.test(namespace.instanceId) || !UUID.test(namespace.restoreEpoch) ||
          excluded.has(namespace.instanceId) || excluded.has(namespace.restoreEpoch) || namespace.instanceId === namespace.restoreEpoch ||
          namespace.instanceId !== header.instance_id || namespace.restoreEpoch !== header.restore_epoch) unavailable();
    });
    const first = metadata.namespaces[0];
    if (header.tenant_id !== first.tenantId || header.instance_id !== first.instanceId || header.restore_epoch !== first.restoreEpoch) unavailable();
  } catch { unavailable(); }
  nativeRetained(db); // Exact known SQL families/indexes/physical integrity, without a grant inference.
  const marker = db.prepare('SELECT version FROM health_schema_version').all();
  const { sourcePolicySchemaVersion } = require('../health-connect/schema');
  if (marker.length !== 1 || marker[0].version !== 2 || sourcePolicySchemaVersion(db, unavailable) !== 1) unavailable();
  const expected = historicalRows(decoded.inventory, metadata.namespaces, ownerId);
  for (const [table, rows] of Object.entries(expected)) historicalFamily(db, table, rows, encoding);
  return { publication: { version: 1, controlProfileVersion: 3, publicationId: header.publication_id,
    tenantId: header.tenant_id, instanceId: header.instance_id, restoreEpoch: header.restore_epoch,
    namespaces: metadata.namespaces, metadataSha256: header.metadata_sha256, counts: decoded.envelope.counts,
    sources: expected.health_restore_source_owners.map(row => ({ tenantId: row.tenant_id,
      sourceStoreId: row.source_store_id, ownerId: row.owner_id })) },
    inputBytes: Buffer.from(decoded.inputJSON, 'utf8'), footerBytes: Buffer.from(decoded.envelopeJSON, 'utf8') };
}
// The exporter owns a read transaction on this same handle; it cannot substitute another DB.
function readManagedHistorical(db, importActor) {
  const { assertImportActor } = require('./owner-approval');
  const ownerId = assertImportActor(importActor);
  if (!db || db.isTransaction !== true) unavailable();
  try {
    const result = managedHistoricalInSnapshot(db, ownerId);
    if (assertImportActor(importActor) !== ownerId) throw new OwnerApprovalError(403, 'IMPORT_OWNER_MISMATCH');
    return result;
  } catch (error) {
    if (error instanceof OwnerApprovalError || error instanceof PublicationError) throw error;
    unavailable();
  }
}
function publishManagedPublication(saved, current) {
  const { markerV2, guardV2, sourcePolicyTables, sourcePolicySchemaVersion } = require('../health-connect/schema');
  const dbFile = path.resolve(current.selectedDbFile);
  let db, transaction = false, committed = false, result, failure;
  try {
    const stat = fs.lstatSync(dbFile);
    if (!stat.isFile() || stat.isSymbolicLink()) unavailable();
    const cache = sterileCache(current.targetHome);
    const excluded = archivedUUIDs(saved.inventory);
    if (cache) excluded.push(cache.tenantId, cache.instanceId, cache.restoreEpoch);
    const instanceId = freshUUID(excluded); excluded.push(instanceId);
    const restoreEpoch = freshUUID(excluded); excluded.push(restoreEpoch);
    const namespaces = saved.inventory.catalog.namespaces.map(namespace => ({
      tenantId: namespace.tenantId, instanceId, restoreEpoch }));
    const metadataJSON = boundedJSON({ controlProfileVersion: 3, inputJSON: saved.inputJSON,
      envelopeJSON: saved.envelopeJSON, namespaces });
    db = new DatabaseSync(dbFile);
    db.exec('PRAGMA busy_timeout=5000'); db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA synchronous=FULL'); db.exec('PRAGMA foreign_keys=ON');
    if (db.prepare('PRAGMA journal_mode').get().journal_mode !== 'wal' ||
        db.prepare('PRAGMA synchronous').get().synchronous !== 2) unavailable();
    db.exec('BEGIN IMMEDIATE'); transaction = true;
    if (publicationTables(db).length || nativeRetained(db)) nonfresh();
    const present = db.prepare("SELECT 1 FROM sqlite_schema WHERE name='health_schema_version'").get();
    if (!present) {
      for (const [name, sql] of Object.entries(nativeTables)) db.exec(name === 'health_schema_version' ? markerV2 : sql);
      db.exec('CREATE INDEX health_receipt_sequence_order ON health_batch_receipts (stream_key, length(sequence), sequence)');
      db.prepare('INSERT INTO health_schema_version (version) VALUES (2)').run();
      db.exec(guardV2);
    } else if (db.prepare('SELECT version FROM health_schema_version').get().version === 1) {
      db.exec('DROP TABLE health_schema_version'); db.exec(markerV2);
      db.prepare('INSERT INTO health_schema_version (version) VALUES (2)').run(); db.exec(guardV2);
    }
    if (sourcePolicySchemaVersion(db, unavailable) === 0) {
      for (const sql of Object.values(sourcePolicyTables)) db.exec(sql);
    }
    for (const sql of Object.values(restorePublicationTables)) db.exec(sql);
    for (const [table, rows] of Object.entries(historicalRows(saved.inventory, namespaces, current.ownerId))) {
      if (!rows.length) continue;
      const columns = Object.keys(rows[0]);
      const put = db.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
      for (const row of rows) put.run(...columns.map(column => row[column]));
    }
    const first = namespaces[0], publicationId = freshUUID(excluded);
    db.prepare('INSERT INTO health_restore_publication (singleton,version,publication_id,tenant_id,instance_id,restore_epoch,metadata_json,metadata_sha256,envelope_json) VALUES (1,1,?,?,?,?,?,?,?)')
      .run(publicationId, first.tenantId, first.instanceId, first.restoreEpoch,
        metadataJSON, hash(metadataJSON), saved.envelopeJSON);
    const historical = managedHistoricalInSnapshot(db, current.ownerId);
    if (!historical || historical.inputBytes.toString('utf8') !== saved.inputJSON ||
        historical.footerBytes.toString('utf8') !== saved.envelopeJSON) unavailable();
    result = historical.publication;
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
  encodeOrdinaryHistory, decodeOrdinaryHistory, readManagedHistorical };
