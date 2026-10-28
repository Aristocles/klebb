// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Explicit stopped-child SQL controls; they are not capture, ACK or capacity evidence.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { DatabaseSync } = require('node:sqlite');
const { waitFor } = require('./sandbox');
const base = require('./health-connect-source-index-test-fixture.cjs');
const { fixture, close, restart, first, postBatch, noAuthority, assertFirstNative,
  assertFirstIndex, coldReadSourceState, TABLE_NAMES, TYPE, TARGET, STATUS, REBUILD,
  ORIGIN, sha } = base;
const IDS = 100000, STREAMS = 1000, STATUS_BYTES = 1048576;
const ordinal = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const nativeId = n => `limit-record-${String(n).padStart(6, '0')}`;
const digest = () => crypto.createHash('sha256');
const qualified = hash => 'sha256:' + hash.digest('hex');
const hashRow = (hash, row) => hash.update(JSON.stringify(row) + '\n', 'utf8');

// Large synchronous cold hashes can postpone the parent's idle-socket events.
// Keep only this fixture's browser requests unpooled; preserve actual routes,
// authority, the existing 10-second deadline and every independent expectation.
const browserAgent = new http.Agent({ keepAlive: false });
function browserRequest(data, pathname, method, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, data.server.baseUrl);
    assert.equal(url.hostname, '127.0.0.1');
    const request = http.request(url, { method, agent: browserAgent,
      headers: { 'Content-Type': 'application/json', Cookie: data.owner.cookie, Origin: ORIGIN },
    }, response => {
      let text = '';
      response.on('data', bytes => { text += bytes; });
      response.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: response.statusCode, headers: response.headers, body: text, json });
      });
    });
    request.on('error', reject);
    request.setTimeout(10000, () => { request.destroy(new Error('request timeout')); });
    if (body !== null) request.write(JSON.stringify(body));
    request.end();
  });
}
const ownerStatus = data => browserRequest(data, STATUS, 'GET');
const ownerRebuild = data => browserRequest(data, REBUILD, 'POST', {});
async function waitForStatus(data, predicate, { timeoutMs = 10000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  do {
    last = await ownerStatus(data);
    noAuthority(last.body, data);
    if (last.status === 200 && predicate(last.json)) return last;
    await delay(25);
  } while (Date.now() < deadline);
  assert.fail(`Bounded actual source-index status barrier not observed; last status ${last?.status}`);
}

function sandboxFile(data, directory, filename) {
  assert.ok(path.resolve(data.home).startsWith(path.resolve(os.tmpdir()) + path.sep));
  assert.ok(path.basename(data.home).startsWith('eh-test-'));
  const file = path.resolve(data.home, directory, filename);
  assert.equal(path.dirname(file), path.resolve(data.home, directory));
  return file;
}
function database(data, readOnly, action) {
  const db = new DatabaseSync(sandboxFile(data, 'db', 'klebb.db'), { readOnly });
  try {
    db.exec('PRAGMA busy_timeout=5000');
    db.exec(readOnly ? 'BEGIN' : 'BEGIN IMMEDIATE');
    const result = action(db);
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  } finally { db.close(); }
}
async function stop(data) {
  await data.server.kill();
  data.server = null;
}
async function finish(data) {
  if (data.server) await stop(data);
  try { noAuthority(data.requestLogs, data); } finally { await close(data); }
}
async function initialPublished(data) {
  const vector = first(data);
  const saved = await postBatch(data, vector);
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.json, vector.receipt);
  await waitForStatus(data, json => json.target === TARGET &&
    json.sources?.length === 1 && json.sources[0].state === 'current');
  // The common reader is used only before any large inventory is seeded.
  const initial = coldReadSourceState(data.home);
  assertFirstNative(initial.native, data);
  assertFirstIndex(initial.index, data);
  return initial;
}
function tableHash(db, table) {
  assert.match(table, /^[a-z_]+$/);
  const columns = db.prepare(`PRAGMA table_info("${table}")`).all();
  const primary = columns.filter(column => column.pk)
    .sort((a, b) => a.pk - b.pk).map(column => column.name);
  for (const column of primary) assert.match(column, /^[a-z_]+$/);
  const order = primary.length ? primary.map(column => `"${column}"`).join(',') : 'rowid';
  const hash = digest();
  let count = 0;
  for (const row of db.prepare(`SELECT * FROM "${table}" ORDER BY ${order}`).iterate()) {
    hashRow(hash, row);
    count++;
  }
  return { count, hash: qualified(hash) };
}
function snapshot(data) {
  return database(data, true, db => {
    const schema = db.prepare("SELECT name, sql FROM sqlite_schema WHERE type='table' "
      + "AND name GLOB 'health_*' ORDER BY name").all().map(row => ({ ...row }));
    const names = schema.map(row => row.name);
    const native = digest(), derived = digest();
    const tables = {};
    for (const row of schema) {
      const value = tableHash(db, row.name);
      tables[row.name] = value;
      hashRow(TABLE_NAMES.includes(row.name) ? derived : native, [row.name, row.sql, value]);
    }
    const legacy = { cards: tableHash(db, 'cards'), rows: tableHash(db, 'rows') };
    hashRow(native, legacy);
    const count = name => names.includes(name) ? tables[name].count : null;
    const stateRows = names.includes('health_source_index_state') ? db.prepare(
      'SELECT * FROM health_source_index_state WHERE tenant_id=? AND source_store_id=?')
      .all(data.binding.tenantId, data.binding.sourceStoreId).map(row => ({ ...row })) : [];
    const index = digest(), frontiers = digest();
    if (names.includes('health_source_index')) {
      for (const row of db.prepare('SELECT tenant_id,source_store_id,record_type,'
        + 'native_record_id,entry_kind FROM health_source_index '
        + 'ORDER BY tenant_id,source_store_id,record_type,native_record_id').iterate()) {
        hashRow(index, [row.tenant_id, row.source_store_id, row.record_type,
          row.native_record_id, row.entry_kind]);
      }
    }
    if (names.includes('health_source_index_frontiers')) {
      for (const row of db.prepare('SELECT tenant_id,source_store_id,stream_key,record_type,'
        + 'acknowledged_sequence FROM health_source_index_frontiers '
        + 'ORDER BY tenant_id,source_store_id,stream_key').iterate()) {
        hashRow(frontiers, [row.tenant_id, row.source_store_id, row.stream_key,
          row.record_type, row.acknowledged_sequence]);
      }
    }
    return { schema, tables, legacy, nativeHash: qualified(native),
      derivedHash: qualified(derived), records: count('health_records'),
      tombstones: count('health_tombstones'), streams: count('health_streams'),
      indexCount: count('health_source_index'),
      frontierCount: count('health_source_index_frontiers'),
      indexHash: qualified(index), frontierHash: qualified(frontiers), stateRows };
  });
}
function publication(snapshot) {
  return { indexCount: snapshot.indexCount, frontierCount: snapshot.frontierCount,
    indexHash: snapshot.indexHash, frontierHash: snapshot.frontierHash,
    pointers: snapshot.stateRows.filter(row => row.published_at !== null)
      .map(row => ({ tenant_id: row.tenant_id, source_store_id: row.source_store_id,
        published_restore_epoch: row.published_restore_epoch, published_at: row.published_at })) };
}
function seedInventory(data, previousTotal, nextTotal) {
  assert.ok(nextTotal > previousTotal && previousTotal >= 3);
  database(data, false, db => {
    const original = first(data).payload.changes[0];
    const insert = db.prepare('INSERT INTO health_records (tenant_id,source_store_id,record_type,'
      + 'native_record_id,serializer_id,serializer_version,data_family,projection,record_json) '
      + 'VALUES (?,?,?,?,?,?,?,?,?)');
    for (let n = previousTotal - 3; n < nextTotal - 3; n++) {
      const record = structuredClone(original.record);
      record.metadata.id = nativeId(n);
      insert.run(data.binding.tenantId, data.binding.sourceStoreId, TYPE, nativeId(n),
        original.serializerId, original.serializerVersion, original.dataFamily,
        original.projection, JSON.stringify(record));
    }
  });
}
function expectedInventoryHash(data, total) {
  const hash = digest(), b = data.binding;
  for (let n = 0; n < total - 3; n++) {
    hashRow(hash, [b.tenantId, b.sourceStoreId, TYPE, nativeId(n), 'record']);
  }
  for (const [id, kind] of [['raw-a', 'record'], ['raw-b', 'record'],
    ['unknown-deleted-id', 'tombstone']]) {
    hashRow(hash, [b.tenantId, b.sourceStoreId, TYPE, id, kind]);
  }
  return qualified(hash);
}
function streamBinding(data, n, long = false) {
  if (n === 0) return { ...data.binding };
  const prefix = `synthetic-limits-stream-${String(n).padStart(4, '0')}`;
  const installationId = long ? prefix.padEnd(256, 'L') : prefix;
  assert.ok([...installationId].length <= 256);
  return { ...data.binding, installationId };
}
function streamKey(binding) {
  return JSON.stringify([binding.tenantId, binding.instanceId, binding.sourceStoreId,
    binding.installationId, TYPE, binding.generation, binding.restoreEpoch]);
}
function seedStreams(data, previousCount, nextCount, long = false) {
  database(data, false, db => {
    const original = first(data);
    const stream = db.prepare('INSERT INTO health_streams VALUES (?,?,?)');
    const receipt = db.prepare('INSERT INTO health_batch_receipts VALUES (?,?,?,?,?)');
    const queued = db.prepare('INSERT INTO health_projection_outbox VALUES (?,?,?,?,?)');
    for (let n = previousCount; n < nextCount; n++) {
      const binding = streamBinding(data, n, long), key = streamKey(binding);
      const payload = { ...original.payload, binding };
      const payloadDigest = sha(JSON.stringify(payload));
      const saved = { ...original.receipt, binding, payloadDigest };
      assert.equal(saved.sequence, '1');
      stream.run(key, TYPE, '1');
      receipt.run(key, '1', saved.batchId, payloadDigest, JSON.stringify(saved));
      queued.run(key, '1', saved.batchId, payloadDigest, 'queued');
    }
  });
}
function expectedFrontiers(data, count, long = false) {
  return Array.from({ length: count }, (_, n) => {
    const binding = streamBinding(data, n, long);
    return { key: streamKey(binding), binding, recordType: TYPE, acknowledgedSequence: '1' };
  }).sort((a, b) => ordinal(a.key, b.key));
}
function expectedFrontierHash(data, count, long = false) {
  const hash = digest();
  for (const row of expectedFrontiers(data, count, long)) {
    hashRow(hash, [data.binding.tenantId, data.binding.sourceStoreId,
      row.key, TYPE, '1']);
  }
  return qualified(hash);
}
function expectedEncodedStatusBytes(data, count, long = false) {
  const frontiers = expectedFrontiers(data, count, long).map(({ key, ...row }) => row);
  const response = { target: TARGET, sources: [{
    sourceStoreId: data.binding.sourceStoreId, state: 'current',
    saved: { records: 2, tombstones: 1, streams: count, frontiers, complete: true },
    published: { records: 2, tombstones: 1, frontiers,
      restoreEpoch: data.binding.restoreEpoch, publishedAt: '2026-10-28T00:00:00.000Z' },
    currentRestoreEpoch: data.binding.restoreEpoch,
    attempts: { count: 1, limit: 3, nextAt: null }, errorCode: null,
  }] };
  return Buffer.byteLength(JSON.stringify(response), 'utf8');
}
async function coldCurrent(data, identities, streams, identityHash, frontierHash) {
  return waitFor(() => {
    const value = snapshot(data);
    const state = value.stateRows[0];
    return value.indexCount === identities && value.frontierCount === streams &&
      value.indexHash === identityHash && value.frontierHash === frontierHash &&
      state?.state === 'current' && state.published_restore_epoch === data.binding.restoreEpoch ?
      value : null;
  }, { timeoutMs: 15000, what: 'actual bounded cold source-index publication' });
}
async function queued(data) {
  const response = await ownerRebuild(data);
  noAuthority(response.body, data);
  assert.equal(response.status, 202);
  assert.deepEqual(response.json, { target: TARGET, queuedSources: 1 });
}
async function failedLimit(data) {
  return waitForStatus(data, json => json.target === TARGET &&
    json.sources?.length === 1 && json.sources[0].state === 'failed' &&
    json.sources[0].errorCode === 'limit-exceeded');
}
module.exports = { ...base, ownerStatus, ownerRebuild, waitForStatus,
  IDS, STREAMS, STATUS_BYTES, snapshot, publication,
  seedInventory, expectedInventoryHash, seedStreams, expectedFrontierHash,
  expectedFrontiers, expectedEncodedStatusBytes, coldCurrent, initialPublished,
  stop, finish, queued, failedLimit, sandboxFile, database };
