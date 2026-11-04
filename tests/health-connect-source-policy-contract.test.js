// SPDX-License-Identifier: AGPL-3.0-only
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { DatabaseSync } = require('node:sqlite');

const REPO = path.resolve(__dirname, '..');
const TYPES = ['StepsRecord', 'WeightRecord'];
const ORIGIN = 'https://example.test';
const COOKIE = 'a'.repeat(64);
const credential = { id: 'fixture-member', publicKey: Buffer.from('fixture public key').toString('base64') };

async function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'source-policy-contract-'));
  const previous = { home: process.env.HEALTH_HOME, origin: process.env.WEBAUTHN_ORIGIN };
  process.env.HEALTH_HOME = home;
  process.env.WEBAUTHN_ORIGIN = ORIGIN;
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(REPO + path.sep) && !key.startsWith(path.join(REPO, 'node_modules'))) {
      delete require.cache[key];
    }
  }
  const paths = require('../config/paths');
  fs.mkdirSync(paths.DB_DIR, { recursive: true });
  fs.mkdirSync(paths.CREDENTIALS_DIR, { recursive: true });
  fs.mkdirSync(paths.SESSIONS_DIR, { recursive: true });
  const writeCredentials = value => fs.writeFileSync(paths.WEBAUTHN_CREDENTIALS_FILE, JSON.stringify(value));
  writeCredentials({ users: { member: { credentials: [credential] } } });
  fs.writeFileSync(paths.WEBAUTHN_SESSIONS_FILE, JSON.stringify({
    [COOKIE]: { userId: 'member', credentialId: credential.id, created: Date.now(), lastSeen: Date.now() },
  }));
  const schema = require('../lib/health-connect/schema');
  const database = new DatabaseSync(paths.DB_FILE);
  database.exec('PRAGMA foreign_keys=ON');
  for (const sql of Object.values(schema.nativeTables)) database.exec(sql);
  database.exec('CREATE INDEX health_receipt_sequence_order ON health_batch_receipts '
    + '(stream_key, length(sequence), sequence)');
  database.prepare('INSERT INTO health_schema_version(version) VALUES (1)').run();
  for (const sql of Object.values(schema.sourcePolicyTables)) database.exec(sql);
  database.close();
  const policy = require('../lib/health-connect/source-policy');
  const authority = require('../lib/health-connect/authority');
  let action, result, failure;
  const actualResolve = policy.resolveBrowser;
  // Observe genuine custody inside the real handler's active request lifecycle.
  // Abort this fixture request before management publication or allocation.
  const observerStop = new Error('fixture observer completed before publication');
  const server = http.createServer((req, res) => {
    authority.handleHealthConnect(req, res, new URL(req.url, ORIGIN).pathname, () => {
      if (!action) return null;
      const work = action;
      action = null;
      try { result = work(policy.resolveBrowser(req).actor); } catch (error) { failure = error; }
      throw observerStop;
    }).catch(error => { res.writeHead(500); res.end(String(error)); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    policy.resolveBrowser = actualResolve;
    await new Promise(resolve => server.close(resolve));
    if (previous.home === undefined) delete process.env.HEALTH_HOME; else process.env.HEALTH_HOME = previous.home;
    if (previous.origin === undefined) delete process.env.WEBAUTHN_ORIGIN; else process.env.WEBAUTHN_ORIGIN = previous.origin;
    fs.rmSync(home, { recursive: true, force: true });
  });
  const request = (method, route, body) => new Promise((resolve, reject) => {
    const bytes = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port,
      path: route, method, headers: { origin: ORIGIN, cookie: `klebb_session=${COOKIE}`,
        ...(bytes ? { 'content-type': 'application/json', 'content-length': bytes.length } : {}) } }, res => {
      const chunks = [];
      res.on('data', part => chunks.push(part));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)) }));
    });
    req.on('error', reject);
    req.end(bytes);
  });
  const enrol = await request('POST', '/api/connectors/health-connect/pairing-grants',
    { categories: TYPES, name: 'Fixture source' });
  assert.equal(enrol.status, 201, JSON.stringify(enrol.body));
  const tenantId = enrol.body.tenantId;
  const run = async work => {
    action = work; result = undefined; failure = undefined;
    const response = await request('GET', '/api/connectors/health-connect');
    assert.equal(action, null, 'real browser resolver must reach the observer');
    assert.equal(response.status, 503, JSON.stringify(response.body));
    assert.equal(response.body.code, 'storage-unavailable', 'fixture abort precedes management work');
    if (failure) throw failure;
    return result;
  };
  const sql = work => {
    const db = new DatabaseSync(paths.DB_FILE);
    try { return work(db); } finally { db.close(); }
  };
  const write = (actor, work) => policy.withWriteAuthority(actor, work, { tenantId });
  const read = (actor, work) => policy.withReadAuthority(actor, work, { tenantId });
  const expected = snapshot => ({ sourceStoreId: snapshot.sources[0].sourceStoreId,
    epoch: snapshot.epoch, revision: snapshot.revision,
    generations: Object.fromEntries(snapshot.sources[0].categories.map(item => [item.recordType, item.generation])) });
  return { policy, paths, tenantId, sourceStoreId: enrol.body.sourceStoreId,
    instanceId: enrol.body.instanceId, restoreEpoch: enrol.body.restoreEpoch,
    run, sql, write, read, expected, writeCredentials, request };
}

const code = expected => error => error && error.code === expected;

test('POLICY01 real pairing births only a new stopped complete scope', async t => {
  const f = await fixture(t);
  await f.run(actor => f.read(actor, scope => {
    const snapshot = f.policy.snapshot(scope);
    assert.equal(snapshot.tenantId, f.tenantId);
    assert.equal(snapshot.knowledge, 'COMPLETE');
    assert.equal(snapshot.revision, '1');
    assert.equal(snapshot.sourceCount, 1);
    assert.equal(snapshot.sources[0].categoryCount, 2);
    assert.equal(snapshot.sources[0].reconciledEpoch, null);
    assert.deepEqual(snapshot.sources[0].categories.map(item => [item.recordType, item.sharing, item.generation]),
      [['StepsRecord', 'stopped', '1'], ['WeightRecord', 'stopped', '1']]);
  }));
});

test('POLICY02 copied and escaped transaction scopes cannot read or mutate', async t => {
  const f = await fixture(t);
  await f.run(actor => {
    let escaped;
    f.write(actor, scope => {
      escaped = scope;
      assert.throws(() => f.policy.snapshot({ ...scope }), code('IMPORT_SOURCE_POLICY_CAPABILITY_REQUIRED'));
    });
    assert.throws(() => f.policy.snapshot(escaped), code('IMPORT_SOURCE_POLICY_CAPABILITY_REQUIRED'));
  });
});

test('POLICY03 read authority cannot stop and does not leak after snapshot', async t => {
  const f = await fixture(t);
  await f.run(actor => f.read(actor, scope => {
    const before = f.policy.snapshot(scope);
    assert.throws(() => f.policy.stop(scope, f.expected(before)), code('IMPORT_SOURCE_POLICY_CAPABILITY_REQUIRED'));
    assert.deepEqual(f.policy.snapshot(scope), before);
  }));
});

test('POLICY04 stale opaque epoch and revision refuse before a stopped no-op', async t => {
  const f = await fixture(t);
  await f.run(actor => f.write(actor, scope => {
    const before = f.policy.snapshot(scope);
    const expect = f.expected(before);
    assert.throws(() => f.policy.stop(scope, { ...expect, epoch: '00000000-0000-4000-8000-000000000000' }),
      code('binding-mismatch'));
    assert.throws(() => f.policy.stop(scope, { ...expect, revision: '0' }), code('binding-mismatch'));
    assert.deepEqual(f.policy.snapshot(scope), before);
  }));
});

test('POLICY05 a current stopped no-op does not advance revision or generations', async t => {
  const f = await fixture(t);
  await f.run(actor => f.write(actor, scope => {
    const before = f.policy.snapshot(scope);
    f.policy.stop(scope, f.expected(before));
    assert.deepEqual(f.policy.snapshot(scope), before);
  }));
});

test('POLICY06 effective stop advances only the selected type and preserves native history', async t => {
  const f = await fixture(t);
  f.sql(db => {
    db.prepare("UPDATE health_source_policy_state SET revision='12'").run();
    db.prepare("UPDATE health_source_policy_categories SET sharing='enabled',generation='3' WHERE record_type='StepsRecord'").run();
    db.prepare("UPDATE health_source_policy_categories SET generation='8' WHERE record_type='WeightRecord'").run();
    db.prepare("INSERT INTO health_tombstones VALUES (?,?,?,?,?,?)")
      .run(f.tenantId, f.sourceStoreId, 'StepsRecord', 'old-id',
        JSON.stringify([f.tenantId, f.instanceId, f.sourceStoreId,
          '11111111-1111-4111-8111-111111111111', 'StepsRecord', '3', f.restoreEpoch]), '7');
  });
  const oldRows = f.sql(db => db.prepare('SELECT * FROM health_tombstones').all());
  await f.run(actor => f.write(actor, scope => {
    const before = f.policy.snapshot(scope);
    f.policy.stop(scope, { ...f.expected(before), generations: { StepsRecord: '3' } });
    const after = f.policy.snapshot(scope);
    assert.equal(after.revision, '13');
    assert.deepEqual(after.sources[0].categories.map(item => [item.recordType, item.sharing, item.generation]),
      [['StepsRecord', 'stopped', '4'], ['WeightRecord', 'stopped', '8']]);
  }));
  assert.deepEqual(f.sql(db => db.prepare('SELECT * FROM health_tombstones').all()), oldRows);
});

test('POLICY07 retirement retains stopped intent, all sources and history', async t => {
  const f = await fixture(t);
  await f.run(actor => f.write(actor, scope => {
    const before = f.policy.snapshot(scope);
    f.policy.retire(scope, f.expected(before));
    const after = f.policy.snapshot(scope);
    assert.equal(after.revision, '2');
    assert.equal(after.sourceCount, 1);
    assert.equal(after.sources[0].lifecycle, 'retired');
    assert.equal(after.sources[0].retainCommittedHistory, 1);
    assert.deepEqual(after.sources[0].categories.map(item => [item.sharing, item.generation]),
      [['stopped', '2'], ['stopped', '2']]);
  }));
});

test('POLICY08 canonical INT64 generation overflow refuses without mutation', async t => {
  const f = await fixture(t);
  f.sql(db => db.prepare("UPDATE health_source_policy_categories SET sharing='enabled',generation=? WHERE record_type='StepsRecord'")
    .run('9223372036854775807'));
  await f.run(actor => f.write(actor, scope => {
    const before = f.policy.snapshot(scope);
    assert.throws(() => f.policy.stop(scope, { ...f.expected(before),
      generations: { StepsRecord: '9223372036854775807' } }), code('limit-exceeded'));
    assert.deepEqual(f.policy.snapshot(scope), before);
  }));
});

test('POLICY09 wrong connection and fabricated admission scope refuse', async t => {
  const f = await fixture(t);
  await f.run(actor => f.write(actor, scope => {
    const other = new DatabaseSync(f.paths.DB_FILE, { readOnly: true });
    try {
      assert.throws(() => f.policy.assertAdmission(other, scope, {}, 'StepsRecord'),
        code('IMPORT_SOURCE_POLICY_CAPABILITY_REQUIRED'));
    } finally { other.close(); }
    assert.throws(() => f.policy.assertAdmission(null, {}, {}, 'StepsRecord'),
      code('IMPORT_SOURCE_POLICY_CAPABILITY_REQUIRED'));
  }));
});

test('POLICY10 corrupt source counts cannot be treated as complete', async t => {
  const f = await fixture(t);
  f.sql(db => db.prepare('UPDATE health_source_policy_state SET source_count=0').run());
  await assert.rejects(f.run(actor => f.read(actor, scope => f.policy.snapshot(scope))),
    code('IMPORT_SOURCE_POLICY_UNKNOWN'));
});

test('POLICY11 missing native verifier denies enable and reconciliation', async t => {
  const f = await fixture(t);
  await f.run(actor => f.write(actor, scope => {
    const before = f.policy.snapshot(scope);
    assert.throws(() => f.policy.enable(scope, f.expected(before)), code('IMPORT_SOURCE_POLICY_VERIFIER_REQUIRED'));
    assert.throws(() => f.policy.reconcile(scope, f.expected(before)), code('IMPORT_SOURCE_POLICY_VERIFIER_REQUIRED'));
    assert.deepEqual(f.policy.snapshot(scope), before);
  }));
});

test('POLICY12 callback failure rolls back SQL and retains the exact prior sidecar', async t => {
  const f = await fixture(t);
  const sidecar = path.join(f.paths.CREDENTIALS_DIR, 'health-connect-policy.json');
  const bytes = fs.readFileSync(sidecar);
  const rows = f.sql(db => db.prepare('SELECT * FROM health_source_policy_state').all());
  await assert.rejects(f.run(actor => f.write(actor, scope => {
    f.policy.retire(scope, f.expected(f.policy.snapshot(scope)));
    throw new Error('fixture failure before COMMIT');
  })));
  assert.deepEqual(fs.readFileSync(sidecar), bytes);
  assert.deepEqual(f.sql(db => db.prepare('SELECT * FROM health_source_policy_state').all()), rows);
});

test('POLICY13 committed stop survives an actual final sidecar rename refusal and denies recovery', async t => {
  const f = await fixture(t);
  const sidecar = path.join(f.paths.CREDENTIALS_DIR, 'health-connect-policy.json');
  f.sql(db => {
    db.prepare("UPDATE health_source_policy_state SET revision='12'").run();
    db.prepare("UPDATE health_source_policy_categories SET sharing='enabled',generation='3' WHERE record_type='StepsRecord'").run();
    db.prepare("UPDATE health_source_policy_categories SET generation='8' WHERE record_type='WeightRecord'").run();
  });
  const beforeSources = f.sql(db => db.prepare('SELECT * FROM health_source_policy_sources').all());
  const originalRename = fs.renameSync;
  let refused = 0;
  fs.renameSync = function(from, to) {
    if (String(to) === sidecar && JSON.parse(fs.readFileSync(from, 'utf8')).recoveryRequired === false) {
      refused++;
      throw new Error('fixture final publication refusal after SQL COMMIT');
    }
    return originalRename.apply(this, arguments);
  };
  try {
    await assert.rejects(f.run(actor => f.write(actor, scope => {
      const before = f.policy.snapshot(scope);
      f.policy.stop(scope, { ...f.expected(before), generations: { StepsRecord: '3' } });
    })), code('IMPORT_SOURCE_POLICY_RECOVERY_REQUIRED'));
  } finally { fs.renameSync = originalRename; }
  assert.equal(refused, 1, 'no automatic second stop or failed final publication retry');
  assert.equal(JSON.parse(fs.readFileSync(sidecar)).recoveryRequired, true);
  assert.deepEqual(f.sql(db => db.prepare('SELECT revision FROM health_source_policy_state').all())
    .map(row => ({ ...row })), [{ revision: '13' }]);
  assert.deepEqual(f.sql(db => db.prepare('SELECT record_type,sharing,generation FROM health_source_policy_categories ORDER BY record_type').all())
    .map(row => ({ ...row })), [
      { record_type: 'StepsRecord', sharing: 'stopped', generation: '4' },
      { record_type: 'WeightRecord', sharing: 'stopped', generation: '8' },
    ]);
  assert.deepEqual(f.sql(db => db.prepare('SELECT * FROM health_source_policy_sources').all()), beforeSources);
  assert.throws(() => f.policy.readNamespaces(), code('IMPORT_SOURCE_POLICY_RECOVERY_REQUIRED'));
});

test('POLICY14 real SQL COMMIT followed by close error preserves stopped rows and keeps recovery denied', async t => {
  const f = await fixture(t);
  const sidecar = path.join(f.paths.CREDENTIALS_DIR, 'health-connect-policy.json');
  f.sql(db => {
    db.prepare("UPDATE health_source_policy_state SET revision='12'").run();
    db.prepare("UPDATE health_source_policy_categories SET sharing='enabled',generation='3' WHERE record_type='StepsRecord'").run();
    db.prepare("UPDATE health_source_policy_categories SET generation='8' WHERE record_type='WeightRecord'").run();
  });
  const originalExec = DatabaseSync.prototype.exec;
  const originalClose = DatabaseSync.prototype.close;
  const writers = new WeakSet(), committed = new WeakSet();
  let commits = 0, closeFaults = 0;
  DatabaseSync.prototype.exec = function(sql) {
    const result = originalExec.apply(this, arguments);
    if (sql === 'BEGIN IMMEDIATE') writers.add(this);
    if (sql === 'COMMIT' && writers.has(this)) { committed.add(this); commits++; }
    return result;
  };
  DatabaseSync.prototype.close = function() {
    const afterCommit = committed.has(this);
    const result = originalClose.apply(this, arguments);
    if (afterCommit) { closeFaults++; throw new Error('fixture close failure after actual SQL COMMIT'); }
    return result;
  };
  try {
    await assert.rejects(f.run(actor => f.write(actor, scope => {
      const before = f.policy.snapshot(scope);
      f.policy.stop(scope, { ...f.expected(before), generations: { StepsRecord: '3' } });
    })), code('IMPORT_SOURCE_POLICY_RECOVERY_REQUIRED'));
  } finally {
    DatabaseSync.prototype.exec = originalExec;
    DatabaseSync.prototype.close = originalClose;
  }
  assert.equal(commits, 1, 'this fault must follow one observed genuine SQL COMMIT');
  assert.equal(closeFaults, 1);
  assert.equal(JSON.parse(fs.readFileSync(sidecar)).recoveryRequired, true);
  assert.deepEqual(f.sql(db => db.prepare('SELECT revision FROM health_source_policy_state').all())
    .map(row => ({ ...row })), [{ revision: '13' }]);
  assert.deepEqual(f.sql(db => db.prepare('SELECT record_type,sharing,generation FROM health_source_policy_categories ORDER BY record_type').all())
    .map(row => ({ ...row })), [
      { record_type: 'StepsRecord', sharing: 'stopped', generation: '4' },
      { record_type: 'WeightRecord', sharing: 'stopped', generation: '8' },
    ]);
  assert.throws(() => f.policy.readNamespaces(), code('IMPORT_SOURCE_POLICY_RECOVERY_REQUIRED'));
});

test('POLICY15 new server namespace excludes a UUID retained only as a native tombstone ID', async t => {
  const f = await fixture(t);
  const crypto = require('node:crypto');
  const retainedId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const legacy = path.join(f.paths.CREDENTIALS_DIR, 'health-connect.json');
  const legacyBytes = fs.readFileSync(legacy);
  f.sql(db => db.prepare('INSERT INTO health_tombstones VALUES (?,?,?,?,?,?)')
    .run(f.tenantId, f.sourceStoreId, 'StepsRecord', retainedId,
      JSON.stringify([f.tenantId, f.instanceId, f.sourceStoreId,
        '11111111-1111-4111-8111-111111111111', 'StepsRecord', '1', f.restoreEpoch]), '7'));
  const retained = f.sql(db => db.prepare('SELECT * FROM health_tombstones').all());
  const original = crypto.randomUUID;
  let candidates = 0, result;
  crypto.randomUUID = () => candidates++ === 0 ? retainedId : original();
  try {
    result = await f.request('POST', '/api/connectors/health-connect/pairing-grants',
      { categories: ['WeightRecord'], name: 'Another source' });
  } finally { crypto.randomUUID = original; }
  assert.equal(result.status, 201, JSON.stringify(result.body));
  assert.notEqual(result.body.tenantId, retainedId);
  assert.ok(candidates >= 2 && candidates <= 21, 'bounded candidate exclusion, no operation retry');
  assert.deepEqual(f.sql(db => db.prepare('SELECT * FROM health_tombstones').all()), retained);
  assert.deepEqual(fs.readFileSync(legacy), legacyBytes);
});

test('POLICY16 transport-only unknown source prevents a complete owner snapshot', async t => {
  const f = await fixture(t);
  const unregisteredSource = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const streamKey = JSON.stringify([f.tenantId, f.instanceId, unregisteredSource,
    '11111111-1111-4111-8111-111111111111', 'StepsRecord', '1', f.restoreEpoch]);
  f.sql(db => db.prepare('INSERT INTO health_streams VALUES (?,?,?)')
    .run(streamKey, 'StepsRecord', '0'));
  await assert.rejects(f.run(actor => f.read(actor, scope => f.policy.snapshot(scope))),
    code('IMPORT_SOURCE_POLICY_UNKNOWN'));
});

test('POLICY17 the whole retained catalogue validates retired SQL source and category closure', async t => {
  const f = await fixture(t);
  const other = await f.request('POST', '/api/connectors/health-connect/pairing-grants',
    { categories: ['WeightRecord'], name: 'Retained other source' });
  assert.equal(other.status, 201, JSON.stringify(other.body));
  f.sql(db => {
    db.prepare("UPDATE health_source_policy_sources SET lifecycle='retired' WHERE tenant_id=? AND source_store_id=?")
      .run(other.body.tenantId, other.body.sourceStoreId);
    db.prepare('DELETE FROM health_source_policy_categories WHERE tenant_id=? AND source_store_id=?')
      .run(other.body.tenantId, other.body.sourceStoreId);
  });
  assert.throws(() => f.policy.readNamespaces(), code('IMPORT_SOURCE_POLICY_UNKNOWN'));
});


test('POLICY18 valid unrelated auth credentials preserve current-member registration custody', async t => {
  const f = await fixture(t);
  const before = await f.run(actor => f.read(actor, scope => f.policy.snapshot(scope)));
  const sidecar = path.join(f.paths.CREDENTIALS_DIR, 'health-connect-policy.json');
  const catalogueBefore = fs.readFileSync(sidecar);
  const registrationRequest = () => ({ headers: { cookie: `klebb_session=${COOKIE}` } });
  const custody = f.policy.captureRegistrationActor(registrationRequest());
  assert.ok(custody, 'the unchanged real persisted member must establish auth custody before the capacity case');

  const credentials = {
    users: {
      member: { credentials: [credential] },
      unrelated: {
        credentials: Array.from({ length: 128 }, (_, index) => ({
          id: `fixture-unrelated-${String(index).padStart(3, '0')}`,
          publicKey: Buffer.from(`unrelated valid public key ${index}`).toString('base64'),
        })),
      },
    },
  };
  f.writeCredentials(credentials);
  const response = await f.request('GET', '/api/connectors/health-connect');
  assert.equal(response.status, 200, 'valid unrelated credentials must not deny the existing real current member');

  assert.doesNotThrow(() => f.policy.verifyRegistrationActor(custody, registrationRequest()));
  let freshCustody;
  assert.doesNotThrow(() => { freshCustody = f.policy.captureRegistrationActor(registrationRequest()); });
  assert.ok(freshCustody);
  assert.doesNotThrow(() => f.policy.verifyRegistrationActor(freshCustody, registrationRequest()));
  await f.run(actor => f.read(actor, scope => assert.deepEqual(f.policy.snapshot(scope), before)));
  assert.deepEqual(fs.readFileSync(sidecar), catalogueBefore, 'auth capacity creates no principal or namespace');
  assert.deepEqual(JSON.parse(fs.readFileSync(f.paths.WEBAUTHN_CREDENTIALS_FILE, 'utf8')), credentials);
});

test('POLICY19 real committed stop survives a final rename followed by an error with recovery still denied', async t => {
  const f = await fixture(t);
  const sidecar = path.join(f.paths.CREDENTIALS_DIR, 'health-connect-policy.json');
  const legacy = path.join(f.paths.CREDENTIALS_DIR, 'health-connect.json');
  const legacyBytes = fs.readFileSync(legacy);
  f.sql(db => {
    db.prepare("UPDATE health_source_policy_state SET revision='12'").run();
    db.prepare("UPDATE health_source_policy_categories SET sharing='enabled',generation='3' WHERE record_type='StepsRecord'").run();
    db.prepare("UPDATE health_source_policy_categories SET generation='8' WHERE record_type='WeightRecord'").run();
  });
  const beforeSources = f.sql(db => db.prepare('SELECT * FROM health_source_policy_sources').all());
  const nativeTables = Object.keys(require('../lib/health-connect/schema').nativeTables);
  const nativeInventory = () => f.sql(db => Object.fromEntries(nativeTables.map(table =>
    [table, db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all()])));
  const beforeNative = nativeInventory();
  const originalRename = fs.renameSync;
  const originalExec = DatabaseSync.prototype.exec;
  const writers = new WeakSet();
  let commits = 0, faults = 0, observedRenamedFalse = false;
  DatabaseSync.prototype.exec = function(sql) {
    const result = originalExec.apply(this, arguments);
    if (sql === 'BEGIN IMMEDIATE') writers.add(this);
    if (sql === 'COMMIT' && writers.has(this)) commits++;
    return result;
  };
  fs.renameSync = function(from, to) {
    if (String(to) === sidecar && faults === 0 &&
        JSON.parse(fs.readFileSync(from, 'utf8')).recoveryRequired === false) {
      const result = originalRename.apply(this, arguments);
      observedRenamedFalse = JSON.parse(fs.readFileSync(sidecar, 'utf8')).recoveryRequired === false;
      faults++;
      throw new Error('fixture publication error after actual final rename');
    }
    return originalRename.apply(this, arguments);
  };
  try {
    await assert.rejects(f.run(actor => f.write(actor, scope => {
      const before = f.policy.snapshot(scope);
      f.policy.stop(scope, { ...f.expected(before), generations: { StepsRecord: '3' } });
    })), error => error instanceof f.policy.PolicyError && error.status === 503 &&
      error.code === 'IMPORT_SOURCE_POLICY_RECOVERY_REQUIRED');
  } finally {
    fs.renameSync = originalRename;
    DatabaseSync.prototype.exec = originalExec;
  }
  assert.equal(commits, 1, 'one real SQL COMMIT, without repeating the stop');
  assert.equal(faults, 1, 'one failure after the real final rename');
  assert.equal(observedRenamedFalse, true, 'the fault follows physical publication of the cleared gate');
  assert.deepEqual(f.sql(db => db.prepare('SELECT revision FROM health_source_policy_state').all())
    .map(row => ({ ...row })), [{ revision: '13' }]);
  assert.deepEqual(f.sql(db => db.prepare('SELECT record_type,sharing,generation FROM health_source_policy_categories ORDER BY record_type').all())
    .map(row => ({ ...row })), [
      { record_type: 'StepsRecord', sharing: 'stopped', generation: '4' },
      { record_type: 'WeightRecord', sharing: 'stopped', generation: '8' },
    ]);
  assert.deepEqual(f.sql(db => db.prepare('SELECT * FROM health_source_policy_sources').all()), beforeSources);
  assert.deepEqual(nativeInventory(), beforeNative);
  assert.deepEqual(fs.readFileSync(legacy), legacyBytes);
  assert.equal(JSON.parse(fs.readFileSync(sidecar, 'utf8')).recoveryRequired, true,
    'a publication error after COMMIT must restore the durable denial gate');
  assert.throws(() => f.policy.readNamespaces(), error => error instanceof f.policy.PolicyError &&
    error.status === 503 && error.code === 'IMPORT_SOURCE_POLICY_RECOVERY_REQUIRED');
});

test('POLICY20 retained quarantine denies reads after failed gate restoration and actual mutex close error', async t => {
  const f = await fixture(t);
  const sidecar = path.join(f.paths.CREDENTIALS_DIR, 'health-connect-policy.json');
  const legacy = path.join(f.paths.CREDENTIALS_DIR, 'health-connect.json');
  const legacyBytes = fs.readFileSync(legacy);
  f.sql(db => {
    db.prepare("UPDATE health_source_policy_state SET revision='12'").run();
    db.prepare("UPDATE health_source_policy_categories SET sharing='enabled',generation='3' WHERE record_type='StepsRecord'").run();
    db.prepare("UPDATE health_source_policy_categories SET generation='8' WHERE record_type='WeightRecord'").run();
  });
  const beforeSources = f.sql(db => db.prepare('SELECT * FROM health_source_policy_sources').all());
  const nativeTables = Object.keys(require('../lib/health-connect/schema').nativeTables);
  const nativeInventory = () => f.sql(db => Object.fromEntries(nativeTables.map(table =>
    [table, db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all()])));
  const beforeNative = nativeInventory();
  const originalRename = fs.renameSync;
  const originalExec = DatabaseSync.prototype.exec;
  const originalOpen = fs.openSync;
  const originalClose = fs.closeSync;
  const mutex = sidecar + '.lock';
  let mutexFd;
  const writers = new WeakSet();
  let commits = 0, faults = 0, gateRefusals = 0, mutexCloseFaults = 0, observedRenamedFalse = false;
  fs.openSync = function(filename) {
    const result = originalOpen.apply(this, arguments);
    if (String(filename) === mutex) mutexFd = result;
    return result;
  };
  fs.closeSync = function(fd) {
    const result = originalClose.apply(this, arguments);
    if (fd === mutexFd && gateRefusals === 1 && mutexCloseFaults === 0) {
      mutexCloseFaults++;
      throw new Error('fixture mutex close error after actual close');
    }
    return result;
  };
  DatabaseSync.prototype.exec = function(sql) {
    const result = originalExec.apply(this, arguments);
    if (sql === 'BEGIN IMMEDIATE') writers.add(this);
    if (sql === 'COMMIT' && writers.has(this)) commits++;
    return result;
  };
  fs.renameSync = function(from, to) {
    if (String(to) === sidecar && faults === 1 &&
        JSON.parse(fs.readFileSync(from, 'utf8')).recoveryRequired === true) {
      gateRefusals++;
      throw new Error('fixture denial gate restoration refusal');
    }
    if (String(to) === sidecar && faults === 0 &&
        JSON.parse(fs.readFileSync(from, 'utf8')).recoveryRequired === false) {
      const result = originalRename.apply(this, arguments);
      observedRenamedFalse = JSON.parse(fs.readFileSync(sidecar, 'utf8')).recoveryRequired === false;
      faults++;
      throw new Error('fixture publication error after actual final rename');
    }
    return originalRename.apply(this, arguments);
  };
  try {
    await assert.rejects(f.run(actor => f.write(actor, scope => {
      const before = f.policy.snapshot(scope);
      f.policy.stop(scope, { ...f.expected(before), generations: { StepsRecord: '3' } });
    })));
  } finally {
    fs.renameSync = originalRename;
    fs.openSync = originalOpen;
    fs.closeSync = originalClose;
    DatabaseSync.prototype.exec = originalExec;
  }
  assert.equal(commits, 1, 'one real SQL COMMIT, without repeating the stop');
  assert.equal(faults, 1, 'one failure after the real final rename');
  assert.equal(gateRefusals, 1, 'one denied attempt to reassert the true gate');
  assert.equal(mutexCloseFaults, 1, 'the actual mutex descriptor closes before throwing once');
  assert.equal(observedRenamedFalse, true, 'the fault follows physical publication of the cleared gate');
  assert.deepEqual(f.sql(db => db.prepare('SELECT revision FROM health_source_policy_state').all())
    .map(row => ({ ...row })), [{ revision: '13' }]);
  assert.deepEqual(f.sql(db => db.prepare('SELECT record_type,sharing,generation FROM health_source_policy_categories ORDER BY record_type').all())
    .map(row => ({ ...row })), [
      { record_type: 'StepsRecord', sharing: 'stopped', generation: '4' },
      { record_type: 'WeightRecord', sharing: 'stopped', generation: '8' },
    ]);
  assert.deepEqual(f.sql(db => db.prepare('SELECT * FROM health_source_policy_sources').all()), beforeSources);
  assert.deepEqual(nativeInventory(), beforeNative);
  assert.deepEqual(fs.readFileSync(legacy), legacyBytes);
  assert.equal(JSON.parse(fs.readFileSync(sidecar, 'utf8')).recoveryRequired, false,
    'the refused restoration leaves the actual cleared image');
  assert.equal(fs.existsSync(mutex), true, 'the original mutex is retained as durable quarantine');
  assert.throws(() => f.policy.readNamespaces(), error => error instanceof f.policy.PolicyError &&
    error.status === 503 && error.code === 'IMPORT_SOURCE_POLICY_RECOVERY_REQUIRED');
});

test('POLICY21 supported raw-only type absent from source categories denies complete closure', async t => {
  const f = await fixture(t);
  await f.run(actor => f.read(actor, scope => {
    const healthy = f.policy.snapshot(scope);
    assert.equal(healthy.knowledge, 'COMPLETE');
    assert.equal(healthy.sources[0].categoryCount, 2);
  }));
  const original = require('./fixtures/health-connect/protocol-v1.json');
  const frame = JSON.parse(original.cases.find(item => item.id === 'rawOnly').wire);
  const payload = JSON.parse(frame.payloadJson);
  const change = payload.changes[0];
  assert.equal(payload.recordType, 'BodyWaterMassRecord');
  assert.equal(change.projection, 'raw-only');
  const recordJson = JSON.stringify(change.record);
  f.sql(db => db.prepare('INSERT INTO health_records VALUES (?,?,?,?,?,?,?,?,?)')
    .run(f.tenantId, f.sourceStoreId, payload.recordType, change.identity.nativeRecordId,
      change.serializerId, change.serializerVersion, change.dataFamily, change.projection, recordJson));
  const rawBefore = f.sql(db => db.prepare('SELECT * FROM health_records').all());
  const policyTables = Object.keys(require('../lib/health-connect/schema').sourcePolicyTables);
  const policyInventory = () => f.sql(db => Object.fromEntries(policyTables.map(table =>
    [table, db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all()])));
  const policyBefore = policyInventory();
  const sidecar = path.join(f.paths.CREDENTIALS_DIR, 'health-connect-policy.json');
  const catalogueBefore = fs.readFileSync(sidecar);
  await assert.rejects(f.run(actor => f.read(actor, scope => f.policy.snapshot(scope))),
    code('IMPORT_SOURCE_POLICY_UNKNOWN'));
  assert.deepEqual(f.sql(db => db.prepare('SELECT * FROM health_records').all()), rawBefore);
  assert.deepEqual(policyInventory(), policyBefore);
  assert.deepEqual(fs.readFileSync(sidecar), catalogueBefore);
});

test('POLICY22 a genuine short read cannot hide malformed bytes after the valid catalogue prefix', async t => {
  const f = await fixture(t);
  const sidecar = path.join(f.paths.CREDENTIALS_DIR, 'health-connect-policy.json');
  const validBytes = fs.readFileSync(sidecar);
  fs.appendFileSync(sidecar, '\nnot-json-after-real-catalogue');
  const actualBytes = fs.readFileSync(sidecar);
  assert.equal(actualBytes.subarray(0, validBytes.length).equals(validBytes), true);
  const tables = Object.keys(require('../lib/health-connect/schema').sourcePolicyTables);
  const inventory = () => f.sql(db => Object.fromEntries(tables.map(table =>
    [table, db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all()])));
  const before = inventory();
  const originalOpen = fs.openSync, originalRead = fs.readSync;
  let descriptor, shortReads = 0;
  fs.openSync = function(filename) {
    const fd = originalOpen.apply(this, arguments);
    if (String(filename) === sidecar) descriptor = fd;
    return fd;
  };
  fs.readSync = function(fd, buffer, offset, length, position) {
    if (fd === descriptor && shortReads === 0) {
      shortReads++;
      return originalRead.call(this, fd, buffer, offset, Math.min(length, validBytes.length), position);
    }
    return originalRead.apply(this, arguments);
  };
  try {
    assert.throws(() => f.policy.readNamespaces(), error => error instanceof f.policy.PolicyError &&
      error.status === 503 && error.code === 'storage-unavailable');
  } finally { fs.openSync = originalOpen; fs.readSync = originalRead; }
  assert.equal(shortReads, 1, 'the original file descriptor returned only real valid-prefix bytes once');
  assert.deepEqual(fs.readFileSync(sidecar), actualBytes);
  assert.deepEqual(inventory(), before);
});

test('POLICY23 callback throw and returned thenable invalidate real scopes and restore stopped rows', async t => {
  const f = await fixture(t);
  const sidecar = path.join(f.paths.CREDENTIALS_DIR, 'health-connect-policy.json');
  const catalogueBefore = fs.readFileSync(sidecar);
  const tables = Object.keys(require('../lib/health-connect/schema').sourcePolicyTables);
  const inventory = () => f.sql(db => Object.fromEntries(tables.map(table =>
    [table, db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all()])));
  const before = inventory();
  let thenInvoked = false;
  await f.run(actor => {
    let escapedThrow, escapedThenable;
    assert.throws(() => f.write(actor, scope => {
      escapedThrow = scope;
      f.policy.retire(scope, f.expected(f.policy.snapshot(scope)));
      throw new Error('fixture original callback failure before COMMIT');
    }));
    assert.throws(() => f.policy.snapshot(escapedThrow), code('IMPORT_SOURCE_POLICY_CAPABILITY_REQUIRED'));
    assert.throws(() => f.write(actor, scope => {
      escapedThenable = scope;
      f.policy.retire(scope, f.expected(f.policy.snapshot(scope)));
      return { then() { thenInvoked = true; } };
    }), error => error instanceof f.policy.PolicyError && error.status === 503 && error.code === 'storage-unavailable');
    assert.throws(() => f.policy.snapshot(escapedThenable), code('IMPORT_SOURCE_POLICY_CAPABILITY_REQUIRED'));
  });
  assert.equal(thenInvoked, false, 'synchronous issuer must never await or invoke the returned thenable');
  assert.deepEqual(inventory(), before);
  assert.deepEqual(fs.readFileSync(sidecar), catalogueBefore);
});


test('RISK_SIBLING01 genuine same-namespace enrolment preserves sibling generation 7 on primary stop', async t => {
  const f = await fixture(t);
  const schema = require('../lib/health-connect/schema');
  const sidecar = path.join(f.paths.CREDENTIALS_DIR, 'health-connect-policy.json');
  const catalogueBefore = fs.readFileSync(sidecar);
  const nativeInventory = () => f.sql(db => Object.fromEntries(Object.keys(schema.nativeTables).map(table =>
    [table, db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all()])));
  const nativeBeforeBirth = nativeInventory();
  const primaryBeforeBirth = f.sql(db => db.prepare(
    'SELECT * FROM health_source_policy_sources WHERE tenant_id=? AND source_store_id=?')
    .get(f.tenantId, f.sourceStoreId));
  const originalResolver = f.policy.resolveBrowser;
  let currentReq, sibling;
  f.policy.resolveBrowser = req => {
    currentReq = req;
    return originalResolver(req);
  };
  try {
    await f.run(actor => {
      const before = f.read(actor, scope => f.policy.snapshot(scope));
      assert.equal(before.sourceCount, 1);
      assert.equal(before.revision, '1');
      const custody = f.policy.namespaceAuthority(actor, f.tenantId);
      sibling = f.policy.enrolStopped(currentReq, ['WeightRecord'], {
        namespaceAuthority: custody, expected: { epoch: f.restoreEpoch, revision: '1' },
      });
      assert.equal(sibling.tenantId, f.tenantId, 'the genuine selected namespace must not be replaced by a new one');
      assert.equal(sibling.ownerId, before.ownerId);
      assert.equal(sibling.instanceId, f.instanceId);
      assert.equal(sibling.restoreEpoch, f.restoreEpoch);
      assert.notEqual(sibling.sourceStoreId, f.sourceStoreId);
      assert.deepEqual(sibling.generations, { WeightRecord: '1' });
      const after = f.read(actor, scope => f.policy.snapshot(scope));
      assert.equal(after.sourceCount, 2);
      assert.equal(after.revision, '2');
      const added = after.sources.find(source => source.sourceStoreId === sibling.sourceStoreId);
      assert.ok(added);
      assert.equal(added.categoryCount, 1);
      assert.equal(added.lifecycle, 'active');
      assert.equal(added.knowledge, 'COMPLETE');
      assert.equal(added.retainCommittedHistory, 1);
      assert.equal(added.reconciledEpoch, null);
      assert.notEqual(added.policyId, after.sources.find(source => source.sourceStoreId === f.sourceStoreId).policyId);
      assert.deepEqual(added.categories, [{ recordType: 'WeightRecord', sharing: 'stopped', generation: '1' }]);
    });
  } finally { f.policy.resolveBrowser = originalResolver; }
  assert.deepEqual(fs.readFileSync(sidecar), catalogueBefore, 'the original namespace, principal and first grant stay exact');
  assert.deepEqual(nativeInventory(), nativeBeforeBirth);
  assert.deepEqual(f.sql(db => db.prepare(
    'SELECT * FROM health_source_policy_sources WHERE tenant_id=? AND source_store_id=?')
    .get(f.tenantId, f.sourceStoreId)), primaryBeforeBirth);
  const pastStream = JSON.stringify([f.tenantId, f.instanceId, f.sourceStoreId,
    '11111111-1111-4111-8111-111111111111', 'StepsRecord', '3', f.restoreEpoch]);
  f.sql(db => {
    db.prepare("UPDATE health_source_policy_state SET revision='12' WHERE tenant_id=?").run(f.tenantId);
    db.prepare("UPDATE health_source_policy_categories SET sharing='enabled',generation='3' "
      + "WHERE tenant_id=? AND source_store_id=? AND record_type='StepsRecord'").run(f.tenantId, f.sourceStoreId);
    db.prepare("UPDATE health_source_policy_categories SET generation='8' "
      + "WHERE tenant_id=? AND source_store_id=? AND record_type='WeightRecord'").run(f.tenantId, f.sourceStoreId);
    db.prepare("UPDATE health_source_policy_categories SET generation='7' "
      + "WHERE tenant_id=? AND source_store_id=? AND record_type='WeightRecord'").run(f.tenantId, sibling.sourceStoreId);
    db.prepare('INSERT INTO health_tombstones VALUES (?,?,?,?,?,?)')
      .run(f.tenantId, f.sourceStoreId, 'StepsRecord', 'old-id', pastStream, '7');
  });
  const siblingInventory = () => f.sql(db => ({
    source: db.prepare('SELECT * FROM health_source_policy_sources WHERE tenant_id=? AND source_store_id=?')
      .get(f.tenantId, sibling.sourceStoreId),
    categories: db.prepare('SELECT * FROM health_source_policy_categories WHERE tenant_id=? AND source_store_id=? ORDER BY record_type')
      .all(f.tenantId, sibling.sourceStoreId),
  }));
  const siblingBefore = siblingInventory(), nativeBeforeStop = nativeInventory();
  await f.run(actor => f.write(actor, scope => {
    f.policy.stop(scope, { sourceStoreId: f.sourceStoreId, epoch: f.restoreEpoch,
      revision: '12', generations: { StepsRecord: '3' } });
    const after = f.policy.snapshot(scope);
    assert.equal(after.epoch, f.restoreEpoch);
    assert.equal(after.revision, '13');
    assert.equal(after.sourceCount, 2);
    assert.deepEqual(after.sources.find(source => source.sourceStoreId === f.sourceStoreId).categories,
      [{ recordType: 'StepsRecord', sharing: 'stopped', generation: '4' },
        { recordType: 'WeightRecord', sharing: 'stopped', generation: '8' }]);
    assert.deepEqual(after.sources.find(source => source.sourceStoreId === sibling.sourceStoreId).categories,
      [{ recordType: 'WeightRecord', sharing: 'stopped', generation: '7' }]);
  }));
  assert.deepEqual(siblingInventory(), siblingBefore);
  assert.deepEqual(nativeInventory(), nativeBeforeStop);
  assert.deepEqual(fs.readFileSync(sidecar), catalogueBefore);
});

test('RISK_SIBLING02 copied namespace custody cannot enrol a source', async t => {
  const f = await fixture(t);
  const sidecar = path.join(f.paths.CREDENTIALS_DIR, 'health-connect-policy.json');
  const beforeBytes = fs.readFileSync(sidecar);
  const schema = require('../lib/health-connect/schema');
  const tables = [...Object.keys(schema.nativeTables), ...Object.keys(schema.sourcePolicyTables)];
  const inventory = () => f.sql(db => Object.fromEntries(tables.map(table =>
    [table, db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all()])));
  const beforeRows = inventory();
  const originalResolver = f.policy.resolveBrowser;
  let currentReq;
  f.policy.resolveBrowser = req => { currentReq = req; return originalResolver(req); };
  try {
    await f.run(actor => {
      assert.equal(f.read(actor, scope => f.policy.snapshot(scope)).sourceCount, 1);
      const custody = f.policy.namespaceAuthority(actor, f.tenantId);
      assert.throws(() => f.policy.enrolStopped(currentReq, ['WeightRecord'], {
        namespaceAuthority: { ...custody }, expected: { epoch: f.restoreEpoch, revision: '1' },
      }), error => error instanceof f.policy.PolicyError && error.status === 409 &&
        error.code === 'IMPORT_SOURCE_POLICY_CAPABILITY_REQUIRED');
    });
  } finally { f.policy.resolveBrowser = originalResolver; }
  assert.deepEqual(inventory(), beforeRows);
  assert.deepEqual(fs.readFileSync(sidecar), beforeBytes);
});

test('RISK_SIBLING03 independent stale epoch and revision refuse before source birth', async t => {
  const f = await fixture(t);
  const sidecar = path.join(f.paths.CREDENTIALS_DIR, 'health-connect-policy.json');
  const beforeBytes = fs.readFileSync(sidecar);
  const schema = require('../lib/health-connect/schema');
  const tables = [...Object.keys(schema.nativeTables), ...Object.keys(schema.sourcePolicyTables)];
  const inventory = () => f.sql(db => Object.fromEntries(tables.map(table =>
    [table, db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all()])));
  const beforeRows = inventory();
  const originalResolver = f.policy.resolveBrowser;
  let currentReq;
  f.policy.resolveBrowser = req => { currentReq = req; return originalResolver(req); };
  try {
    await f.run(actor => {
      const healthy = f.read(actor, scope => f.policy.snapshot(scope));
      assert.equal(healthy.revision, '1');
      const custody = f.policy.namespaceAuthority(actor, f.tenantId);
      const refused = error => error instanceof f.policy.PolicyError &&
        error.status === 409 && error.code === 'binding-mismatch';
      assert.notEqual(f.restoreEpoch, '00000000-0000-4000-8000-000000000000');
      assert.throws(() => f.policy.enrolStopped(currentReq, ['WeightRecord'], {
        namespaceAuthority: custody,
        expected: { epoch: '00000000-0000-4000-8000-000000000000', revision: '1' },
      }), refused);
      assert.throws(() => f.policy.enrolStopped(currentReq, ['WeightRecord'], {
        namespaceAuthority: custody, expected: { epoch: f.restoreEpoch, revision: '0' },
      }), refused);
    });
  } finally { f.policy.resolveBrowser = originalResolver; }
  assert.deepEqual(inventory(), beforeRows);
  assert.deepEqual(fs.readFileSync(sidecar), beforeBytes);
});


test('RISK_CAS01 stale generation refuses before an already-stopped no-op', async t => {
  const f = await fixture(t);
  const sidecar = path.join(f.paths.CREDENTIALS_DIR, 'health-connect-policy.json');
  const beforeBytes = fs.readFileSync(sidecar);
  const schema = require('../lib/health-connect/schema');
  const tables = [...Object.keys(schema.nativeTables), ...Object.keys(schema.sourcePolicyTables)];
  const inventory = () => f.sql(db => Object.fromEntries(tables.map(table =>
    [table, db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all()])));
  const beforeRows = inventory();
  await f.run(actor => f.write(actor, scope => {
    const before = f.policy.snapshot(scope);
    assert.equal(before.revision, '1');
    assert.deepEqual(before.sources[0].categories.map(item => [item.recordType, item.sharing, item.generation]),
      [['StepsRecord', 'stopped', '1'], ['WeightRecord', 'stopped', '1']]);
    assert.throws(() => f.policy.stop(scope, { ...f.expected(before),
      generations: { StepsRecord: '0' } }), error => error instanceof f.policy.PolicyError &&
      error.status === 409 && error.code === 'binding-mismatch');
    assert.deepEqual(f.policy.snapshot(scope), before);
  }));
  assert.deepEqual(inventory(), beforeRows);
  assert.deepEqual(fs.readFileSync(sidecar), beforeBytes);
});

test('RISK_CAS02 revision INT64 maximum permits a current no-op but refuses an effective stop', async t => {
  const f = await fixture(t);
  f.sql(db => {
    db.prepare("UPDATE health_source_policy_state SET revision='9223372036854775807'").run();
    db.prepare("UPDATE health_source_policy_categories SET sharing='enabled',generation='3' WHERE record_type='StepsRecord'").run();
    db.prepare("UPDATE health_source_policy_categories SET generation='8' WHERE record_type='WeightRecord'").run();
  });
  const sidecar = path.join(f.paths.CREDENTIALS_DIR, 'health-connect-policy.json');
  const beforeBytes = fs.readFileSync(sidecar);
  const schema = require('../lib/health-connect/schema');
  const tables = [...Object.keys(schema.nativeTables), ...Object.keys(schema.sourcePolicyTables)];
  const inventory = () => f.sql(db => Object.fromEntries(tables.map(table =>
    [table, db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all()])));
  const beforeRows = inventory();
  await f.run(actor => f.write(actor, scope => {
    const before = f.policy.snapshot(scope);
    assert.equal(before.revision, '9223372036854775807');
    assert.deepEqual(before.sources[0].categories.map(item => [item.recordType, item.sharing, item.generation]),
      [['StepsRecord', 'enabled', '3'], ['WeightRecord', 'stopped', '8']]);
    f.policy.stop(scope, { ...f.expected(before), generations: { WeightRecord: '8' } });
    assert.deepEqual(f.policy.snapshot(scope), before, 'the current stopped no-op remains valid at MAX');
    assert.throws(() => f.policy.stop(scope, { ...f.expected(before),
      generations: { StepsRecord: '3' } }), error => error instanceof f.policy.PolicyError &&
      error.status === 409 && error.code === 'limit-exceeded');
    assert.deepEqual(f.policy.snapshot(scope), before);
  }));
  assert.deepEqual(inventory(), beforeRows);
  assert.deepEqual(fs.readFileSync(sidecar), beforeBytes);
});

test('RISK_RETIRE01 retirement preserves enabled intent and exact past native history', async t => {
  const f = await fixture(t);
  const pastStream = JSON.stringify([f.tenantId, f.instanceId, f.sourceStoreId,
    '11111111-1111-4111-8111-111111111111', 'StepsRecord', '3', f.restoreEpoch]);
  f.sql(db => {
    db.prepare("UPDATE health_source_policy_state SET revision='12'").run();
    db.prepare("UPDATE health_source_policy_categories SET sharing='enabled',generation='3' WHERE record_type='StepsRecord'").run();
    db.prepare("UPDATE health_source_policy_categories SET generation='8' WHERE record_type='WeightRecord'").run();
    db.prepare('INSERT INTO health_tombstones VALUES (?,?,?,?,?,?)')
      .run(f.tenantId, f.sourceStoreId, 'StepsRecord', 'old-id', pastStream, '7');
  });
  const nativeTables = Object.keys(require('../lib/health-connect/schema').nativeTables);
  const nativeInventory = () => f.sql(db => Object.fromEntries(nativeTables.map(table =>
    [table, db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all()])));
  const beforeNative = nativeInventory();
  const legacy = path.join(f.paths.CREDENTIALS_DIR, 'health-connect.json');
  const legacyExisted = fs.existsSync(legacy);
  const beforeLegacy = legacyExisted ? fs.readFileSync(legacy) : null;
  await f.run(actor => f.write(actor, scope => {
    const before = f.policy.snapshot(scope);
    assert.equal(before.revision, '12');
    assert.equal(before.sources[0].lifecycle, 'active');
    assert.deepEqual(before.sources[0].categories.map(item => [item.recordType, item.sharing, item.generation]),
      [['StepsRecord', 'enabled', '3'], ['WeightRecord', 'stopped', '8']]);
    f.policy.retire(scope, f.expected(before));
    const after = f.policy.snapshot(scope);
    assert.equal(after.epoch, before.epoch);
    assert.equal(after.revision, '13');
    assert.equal(after.sourceCount, 1);
    assert.equal(after.sources[0].sourceStoreId, before.sources[0].sourceStoreId);
    assert.equal(after.sources[0].categoryCount, 2);
    assert.equal(after.sources[0].lifecycle, 'retired');
    assert.equal(after.sources[0].retainCommittedHistory, 1);
    assert.equal(after.sources[0].reconciledEpoch, null);
    assert.deepEqual(after.sources[0].categories.map(item => [item.recordType, item.sharing, item.generation]),
      [['StepsRecord', 'enabled', '4'], ['WeightRecord', 'stopped', '9']]);
    const verifierDenied = error => error instanceof f.policy.PolicyError &&
      error.status === 409 && error.code === 'IMPORT_SOURCE_POLICY_VERIFIER_REQUIRED';
    assert.throws(() => f.policy.enable(scope, f.expected(after)), verifierDenied);
    assert.throws(() => f.policy.reconcile(scope, f.expected(after)), verifierDenied);
    assert.deepEqual(f.policy.snapshot(scope), after);
  }));
  assert.deepEqual(nativeInventory(), beforeNative, 'past generation 3 / sequence 7 native control remains exact');
  assert.equal(fs.existsSync(legacy), legacyExisted, 'legacy existence remains unchanged');
  if (legacyExisted) assert.deepEqual(fs.readFileSync(legacy), beforeLegacy);
});

test('POLICY_PATH_REPLACED actual copied selected database invalidates the original real actor', async t => {
  const f = await fixture(t);
  const schema = require('../lib/health-connect/schema');
  const tables = [...Object.keys(schema.nativeTables), ...Object.keys(schema.sourcePolicyTables)];
  const inventory = () => f.sql(db => Object.fromEntries(tables.map(table =>
    [table, db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all()])));
  const sidecar = path.join(f.paths.CREDENTIALS_DIR, 'health-connect-policy.json');
  const legacy = path.join(f.paths.CREDENTIALS_DIR, 'health-connect.json');
  f.sql(db => db.prepare('INSERT INTO health_tombstones VALUES (?,?,?,?,?,?)')
    .run(f.tenantId, f.sourceStoreId, 'StepsRecord', 'retained-path-control',
      JSON.stringify([f.tenantId, f.instanceId, f.sourceStoreId,
        '11111111-1111-4111-8111-111111111111', 'StepsRecord', '1', f.restoreEpoch]), '7'));
  const beforeRows = inventory();
  const catalogueBefore = fs.readFileSync(sidecar);
  const legacyBefore = fs.existsSync(legacy) ? fs.readFileSync(legacy) : null;
  const copied = f.paths.DB_FILE + '.new-physical-copy';
  const retainedOriginal = f.paths.DB_FILE + '.retained-original';
  const retainedReplacement = f.paths.DB_FILE + '.retained-replacement';
  for (const filename of [copied, retainedOriginal, retainedReplacement]) {
    assert.equal(fs.existsSync(filename), false, 'replacement setup uses fresh fixture-only operands');
  }
  await f.run(actor => {
    const healthy = f.read(actor, scope => f.policy.snapshot(scope));
    assert.equal(healthy.knowledge, 'COMPLETE');
    assert.equal(healthy.tenantId, f.tenantId);
    assert.equal(healthy.sources[0].lifecycle, 'active');
    // f.read has returned and closed its connection. Checkpoint and close the
    // fixture connection before copying, so the replacement is a genuine DB.
    f.sql(db => db.exec('PRAGMA wal_checkpoint(TRUNCATE)'));
    const originalIdentity = fs.lstatSync(f.paths.DB_FILE, { bigint: true });
    assert.equal(originalIdentity.isFile(), true);
    fs.copyFileSync(f.paths.DB_FILE, copied);
    let originalMoved = false, replacementSelected = false;
    try {
      fs.renameSync(f.paths.DB_FILE, retainedOriginal);
      originalMoved = true;
      fs.renameSync(copied, f.paths.DB_FILE);
      replacementSelected = true;
      const replacementIdentity = fs.lstatSync(f.paths.DB_FILE, { bigint: true });
      assert.equal(replacementIdentity.isFile(), true);
      assert.ok(originalIdentity.dev !== replacementIdentity.dev ||
        originalIdentity.ino !== replacementIdentity.ino,
        'PREREQUISITE: physical selected database identity must actually differ');
      assert.deepEqual(inventory(), beforeRows, 'the physical copy has the same healthy SQL data');
      const mismatch = error => error instanceof f.policy.PolicyError &&
        error.status === 409 && error.code === 'binding-mismatch';
      // The original live actor remains bound to the original physical database.
      assert.throws(() => f.read(actor, scope => f.policy.snapshot(scope)), mismatch,
        'the old genuine actor must not read a physically replaced selected database');
      assert.throws(() => f.write(actor, scope => f.policy.retire(scope, f.expected(healthy))), mismatch,
        'the old genuine actor must not mutate a physically replaced selected database');
      assert.deepEqual(inventory(), beforeRows);
      assert.deepEqual(fs.readFileSync(sidecar), catalogueBefore);
      assert.equal(fs.existsSync(legacy), legacyBefore !== null);
      if (legacyBefore !== null) assert.deepEqual(fs.readFileSync(legacy), legacyBefore);
    } finally {
      // Restore before the real HTTP handler continues. All connection work
      // above is synchronous and has returned before these fixture-only moves.
      if (replacementSelected) fs.renameSync(f.paths.DB_FILE, retainedReplacement);
      if (originalMoved) fs.renameSync(retainedOriginal, f.paths.DB_FILE);
    }
  });
  assert.deepEqual(inventory(), beforeRows);
  assert.deepEqual(fs.readFileSync(sidecar), catalogueBefore);
  assert.equal(fs.existsSync(legacy), legacyBefore !== null);
      if (legacyBefore !== null) assert.deepEqual(fs.readFileSync(legacy), legacyBefore);
});

for (const scenario of [
  {
    name: 'POLICY_ACTOR_KEY live real scope refuses a replaced selected credential key',
    status: 403, code: 'scope-mismatch',
    replace(f) {
      f.writeCredentials({ users: { member: { credentials: [{ ...credential,
        publicKey: Buffer.from('different genuine saved fixture key').toString('base64') }] } } });
    },
  },
  {
    name: 'POLICY_ACTOR_MISSING live real scope refuses an absent selected credential',
    status: 401, code: 'unauthorised',
    replace(f) { f.writeCredentials({ users: { member: { credentials: [] } } }); },
  },
  {
    name: 'POLICY_ACTOR_OWNER live real scope refuses a replaced current persisted session owner',
    status: 403, code: 'scope-mismatch',
    replace(f) {
      const replacement = { id: 'distinct-fixture-member',
        publicKey: Buffer.from('distinct fixture owner key').toString('base64') };
      f.writeCredentials({ users: { member: { credentials: [credential] },
        'distinct-member': { credentials: [replacement] } } });
      const sessions = JSON.parse(fs.readFileSync(f.paths.WEBAUTHN_SESSIONS_FILE, 'utf8'));
      sessions[COOKIE] = { ...sessions[COOKIE], userId: 'distinct-member', credentialId: replacement.id };
      fs.writeFileSync(f.paths.WEBAUTHN_SESSIONS_FILE, JSON.stringify(sessions));
    },
  },
]) {
  test(scenario.name, async t => {
    const f = await fixture(t);
    const schema = require('../lib/health-connect/schema');
    const tables = [...Object.keys(schema.nativeTables), ...Object.keys(schema.sourcePolicyTables)];
    const inventory = () => f.sql(db => Object.fromEntries(tables.map(table =>
      [table, db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all()])));
    const sidecar = path.join(f.paths.CREDENTIALS_DIR, 'health-connect-policy.json');
    const legacy = path.join(f.paths.CREDENTIALS_DIR, 'health-connect.json');
    const beforeRows = inventory();
    const catalogueBefore = fs.readFileSync(sidecar);
    const legacyBefore = fs.existsSync(legacy) ? fs.readFileSync(legacy) : null;
    await f.run(actor => f.write(actor, scope => {
      const before = f.policy.snapshot(scope);
      assert.equal(before.knowledge, 'COMPLETE');
      assert.equal(before.sources[0].lifecycle, 'active');
      // These are the actual saved credential/session bytes after genuine
      // current-member capture. lastSeen touches are original auth behavior.
      const credentialsBefore = fs.readFileSync(f.paths.WEBAUTHN_CREDENTIALS_FILE);
      const sessionsBefore = fs.readFileSync(f.paths.WEBAUTHN_SESSIONS_FILE);
      // The original writer wrapper has already published its reversible
      // denial gate. The rejected mutation must not change that gated image.
      const gateBefore = fs.readFileSync(sidecar);
      try {
        scenario.replace(f);
        assert.throws(() => f.policy.retire(scope, f.expected(before)), error =>
          error instanceof f.policy.PolicyError && error.status === scenario.status &&
          error.code === scenario.code);
        assert.deepEqual(fs.readFileSync(sidecar), gateBefore);
      } finally {
        fs.writeFileSync(f.paths.WEBAUTHN_CREDENTIALS_FILE, credentialsBefore);
        fs.writeFileSync(f.paths.WEBAUTHN_SESSIONS_FILE, sessionsBefore);
      }
      assert.deepEqual(f.policy.snapshot(scope), before,
        'restoring the real current actor shows the denied mutation changed no SQL state');
    }));
    assert.deepEqual(inventory(), beforeRows);
    assert.deepEqual(fs.readFileSync(sidecar), catalogueBefore);
    assert.equal(fs.existsSync(legacy), legacyBefore !== null);
      if (legacyBefore !== null) assert.deepEqual(fs.readFileSync(legacy), legacyBefore);
  });
}

test('POLICY_V2_ABSENT missing custody cannot adopt or mutate a retained namespace', async t => {
  const f = await fixture(t);
  const schema = require('../lib/health-connect/schema');
  const tables = [...Object.keys(schema.nativeTables), ...Object.keys(schema.sourcePolicyTables)];
  const inventory = () => f.sql(db => Object.fromEntries(tables.map(table =>
    [table, db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all()])));
  const sidecar = path.join(f.paths.CREDENTIALS_DIR, 'health-connect-policy.json');
  const retained = sidecar + '.retained-before-absence';
  const legacy = path.join(f.paths.CREDENTIALS_DIR, 'health-connect.json');
  const beforeRows = inventory();
  const catalogueBefore = fs.readFileSync(sidecar);
  const legacyBefore = fs.existsSync(legacy) ? fs.readFileSync(legacy) : null;
  assert.equal(fs.existsSync(retained), false);
  await f.run(actor => {
    const healthy = f.read(actor, scope => f.policy.snapshot(scope));
    assert.equal(healthy.knowledge, 'COMPLETE');
    fs.renameSync(sidecar, retained);
    try {
      const wrongScope = error => error instanceof f.policy.PolicyError &&
        error.status === 403 && error.code === 'scope-mismatch';
      assert.throws(() => f.read(actor, scope => f.policy.snapshot(scope)), wrongScope);
      assert.throws(() => f.write(actor, scope => f.policy.retire(scope, f.expected(healthy))), wrongScope);
      assert.equal(fs.existsSync(sidecar), false,
        'denied old-scope operations do not invent a private catalogue or COMPLETE birth');
      assert.deepEqual(inventory(), beforeRows);
      assert.equal(fs.existsSync(legacy), legacyBefore !== null);
      if (legacyBefore !== null) assert.deepEqual(fs.readFileSync(legacy), legacyBefore);
    } finally {
      fs.renameSync(retained, sidecar);
    }
  });
  assert.deepEqual(inventory(), beforeRows);
  assert.deepEqual(fs.readFileSync(sidecar), catalogueBefore);
  assert.equal(fs.existsSync(legacy), legacyBefore !== null);
      if (legacyBefore !== null) assert.deepEqual(fs.readFileSync(legacy), legacyBefore);
});

test('POLICY_V2_FORWARD lost catalogue refuses birth while retaining every old namespace', async t => {
  const f = await fixture(t);
  const schema = require('../lib/health-connect/schema');
  const tables = [...Object.keys(schema.nativeTables), ...Object.keys(schema.sourcePolicyTables)];
  const inventory = () => f.sql(db => Object.fromEntries(tables.map(table =>
    [table, db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all()])));
  const sidecar = path.join(f.paths.CREDENTIALS_DIR, 'health-connect-policy.json');
  const retained = sidecar + '.retained-custody';
  const beforeRows = inventory(), custodyBefore = fs.readFileSync(sidecar);
  const credentialsBefore = fs.readFileSync(f.paths.WEBAUTHN_CREDENTIALS_FILE);
  fs.renameSync(sidecar, retained);
  const enrolled = await f.request('POST', '/api/connectors/health-connect/pairing-grants',
    { categories: ['WeightRecord'], name: 'Refused lost-custody fixture source' });
  assert.equal(enrolled.status, 409);
  assert.equal(enrolled.body.code, 'IMPORT_SOURCE_POLICY_UNKNOWN');
  assert.deepEqual(inventory(), beforeRows);
  assert.deepEqual(fs.readFileSync(retained), custodyBefore);
  assert.equal(fs.existsSync(sidecar), false);
  assert.deepEqual(fs.readFileSync(f.paths.WEBAUTHN_CREDENTIALS_FILE), credentialsBefore);
});


test('POLICY_PATH_CAPTURE_ABSENT a managed actor cannot adopt a database that appears after capture', async t => {
  const f = await fixture(t);
  const schema = require('../lib/health-connect/schema');
  const tables = [...Object.keys(schema.nativeTables), ...Object.keys(schema.sourcePolicyTables)];
  const inventory = () => f.sql(db => Object.fromEntries(tables.map(table =>
    [table, db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all()])));
  await f.run(actor => f.read(actor, scope => {
    assert.equal(f.policy.snapshot(scope).knowledge, 'COMPLETE');
  }));
  const beforeRows = inventory();
  const sidecar = path.join(f.paths.CREDENTIALS_DIR, 'health-connect-policy.json');
  const catalogueBefore = fs.readFileSync(sidecar);
  const legacy = path.join(f.paths.CREDENTIALS_DIR, 'health-connect.json');
  const legacyBefore = fs.existsSync(legacy) ? fs.readFileSync(legacy) : null;
  const retained = f.paths.DB_FILE + '.missing-during-actor-capture';
  assert.equal(fs.existsSync(retained), false);
  fs.renameSync(f.paths.DB_FILE, retained);
  let restored = false, observerReached = false;
  try {
    await assert.rejects(f.run(actor => {
      observerReached = true;
      // The real actor was captured with the selected database absent.
      // Restoring a file must not retroactively supply that missing binding.
      fs.renameSync(retained, f.paths.DB_FILE);
      restored = true;
      return f.read(actor, scope => f.policy.snapshot(scope));
    }), error => error instanceof f.policy.PolicyError &&
      error.status === 503 && error.code === 'storage-unavailable');
  } finally {
    if (!restored) fs.renameSync(retained, f.paths.DB_FILE);
  }
  assert.equal(observerReached, true, 'the actual lifecycle reaches the genuine identity observer');
  await f.run(actor => f.read(actor, scope => {
    assert.equal(f.policy.snapshot(scope).knowledge, 'COMPLETE',
      'a fresh request binds the restored original database normally');
  }));
  assert.deepEqual(inventory(), beforeRows);
  assert.deepEqual(fs.readFileSync(sidecar), catalogueBefore);
  assert.equal(fs.existsSync(legacy), legacyBefore !== null);
  if (legacyBefore !== null) assert.deepEqual(fs.readFileSync(legacy), legacyBefore);
});

test('POLICY_PATH_NEWBORN_CUSTODY first-birth custody binds its actual selected database', async t => {
  const Module = require('node:module');
  const originalLoad = Module._load;
  let checked = 0, newbornIdentity;
  Module._load = function(request, parent, isMain) {
    const policy = originalLoad.call(this, request, parent, isMain);
    if (request !== '../lib/health-connect/source-policy' || parent?.filename !== __filename) return policy;
    const enrol = policy.enrolStopped;
    policy.enrolStopped = function() {
      const newborn = enrol.apply(this, arguments);
      const paths = require('../config/paths');
      const schema = require('../lib/health-connect/schema');
      const tables = [...Object.keys(schema.nativeTables), ...Object.keys(schema.sourcePolicyTables)];
      const inventory = () => {
        const db = new DatabaseSync(paths.DB_FILE);
        try { return Object.fromEntries(tables.map(table =>
          [table, db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all()])); }
        finally { db.close(); }
      };
      assert.equal(checked, 0, 'observe only the original fixture first ordinary pairing');
      const healthy = policy.updateNamespace(newborn.namespaceAuthority, state => state);
      assert.equal(healthy.tenantId, newborn.tenantId);
      const sidecar = path.join(paths.CREDENTIALS_DIR, 'health-connect-policy.json');
      const beforeRows = inventory(), catalogueBefore = fs.readFileSync(sidecar);
      const checkpoint = new DatabaseSync(paths.DB_FILE);
      try { checkpoint.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } finally { checkpoint.close(); }
      const originalIdentity = fs.lstatSync(paths.DB_FILE, { bigint: true });
      const copied = paths.DB_FILE + '.newborn-physical-copy';
      const retainedOriginal = paths.DB_FILE + '.newborn-retained-original';
      const retainedReplacement = paths.DB_FILE + '.newborn-retained-replacement';
      for (const filename of [copied, retainedOriginal, retainedReplacement]) assert.equal(fs.existsSync(filename), false);
      fs.copyFileSync(paths.DB_FILE, copied);
      let originalMoved = false, replacementSelected = false, deniedCallbackReached = false;
      try {
        fs.renameSync(paths.DB_FILE, retainedOriginal); originalMoved = true;
        fs.renameSync(copied, paths.DB_FILE); replacementSelected = true;
        const replacementIdentity = fs.lstatSync(paths.DB_FILE, { bigint: true });
        assert.ok(originalIdentity.dev !== replacementIdentity.dev || originalIdentity.ino !== replacementIdentity.ino,
          'PREREQUISITE: selected physical database identity actually changes');
        assert.deepEqual(inventory(), beforeRows);
        assert.throws(() => policy.updateNamespace(newborn.namespaceAuthority, state => {
          deniedCallbackReached = true; return state;
        }), error => error instanceof policy.PolicyError && error.status === 409 && error.code === 'binding-mismatch');
        assert.equal(deniedCallbackReached, false);
        assert.deepEqual(inventory(), beforeRows);
        assert.deepEqual(fs.readFileSync(sidecar), catalogueBefore);
      } finally {
        if (replacementSelected) fs.renameSync(paths.DB_FILE, retainedReplacement);
        if (originalMoved) fs.renameSync(retainedOriginal, paths.DB_FILE);
      }
      checked++; newbornIdentity = newborn.tenantId;
      return newborn;
    };
    return policy;
  };
  let f;
  try { f = await fixture(t); } finally { Module._load = originalLoad; }
  assert.equal(checked, 1);
  assert.equal(f.tenantId, newbornIdentity, 'same real first HTTP pairing completes healthy201 after restoration');
});


test('POLICY_F01 omitted retired namespace refuses read and new birth without mutation', async t => {
  const f = await fixture(t);
  const other = await f.request('POST', '/api/connectors/health-connect/pairing-grants',
    { categories: ['WeightRecord'], name: 'Retained retired fixture source' });
  assert.equal(other.status, 201, JSON.stringify(other.body));
  await f.run(actor => f.policy.withWriteAuthority(actor, scope => {
    const before = f.policy.snapshot(scope);
    f.policy.retire(scope, f.expected(before));
    assert.equal(f.policy.snapshot(scope).sources[0].lifecycle, 'retired');
  }, { tenantId: other.body.tenantId }));
  assert.equal(f.policy.readNamespaces().length, 2, 'healthy complete catalogue control');
  const sidecar = path.join(f.paths.CREDENTIALS_DIR, 'health-connect-policy.json');
  const cat = JSON.parse(fs.readFileSync(sidecar));
  cat.namespaces = cat.namespaces.filter(n => n.state.tenantId !== other.body.tenantId);
  fs.writeFileSync(sidecar, JSON.stringify(cat));
  const faulty = fs.readFileSync(sidecar);
  const tables = [...Object.keys(require('../lib/health-connect/schema').nativeTables),
    ...Object.keys(require('../lib/health-connect/schema').sourcePolicyTables)];
  const inventory = () => f.sql(db => Object.fromEntries(tables.map(table =>
    [table, db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all()])));
  const beforeRows = inventory();
  assert.throws(() => f.policy.readNamespaces(), error => error.status === 409 &&
    error.code === 'IMPORT_SOURCE_POLICY_UNKNOWN');
  const result = await f.request('POST', '/api/connectors/health-connect/pairing-grants',
    { categories: ['WeightRecord'], name: 'Refused truncated catalogue birth' });
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'IMPORT_SOURCE_POLICY_UNKNOWN');
  assert.deepEqual(inventory(), beforeRows);
  assert.deepEqual(fs.readFileSync(sidecar), faulty);
});

test('POLICY_F01 missing catalogue with retained managed SQL refuses fresh birth', async t => {
  const f = await fixture(t);
  const sidecar = path.join(f.paths.CREDENTIALS_DIR, 'health-connect-policy.json');
  const tables = [...Object.keys(require('../lib/health-connect/schema').nativeTables),
    ...Object.keys(require('../lib/health-connect/schema').sourcePolicyTables)];
  const inventory = () => f.sql(db => Object.fromEntries(tables.map(table =>
    [table, db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all()])));
  const beforeRows = inventory();
  assert.equal(f.policy.readNamespaces().length, 1, 'healthy current scope before file loss');
  fs.unlinkSync(sidecar);
  const result = await f.request('POST', '/api/connectors/health-connect/pairing-grants',
    { categories: ['WeightRecord'], name: 'Refused missing catalogue birth' });
  assert.equal(result.status, 409, 'retained managed namespace forbids treating absence as empty');
  assert.equal(result.body.code, 'IMPORT_SOURCE_POLICY_UNKNOWN');
  assert.deepEqual(inventory(), beforeRows);
  assert.equal(fs.existsSync(sidecar), false);
});

test('POLICY_F02 actual association rename then fault retains recovery denial', async t => {
  const f = await fixture(t);
  const sidecar = path.join(f.paths.CREDENTIALS_DIR, 'health-connect-policy.json');
  const req = { headers: { cookie: `klebb_session=${COOKIE}` } };
  const custody = f.policy.captureRegistrationActor(req);
  assert.ok(custody, 'genuine existing member registration authority');
  const added = { id: 'added-current-member', publicKey: Buffer.from('added genuine saved key').toString('base64') };
  f.writeCredentials({ users: { member: { credentials: [credential, added] } } });
  const credentialsBefore = fs.readFileSync(f.paths.WEBAUTHN_CREDENTIALS_FILE);
  const tables = [...Object.keys(require('../lib/health-connect/schema').nativeTables),
    ...Object.keys(require('../lib/health-connect/schema').sourcePolicyTables)];
  const inventory = () => f.sql(db => Object.fromEntries(tables.map(table =>
    [table, db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all()])));
  const beforeRows = inventory();
  const originalRename = fs.renameSync;
  let faults = 0, observedPublication = false;
  fs.renameSync = function(from, to) {
    const result = originalRename.apply(this, arguments);
    if (String(to) === sidecar && faults === 0 &&
        JSON.parse(fs.readFileSync(sidecar)).principals.some(p => p.members.some(m => m.credentialId === added.id))) {
      observedPublication = true; faults++;
      const error = new Error('fixture uncertainty after actual membership rename'); error.code = 'EIO'; throw error;
    }
    return result;
  };
  try {
    assert.throws(() => f.policy.bindRegisteredCredential(custody, req, added), error =>
      error.status === 503 && error.code === 'IMPORT_SOURCE_POLICY_RECOVERY_REQUIRED');
  } finally { fs.renameSync = originalRename; }
  assert.equal(faults, 1); assert.equal(observedPublication, true);
  assert.throws(() => f.policy.readNamespaces(), error => error.status === 503 &&
    error.code === 'IMPORT_SOURCE_POLICY_RECOVERY_REQUIRED');
  assert.deepEqual(fs.readFileSync(f.paths.WEBAUTHN_CREDENTIALS_FILE), credentialsBefore);
  assert.deepEqual(inventory(), beforeRows);
});


test('POLICY_F01 binder cannot publish membership over an omitted retired namespace', async t => {
  const f = await fixture(t);
  const other = await f.request('POST', '/api/connectors/health-connect/pairing-grants',
    { categories: ['WeightRecord'], name: 'Retained registration fixture source' });
  assert.equal(other.status, 201);
  await f.run(actor => f.policy.withWriteAuthority(actor, scope =>
    f.policy.retire(scope, f.expected(f.policy.snapshot(scope))), { tenantId: other.body.tenantId }));
  assert.equal(f.policy.readNamespaces().length, 2);
  const sidecar = path.join(f.paths.CREDENTIALS_DIR, 'health-connect-policy.json');
  const req = { headers: { cookie: `klebb_session=${COOKIE}` } };
  const custody = f.policy.captureRegistrationActor(req);
  const cat = JSON.parse(fs.readFileSync(sidecar));
  cat.namespaces = cat.namespaces.filter(n => n.state.tenantId !== other.body.tenantId);
  fs.writeFileSync(sidecar, JSON.stringify(cat));
  const faulty = fs.readFileSync(sidecar);
  const added = { id: 'added-after-omission', publicKey: Buffer.from('saved omitted catalogue key').toString('base64') };
  f.writeCredentials({ users: { member: { credentials: [credential, added] } } });
  const tables = [...Object.keys(require('../lib/health-connect/schema').nativeTables),
    ...Object.keys(require('../lib/health-connect/schema').sourcePolicyTables)];
  const inventory = () => f.sql(db => Object.fromEntries(tables.map(table =>
    [table, db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all()])));
  const beforeRows = inventory(), originalRename = fs.renameSync;
  let policyRenames = 0;
  fs.renameSync = function(from, to) {
    if (String(to) === sidecar) policyRenames++;
    return originalRename.apply(this, arguments);
  };
  try {
    assert.throws(() => f.policy.bindRegisteredCredential(custody, req, added), error =>
      error.status === 409 && error.code === 'IMPORT_SOURCE_POLICY_UNKNOWN');
  } finally { fs.renameSync = originalRename; }
  assert.equal(policyRenames, 0, 'refusal must precede any credential association publication');
  assert.deepEqual(fs.readFileSync(sidecar), faulty);
  assert.deepEqual(inventory(), beforeRows);
});

test('POLICY_F02 failed recovery publication keeps the original association mutex as quarantine', async t => {
  const f = await fixture(t);
  const sidecar = path.join(f.paths.CREDENTIALS_DIR, 'health-connect-policy.json');
  const req = { headers: { cookie: `klebb_session=${COOKIE}` } };
  const custody = f.policy.captureRegistrationActor(req);
  const added = { id: 'added-uncertain-quarantine', publicKey: Buffer.from('saved quarantine key').toString('base64') };
  f.writeCredentials({ users: { member: { credentials: [credential, added] } } });
  const savedCredentials = fs.readFileSync(f.paths.WEBAUTHN_CREDENTIALS_FILE);
  const tables = [...Object.keys(require('../lib/health-connect/schema').nativeTables),
    ...Object.keys(require('../lib/health-connect/schema').sourcePolicyTables)];
  const inventory = () => f.sql(db => Object.fromEntries(tables.map(table =>
    [table, db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all()])));
  const beforeRows = inventory(), originalRename = fs.renameSync;
  let actualAssociationRenames = 0, recoveryRefusals = 0;
  fs.renameSync = function(from, to) {
    if (String(to) === sidecar && actualAssociationRenames > 0) {
      recoveryRefusals++; throw new Error('fixture refusal of recovery publication');
    }
    const result = originalRename.apply(this, arguments);
    if (String(to) === sidecar && JSON.parse(fs.readFileSync(sidecar)).principals
      .some(p => p.members.some(m => m.credentialId === added.id))) {
      actualAssociationRenames++; throw new Error('fixture failure after actual association rename');
    }
    return result;
  };
  try {
    assert.throws(() => f.policy.bindRegisteredCredential(custody, req, added), error =>
      error.status === 503 && error.code === 'IMPORT_SOURCE_POLICY_RECOVERY_REQUIRED');
  } finally { fs.renameSync = originalRename; }
  assert.equal(actualAssociationRenames, 1); assert.equal(recoveryRefusals, 1);
  assert.equal(fs.existsSync(sidecar + '.lock'), true, 'original mutex must remain after uncertain quarantine publication');
  assert.throws(() => f.policy.readNamespaces(), error => error.status === 503 &&
    error.code === 'IMPORT_SOURCE_POLICY_RECOVERY_REQUIRED');
  assert.deepEqual(fs.readFileSync(f.paths.WEBAUTHN_CREDENTIALS_FILE), savedCredentials);
  assert.deepEqual(inventory(), beforeRows);
});

test('PLC00 healthy existing tenant read returns the fixed stopped policy snapshot', async t => {

  const f = await fixture(t);
  const catalogueFile = path.join(f.paths.CREDENTIALS_DIR, 'health-connect-policy.json');
  const originalBytes = fs.readFileSync(catalogueFile);
  const catalogue = JSON.parse(originalBytes);
  assert.equal(catalogue.principals.length, 1);
  assert.equal(catalogue.namespaces.length, 1);
  assert.deepEqual(catalogue.principals[0].members, [{
    userId: 'member', credentialId: 'fixture-member',
    publicKeySha256: 'sha256:f42dacc49d0b89b43060df327b9663abb5e395f3607419938ee546146d02a007',
  }]);
  assert.equal(catalogue.namespaces[0].state.tenantId, f.tenantId);
  assert.equal(catalogue.namespaces[0].state.grants.length, 1);
  assert.equal(catalogue.namespaces[0].state.connectors.length, 0);
  assert.equal(catalogue.namespaces[0].state.grants[0].name, 'Fixture source');
  assert.equal(catalogue.namespaces[0].state.grants[0].sourceStoreId, f.sourceStoreId);
  const ownerId = catalogue.principals[0].ownerId;
  const policyId = f.sql(db => db.prepare(
    'SELECT policy_id FROM health_source_policy_sources WHERE tenant_id=? AND source_store_id=?'
  ).get(f.tenantId, f.sourceStoreId).policy_id);
  assert.match(policyId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  const expected = {
    tenantId: f.tenantId, ownerId, epoch: f.restoreEpoch, revision: '1', knowledge: 'COMPLETE', sourceCount: 1,
    sources: [{
      sourceStoreId: f.sourceStoreId, policyId, lifecycle: 'active', knowledge: 'COMPLETE',
      retainCommittedHistory: 1, categoryCount: 2, reconciledEpoch: null,
      categories: [
        { recordType: 'StepsRecord', sharing: 'stopped', generation: '1' },
        { recordType: 'WeightRecord', sharing: 'stopped', generation: '1' },
      ],
    }],
  };
  const credentialsBefore = fs.readFileSync(f.paths.WEBAUTHN_CREDENTIALS_FILE);
  const sessionBefore = JSON.parse(fs.readFileSync(f.paths.WEBAUTHN_SESSIONS_FILE))[COOKIE];
  const sqlBefore = f.sql(db => ({
    schema: db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all(),
    tables: Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
      .map(({ name }) => [name, db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all()])),
  }));

  const captured = await f.run(actor => f.read(actor, scope => {
    const snapshot = f.policy.snapshot(scope);
    assert.deepEqual(snapshot, expected);
    return snapshot;
  }));
  assert.deepEqual(captured, expected);

    assert.deepEqual(fs.readFileSync(catalogueFile), originalBytes);
    assert.deepEqual(fs.readFileSync(f.paths.WEBAUTHN_CREDENTIALS_FILE), credentialsBefore);
    assert.deepEqual(f.sql(db => ({
    schema: db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all(),
    tables: Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
      .map(({ name }) => [name, db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all()])),
  })), sqlBefore);
    const sessionAfter = JSON.parse(fs.readFileSync(f.paths.WEBAUTHN_SESSIONS_FILE))[COOKIE];
    assert.deepEqual({ ...sessionAfter, lastSeen: sessionBefore.lastSeen }, sessionBefore);
    assert.ok(Number.isFinite(sessionAfter.lastSeen) && sessionAfter.lastSeen >= sessionBefore.lastSeen);

  console.log(JSON.stringify({ tenantReadControlHealthy: true, sourceCount: 1, categoryCount: 2 }));
});

test('PLC01 late valid catalogue grant bytes refuse before the tenant snapshot escapes', async t => {

  const f = await fixture(t);
  const catalogueFile = path.join(f.paths.CREDENTIALS_DIR, 'health-connect-policy.json');
  const originalBytes = fs.readFileSync(catalogueFile);
  const catalogue = JSON.parse(originalBytes);
  assert.equal(catalogue.principals.length, 1);
  assert.equal(catalogue.namespaces.length, 1);
  assert.deepEqual(catalogue.principals[0].members, [{
    userId: 'member', credentialId: 'fixture-member',
    publicKeySha256: 'sha256:f42dacc49d0b89b43060df327b9663abb5e395f3607419938ee546146d02a007',
  }]);
  assert.equal(catalogue.namespaces[0].state.tenantId, f.tenantId);
  assert.equal(catalogue.namespaces[0].state.grants.length, 1);
  assert.equal(catalogue.namespaces[0].state.connectors.length, 0);
  assert.equal(catalogue.namespaces[0].state.grants[0].name, 'Fixture source');
  assert.equal(catalogue.namespaces[0].state.grants[0].sourceStoreId, f.sourceStoreId);
  const ownerId = catalogue.principals[0].ownerId;
  const policyId = f.sql(db => db.prepare(
    'SELECT policy_id FROM health_source_policy_sources WHERE tenant_id=? AND source_store_id=?'
  ).get(f.tenantId, f.sourceStoreId).policy_id);
  assert.match(policyId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  const expected = {
    tenantId: f.tenantId, ownerId, epoch: f.restoreEpoch, revision: '1', knowledge: 'COMPLETE', sourceCount: 1,
    sources: [{
      sourceStoreId: f.sourceStoreId, policyId, lifecycle: 'active', knowledge: 'COMPLETE',
      retainCommittedHistory: 1, categoryCount: 2, reconciledEpoch: null,
      categories: [
        { recordType: 'StepsRecord', sharing: 'stopped', generation: '1' },
        { recordType: 'WeightRecord', sharing: 'stopped', generation: '1' },
      ],
    }],
  };
  const credentialsBefore = fs.readFileSync(f.paths.WEBAUTHN_CREDENTIALS_FILE);
  const sessionBefore = JSON.parse(fs.readFileSync(f.paths.WEBAUTHN_SESSIONS_FILE))[COOKIE];
  const sqlBefore = f.sql(db => ({
    schema: db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all(),
    tables: Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
      .map(({ name }) => [name, db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all()])),
  }));

  let healthyReached = false, mutationApplied = false, resultEscaped = false;
  try {
    await f.run(actor => {
      f.read(actor, scope => {
        assert.deepEqual(f.policy.snapshot(scope), expected);
        healthyReached = true;
      });
      assert.throws(() => {
        const returned = f.read(actor, scope => {
          const captured = f.policy.snapshot(scope);
          assert.deepEqual(captured, expected);
          const changedCatalogue = JSON.parse(originalBytes);
          changedCatalogue.namespaces[0].state.grants[0].name = 'Late catalogue fixture';
          const changedBytes = Buffer.from(JSON.stringify(changedCatalogue));
          assert.notDeepEqual(changedBytes, originalBytes);
          fs.writeFileSync(catalogueFile, changedBytes);
          assert.deepEqual(fs.readFileSync(catalogueFile), changedBytes);
          const unchangedFields = JSON.parse(changedBytes);
          unchangedFields.namespaces[0].state.grants[0].name = 'Fixture source';
          assert.deepEqual(unchangedFields, catalogue);
          mutationApplied = true;
          return captured;
        });
        resultEscaped = true;
        return returned;
      }, error => error instanceof f.policy.PolicyError && error.status === 409 &&
        error.code === 'IMPORT_SOURCE_POLICY_UNKNOWN',
      'Late catalogue bytes must refuse before the tenant snapshot escapes');
    });
  } finally {
    fs.writeFileSync(catalogueFile, originalBytes);
    assert.equal(healthyReached, true);
    assert.equal(mutationApplied, true);

    assert.deepEqual(fs.readFileSync(catalogueFile), originalBytes);
    assert.deepEqual(fs.readFileSync(f.paths.WEBAUTHN_CREDENTIALS_FILE), credentialsBefore);
    assert.deepEqual(f.sql(db => ({
    schema: db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all(),
    tables: Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
      .map(({ name }) => [name, db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all()])),
  })), sqlBefore);
    const sessionAfter = JSON.parse(fs.readFileSync(f.paths.WEBAUTHN_SESSIONS_FILE))[COOKIE];
    assert.deepEqual({ ...sessionAfter, lastSeen: sessionBefore.lastSeen }, sessionBefore);
    assert.ok(Number.isFinite(sessionAfter.lastSeen) && sessionAfter.lastSeen >= sessionBefore.lastSeen);

    console.log(JSON.stringify({
      tenantReadControlHealthy: healthyReached, lateGrantNameMutationApplied: mutationApplied,
      catalogueRestored: true, sqlUnchanged: true, credentialsUnchanged: true, resultEscaped,
    }));
  }
  assert.equal(resultEscaped, false);
});


// These controls use genuine existing lifecycle/authentication and pairing.
// Only the explicit ownerWide option is a proposed extension of an existing API.
async function ownerWideStoppedFixture(t) {
  const f = await fixture(t);
  const secondResponse = await f.request('POST', '/api/connectors/health-connect/pairing-grants', {
    categories: ['WeightRecord'], name: 'Second owned fixture',
  });
  assert.equal(secondResponse.status, 201, JSON.stringify(secondResponse.body));
  const second = secondResponse.body;
  assert.notEqual(second.tenantId, f.tenantId);
  const sessionFile = f.paths.WEBAUTHN_SESSIONS_FILE;
  const primarySessions = fs.readFileSync(sessionFile);
  const foreignCredential = {
    id: 'foreign-fixture-member',
    publicKey: Buffer.from('foreign fixture public key').toString('base64'),
  };
  f.writeCredentials({ users: {
    member: { credentials: [credential] },
    'foreign-member': { credentials: [foreignCredential] },
  } });
  let foreign;
  try {
    fs.writeFileSync(sessionFile, JSON.stringify({
      [COOKIE]: { userId: 'foreign-member', credentialId: foreignCredential.id,
        created: Date.now(), lastSeen: Date.now() },
    }));
    const response = await f.request('POST', '/api/connectors/health-connect/pairing-grants', {
      categories: ['StepsRecord'], name: 'Foreign owned fixture',
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    foreign = response.body;
    assert.notEqual(foreign.tenantId, f.tenantId);
    assert.notEqual(foreign.tenantId, second.tenantId);
  } finally {
    fs.writeFileSync(sessionFile, primarySessions);
  }
  await f.run(actor => f.policy.withWriteAuthority(actor, scope => f.policy.retire(scope, {
    sourceStoreId: second.sourceStoreId, epoch: second.restoreEpoch, revision: '1',
    generations: { WeightRecord: '1' },
  }), { tenantId: second.tenantId }));

  const catalogueFile = path.join(f.paths.CREDENTIALS_DIR, 'health-connect-policy.json');
  const catalogueBytes = fs.readFileSync(catalogueFile);
  const catalogue = JSON.parse(catalogueBytes);
  assert.equal(catalogue.principals.length, 2);
  assert.equal(catalogue.namespaces.length, 3);
  const primaryNamespace = catalogue.namespaces.find(n => n.state.tenantId === f.tenantId);
  const secondNamespace = catalogue.namespaces.find(n => n.state.tenantId === second.tenantId);
  const foreignNamespace = catalogue.namespaces.find(n => n.state.tenantId === foreign.tenantId);
  assert.ok(primaryNamespace && secondNamespace && foreignNamespace);
  const ownerId = primaryNamespace.ownerId;
  assert.equal(secondNamespace.ownerId, ownerId);
  assert.notEqual(foreignNamespace.ownerId, ownerId);
  assert.deepEqual(catalogue.namespaces.filter(n => n.ownerId === ownerId)
    .map(n => n.state.tenantId).sort(), [f.tenantId, second.tenantId].sort());
  assert.ok(catalogue.principals.find(p => p.ownerId === ownerId).members.some(m =>
    m.userId === 'member' && m.credentialId === credential.id));
  assert.ok(catalogue.principals.find(p => p.ownerId === foreignNamespace.ownerId).members.some(m =>
    m.userId === 'foreign-member' && m.credentialId === foreignCredential.id));
  for (const n of catalogue.namespaces) {
    assert.equal(n.state.grants.length, 1);
    assert.equal(n.state.connectors.length, 0);
  }

  const identities = [
    { tenantId: f.tenantId, sourceStoreId: f.sourceStoreId, epoch: f.restoreEpoch,
      revision: '1', lifecycle: 'active',
      categories: [
        { recordType: 'StepsRecord', sharing: 'stopped', generation: '1' },
        { recordType: 'WeightRecord', sharing: 'stopped', generation: '1' },
      ] },
    { tenantId: second.tenantId, sourceStoreId: second.sourceStoreId, epoch: second.restoreEpoch,
      revision: '2', lifecycle: 'retired',
      categories: [{ recordType: 'WeightRecord', sharing: 'stopped', generation: '2' }] },
  ].sort((a, b) => a.tenantId < b.tenantId ? -1 : a.tenantId > b.tenantId ? 1 : 0);
  for (const identity of identities) {
    const row = f.sql(db => db.prepare(
      'SELECT policy_id FROM health_source_policy_sources WHERE tenant_id=? AND source_store_id=?'
    ).get(identity.tenantId, identity.sourceStoreId));
    assert.match(row.policy_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    identity.policyId = row.policy_id;
  }
  const expectedTenant = identity => ({
    tenantId: identity.tenantId, ownerId, epoch: identity.epoch,
    revision: identity.revision, knowledge: 'COMPLETE', sourceCount: 1,
    sources: [{
      sourceStoreId: identity.sourceStoreId, policyId: identity.policyId,
      lifecycle: identity.lifecycle, knowledge: 'COMPLETE',
      retainCommittedHistory: 1, categoryCount: identity.categories.length,
      reconciledEpoch: null, categories: identity.categories,
    }],
  });
  const expected = {
    catalog: {
      version: 3, ownerRef: ownerId,
      namespaces: identities.map(identity => ({
        tenantId: identity.tenantId, ownerRef: ownerId, sourceCount: 1,
        sources: [{
          sourceStoreId: identity.sourceStoreId,
          provider: 'health-connect-native', policyRef: identity.policyId,
        }],
      })),
    },
    records: [],
    sourcePolicies: identities.map(identity => ({
      tenantId: identity.tenantId, ownerRef: ownerId,
      revision: identity.revision, sourceCount: 1,
      sources: [{
        sourceStoreId: identity.sourceStoreId, policyId: identity.policyId,
        lifecycle: identity.lifecycle, retainCommittedHistory: true,
        categoryCount: identity.categories.length, categories: identity.categories,
      }],
    })),
    streams: [], receipts: [], projectionOutbox: [],
    tombstones: [], deletionGuards: [], suppressions: [],
  };
  const inventory = () => f.sql(db => ({
    schema: db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all(),
    tables: Object.fromEntries(db.prepare(
      "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).all().map(({ name }) => [
      name, db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all(),
    ])),
  }));
  const sqlBefore = inventory();
  for (const table of ['health_records', 'health_streams', 'health_batch_receipts',
    'health_projection_outbox', 'health_tombstones']) {
    assert.deepEqual(sqlBefore.tables[table], [], 'This smallest slice has no native family rows');
  }
  assert.equal(Object.hasOwn(sqlBefore.tables, 'health_deletion_guards'), false,
    'The original native v1 fixture has no guard table; this slice does not create one');
  const credentialsBefore = fs.readFileSync(f.paths.WEBAUTHN_CREDENTIALS_FILE);
  const sessionBefore = JSON.parse(fs.readFileSync(sessionFile))[COOKIE];
  const unchanged = () => {
    assert.deepEqual(fs.readFileSync(catalogueFile), catalogueBytes);
    assert.deepEqual(inventory(), sqlBefore);
    assert.deepEqual(fs.readFileSync(f.paths.WEBAUTHN_CREDENTIALS_FILE), credentialsBefore);
    const sessionAfter = JSON.parse(fs.readFileSync(sessionFile))[COOKIE];
    assert.deepEqual({ ...sessionAfter, lastSeen: sessionBefore.lastSeen }, sessionBefore);
    assert.ok(Number.isFinite(sessionAfter.lastSeen) && sessionAfter.lastSeen >= sessionBefore.lastSeen);
  };
  await f.run(actor => {
    for (const identity of identities) {
      const captured = f.policy.withReadAuthority(actor, scope => f.policy.snapshot(scope),
        { tenantId: identity.tenantId });
      assert.deepEqual(captured, expectedTenant(identity));
    }
  });
  unchanged();
  return { f, expected, unchanged, foreignTenantId: foreign.tenantId,
    ownedTenantIds: identities.map(identity => identity.tenantId) };
}

test('OWN00 genuine two owned stopped-retired namespaces and foreign owner pass tenant controls', async t => {
  const { expected, unchanged, ownedTenantIds, foreignTenantId } = await ownerWideStoppedFixture(t);
  assert.equal(expected.catalog.namespaces.length, 2);
  assert.equal(expected.sourcePolicies.length, 2);
  assert.equal(expected.sourcePolicies.flatMap(p => p.sources).length, 2);
  assert.equal(expected.sourcePolicies.flatMap(p => p.sources.flatMap(s => s.categories)).length, 3);
  assert.ok(!ownedTenantIds.includes(foreignTenantId));
  unchanged();
  console.log(JSON.stringify({
    twoOwnedTenantControlsHealthy: true, foreignPrincipalGenuineAndExcluded: true,
    stoppedActiveAndRetiredIntentFixed: true, wholeSQLCatalogueCredentialsUnchanged: true,
  }));
});

test('OWN01 explicit ownerWide read returns both owned namespaces and excludes the foreign principal', async t => {
  const { f, expected, unchanged, ownedTenantIds, foreignTenantId } = await ownerWideStoppedFixture(t);
  assert.equal(ownedTenantIds.length, 2);
  assert.ok(!ownedTenantIds.includes(foreignTenantId));
  let resultReturned = false, ownerWideMatched = false;
  try {
    const captured = await f.run(actor => f.policy.withReadAuthority(
      actor, scope => f.policy.snapshot(scope),
      { tenantId: f.tenantId, ownerWide: true }
    ));
    resultReturned = true;
    assert.deepEqual(captured, expected,
      'An explicit ownerWide read must return the fixed detached nine-family two-owned-namespace snapshot');
    ownerWideMatched = true;
  } finally {
    unchanged();
    console.log(JSON.stringify({
      twoOwnedTenantControlsHealthy: true, foreignPrincipalGenuineAndExcluded: true,
      stoppedActiveAndRetiredIntentFixed: true, wholeSQLCatalogueCredentialsUnchanged: true,
      ownerWideResultReturned: resultReturned, ownerWideMatched,
    }));
  }
});


async function metadataReadBoundsFixture(t, oversized) {
  const f = await fixture(t);
  await f.run(actor => f.read(actor, scope => {
    const captured = f.policy.snapshot(scope);
    assert.equal(captured.tenantId, f.tenantId);
    assert.equal(captured.knowledge, 'COMPLETE');
    assert.equal(captured.revision, '1');
    assert.equal(captured.sourceCount, 1);
    assert.equal(captured.sources[0].sourceStoreId, f.sourceStoreId);
    assert.deepEqual(captured.sources[0].categories.map(c => [c.recordType, c.sharing, c.generation]),
      [['StepsRecord', 'stopped', '1'], ['WeightRecord', 'stopped', '1']]);
  }));
  const originalTables = [
    'health_batch_receipts', 'health_projection_outbox', 'health_records',
    'health_schema_version', 'health_source_policy_categories',
    'health_source_policy_sources', 'health_source_policy_state',
    'health_streams', 'health_tombstones',
  ];
  f.sql(db => {
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sqlite_schema').get().n, 20);
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")
      .all().map(row => row.name), originalTables);
    assert.deepEqual(db.prepare('SELECT version FROM health_schema_version').all().map(row => row.version), [1]);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM health_source_policy_state').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM health_source_policy_sources').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM health_source_policy_categories').get().n, 2);
    for (const name of ['health_records', 'health_tombstones', 'health_streams',
      'health_batch_receipts', 'health_projection_outbox']) {
      assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n, 0);
    }
  });
  const probeSQL = 'CREATE TABLE health_metadata_bound_probe (' + 'x'.repeat(4096) + ' TEXT)';
  if (oversized) f.sql(db => db.exec(probeSQL));
  const inventory = () => f.sql(db => ({
    schema: db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all(),
    tables: Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")
      .all().map(({ name }) => [
        name, db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all(),
      ])),
  }));
  const beforeSQL = inventory();
  assert.equal(beforeSQL.schema.length, oversized ? 21 : 20);
  assert.deepEqual(Object.keys(beforeSQL.tables),
    oversized ? [...originalTables, 'health_metadata_bound_probe'].sort() : originalTables);
  let probeBytes = 0;
  if (oversized) {
    probeBytes = f.sql(db => db.prepare("SELECT length(CAST(sql AS BLOB)) AS bytes FROM sqlite_schema "
      + "WHERE type='table' AND name='health_metadata_bound_probe'").get().bytes);
    assert.equal(probeBytes, 4144);
    assert.ok(probeBytes > 4096, 'The fixed CREATE SQL is oversized before the tested read');
    assert.deepEqual(beforeSQL.tables.health_metadata_bound_probe, []);
  }
  const catalogueFile = path.join(f.paths.CREDENTIALS_DIR, 'health-connect-policy.json');
  const catalogueBytes = fs.readFileSync(catalogueFile);
  const credentialBytes = fs.readFileSync(f.paths.WEBAUTHN_CREDENTIALS_FILE);
  const sessionBytes = fs.readFileSync(f.paths.WEBAUTHN_SESSIONS_FILE);
  const unchanged = () => {
    assert.deepEqual(inventory(), beforeSQL);
    assert.deepEqual(fs.readFileSync(catalogueFile), catalogueBytes);
    assert.deepEqual(fs.readFileSync(f.paths.WEBAUTHN_CREDENTIALS_FILE), credentialBytes);
    assert.deepEqual(fs.readFileSync(f.paths.WEBAUTHN_SESSIONS_FILE), sessionBytes);
  };
  return { history: require('../lib/health-connect/history'), unchanged, probeBytes };
}

test('MD00 genuine V1 default snapshot preserves SQL catalogue and credentials', async t => {
  const { history, unchanged, probeBytes } = await metadataReadBoundsFixture(t, false);
  assert.equal(probeBytes, 0);
  let callbackReached = false, fixedResultReturned = false;
  try {
    const result = history.readHistorySnapshot((db, schemaPresent) => {
      callbackReached = true;
      assert.equal(schemaPresent, true);
      return 'metadata-default-v1-read';
    });
    assert.equal(result, 'metadata-default-v1-read');
    assert.equal(callbackReached, true);
    fixedResultReturned = true;
  } finally {
    unchanged();
    console.log(JSON.stringify({
      genuineV1TenantControlHealthy: true, defaultSnapshotCallbackReached: callbackReached,
      fixedDefaultResultReturned: fixedResultReturned, wholeSQLCatalogueCredentialsSessionsUnchanged: true,
    }));
  }
});

test('MD01 explicit ownerWide snapshot refuses oversized CREATE SQL before work', async t => {
  const { history, unchanged, probeBytes } = await metadataReadBoundsFixture(t, true);
  let healthyDefaultCallbackReached = false;
  assert.equal(history.readHistorySnapshot((db, schemaPresent) => {
    healthyDefaultCallbackReached = true;
    assert.equal(schemaPresent, true);
    return 'metadata-oversized-default-control';
  }), 'metadata-oversized-default-control');
  assert.equal(healthyDefaultCallbackReached, true);
  unchanged();
  let ownerWideCallbackReached = false, explicitLimitRefusalQualified = false;
  try {
    assert.throws(() => history.readHistorySnapshot(() => {
      ownerWideCallbackReached = true;
      return 'metadata-oversized-ownerwide-work-reached';
    }, { ownerWide: true }), error => {
      explicitLimitRefusalQualified = error instanceof history.HistoryError &&
        error.status === 503 && error.code === 'storage-unavailable';
      return explicitLimitRefusalQualified;
    }, 'An explicit ownerWide read must refuse oversized CREATE SQL before schema materialization');
    assert.equal(ownerWideCallbackReached, false);
  } finally {
    unchanged();
    console.log(JSON.stringify({
      genuineV1TenantControlHealthy: true, oversizedCREATEColdSQLBytes: probeBytes,
      healthyDefaultCallbackReached, explicitOwnerWideCallbackReached: ownerWideCallbackReached,
      explicitLimitRefusalQualified, wholeSQLCatalogueCredentialsSessionsUnchanged: true,
    }));
  }
});


// These are separate, invented cold V1 files, never a PRAGMA change to the
// already-created UTF-8 pairing database. Both real history calls use the
// same UTF-16 file and the unchanged exported V1 DDL.
for (const [suffix, encoding] of [['LE', 'UTF-16le'], ['BE', 'UTF-16be']]) {
  test(`MDUTF${suffix} real UTF16 V1 default read succeeds and ownerWide refuses before callback`, async t => {
    const f = await fixture(t);
    await f.run(actor => f.read(actor, scope => {
      const current = f.policy.snapshot(scope);
      assert.equal(current.tenantId, f.tenantId);
      assert.equal(current.knowledge, 'COMPLETE');
      assert.equal(current.sourceCount, 1);
    }));
    const pairedInventory = () => f.sql(db => ({
      schema: db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all(),
      tables: Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")
        .all().map(({ name }) => [name, db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all()])),
    }));
    const pairedBefore = pairedInventory();
    const privateFiles = [path.join(f.paths.CREDENTIALS_DIR, 'health-connect-policy.json'),
      f.paths.WEBAUTHN_CREDENTIALS_FILE, f.paths.WEBAUTHN_SESSIONS_FILE];
    const privateBefore = privateFiles.map(file => fs.readFileSync(file));
    const probeName = 'health_' + '\u4e00'.repeat(121);
    assert.equal(probeName.length, 128);
    assert.equal(Buffer.byteLength(probeName, 'utf8'), 370);
    const utf16File = path.join(f.paths.DB_DIR, `invented-metadata-utf16-${suffix}.sqlite`);
    assert.equal(fs.existsSync(utf16File), false);
    const schema = require('../lib/health-connect/schema');
    const created = new DatabaseSync(utf16File);
    try {
      created.exec(`PRAGMA encoding='${encoding}'`);
      for (const sql of Object.values(schema.nativeTables)) created.exec(sql);
      created.exec('CREATE INDEX health_receipt_sequence_order ON health_batch_receipts '
        + '(stream_key, length(sequence), sequence)');
      created.prepare('INSERT INTO health_schema_version(version) VALUES (1)').run();
      created.exec(`CREATE TABLE "${probeName}" (invented_value INTEGER)`);
    } finally { created.close(); }
    const inventory = () => {
      const db = new DatabaseSync(utf16File, { readOnly: true });
      try {
        const actualEncoding = db.prepare('PRAGMA encoding').get().encoding;
        assert.equal(actualEncoding, encoding);
        const witness = db.prepare('SELECT length(CAST(name AS BLOB)) AS storedBytes '
          + 'FROM sqlite_schema WHERE type=? AND name=?').get('table', probeName);
        assert.equal(witness.storedBytes, 256);
        const rows = db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();
        assert.equal(rows.length, 14);
        assert.equal(rows.find(row => row.name === 'health_schema_version').sql,
          schema.nativeTables.health_schema_version);
        assert.deepEqual(db.prepare('SELECT version FROM health_schema_version').all().map(row => row.version), [1]);
        return { encoding: actualEncoding, schema: rows,
          tables: Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")
            .all().map(({ name }) => [name, db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all()])) };
      } finally { db.close(); }
    };
    const utf16Before = inventory();
    for (const [name, rows] of Object.entries(utf16Before.tables)) {
      if (name !== 'health_schema_version') assert.deepEqual(rows, []);
    }
    // Rebind only this fresh history module's DB_FILE. Restore the existing
    // fixture's module entries and environment before either read executes.
    const pathsKey = require.resolve('../config/paths');
    const historyKey = require.resolve('../lib/health-connect/history');
    const priorPaths = require.cache[pathsKey];
    const priorHistory = require.cache[historyKey];
    const priorDBFile = process.env.HEALTH_DB_FILE;
    let history;
    try {
      process.env.HEALTH_DB_FILE = utf16File;
      delete require.cache[pathsKey];
      delete require.cache[historyKey];
      assert.equal(require('../config/paths').DB_FILE, utf16File);
      history = require('../lib/health-connect/history');
    } finally {
      if (priorDBFile === undefined) delete process.env.HEALTH_DB_FILE;
      else process.env.HEALTH_DB_FILE = priorDBFile;
      if (priorPaths === undefined) delete require.cache[pathsKey];
      else require.cache[pathsKey] = priorPaths;
      if (priorHistory === undefined) delete require.cache[historyKey];
      else require.cache[historyKey] = priorHistory;
    }
    let defaultCallbackReached = false;
    let ownerWideCallbackReached = false;
    let refusalQualified = false;
    let preservationQualified = false;
    try {
      assert.equal(history.readHistorySnapshot((db, present) => {
        defaultCallbackReached = true;
        assert.equal(present, true);
        assert.equal(db.prepare('PRAGMA encoding').get().encoding, encoding);
        assert.equal(db.prepare('SELECT name FROM sqlite_schema WHERE type=? AND name=?')
          .get('table', probeName).name, probeName);
        return 'invented-utf16-default-healthy';
      }), 'invented-utf16-default-healthy');
      assert.deepEqual(inventory(), utf16Before);
      assert.throws(() => history.readHistorySnapshot(() => {
        ownerWideCallbackReached = true;
        return 'invented-utf16-ownerwide-escaped';
      }, { ownerWide: true }), error => error instanceof history.HistoryError
        && error.status === 503 && error.code === 'storage-unavailable',
      'An explicit ownerWide read must refuse UTF16 metadata before schema materialization');
      refusalQualified = true;
      assert.equal(ownerWideCallbackReached, false);
    } finally {
      assert.deepEqual(inventory(), utf16Before);
      assert.deepEqual(pairedInventory(), pairedBefore);
      privateFiles.forEach((file, index) => assert.deepEqual(fs.readFileSync(file), privateBefore[index]));
      preservationQualified = true;
      console.log(`MDUTF${suffix}_FIXED_EVIDENCE ${JSON.stringify({
        actualEncoding: encoding, storedNameBytes: 256, utf8NameBytes: 370,
        genuineDefaultCallbackReached: defaultCallbackReached,
        explicitOwnerWideCallbackReached: ownerWideCallbackReached,
        explicitEncodingRefusalQualified: refusalQualified,
        bothSQLCatalogueCredentialsSessionsUnchanged: preservationQualified,
      })}`);
    }
  });
}


// Invented retained native SQL representation; no authenticated ingestion or SDK ACK claim.
async function ownerWideRetainedBatchFixture(t) {
  const original = await ownerWideStoppedFixture(t);
  const { f, expected, foreignTenantId } = original;
  // The existing two genuine tenant controls ran before seeding and checked empty SQL custody.
  const catalogueFile = path.join(f.paths.CREDENTIALS_DIR, 'health-connect-policy.json');
  const catalogueBytes = fs.readFileSync(catalogueFile);
  const catalogue = JSON.parse(catalogueBytes);
  const foreignNamespace = catalogue.namespaces.find(n => n.state.tenantId === foreignTenantId);
  const ownerNamespace = catalogue.namespaces.find(n => n.state.tenantId === f.tenantId);
  assert.ok(ownerNamespace && foreignNamespace);
  assert.notEqual(ownerNamespace.ownerId, foreignNamespace.ownerId);
  const foreignSources = f.sql(db => db.prepare(
    'SELECT source_store_id FROM health_source_policy_sources WHERE tenant_id=? ORDER BY source_store_id'
  ).all(foreignTenantId));
  assert.equal(foreignSources.length, 1);
  const ownedLiteral = {"recordJson":"{\"startTime\":\"2026-01-02T03:00:00Z\",\"endTime\":\"2026-01-02T03:10:00Z\",\"startZoneOffset\":\"+11:00\",\"endZoneOffset\":\"+11:00\",\"count\":\"42\",\"metadata\":{\"id\":\"invented-owner-record-01\",\"dataOrigin\":{\"packageName\":\"example.synthetic.owned\"},\"device\":{\"manufacturer\":null,\"model\":null,\"type\":0},\"lastModifiedTime\":\"2026-01-02T03:11:00Z\",\"clientRecordId\":null,\"clientRecordVersion\":\"1\",\"recordingMethod\":0}}","expectedUtf8Bytes":397,"expectedRecordDigest":"sha256:3e9cdfe5e7e6b025715667e0951f3bb261aff52dc748acc52b9ff130c81ed8df","serializerId":"health-connect-record","serializerVersion":1,"dataFamily":"ordinary","projection":"raw-only","nativeRecordId":"invented-owner-record-01","recordType":"StepsRecord"};
  const ownedTransport = {"installationId":"invented-historical-owner-01","generation":"0","restoreEpoch":"00000000-0000-4000-8000-000000000001","sequence":"1","batchId":"invented-owner-one-batch-01","payloadDigest":"sha256:723e618f8a8c6d051fab0e734052886f379a821e80ed664127544713608e3ecd"};
  const foreignLiteral = {"recordJson":"{\"startTime\":\"2026-01-02T03:00:00Z\",\"endTime\":\"2026-01-02T03:10:00Z\",\"startZoneOffset\":\"+11:00\",\"endZoneOffset\":\"+11:00\",\"count\":\"17\",\"metadata\":{\"id\":\"invented-foreign-record-01\",\"dataOrigin\":{\"packageName\":\"example.synthetic.foreign\"},\"device\":{\"manufacturer\":null,\"model\":null,\"type\":0},\"lastModifiedTime\":\"2026-01-02T03:11:00Z\",\"clientRecordId\":null,\"clientRecordVersion\":\"1\",\"recordingMethod\":0}}","expectedUtf8Bytes":401,"expectedRecordDigest":"sha256:d86c9cfdf98f9a991e1caeff7a1ff32c6e08d5ca465536acbe259acc6b26dbc4","nativeRecordId":"invented-foreign-record-01","recordType":"StepsRecord","serializerId":"health-connect-record","serializerVersion":1,"dataFamily":"ordinary","projection":"raw-only"};
  const foreignTransport = {"installationId":"invented-historical-foreign-01","generation":"0","restoreEpoch":"00000000-0000-4000-8000-000000000002","sequence":"1","batchId":"invented-foreign-one-batch-01","payloadDigest":"sha256:ddb17398f1435ceddfb6e6c3f5a515179af9cf8ff47dc79e077249c380428482"};
  assert.notEqual(ownedTransport.restoreEpoch, f.restoreEpoch);
  assert.notEqual(foreignTransport.restoreEpoch, foreignNamespace.state.restoreEpoch);
  assert.equal(ownedTransport.generation, '0');
  assert.equal(expected.sourcePolicies.find(p => p.tenantId === f.tenantId)
    .sources[0].categories.find(c => c.recordType === 'StepsRecord').generation, '1');
  const batches = [
    { tenantId: f.tenantId, instanceId: f.instanceId, sourceStoreId: f.sourceStoreId,
      literal: ownedLiteral, transport: ownedTransport },
    { tenantId: foreignTenantId, instanceId: foreignNamespace.state.instanceId,
      sourceStoreId: foreignSources[0].source_store_id, literal: foreignLiteral,
      transport: foreignTransport },
  ];
  for (const batch of batches) {
    const { tenantId, instanceId, sourceStoreId, literal, transport } = batch;
    assert.match(instanceId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const identity = [tenantId, sourceStoreId, 'StepsRecord', literal.nativeRecordId];
    batch.record = { identity, nativeKeyJson: JSON.stringify(identity),
      serializerId: 'health-connect-record', serializerVersion: 1,
      dataFamily: 'ordinary', projection: 'raw-only',
      expectedUtf8Bytes: literal.expectedUtf8Bytes,
      expectedRecordDigest: literal.expectedRecordDigest, recordJson: literal.recordJson };
    assert.equal(Buffer.byteLength(literal.recordJson, 'utf8'), literal.expectedUtf8Bytes);
    assert.equal('sha256:' + require('node:crypto').createHash('sha256').update(literal.recordJson, 'utf8').digest('hex'),
      literal.expectedRecordDigest);
    const streamKey = JSON.stringify([tenantId, instanceId, sourceStoreId,
      transport.installationId, 'StepsRecord', '0', transport.restoreEpoch]);
    const binding = { tenantId, instanceId, sourceStoreId, installationId: transport.installationId,
      generation: '0', restoreEpoch: transport.restoreEpoch };
    const receiptJson = JSON.stringify({ version: 1, kind: 'durable-receipt', binding,
      recordType: 'StepsRecord', sequence: '1', batchId: transport.batchId,
      payloadDigest: transport.payloadDigest });
    batch.stream = { streamKey, recordType: 'StepsRecord', acknowledgedSequence: '1' };
    batch.receipt = { streamKey, sequence: '1', batchId: transport.batchId,
      payloadDigest: transport.payloadDigest, receiptJson };
    batch.outbox = { streamKey, sequence: '1', batchId: transport.batchId,
      payloadDigest: transport.payloadDigest, state: 'queued' };
  }
  const inventory = () => f.sql(db => ({
    schema: db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all(),
    tables: Object.fromEntries(db.prepare(
      "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).all().map(({ name }) => [name,
      db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all().map(row => ({ ...row }))])),
  }));
  const beforeSeed = inventory();
  f.sql(db => {
    db.exec('BEGIN');
    try {
      for (const batch of batches) {
        db.prepare('INSERT INTO health_records VALUES (?,?,?,?,?,?,?,?,?)').run(
          batch.tenantId, batch.sourceStoreId, 'StepsRecord', batch.literal.nativeRecordId,
          'health-connect-record', 1, 'ordinary', 'raw-only', batch.literal.recordJson);
        db.prepare('INSERT INTO health_streams VALUES (?,?,?)').run(
          batch.stream.streamKey, 'StepsRecord', '1');
        db.prepare('INSERT INTO health_batch_receipts VALUES (?,?,?,?,?)').run(
          batch.receipt.streamKey, '1', batch.receipt.batchId,
          batch.receipt.payloadDigest, batch.receipt.receiptJson);
        db.prepare('INSERT INTO health_projection_outbox VALUES (?,?,?,?,?)').run(
          batch.outbox.streamKey, '1', batch.outbox.batchId, batch.outbox.payloadDigest, 'queued');
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  });
  const sqlBefore = inventory();
  assert.deepEqual(sqlBefore.schema, beforeSeed.schema);
  const seeded = ['health_records', 'health_streams', 'health_batch_receipts', 'health_projection_outbox'];
  for (const [name, rows] of Object.entries(beforeSeed.tables)) {
    if (!seeded.includes(name)) assert.deepEqual(sqlBefore.tables[name], rows);
  }
  assert.deepEqual(sqlBefore.tables.health_records, batches.map(b => ({
    tenant_id: b.tenantId, source_store_id: b.sourceStoreId, record_type: 'StepsRecord',
    native_record_id: b.literal.nativeRecordId, serializer_id: 'health-connect-record',
    serializer_version: 1, data_family: 'ordinary', projection: 'raw-only', record_json: b.literal.recordJson,
  })));
  assert.deepEqual(sqlBefore.tables.health_streams, batches.map(b => ({
    stream_key: b.stream.streamKey, record_type: 'StepsRecord', acknowledged_sequence: '1',
  })));
  assert.deepEqual(sqlBefore.tables.health_batch_receipts, batches.map(b => ({
    stream_key: b.receipt.streamKey, sequence: '1', batch_id: b.receipt.batchId,
    payload_digest: b.receipt.payloadDigest, receipt_json: b.receipt.receiptJson,
  })));
  assert.deepEqual(sqlBefore.tables.health_projection_outbox, batches.map(b => ({
    stream_key: b.outbox.streamKey, sequence: '1', batch_id: b.outbox.batchId,
    payload_digest: b.outbox.payloadDigest, state: 'queued',
  })));
  assert.deepEqual(sqlBefore.tables.health_tombstones, []);
  assert.equal(Object.hasOwn(sqlBefore.tables, 'health_deletion_guards'), false);
  const credentialsBefore = fs.readFileSync(f.paths.WEBAUTHN_CREDENTIALS_FILE);
  const sessionsBytesBefore = fs.readFileSync(f.paths.WEBAUTHN_SESSIONS_FILE);
  const sessionsBefore = JSON.parse(sessionsBytesBefore);
  const unchanged = () => {
    assert.deepEqual(inventory(), sqlBefore);
    assert.deepEqual(fs.readFileSync(catalogueFile), catalogueBytes);
    assert.deepEqual(fs.readFileSync(f.paths.WEBAUTHN_CREDENTIALS_FILE), credentialsBefore);
    const sessionsAfter = JSON.parse(fs.readFileSync(f.paths.WEBAUTHN_SESSIONS_FILE));
    const lastSeen = sessionsAfter[COOKIE].lastSeen;
    sessionsAfter[COOKIE].lastSeen = sessionsBefore[COOKIE].lastSeen;
    assert.deepEqual(sessionsAfter, sessionsBefore);
    assert.ok(Number.isFinite(lastSeen) && lastSeen >= sessionsBefore[COOKIE].lastSeen);
  };
  const desired = { ...expected, records: [batches[0].record], streams: [batches[0].stream],
    receipts: [batches[0].receipt], projectionOutbox: [batches[0].outbox] };
  assert.deepEqual(Object.keys(desired).sort(), ['catalog', 'records', 'sourcePolicies', 'streams',
    'receipts', 'projectionOutbox', 'tombstones', 'deletionGuards', 'suppressions'].sort());
  unchanged();
  return { f, desired, unchanged };
}

test('OWN02 retained SQL fixture keeps genuine pre-seed tenant controls and both complete batches healthy', async t => {
  const { unchanged } = await ownerWideRetainedBatchFixture(t);
  unchanged();
  console.log('OWN_RETAINED_CONTROL ' + JSON.stringify({ preSeedTenantControlsHealthy: true,
    atomicColdSQLBothBatchesExact: true, historicalGenerationZeroAndEpochFixed: true,
    fullPostSeedCustodyQualified: true, syntheticReceiptHasNoAdmissionAuthority: true }));
});

test('OWN03 ownerWide capture preserves one retained native batch and excludes the complete foreign sentinel', async t => {
  const { f, desired, unchanged } = await ownerWideRetainedBatchFixture(t);
  let captureReturned = false, ownerWideMatched = false;
  try {
    const captured = await f.run(actor => {
      let value;
      assert.doesNotThrow(() => {
        value = f.policy.withReadAuthority(actor, scope => f.policy.snapshot(scope),
          { tenantId: f.tenantId, ownerWide: true });
        captureReturned = true;
      }, 'A supported ownerWide capture must preserve the retained one-batch inventory');
      return value;
    });
    assert.deepEqual(captured, desired,
      'The independent nine-family owner DTO must retain all four nonempty native families and exclude foreign rows');
    ownerWideMatched = true;
  } finally {
    unchanged();
    console.log('OWN_RETAINED_CAPTURE ' + JSON.stringify({ preSeedTenantControlsHealthy: true,
      atomicColdSQLBothBatchesExact: true, historicalGenerationZeroAndEpochFixed: true,
      fullPostSeedCustodyQualified: true, syntheticReceiptHasNoAdmissionAuthority: true,
      captureReturned, ownerWideMatched }));
  }
});


// Each case changes one bounded foreign row after the genuine healthy fixture.
// Stream-key poisons also orphan the original receipt/outbox; they prove refusal
// of the complete poisoned state, not an isolated generation or encoding cause.
for (const poison of [
  { name: 'OWN04 ownerWide refuses an unregistered foreign native tenant',
    table: 'health_records', column: 'tenant_id', value: '00000000-0000-4000-8000-000000000099' },
  { name: 'OWN05 ownerWide refuses foreign receipt sequence against JSON and frontier',
    table: 'health_batch_receipts', column: 'sequence', value: '2' },
  { name: 'OWN06 ownerWide refuses foreign outbox batch against its receipt',
    table: 'health_projection_outbox', column: 'batch_id', value: 'invented-mismatched-foreign-batch' },
  { name: 'OWN07 ownerWide refuses a foreign native JSON array',
    table: 'health_records', column: 'record_json', value: '[]' },
  { name: 'OWN08 ownerWide refuses a future-generation foreign stream',
    table: 'health_streams', column: 'stream_key', transform: 'future-generation' },
  { name: 'OWN09 ownerWide refuses a noncanonical foreign stream key',
    table: 'health_streams', column: 'stream_key', transform: 'noncanonical-key' },
]) {
  test(poison.name, async t => {
    const { f, unchanged } = await ownerWideRetainedBatchFixture(t);
    const inventory = () => f.sql(db => ({
      schema: db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all(),
      tables: Object.fromEntries(db.prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      ).all().map(({ name }) => [name,
        db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all().map(row => ({ ...row }))])),
    }));
    const healthy = inventory();
    for (const table of ['health_records', 'health_streams', 'health_batch_receipts', 'health_projection_outbox']) {
      assert.equal(healthy.tables[table].length, 2);
    }
    const foreignRecords = healthy.tables.health_records.filter(row => row.tenant_id !== f.tenantId);
    assert.equal(foreignRecords.length, 1);
    const foreign = foreignRecords[0];
    assert.equal(foreign.native_record_id, 'invented-foreign-record-01');
    assert.equal(Buffer.byteLength(foreign.record_json), 401);
    const targetRows = healthy.tables[poison.table];
    const targetIndex = targetRows.findIndex(row => poison.table === 'health_records'
      ? row.tenant_id === foreign.tenant_id : JSON.parse(row.stream_key)[0] === foreign.tenant_id);
    assert.ok(targetIndex >= 0);
    assert.equal(targetRows.filter(row => poison.table === 'health_records'
      ? row.tenant_id === foreign.tenant_id : JSON.parse(row.stream_key)[0] === foreign.tenant_id).length, 1);
    const original = targetRows[targetIndex];
    const catalogueFile = path.join(f.paths.CREDENTIALS_DIR, 'health-connect-policy.json');
    const catalogueBytes = fs.readFileSync(catalogueFile);
    const catalogue = JSON.parse(catalogueBytes);
    assert.ok(catalogue.namespaces.some(n => n.state.tenantId === foreign.tenant_id &&
      n.ownerId !== catalogue.namespaces.find(value => value.state.tenantId === f.tenantId).ownerId));
    const foreignStream = healthy.tables.health_streams.find(row => JSON.parse(row.stream_key)[0] === foreign.tenant_id);
    const fields = JSON.parse(foreignStream.stream_key);
    assert.equal(fields[5], '0');
    assert.equal(foreignStream.acknowledged_sequence, '1');
    const foreignReceipt = healthy.tables.health_batch_receipts.find(row => row.stream_key === foreignStream.stream_key);
    assert.equal(foreignReceipt.sequence, '1');
    assert.equal(JSON.parse(foreignReceipt.receipt_json).sequence, '1');
    assert.equal(foreignReceipt.batch_id, 'invented-foreign-one-batch-01');
    assert.equal(healthy.tables.health_source_policy_categories.find(row =>
      row.tenant_id === fields[0] && row.source_store_id === fields[2] && row.record_type === fields[4]).generation, '1');
    let value = poison.value;
    if (poison.transform === 'future-generation') {
      const future = [...fields]; future[5] = '2'; value = JSON.stringify(future);
    } else if (poison.transform === 'noncanonical-key') {
      value = original.stream_key + ' ';
      assert.deepEqual(JSON.parse(value), fields);
      assert.notEqual(JSON.stringify(fields), value);
    }
    if (poison.column === 'tenant_id') {
      assert.equal(catalogue.namespaces.some(n => n.state.tenantId === value), false);
      assert.equal(healthy.tables.health_source_policy_state.some(row => row.tenant_id === value), false);
    }
    assert.notEqual(value, original[poison.column]);
    const keys = poison.table === 'health_records'
      ? ['tenant_id', 'source_store_id', 'record_type', 'native_record_id']
      : poison.table === 'health_streams' ? ['stream_key'] : ['stream_key', 'sequence'];
    const where = keys.map(column => `"${column}"=?`).join(' AND ');
    const update = `UPDATE "${poison.table}" SET "${poison.column}"=? WHERE ${where}`;
    const expectedPoison = { schema: healthy.schema, tables: JSON.parse(JSON.stringify(healthy.tables)) };
    expectedPoison.tables[poison.table][targetIndex] = { ...original, [poison.column]: value };
    let mutationApplied = false, coldPoisonWitnessQualified = false;
    let callbackReached = false, refusalQualified = false;
    let poisonedStateCustodyQualified = false, originalFixtureRestored = false;
    try {
      const changed = f.sql(db => db.prepare(update).run(value, ...keys.map(column => original[column])));
      mutationApplied = true;
      assert.equal(changed.changes, 1);
      const poisoned = inventory();
      assert.deepEqual(poisoned, expectedPoison);
      coldPoisonWitnessQualified = true;
      const credentialsBefore = fs.readFileSync(f.paths.WEBAUTHN_CREDENTIALS_FILE);
      const sessionsBefore = JSON.parse(fs.readFileSync(f.paths.WEBAUTHN_SESSIONS_FILE));
      try {
        await f.run(actor => {
          assert.throws(() => f.policy.withReadAuthority(actor, scope => {
            callbackReached = true;
            return f.policy.snapshot(scope);
          }, { tenantId: f.tenantId, ownerWide: true }), error => {
            refusalQualified = error instanceof f.policy.PolicyError && error.status === 409 &&
              error.code === 'IMPORT_SOURCE_POLICY_UNKNOWN';
            return refusalQualified;
          }, 'A supported ownerWide read must refuse the independently poisoned foreign row before callback');
          assert.equal(callbackReached, false);
        });
      } finally {
        assert.deepEqual(inventory(), poisoned);
        assert.deepEqual(fs.readFileSync(catalogueFile), catalogueBytes);
        assert.deepEqual(fs.readFileSync(f.paths.WEBAUTHN_CREDENTIALS_FILE), credentialsBefore);
        const sessionsAfter = JSON.parse(fs.readFileSync(f.paths.WEBAUTHN_SESSIONS_FILE));
        const lastSeen = sessionsAfter[COOKIE].lastSeen;
        sessionsAfter[COOKIE].lastSeen = sessionsBefore[COOKIE].lastSeen;
        assert.deepEqual(sessionsAfter, sessionsBefore);
        assert.ok(Number.isFinite(lastSeen) && lastSeen >= sessionsBefore[COOKIE].lastSeen);
        poisonedStateCustodyQualified = true;
      }
    } finally {
      if (mutationApplied) {
        const poisonedKeys = keys.map(column => column === poison.column ? value : original[column]);
        assert.equal(f.sql(db => db.prepare(update).run(original[poison.column], ...poisonedKeys)).changes, 1);
        unchanged();
        originalFixtureRestored = true;
      }
      console.log('OWN_FOREIGN_POISON ' + JSON.stringify({ name: poison.name,
        preSeedTenantControlsHealthy: true, coldPoisonWitnessQualified,
        callbackReached, refusalQualified, poisonedStateCustodyQualified, originalFixtureRestored,
        singleRowMutation: true, syntheticReceiptHasNoAdmissionAuthority: true,
        isolatedGenerationOrCanonicalCauseClaimed: false }));
    }
  });
}


async function ownerWideRetainedTombstoneFixture(t) {
  const { f, desired, unchanged } = await ownerWideRetainedBatchFixture(t);
  const inventory = () => f.sql(db => ({
    schema: db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all(),
    tables: Object.fromEntries(db.prepare(
      "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).all().map(({ name }) => [name,
      db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all().map(row => ({ ...row }))])),
  }));
  const healthy = inventory();
  assert.deepEqual(healthy.tables.health_tombstones, []);
  for (const table of ['health_records', 'health_streams', 'health_batch_receipts', 'health_projection_outbox']) {
    assert.equal(healthy.tables[table].length, 2);
  }
  const ownedStream = desired.streams[0].streamKey;
  const foreignStreams = healthy.tables.health_streams.filter(row => JSON.parse(row.stream_key)[0] !== f.tenantId);
  assert.equal(foreignStreams.length, 1);
  const foreignFields = JSON.parse(foreignStreams[0].stream_key);
  const catalogue = JSON.parse(fs.readFileSync(path.join(f.paths.CREDENTIALS_DIR, 'health-connect-policy.json')));
  assert.notEqual(catalogue.namespaces.find(n => n.state.tenantId === foreignFields[0]).ownerId,
    catalogue.namespaces.find(n => n.state.tenantId === f.tenantId).ownerId);
  const rows = [
    { tenant_id: f.tenantId, source_store_id: f.sourceStoreId, record_type: 'StepsRecord',
      native_record_id: 'invented-owner-tombstone-01', stream_key: ownedStream, sequence: '1' },
    { tenant_id: foreignFields[0], source_store_id: foreignFields[2], record_type: 'StepsRecord',
      native_record_id: 'invented-foreign-tombstone-01', stream_key: foreignStreams[0].stream_key, sequence: '1' },
  ];
  for (const row of rows) {
    const fields = JSON.parse(row.stream_key);
    assert.equal(fields[0], row.tenant_id);
    assert.equal(fields[2], row.source_store_id);
    assert.equal(fields[4], 'StepsRecord');
    assert.equal(fields[5], '0');
    const stream = healthy.tables.health_streams.find(value => value.stream_key === row.stream_key);
    const receipt = healthy.tables.health_batch_receipts.find(value => value.stream_key === row.stream_key);
    assert.equal(stream.acknowledged_sequence, '1');
    assert.equal(receipt.sequence, '1');
    assert.equal(JSON.parse(receipt.receipt_json).sequence, '1');
    assert.equal(healthy.tables.health_records.some(value => value.native_record_id === row.native_record_id), false);
  }
  f.sql(db => {
    db.exec('BEGIN');
    try {
      for (const row of rows) db.prepare('INSERT INTO health_tombstones VALUES (?,?,?,?,?,?)').run(
        row.tenant_id, row.source_store_id, row.record_type, row.native_record_id, row.stream_key, row.sequence);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  });
  const seeded = { schema: healthy.schema, tables: structuredClone(healthy.tables) };
  seeded.tables.health_tombstones = rows.map(row => ({ ...row }));
  assert.deepEqual(inventory(), seeded);
  const expected = { ...desired, tombstones: [{
    identity: [f.tenantId, f.sourceStoreId, 'StepsRecord', 'invented-owner-tombstone-01'],
    sourceStreamKey: ownedStream, sourceSequence: '1',
  }] };
  const restore = () => {
    for (const row of rows) {
      const result = f.sql(db => db.prepare(
        'DELETE FROM health_tombstones WHERE tenant_id=? AND source_store_id=? AND record_type=? AND native_record_id=?'
      ).run(row.tenant_id, row.source_store_id, row.record_type, row.native_record_id));
      assert.equal(result.changes, 1);
    }
    unchanged();
  };
  return { f, inventory, seeded, expected, foreign: rows[1], restore };
}

test('OWN10 ownerWide preserves typed V1 tombstones and original historical receipt provenance', async t => {
  const { f, inventory, seeded, expected, restore } = await ownerWideRetainedTombstoneFixture(t);
  let callbackCount = 0;
  try {
    const captured = await f.run(actor => {
      let value;
      assert.doesNotThrow(() => {
        value = f.policy.withReadAuthority(actor, scope => {
          callbackCount++;
          return f.policy.snapshot(scope);
        }, { tenantId: f.tenantId, ownerWide: true });
      }, 'The bounded V1 typed tombstone and original receipt must survive a genuine owner-wide snapshot');
      return value;
    });
    assert.equal(callbackCount, 1);
    assert.deepEqual(captured, expected);
    assert.deepEqual(inventory(), seeded);
  } finally { restore(); }
});

test('OWN11 ownerWide refuses a foreign typed tombstone without its original receipt', async t => {
  const { f, inventory, seeded, foreign, restore } = await ownerWideRetainedTombstoneFixture(t);
  let callbackCount = 0;
  try {
    const changed = f.sql(db => db.prepare(
      'UPDATE health_tombstones SET sequence=? WHERE tenant_id=? AND source_store_id=? AND record_type=? AND native_record_id=?'
    ).run('2', foreign.tenant_id, foreign.source_store_id, foreign.record_type, foreign.native_record_id));
    assert.equal(changed.changes, 1);
    const poisoned = { schema: seeded.schema, tables: structuredClone(seeded.tables) };
    poisoned.tables.health_tombstones[1].sequence = '2';
    assert.deepEqual(inventory(), poisoned);
    await f.run(actor => {
      assert.throws(() => f.policy.withReadAuthority(actor, scope => {
        callbackCount++;
        return f.policy.snapshot(scope);
      }, { tenantId: f.tenantId, ownerWide: true }), error =>
        error instanceof f.policy.PolicyError && error.status === 409 && error.code === 'IMPORT_SOURCE_POLICY_UNKNOWN');
    });
    assert.equal(callbackCount, 0);
    assert.deepEqual(inventory(), poisoned);
  } finally { restore(); }
});


async function ownerWideNativeV2MetadataFixture(t) {
  const original = await ownerWideRetainedTombstoneFixture(t);
  const { f, inventory, expected } = original;
  const schema = require('../lib/health-connect/schema');
  const history = require('../lib/health-connect/history');
  const beforeMigration = inventory();
  assert.deepEqual(beforeMigration.tables.health_schema_version, [{ version: 1 }]);
  assert.equal(Object.hasOwn(beforeMigration.tables, 'health_deletion_guards'), false);
  let migration;
  history.withHistoryTransaction((db, changed) => { migration = changed; },
    { deletionSchema: true, windowsDevelopment: process.platform === 'win32' });
  assert.ok(migration && typeof migration.safetyCopy === 'string');
  assert.equal(fs.statSync(path.join(path.dirname(f.paths.DB_FILE), migration.safetyCopy)).isFile(), true);
  const seeded = inventory();
  assert.deepEqual(seeded.tables.health_schema_version, [{ version: 2 }]);
  assert.deepEqual(seeded.tables.health_deletion_guards, []);
  assert.equal(seeded.schema.find(row => row.type === 'table' && row.name === 'health_schema_version').sql, schema.markerV2);
  assert.equal(seeded.schema.find(row => row.type === 'table' && row.name === 'health_deletion_guards').sql, schema.guardV2);
  for (const row of beforeMigration.schema.filter(row => row.name !== 'health_schema_version')) {
    assert.deepEqual(seeded.schema.find(value => value.type === row.type && value.name === row.name), row);
  }
  for (const [table, values] of Object.entries(beforeMigration.tables)) {
    if (table !== 'health_schema_version') assert.deepEqual(seeded.tables[table], values);
  }
  assert.equal(seeded.schema.filter(row => row.type === 'table').length,
    beforeMigration.schema.filter(row => row.type === 'table').length + 1);
  // Preserve the V1 fixture and its original schema assertion. This separate
  // custody point covers the genuine migrated state, not a fabricated restore.
  const catalogueFile = path.join(f.paths.CREDENTIALS_DIR, 'health-connect-policy.json');
  const catalogueBytes = fs.readFileSync(catalogueFile);
  const credentialsBytes = fs.readFileSync(f.paths.WEBAUTHN_CREDENTIALS_FILE);
  const sessionsBefore = JSON.parse(fs.readFileSync(f.paths.WEBAUTHN_SESSIONS_FILE));
  const unchanged = () => {
    assert.deepEqual(inventory(), seeded);
    assert.deepEqual(fs.readFileSync(catalogueFile), catalogueBytes);
    assert.deepEqual(fs.readFileSync(f.paths.WEBAUTHN_CREDENTIALS_FILE), credentialsBytes);
    const sessionsAfter = JSON.parse(fs.readFileSync(f.paths.WEBAUTHN_SESSIONS_FILE));
    const lastSeen = sessionsAfter[COOKIE].lastSeen;
    sessionsAfter[COOKIE].lastSeen = sessionsBefore[COOKIE].lastSeen;
    assert.deepEqual(sessionsAfter, sessionsBefore);
    assert.ok(Number.isFinite(lastSeen) && lastSeen >= sessionsBefore[COOKIE].lastSeen);
  };
  const policyExpected = expected.sourcePolicies.find(value => value.tenantId === f.tenantId);
  await f.run(actor => f.read(actor, scope => {
    const current = f.policy.snapshot(scope);
    assert.equal(current.knowledge, 'COMPLETE');
    assert.equal(current.revision, policyExpected.revision);
    assert.deepEqual(current.sources.map(value => ({
      sourceStoreId: value.sourceStoreId, policyId: value.policyId, lifecycle: value.lifecycle,
      retainCommittedHistory: value.retainCommittedHistory === 1, categoryCount: value.categoryCount,
      categories: value.categories,
    })), policyExpected.sources);
  }));
  unchanged();
  return { f, history, expected, unchanged };
}

test('META_V2_01 genuine native V2 ownerWide metadata preserves the fixed stopped owner inventory', async t => {
  const { f, expected, unchanged } = await ownerWideNativeV2MetadataFixture(t);
  let callbackCount = 0, captureReturned = false;
  try {
    const captured = await f.run(actor => f.policy.withReadAuthority(actor, scope => {
      callbackCount++;
      return f.policy.snapshot(scope);
    }, { tenantId: f.tenantId, ownerWide: true }));
    assert.equal(callbackCount, 1);
    assert.deepEqual(captured, expected);
    captureReturned = true;
  } finally {
    unchanged();
    console.log('NATIVE_V2_METADATA_BOUNDARY ' + JSON.stringify({ callbackCount,
      componentOnly: true, guardCaptureReturned: captureReturned }));
  }
});


async function ownerWideSourceDeletedGuardFixture(t) {
  const original = await ownerWideRetainedTombstoneFixture(t);
  const { f, inventory, expected } = original;
  const schema = require('../lib/health-connect/schema');
  const history = require('../lib/health-connect/history');
  const beforeMigration = inventory();
  const tombstones = beforeMigration.tables.health_tombstones;
  assert.equal(tombstones.length, 2);
  assert.equal(Object.hasOwn(beforeMigration.tables, 'health_deletion_guards'), false);
  const rows = tombstones.map(row => ({
    tenant_id: row.tenant_id, source_store_id: row.source_store_id,
    record_type: row.record_type, native_record_id: row.native_record_id,
    source_deleted: 1, user_suppressed: 0, source_stream_key: row.stream_key,
    source_sequence: '1', footprint_json: null,
  }));
  assert.equal(rows[0].native_record_id, 'invented-owner-tombstone-01');
  assert.equal(rows[1].native_record_id, 'invented-foreign-tombstone-01');
  let migration;
  history.withHistoryTransaction((db, changed) => {
    migration = changed;
    for (const row of rows) db.prepare('INSERT INTO health_deletion_guards VALUES (?,?,?,?,?,?,?,?,?)').run(
      row.tenant_id, row.source_store_id, row.record_type, row.native_record_id,
      1, 0, row.source_stream_key, '1', null);
  }, { deletionSchema: true, windowsDevelopment: process.platform === 'win32' });
  assert.ok(migration && typeof migration.safetyCopy === 'string');
  assert.equal(fs.statSync(path.join(path.dirname(f.paths.DB_FILE), migration.safetyCopy)).isFile(), true);
  const seeded = inventory();
  assert.deepEqual(seeded.tables.health_schema_version, [{ version: 2 }]);
  assert.deepEqual(seeded.tables.health_deletion_guards, rows);
  assert.equal(seeded.schema.find(row => row.type === 'table' && row.name === 'health_schema_version').sql, schema.markerV2);
  assert.equal(seeded.schema.find(row => row.type === 'table' && row.name === 'health_deletion_guards').sql, schema.guardV2);
  for (const row of beforeMigration.schema.filter(row => row.name !== 'health_schema_version')) {
    assert.deepEqual(seeded.schema.find(value => value.type === row.type && value.name === row.name), row);
  }
  for (const [table, values] of Object.entries(beforeMigration.tables)) {
    if (table !== 'health_schema_version') assert.deepEqual(seeded.tables[table], values);
  }
  assert.equal(seeded.schema.filter(row => row.type === 'table').length,
    beforeMigration.schema.filter(row => row.type === 'table').length + 1);
  const desired = { ...expected, deletionGuards: [{
    identity: [...expected.tombstones[0].identity], sourceDeleted: 1, userSuppressed: 0,
    sourceStreamKey: expected.tombstones[0].sourceStreamKey, sourceSequence: '1', footprintJson: null,
  }] };
  // The unchanged V1 helper's restore assertion describes its original schema.
  // Keep the genuine migration and capture a separate post-migration custody point.
  const catalogueFile = path.join(f.paths.CREDENTIALS_DIR, 'health-connect-policy.json');
  const catalogueBytes = fs.readFileSync(catalogueFile);
  const credentialsBytes = fs.readFileSync(f.paths.WEBAUTHN_CREDENTIALS_FILE);
  const sessionsBefore = JSON.parse(fs.readFileSync(f.paths.WEBAUTHN_SESSIONS_FILE));
  const unchanged = expectedSQL => {
    assert.deepEqual(inventory(), expectedSQL);
    assert.deepEqual(fs.readFileSync(catalogueFile), catalogueBytes);
    assert.deepEqual(fs.readFileSync(f.paths.WEBAUTHN_CREDENTIALS_FILE), credentialsBytes);
    const sessionsAfter = JSON.parse(fs.readFileSync(f.paths.WEBAUTHN_SESSIONS_FILE));
    const lastSeen = sessionsAfter[COOKIE].lastSeen;
    sessionsAfter[COOKIE].lastSeen = sessionsBefore[COOKIE].lastSeen;
    assert.deepEqual(sessionsAfter, sessionsBefore);
    assert.ok(Number.isFinite(lastSeen) && lastSeen >= sessionsBefore[COOKIE].lastSeen);
  };
  const policyExpected = expected.sourcePolicies.find(value => value.tenantId === f.tenantId);
  await f.run(actor => f.read(actor, scope => {
    const current = f.policy.snapshot(scope);
    assert.equal(current.knowledge, 'COMPLETE');
    assert.equal(current.revision, policyExpected.revision);
    assert.deepEqual(current.sources.map(value => ({
      sourceStoreId: value.sourceStoreId, policyId: value.policyId, lifecycle: value.lifecycle,
      retainCommittedHistory: value.retainCommittedHistory === 1, categoryCount: value.categoryCount,
      categories: value.categories,
    })), policyExpected.sources);
  }));
  unchanged(seeded);
  return { f, inventory, seeded, desired, foreign: rows[1], unchanged };
}

test('OWN12 ownerWide preserves bounded native V2 source-deleted guards with policy V1', async t => {
  const { f, seeded, desired, unchanged } = await ownerWideSourceDeletedGuardFixture(t);
  let callbackCount = 0;
  try {
    const captured = await f.run(actor => {
      let value;
      assert.doesNotThrow(() => {
        value = f.policy.withReadAuthority(actor, scope => {
          callbackCount++;
          return f.policy.snapshot(scope);
        }, { tenantId: f.tenantId, ownerWide: true });
      }, 'A genuine healthy native V2 guard snapshot must preserve the original identity and receipt');
      return value;
    });
    assert.equal(callbackCount, 1);
    assert.deepEqual(captured, desired);
  } finally { unchanged(seeded); }
});

test('OWN13 ownerWide refuses foreign guard provenance inconsistent with its tombstone and receipt', async t => {
  const { f, inventory, seeded, foreign, unchanged } = await ownerWideSourceDeletedGuardFixture(t);
  let callbackCount = 0;
  const poisoned = { schema: seeded.schema, tables: structuredClone(seeded.tables) };
  poisoned.tables.health_deletion_guards[1].source_sequence = '2';
  const changed = f.sql(db => db.prepare(
    'UPDATE health_deletion_guards SET source_sequence=? WHERE tenant_id=? AND source_store_id=? AND record_type=? AND native_record_id=?'
  ).run('2', foreign.tenant_id, foreign.source_store_id, foreign.record_type, foreign.native_record_id));
  assert.equal(changed.changes, 1);
  assert.deepEqual(inventory(), poisoned);
  try {
    await f.run(actor => assert.throws(() => f.policy.withReadAuthority(actor, scope => {
      callbackCount++;
      return f.policy.snapshot(scope);
    }, { tenantId: f.tenantId, ownerWide: true }), error =>
      error instanceof f.policy.PolicyError && error.status === 409 && error.code === 'IMPORT_SOURCE_POLICY_UNKNOWN'));
    assert.equal(callbackCount, 0);
  } finally { unchanged(poisoned); }
});


async function ownerWideUserOnlyGuardFixture(t) {
  const original = await ownerWideSourceDeletedGuardFixture(t);
  const { f, inventory, seeded, desired, foreign, unchanged } = original;
  let sourceDeletedCallbacks = 0;
  const healthy = await f.run(actor => f.policy.withReadAuthority(actor, scope => {
    sourceDeletedCallbacks++;
    return f.policy.snapshot(scope);
  }, { tenantId: f.tenantId, ownerWide: true }));
  assert.equal(sourceDeletedCallbacks, 1);
  assert.deepEqual(healthy, desired);
  unchanged(seeded);

  assert.equal(seeded.tables.health_deletion_guards.length, 2);
  assert.notEqual(foreign.tenant_id, f.tenantId);
  const rows = [
    { tenant_id: f.tenantId, source_store_id: f.sourceStoreId, record_type: 'StepsRecord',
      native_record_id: 'invented-owner-user-only-guard-01', source_deleted: 0, user_suppressed: 1,
      source_stream_key: null, source_sequence: null, footprint_json: null },
    { tenant_id: foreign.tenant_id, source_store_id: foreign.source_store_id, record_type: 'StepsRecord',
      native_record_id: 'invented-foreign-user-only-guard-01', source_deleted: 0, user_suppressed: 1,
      source_stream_key: null, source_sequence: null, footprint_json: null },
  ];
  for (const row of rows) {
    const prior = seeded.tables.health_deletion_guards.find(value => value.tenant_id === row.tenant_id);
    assert.ok(prior);
    assert.equal(prior.source_store_id, row.source_store_id);
    assert.equal(prior.record_type, row.record_type);
    assert.notEqual(prior.native_record_id, row.native_record_id);
    for (const table of ['health_records', 'health_tombstones']) {
      assert.equal(seeded.tables[table].some(value => value.native_record_id === row.native_record_id), false);
    }
  }
  f.sql(db => {
    db.exec('BEGIN');
    try {
      for (const row of rows) {
        const prior = seeded.tables.health_deletion_guards.find(value => value.tenant_id === row.tenant_id);
        const result = db.prepare('UPDATE health_deletion_guards SET native_record_id=?,source_deleted=?,user_suppressed=?,'
          + 'source_stream_key=?,source_sequence=?,footprint_json=? '
          + 'WHERE tenant_id=? AND source_store_id=? AND record_type=? AND native_record_id=?').run(
          row.native_record_id, 0, 1, null, null, null,
          row.tenant_id, row.source_store_id, row.record_type, prior.native_record_id);
        assert.equal(result.changes, 1);
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  });
  const userOnlySQL = { schema: seeded.schema, tables: structuredClone(seeded.tables) };
  userOnlySQL.tables.health_deletion_guards = rows;
  assert.deepEqual(inventory(), userOnlySQL);
  const expected = { ...desired, deletionGuards: [{
    identity: [f.tenantId, f.sourceStoreId, 'StepsRecord', 'invented-owner-user-only-guard-01'],
    sourceDeleted: 0, userSuppressed: 1, sourceStreamKey: null, sourceSequence: null, footprintJson: null,
  }] };
  const policyExpected = desired.sourcePolicies.find(value => value.tenantId === f.tenantId);
  await f.run(actor => f.read(actor, scope => {
    const current = f.policy.snapshot(scope);
    assert.equal(current.knowledge, 'COMPLETE');
    assert.equal(current.revision, policyExpected.revision);
    assert.deepEqual(current.sources.map(value => ({
      sourceStoreId: value.sourceStoreId, policyId: value.policyId, lifecycle: value.lifecycle,
      retainCommittedHistory: value.retainCommittedHistory === 1, categoryCount: value.categoryCount,
      categories: value.categories,
    })), policyExpected.sources);
  }));
  unchanged(userOnlySQL);
  return { f, inventory, userOnlySQL, expected, foreignUser: rows[1],
    originalForeignStream: foreign.source_stream_key, unchanged };
}

test('OWN14 ownerWide preserves bounded native V2 user-only guards without borrowed provenance', async t => {
  const { f, userOnlySQL, expected, unchanged } = await ownerWideUserOnlyGuardFixture(t);
  let callbackCount = 0, observed = null;
  try {
    const captured = await f.run(actor => {
      let value;
      assert.doesNotThrow(() => {
        try {
          value = f.policy.withReadAuthority(actor, scope => {
            callbackCount++;
            return f.policy.snapshot(scope);
          }, { tenantId: f.tenantId, ownerWide: true });
        } catch (error) {
          observed = { policyError: error instanceof f.policy.PolicyError,
            status: error.status, code: error.code };
          throw error;
        }
      }, 'A healthy native V2 user-only guard must preserve SQL NULL and the independently fixed owner inventory');
      return value;
    });
    assert.equal(callbackCount, 1);
    assert.deepEqual(captured, expected);
  } finally {
    unchanged(userOnlySQL);
    console.log('USER_ONLY_GUARD_BOUNDARY ' + JSON.stringify({ observed, callbackCount }));
  }
});

test('OWN15 ownerWide refuses a foreign mixed-bit guard before owner filtering', async t => {
  const { f, inventory, userOnlySQL, foreignUser, originalForeignStream, unchanged } =
    await ownerWideUserOnlyGuardFixture(t);
  assert.equal(typeof originalForeignStream, 'string');
  const poisoned = { schema: userOnlySQL.schema, tables: structuredClone(userOnlySQL.tables) };
  Object.assign(poisoned.tables.health_deletion_guards[1], {
    source_deleted: 1, user_suppressed: 1, source_stream_key: originalForeignStream, source_sequence: '1',
  });
  const changed = f.sql(db => db.prepare('UPDATE health_deletion_guards '
    + 'SET source_deleted=?,user_suppressed=?,source_stream_key=?,source_sequence=? '
    + 'WHERE tenant_id=? AND source_store_id=? AND record_type=? AND native_record_id=?').run(
    1, 1, originalForeignStream, '1', foreignUser.tenant_id, foreignUser.source_store_id,
    foreignUser.record_type, foreignUser.native_record_id));
  assert.equal(changed.changes, 1);
  assert.deepEqual(inventory(), poisoned);
  let callbackCount = 0;
  try {
    await f.run(actor => assert.throws(() => f.policy.withReadAuthority(actor, scope => {
      callbackCount++;
      return f.policy.snapshot(scope);
    }, { tenantId: f.tenantId, ownerWide: true }), error =>
      error instanceof f.policy.PolicyError && error.status === 409 && error.code === 'IMPORT_SOURCE_POLICY_UNKNOWN'));
    assert.equal(callbackCount, 0);
  } finally { unchanged(poisoned); }
});


const ownerWideStepsGuardFootprint = '{"kind":"interval","startTime":"2026-01-02T03:00:00Z","endTime":"2026-01-02T03:10:00Z","startZoneOffset":"+11:00","endZoneOffset":"+11:00"}';
const ownerWideMalformedForeignFootprint = '{"kind":"interval","startTime":"not-a-time","endTime":"2026-01-02T03:10:00Z","startZoneOffset":"+11:00","endZoneOffset":"+11:00"}';

async function ownerWideKnownFootprintFixture(t) {
  const original = await ownerWideUserOnlyGuardFixture(t);
  const { f, inventory, userOnlySQL, expected, foreignUser, unchanged } = original;
  assert.equal(Buffer.byteLength(ownerWideStepsGuardFootprint), 139);
  assert.equal(userOnlySQL.tables.health_deletion_guards.length, 2);
  const footprintSQL = { schema: userOnlySQL.schema, tables: structuredClone(userOnlySQL.tables) };
  for (const row of footprintSQL.tables.health_deletion_guards) {
    assert.equal(row.record_type, 'StepsRecord');
    assert.equal(row.source_deleted, 0);
    assert.equal(row.user_suppressed, 1);
    assert.equal(row.source_stream_key, null);
    assert.equal(row.source_sequence, null);
    assert.equal(row.footprint_json, null);
    row.footprint_json = ownerWideStepsGuardFootprint;
  }
  f.sql(db => {
    db.exec('BEGIN');
    try {
      for (const row of footprintSQL.tables.health_deletion_guards) {
        const changed = db.prepare('UPDATE health_deletion_guards SET footprint_json=? '
          + 'WHERE tenant_id=? AND source_store_id=? AND record_type=? AND native_record_id=?').run(
          ownerWideStepsGuardFootprint, row.tenant_id, row.source_store_id, row.record_type, row.native_record_id);
        assert.equal(changed.changes, 1);
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  });
  assert.deepEqual(inventory(), footprintSQL);
  const desired = { ...expected, deletionGuards: expected.deletionGuards.map(guard => ({
    ...guard, footprintJson: ownerWideStepsGuardFootprint,
  })) };
  unchanged(footprintSQL);
  return { f, inventory, footprintSQL, desired, foreignUser, unchanged };
}

test('OWN16 ownerWide preserves a known per-record deletion footprint losslessly', async t => {
  const { f, footprintSQL, desired, unchanged } = await ownerWideKnownFootprintFixture(t);
  let callbackCount = 0, observed = null;
  try {
    const captured = await f.run(actor => {
      let value;
      assert.doesNotThrow(() => {
        try {
          value = f.policy.withReadAuthority(actor, scope => {
            callbackCount++;
            return f.policy.snapshot(scope);
          }, { tenantId: f.tenantId, ownerWide: true });
        } catch (error) {
          observed = { policyError: error instanceof f.policy.PolicyError, status: error.status, code: error.code };
          throw error;
        }
      }, 'A known Steps deletion footprint must preserve the fixed full owner inventory');
      return value;
    });
    assert.equal(callbackCount, 1);
    assert.deepEqual(captured, desired);
  } finally {
    unchanged(footprintSQL);
    console.log('DELETION_FOOTPRINT_BOUNDARY ' + JSON.stringify({ observed, callbackCount }));
  }
});

test('OWN17 ownerWide validates a foreign deletion footprint before owner filtering', async t => {
  const { f, inventory, footprintSQL, foreignUser, unchanged } = await ownerWideKnownFootprintFixture(t);
  assert.equal(Buffer.byteLength(ownerWideMalformedForeignFootprint), 129);
  const poisoned = { schema: footprintSQL.schema, tables: structuredClone(footprintSQL.tables) };
  const foreignGuard = poisoned.tables.health_deletion_guards.find(row => row.tenant_id === foreignUser.tenant_id
    && row.source_store_id === foreignUser.source_store_id && row.record_type === foreignUser.record_type
    && row.native_record_id === foreignUser.native_record_id);
  assert.ok(foreignGuard);
  foreignGuard.footprint_json = ownerWideMalformedForeignFootprint;
  const changed = f.sql(db => db.prepare('UPDATE health_deletion_guards SET footprint_json=? '
    + 'WHERE tenant_id=? AND source_store_id=? AND record_type=? AND native_record_id=?').run(
    ownerWideMalformedForeignFootprint, foreignGuard.tenant_id, foreignGuard.source_store_id,
    foreignGuard.record_type, foreignGuard.native_record_id));
  assert.equal(changed.changes, 1);
  assert.deepEqual(inventory(), poisoned);
  let callbackCount = 0;
  try {
    await f.run(actor => assert.throws(() => f.policy.withReadAuthority(actor, scope => {
      callbackCount++;
      return f.policy.snapshot(scope);
    }, { tenantId: f.tenantId, ownerWide: true }), error =>
      error instanceof f.policy.PolicyError && error.status === 409 && error.code === 'IMPORT_SOURCE_POLICY_UNKNOWN'));
    assert.equal(callbackCount, 0);
  } finally { unchanged(poisoned); }
});
