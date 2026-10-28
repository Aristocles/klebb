// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Stopped-child synthetic storage controls. No authority/ACK/restore claim.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const home = path.resolve(process.env.HEALTH_HOME || '');
assert.equal(path.dirname(home), path.resolve(os.tmpdir()));
assert.ok(path.basename(home).startsWith('eh-test-'));
assert.equal(fs.lstatSync(home).isSymbolicLink(), false);
const database = path.join(home, 'db', 'klebb.db');
const root = path.resolve(__dirname, '../..');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
let db;
function argument(item) {
  if (item && typeof item === 'object' && item.blobHex !== undefined) {
    return Buffer.from(item.blobHex, 'hex');
  }
  return item;
}
try {
  let result;
  if (input.command === 'migrate') {
    result = require(path.join(root, 'lib/health-connect/history')).withHistoryTransaction(
      (writer, metadata) => ({
        version: writer.prepare('SELECT version FROM health_schema_version').get().version,
        guardCount: writer.prepare('SELECT count(*) AS n FROM health_deletion_guards').get().n,
        metadata,
      }), { deletionSchema: true, ...(process.platform === 'win32' ?
        { windowsDevelopment: true } : {}) });
  } else if (input.command === 'authority') {
    const filename = path.join(home, 'credentials', 'health-connect.json');
    const state = JSON.parse(fs.readFileSync(filename, 'utf8'));
    const connector = state.connectors.find(item => item.sourceStoreId === input.sourceStoreId);
    assert.ok(connector);
    if (input.generation !== undefined) connector.generations[input.recordType] = input.generation;
    if (input.installationId !== undefined) connector.installationId = input.installationId;
    if (input.restoreEpoch !== undefined) state.restoreEpoch = input.restoreEpoch;
    fs.writeFileSync(filename, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
    result = { controlled: true };
  } else if (input.command === 'bulk-stage') {
    // Fixed stopped-storage boundary inventory, not real upload/ACK/capacity.
    db = new DatabaseSync(database);
    db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; '
      + 'PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
    db.exec('DELETE FROM health_object_staging');
    const stage = db.prepare('INSERT INTO health_object_staging VALUES (?,?,?,?,?)');
    const part = db.prepare('INSERT INTO health_object_parts VALUES (?,?,?,?)');
    const hash = bytes => 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex');
    const createdAt = Date.now();
    for (let index = 0; index < input.objectCount; index++) {
      const header = structuredClone(input.header);
      header.binding.generation = String(index + 10);
      header.binding.installationId = `synthetic-bulk-${index}`;
      header.objectId = `synthetic-bulk-${index}`;
      header.batchId = `synthetic-bulk-${index}`;
      header.sequence = '1';
      const sizes = input.objectPartSizes?.[index] || input.partSizes || Array(input.partsPerObject).fill(1);
      header.partCount = sizes.length; header.totalBytes = sizes.reduce((sum, size) => sum + size, 0);
      const bytes = sizes.map(size => Buffer.alloc(size, 80));
      header.objectDigest = hash(Buffer.concat(bytes));
      const b = header.binding;
      const key = JSON.stringify([b.tenantId, b.instanceId, b.sourceStoreId,
        b.installationId, header.recordType, b.generation, b.restoreEpoch]);
      stage.run(key, JSON.stringify(header), createdAt, createdAt + 86400000, header.totalBytes);
      for (let position = 0; position < bytes.length; position++) {
        part.run(key, position, bytes[position], hash(bytes[position]));
      }
      if (input.extraPart && index === 0) part.run(key, sizes.length, Buffer.from('P'), hash(Buffer.from('P')));
    }
    db.exec('COMMIT');
    result = { controlled: true, objects: input.objectCount };
  } else if (input.command === 'sql') {
    db = new DatabaseSync(database);
    db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON');
    if (input.foreignKeysOff) db.exec('PRAGMA foreign_keys=OFF');
    db.exec('BEGIN IMMEDIATE');
    for (const operation of input.operations) {
      const params = (operation.params || []).map(argument);
      if (operation.repeat) {
        const statement = db.prepare(operation.sql);
        for (const values of operation.repeat) statement.run(...values.map(argument));
      } else if (params.length) db.prepare(operation.sql).run(...params);
      else db.exec(operation.sql);
    }
    db.exec('COMMIT');
    if (input.vacuum) {
      db.exec('VACUUM; PRAGMA wal_checkpoint(TRUNCATE)');
      assert.equal(db.prepare('PRAGMA freelist_count').get().freelist_count, 0);
    }
    result = { controlled: true };
  } else throw new Error('Unexpected controlled-state command');
  process.stdout.write(JSON.stringify({ ok: true, result }) + '\n');
} catch (error) {
  if (db) try { db.exec('ROLLBACK'); } catch {}
  process.stdout.write(JSON.stringify({ ok: false, code: error.code ?? null,
    status: error.status ?? null, sqliteResult: error.errcode ?? null }) + '\n');
  process.exitCode = 1;
} finally { if (db) db.close(); }
