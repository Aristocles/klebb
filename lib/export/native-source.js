// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { decodeJson, HARD_LIMITS } = require('../health-connect/protocol');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const unavailable = () => { throw new Error('native-history-source-unavailable'); };

function regular(file) {
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile()) unavailable();
  return stat;
}

function nativeSchema(file) {
  if (!regular(file)) return false;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=5000; BEGIN');
    const found = db.prepare("SELECT 1 FROM sqlite_schema WHERE type IN ('table','view') "
      + "AND lower(name) GLOB 'health_*' LIMIT 1").get();
    if (!found && db.prepare('PRAGMA integrity_check(1)').get()?.integrity_check !== 'ok') unavailable();
    return !!found;
  } finally {
    try { db.exec('ROLLBACK'); } finally { db.close(); }
  }
}

function authorityRetained(file) {
  const stat = regular(file);
  if (!stat) return false;
  if (stat.size > HARD_LIMITS.maxBytes) unavailable();
  const fd = fs.openSync(file, 'r');
  try {
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
  } finally { fs.closeSync(fd); }
}

function assertLegacyExportableSource(dbFile, authorityFile) {
  let native, retained;
  try {
    native = nativeSchema(dbFile);
    retained = authorityRetained(authorityFile);
  } catch { unavailable(); }
  if (native || retained) throw new Error('native-history-export-unsupported');
}

function readExportableSource(dbFile, authorityFile) {
  let db;
  try {
    if (authorityRetained(authorityFile)) throw new Error('native-history-export-unsupported');
    if (!regular(dbFile)) return null;
    db = new DatabaseSync(dbFile, { readOnly: true });
    db.exec('PRAGMA busy_timeout=5000; BEGIN');
    const native = db.prepare("SELECT 1 FROM sqlite_schema WHERE type IN ('table','view') "
      + "AND lower(name) GLOB 'health_*' LIMIT 1").get();
    if (!native) {
      if (db.prepare('PRAGMA integrity_check(1)').get()?.integrity_check !== 'ok') unavailable();
      return null;
    }
    if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='health_restore_publication'").get()) {
      throw new Error('native-history-export-unsupported');
    }
    return require('./ordinary-history').readOrdinaryHistory(db);
  } catch (error) {
    if (error.message === 'native-history-export-unsupported') throw error;
    unavailable();
  } finally {
    if (db) try { db.exec('ROLLBACK'); } finally { db.close(); }
  }
}

// Consume historical bytes on the same live read-only connection. It is not
// a collection capability and cannot create credentials or a policy catalogue.
function withHistoricalExportSource(dbFile, importActor, work) {
  const { assertImportActor } = require('../import/owner-approval');
  assertImportActor(importActor);
  let db;
  try {
    if (!regular(dbFile)) {
      const result = work(null); assertImportActor(importActor); return result;
    }
    db = new DatabaseSync(dbFile, { readOnly: true });
    db.exec('PRAGMA busy_timeout=5000; BEGIN');
    const captured = require('../import/native-publication').readManagedHistorical(db, importActor);
    if (!captured) {
      db.exec('ROLLBACK'); db.close(); db = null;
      const result = work(null); assertImportActor(importActor); return result;
    }
    const ordinary = require('./ordinary-history');
    const legacy = ordinary.legacySnapshot(db, 'utf-8', { allowHAE: true });
    function* guardedPushes() {
      const iterator = ordinary.readHAEPushesStream(db, 'utf-8');
      for (;;) {
        assertImportActor(importActor);
        if (!db || db.isTransaction !== true) unavailable();
        const result = iterator.next();
        if (result.done) return;
        yield result.value;
      }
    }
    const result = work({ inputBytes: captured.inputBytes, footerBytes: captured.footerBytes,
      controlProfileVersion: 3, legacy, haePushes: guardedPushes() });
    if (result && typeof result.then === 'function') unavailable();
    assertImportActor(importActor);
    return result;
  } finally {
    if (db) try { db.exec('ROLLBACK'); } finally { db.close(); }
  }
}

module.exports = { assertLegacyExportableSource, readExportableSource, withHistoricalExportSource };
