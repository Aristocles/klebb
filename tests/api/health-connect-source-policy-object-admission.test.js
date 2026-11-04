// SPDX-License-Identifier: AGPL-3.0-only
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { sourcePolicyTables } = require('../../lib/health-connect/schema');
const {
  fixture, close, restart, stage, finalise, post, makeObject,
  coldReadNative, coldReadObjects, PART, FINAL,
} = require('../helpers/health-connect-object-test-fixture.cjs');

test('SQL policy refusal precedes both committed object replay paths without changing retained history', async () => {
  const sandboxModule = require.resolve('../helpers/sandbox');
  const ordinarySandbox = require.cache[sandboxModule];
  assert.ok(ordinarySandbox, 'Ordinary sandbox must already be loaded');
  let original;
  delete require.cache[sandboxModule];
  try { original = require('../helpers/legacy-health-producer'); }
  finally { require.cache[sandboxModule] = ordinarySandbox; }
  const data = await fixture({}, original, { legacyProducer: true });
  try {
    const object = makeObject(data.binding, { paddingCount: 32 });
    // This real legacy control proves that both original paths and the exact
    // object bytes are healthy before the new SQL authority boundary is added.
    await stage(data, object);
    await finalise(data, object);
    await data.server.kill();
    data.server = null;
    const db = new DatabaseSync(path.join(data.home, 'db', 'klebb.db'));
    try {
      db.exec('PRAGMA foreign_keys=ON');
      db.exec('BEGIN IMMEDIATE');
      for (const sql of Object.values(sourcePolicyTables)) db.exec(sql);
      db.exec('COMMIT');
    } finally { db.close(); }
    await restart(data);
    const nativeBefore = coldReadNative(data.home);
    const objectsBefore = coldReadObjects(data.home);
    assert.equal(nativeBefore.receipts.length, 1);
    assert.equal(objectsBefore.committedDeclarations.length, 1);
    for (const [route, frame] of [
      [PART, object.partFrames[0]],
      [FINAL, object.finalise],
    ]) {
      const result = await post(data, route, frame);
      assert.equal(result.status, 409, result.body);
      assert.equal(result.json.version, 1);
      assert.equal(result.json.kind, 'error');
      assert.equal(result.json.receipt, undefined);
      assert.deepEqual(coldReadNative(data.home), nativeBefore,
        'SQL refusal must precede replay as well as new raw/receipt/frontier writes');
      assert.deepEqual(coldReadObjects(data.home), objectsBefore,
        'SQL refusal must preserve compact receipts and all physical staging');
    }
  } finally { await close(data); }
});


test('a new stopped namespace preserves healthy retained object history and its original expiry index', async () => {
  const { req, BASE, TYPE, ENV } = require('../helpers/health-connect-object-test-fixture.cjs');
  const fs = require('node:fs');
  const sandboxModule = require.resolve('../helpers/sandbox');
  const ordinarySandbox = require.cache[sandboxModule];
  assert.ok(ordinarySandbox, 'Ordinary sandbox must already be loaded');
  let original;
  delete require.cache[sandboxModule];
  try { original = require('../helpers/legacy-health-producer'); }
  finally { require.cache[sandboxModule] = ordinarySandbox; }
  const data = await fixture({}, original, { legacyProducer: true });
  try {
    const object = makeObject(data.binding, { paddingCount: 32 });
    await stage(data, object);
    await finalise(data, object);
    await data.server.kill(); data.server = null;
    const legacyFile = path.join(data.home, 'credentials', 'health-connect.json');
    const legacyBytes = fs.readFileSync(legacyFile);
    const nativeBefore = coldReadNative(data.home);
    const objectsBefore = coldReadObjects(data.home);
    assert.equal(nativeBefore.receipts.length, 1);
    assert.equal(objectsBefore.committedDeclarations.length, 1);
    const db = new DatabaseSync(path.join(data.home, 'db', 'klebb.db'));
    try {
      assert.equal(db.prepare("SELECT sql FROM sqlite_schema WHERE name='health_object_expiry'")
        .get().sql, 'CREATE INDEX health_object_expiry ON health_object_staging (expires_at)');
      db.exec('PRAGMA foreign_keys=ON');
      db.exec('BEGIN IMMEDIATE');
      for (const sql of Object.values(sourcePolicyTables)) db.exec(sql);
      db.exec('COMMIT');
    } finally { db.close(); }
    await restart(data);
    const result = await req(data.server.baseUrl, `${BASE}/pairing-grants`, {
      method: 'POST', cookie: data.owner.cookie, headers: { Origin: ENV.HEALTH_ORIGIN },
      body: { categories: [TYPE], name: 'Synthetic stopped source' },
    });
    assert.equal(result.status, 201, result.body);
    assert.notEqual(result.json.tenantId, data.binding.tenantId);
    const nativeAfter = coldReadNative(data.home);
    const oldDump = JSON.parse(nativeBefore.logicalNativeDump);
    const afterDump = JSON.parse(nativeAfter.logicalNativeDump);
    assert.deepEqual(Object.keys(afterDump).sort(),
      [...Object.keys(oldDump), ...Object.keys(sourcePolicyTables)].sort());
    for (const table of Object.keys(oldDump)) assert.deepEqual(afterDump[table], oldDump[table],
      `every original retained row and unknown field in ${table} must remain exact`);
    assert.deepEqual({ ...nativeAfter, logicalNativeDump: nativeBefore.logicalNativeDump }, nativeBefore);
    const state = afterDump.health_source_policy_state;
    assert.equal(state.length, 1);
    assert.match(state[0].owner_id, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
    assert.deepEqual(state, [{ version: 1, tenant_id: result.json.tenantId,
      owner_id: state[0].owner_id, epoch: result.json.restoreEpoch, revision: '1',
      knowledge: 'COMPLETE', source_count: 1 }]);
    const sources = afterDump.health_source_policy_sources;
    assert.equal(sources.length, 1);
    assert.match(sources[0].policy_id, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
    assert.deepEqual(sources, [{ tenant_id: result.json.tenantId, source_store_id: result.json.sourceStoreId,
      owner_id: state[0].owner_id, policy_id: sources[0].policy_id, lifecycle: 'active',
      knowledge: 'COMPLETE', retain_committed_history: 1, category_count: 1, reconciled_epoch: null }]);
    assert.deepEqual(afterDump.health_source_policy_categories, [{ tenant_id: result.json.tenantId,
      source_store_id: result.json.sourceStoreId, record_type: TYPE, sharing: 'stopped', generation: '1' }]);
    assert.deepEqual(coldReadObjects(data.home), objectsBefore);
    assert.deepEqual(fs.readFileSync(legacyFile), legacyBytes);
    const read = new DatabaseSync(path.join(data.home, 'db', 'klebb.db'), { readOnly: true });
    try {
      assert.deepEqual(read.prepare('SELECT knowledge,source_count FROM health_source_policy_state WHERE tenant_id=?')
        .all(result.json.tenantId).map(row => ({ ...row })), [{ knowledge: 'COMPLETE', source_count: 1 }]);
      assert.deepEqual(read.prepare('SELECT record_type,sharing,generation FROM health_source_policy_categories WHERE tenant_id=?')
        .all(result.json.tenantId).map(row => ({ ...row })), [{ record_type: TYPE, sharing: 'stopped', generation: '1' }]);
    } finally { read.close(); }
  } finally { await close(data); }
});
