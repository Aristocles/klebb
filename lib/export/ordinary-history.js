// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const { nativeTables, restorePublicationTables } = require('../health-connect/schema');
const { nativeRetained } = require('../import/target-native');
const { decodeOrdinaryHistory } = require('../import/native-publication');
const { reconstruct } = require('../datastore/shape');

const MAX_BYTES = 16777216;
const MAX_ENTRY_BYTES = 1048576;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const PAYLOAD = 'data/health-connect/ordinary-history.json';
const FOOTER = 'data/health-connect/ordinary-history-footer.json';
const unavailable = () => { throw new Error('native-history-source-unavailable'); };
const unsupported = () => { throw new Error('native-history-export-unsupported'); };
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const quote = name => '"' + name.replaceAll('"', '""') + '"';

// Bound every physical TEXT column before SELECT materializes any strings.
// SQLite may store UTF-16; decode the actual bytes instead of accepting the
// replacement characters that a convenience TEXT read could introduce.
function textRows(db, table, fields, integers, encoding, maxRows, maxTextBytes) {
  if (db.prepare(`SELECT 1 FROM ${quote(table)} WHERE ${fields.map(name =>
    `typeof(${quote(name)}) <> 'text'`).join(' OR ')} LIMIT 1`).get()) unavailable();
  const lengths = fields.map(name => `COALESCE(length(CAST(${quote(name)} AS BLOB)),0)`);
  const size = db.prepare(`SELECT COUNT(*) AS count,
    COALESCE(SUM(${lengths.join('+')}),0) AS bytes,
    COALESCE(MAX(max(${lengths.join(',')})),0) AS largest FROM ${quote(table)}`).get();
  const factor = encoding === 'utf-8' ? 1 : 2;
  if (!Number.isSafeInteger(size.count) || size.count > maxRows ||
      !Number.isSafeInteger(size.bytes) || size.bytes > MAX_BYTES * factor ||
      !Number.isSafeInteger(size.largest) || size.largest > maxTextBytes * factor) unavailable();
  const aliases = fields.flatMap((name, index) => [
    `typeof(${quote(name)}) AS type_${index}`, `CAST(${quote(name)} AS BLOB) AS bytes_${index}`,
  ]).concat(integers.map((name, index) => `typeof(${quote(name)}) AS integer_${index}`));
  const columns = [...fields, ...integers].map(quote).join(',');
  const rows = db.prepare(`SELECT ${columns},${aliases.join(',')} FROM ${quote(table)}`).all();
  const decoder = new TextDecoder(encoding, { fatal: true, ignoreBOM: true });
  let utf8Bytes = 0;
  for (const row of rows) {
    for (const [index, name] of fields.entries()) {
      if (row['type_' + index] !== 'text' || !(row['bytes_' + index] instanceof Uint8Array)) unavailable();
      try { row[name] = decoder.decode(row['bytes_' + index]); } catch { unavailable(); }
      const length = Buffer.byteLength(row[name], 'utf8');
      utf8Bytes += length;
      if (length > maxTextBytes || utf8Bytes > MAX_BYTES) unavailable();
      delete row['type_' + index]; delete row['bytes_' + index];
    }
    for (const [index, name] of integers.entries()) {
      if (row['integer_' + index] !== 'integer' || !Number.isSafeInteger(row[name])) unavailable();
      delete row['integer_' + index];
    }
  }
  return rows;
}

function legacySnapshot(db, encoding) {
  const found = db.prepare("SELECT type,name FROM sqlite_schema WHERE name IN ('schema_version','cards','rows','hae_pushes','hae_samples')").all();
  const hae = found.filter(row => row.name.startsWith('hae_'));
  if (hae.length && (hae.length !== 2 || hae.some(row => row.type !== 'table'))) unavailable();
  const haeColumns = { hae_pushes: 'push_seq,received_at,source_file',
    hae_samples: 'hash,metric,metric_meta,sample_date,doc,dup_count,push_ord,first_push,last_push' };
  for (const row of hae) {
    if (db.prepare(`PRAGMA table_info(${quote(row.name)})`).all().map(column => column.name).join(',') !== haeColumns[row.name]) unavailable();
    if (db.prepare(`SELECT 1 FROM ${quote(row.name)} LIMIT 1`).get()) unsupported();
  }
  const legacy = found.filter(row => !row.name.startsWith('hae_'));
  const values = new Map(), updated = new Map();
  if (legacy.length) {
    if (legacy.length !== 3 || legacy.some(row => row.type !== 'table')) unavailable();
    const versions = db.prepare('SELECT version FROM schema_version').all();
    if (versions.length !== 1 || versions[0].version !== 1) unavailable();
    const cards = textRows(db, 'cards', ['card_id', 'shape', 'data_updated_at'], [],
      encoding, 10000, MAX_ENTRY_BYTES);
    const rows = textRows(db, 'rows', ['card_id', 'container', 'doc'], ['seq'],
      encoding, 10000, MAX_ENTRY_BYTES);
    const byCard = new Map(cards.map(card => [card.card_id, []]));
    if (byCard.size !== cards.length) unavailable();
    for (const row of rows) {
      if (!byCard.has(row.card_id) || !(row.container === '__rest__' || row.container === '__doc__' ||
          row.container.startsWith('c:'))) unavailable();
      byCard.get(row.card_id).push(row);
    }
    for (const card of cards) {
      const containers = Object.create(null);
      let rest = null;
      const ordered = byCard.get(card.card_id).sort((a, b) =>
        a.container < b.container ? -1 : a.container > b.container ? 1 : a.seq - b.seq);
      for (const row of ordered) {
        const doc = JSON.parse(row.doc);
        if (row.container === '__rest__') rest = doc;
        else if (row.container === '__doc__') containers.__doc__ = [doc];
        else (containers[row.container.slice(2)] ||= []).push(doc);
      }
      values.set(card.card_id, reconstruct({ shape: JSON.parse(card.shape), containers, rest }));
      updated.set(card.card_id, card.data_updated_at);
    }
  }
  // A detached view: no database handle, DDL or writable API escapes capture.
  return { getData: id => values.get(id), dataUpdatedAt: id => updated.get(id) ?? null };
}

// The caller owns a read-only SQL transaction. This initial profile represents
// a persisted publication only; it cannot omit live transport/deletion state.
function readOrdinaryHistory(db) {
  nativeRetained(db);
  const schema = { ...nativeTables, ...restorePublicationTables };
  const tables = db.prepare("SELECT name,sql FROM sqlite_schema WHERE type IN ('table','view') AND lower(name) GLOB 'health_*'").all();
  if (tables.length !== Object.keys(schema).length || tables.some(row => schema[row.name] !== row.sql)) unavailable();
  const objects = db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE type IN ('index','trigger') AND (lower(tbl_name) GLOB 'health_*' OR lower(name) GLOB 'health_*')").all();
  const receiptIndex = 'CREATE INDEX health_receipt_sequence_order ON health_batch_receipts (stream_key, length(sequence), sequence)';
  if (objects.some(row => !(row.type === 'index' && row.sql === null && row.name.startsWith('sqlite_autoindex_')) &&
      !(row.type === 'index' && row.name === 'health_receipt_sequence_order' && row.sql === receiptIndex))) unavailable();
  for (const name of Object.keys(nativeTables)) {
    if (name === 'health_schema_version' || name === 'health_records') continue;
    if (db.prepare(`SELECT 1 FROM ${quote(name)} LIMIT 1`).get()) unsupported();
  }
  const encoding = { 'UTF-8': 'utf-8', 'UTF-16le': 'utf-16le', 'UTF-16be': 'utf-16be' }[
    db.prepare('PRAGMA encoding').get().encoding];
  if (!encoding) unavailable();
  const headerFields = ['publication_id', 'tenant_id', 'instance_id', 'restore_epoch',
    'metadata_json', 'metadata_sha256', 'envelope_json'];
  const headers = textRows(db, 'health_restore_publication', headerFields, ['singleton', 'version'],
    encoding, 1, MAX_BYTES);
  const header = headers[0];
  if (headers.length !== 1 || header.singleton !== 1 || header.version !== 1 ||
      ![header.publication_id, header.tenant_id, header.instance_id, header.restore_epoch].every(x => UUID.test(x)) ||
      header.metadata_sha256 !== 'sha256:' + sha(Buffer.from(header.metadata_json, 'utf8'))) unavailable();
  let meta;
  try { meta = JSON.parse(header.metadata_json); } catch { unavailable(); }
  if (!meta || Object.keys(meta).join(',') !== 'catalog,recordDescriptors,sourcePolicies,tombstones,suppressions' ||
      JSON.stringify(meta) !== header.metadata_json || !Array.isArray(meta.recordDescriptors) ||
      meta.recordDescriptors.length > 10000 || !Array.isArray(meta.catalog?.sources) || meta.catalog.sources.length > 128) unavailable();
  const rows = textRows(db, 'health_records', ['tenant_id', 'source_store_id', 'record_type',
    'native_record_id', 'serializer_id', 'data_family', 'projection', 'record_json'], ['serializer_version'],
  encoding, 10000, MAX_ENTRY_BYTES);
  if (rows.length !== meta.recordDescriptors.length) unavailable();
  const byKey = new Map(rows.map(row => [JSON.stringify([
    row.tenant_id, row.source_store_id, row.record_type, row.native_record_id]), row]));
  if (byKey.size !== rows.length) unavailable();
  const descriptorFields = ['identity', 'nativeKeyJson', 'serializerId', 'serializerVersion',
    'dataFamily', 'projection', 'expectedUtf8Bytes', 'expectedRecordDigest'];
  const records = meta.recordDescriptors.map(descriptor => {
    if (!descriptor || typeof descriptor !== 'object' || !Array.isArray(descriptor.identity) ||
        !descriptorFields.every(key => Object.hasOwn(descriptor, key)) ||
        Object.keys(descriptor).some(key => key !== 'label' && !descriptorFields.includes(key))) unavailable();
    const row = byKey.get(JSON.stringify(descriptor.identity));
    if (!row || descriptor.nativeKeyJson !== JSON.stringify(descriptor.identity) ||
        row.serializer_id !== descriptor.serializerId || row.serializer_version !== descriptor.serializerVersion ||
        row.data_family !== descriptor.dataFamily || row.projection !== descriptor.projection) unavailable();
    byKey.delete(descriptor.nativeKeyJson);
    // The stored descriptor preserves all other field positions. The initial
    // supported layout places recordJson after identity; the ORIGINAL footer
    // must authenticate the reconstruction. Unknown layouts remain refused.
    return Object.fromEntries(Object.entries(descriptor).flatMap(([key, value]) =>
      key === 'identity' ? [[key, value], ['recordJson', row.record_json]] : [[key, value]]));
  });
  if (byKey.size || meta.catalog.logicalTenantId !== header.tenant_id) unavailable();
  const owners = textRows(db, 'health_restore_source_owners', ['tenant_id', 'source_store_id', 'owner_id'],
    [], encoding, 128, MAX_ENTRY_BYTES);
  const expectedSources = new Set(meta.catalog.sources.map(source => source.sourceStoreId));
  if (owners.length !== expectedSources.size || owners.some(owner => owner.tenant_id !== header.tenant_id ||
      !owner.owner_id.length || !expectedSources.delete(owner.source_store_id)) || expectedSources.size) unavailable();
  const inputBytes = Buffer.from(JSON.stringify({ catalog: meta.catalog, records,
    sourcePolicies: meta.sourcePolicies, tombstones: meta.tombstones, suppressions: meta.suppressions }), 'utf8');
  const footerBytes = Buffer.from(header.envelope_json, 'utf8');
  try { decodeOrdinaryHistory(inputBytes, footerBytes); } catch { unavailable(); }
  return { inputBytes, footerBytes, legacy: legacySnapshot(db, encoding) };
}

function writeOrdinaryHistory(target, snapshot) {
  const entries = {};
  for (const [name, relative, bytes] of [
    ['payload', PAYLOAD, snapshot.inputBytes], ['footer', FOOTER, snapshot.footerBytes],
  ]) {
    const file = path.join(target, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
    // Hash the written bytes, not only the intended buffer.
    const actual = fs.readFileSync(file);
    if (!actual.equals(bytes)) throw new Error('ordinary-history-output-unavailable');
    entries[name] = { file: relative, bytes: actual.length, sha256: sha(actual) };
  }
  return { version: 1, ...entries };
}

function writeOrdinaryManifest(target, manifest) {
  const file = path.join(target, 'klebb-export.json');
  const temporary = file + '.tmp';
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');
  let owned = false;
  try {
    const descriptor = fs.openSync(temporary, 'wx', 0o600);
    owned = true;
    try { fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); }
    finally { fs.closeSync(descriptor); }
    if (!fs.readFileSync(temporary).equals(bytes)) throw new Error('ordinary-history-output-unavailable');
    fs.renameSync(temporary, file);
    owned = false;
  } finally {
    if (owned) fs.unlinkSync(temporary);
  }
}

module.exports = { readOrdinaryHistory, writeOrdinaryHistory, writeOrdinaryManifest, PAYLOAD, FOOTER };
