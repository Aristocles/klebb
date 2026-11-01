// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { nativeTables, objectTables, sourceIndexTables, restorePublicationTables, markerV2, guardV2 } =
  require('../health-connect/schema');
const { validateMigrationSchema } = require('../health-connect/guard-migration');
const { decodeJson, HARD_LIMITS } = require('../health-connect/protocol');

const unavailable = () => { throw new Error('target-storage-unavailable'); };
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const quote = name => '"' + name.replaceAll('"', '""') + '"';

// The caller owns a read-only transaction on the explicitly selected target.
function nativeRetained(db) {
  const found = db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE type IN ('table','view') "
    + "AND lower(name) GLOB 'health_*'").all();
  if (found.some(row => row.type !== 'table')) unavailable();
  if (!found.length) {
    if (db.prepare('PRAGMA integrity_check(1)').get()?.integrity_check !== 'ok') unavailable();
    return false;
  }
  const marker = found.find(row => row.name === 'health_schema_version')?.sql;
  const version = marker === markerV2 ? 2 : marker === nativeTables.health_schema_version ? 1 : 0;
  if (!version) unavailable();
  const required = { ...nativeTables, health_schema_version: marker };
  if (version === 2) required.health_deletion_guards = guardV2;
  for (const [name, sql] of Object.entries(required)) {
    if (found.find(row => row.name === name)?.sql !== sql) unavailable();
  }
  const supported = { ...required, ...objectTables, ...sourceIndexTables, ...restorePublicationTables };
  if (found.some(row => supported[row.name] !== row.sql)) unavailable();
  const versions = db.prepare('SELECT version FROM health_schema_version').all();
  if (versions.length !== 1 || versions[0].version !== version) unavailable();
  // Validates complete optional families, required indexes and integrity.
  // It does not create a schema or invoke the migration writer.
  validateMigrationSchema(db);
  return found.some(row => row.name !== 'health_schema_version'
    && !!db.prepare(`SELECT 1 FROM ${quote(row.name)} LIMIT 1`).get());
}

function authorityRetained(targetHome) {
  const file = path.join(targetHome, 'credentials', 'health-connect.json');
  let fd;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > HARD_LIMITS.maxBytes) unavailable();
    fd = fs.openSync(file, 'r');
    // Read at most the original byte limit plus one, even if the file grows.
    const bytes = Buffer.alloc(HARD_LIMITS.maxBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = fs.readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    const state = decodeJson(bytes.subarray(0, length));
    const keys = ['version', 'tenantId', 'instanceId', 'restoreEpoch', 'grants', 'connectors'];
    if (!state || typeof state !== 'object' || Array.isArray(state)
        || Object.keys(state).length !== keys.length || !keys.every(key => Object.hasOwn(state, key))
        || state.version !== 1 || ![state.tenantId, state.instanceId, state.restoreEpoch]
          .every(value => typeof value === 'string' && UUID.test(value))
        || ![state.grants, state.connectors]
          .every(value => Array.isArray(value) && value.length <= 128)) unavailable();
    return state.grants.length > 0 || state.connectors.length > 0;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

module.exports = { nativeRetained, authorityRetained };
