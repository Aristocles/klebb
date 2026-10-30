// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const O = require('./helpers/health-connect-owner-deletion-fixture.cjs');
const { F, I } = O;
const clockInputs = require('./fixtures/health-connect/fixed-child-clock-inputs-v1.json');

// Independent f8baeb4a literals were frozen before this first test source.
const BASE_MILLISECONDS = 1792540800123;
const READY = 'OWNER-LIFECYCLE-V1 real paired consumed grants ACKs and current publication preconditions passed';
const PUBLICATION_ASSERTION = 'default owner initial publications use the independently frozen base milliseconds';
const ordered = rows => rows.map(row => JSON.stringify(row)).sort(I.ordinal);
const recordTypes = ['BodyWaterMassRecord', 'BodyWaterMassRecord', 'CyclingPedalingCadenceRecord'];

function assertReady(data, snapshot, response) {
  assert.equal(F.rows(snapshot, 'health_schema_version')[0].version, '1');
  assert.equal(data.original.length, 3);
  assert.equal(F.bank.recordInventory.length, 3);
  assert.equal(F.rows(snapshot, 'health_records').length, 3);
  assert.deepEqual(F.rows(snapshot, 'health_tombstones'), []);
  assert.deepEqual(F.rows(snapshot, 'health_object_staging'), []);
  assert.deepEqual(F.rows(snapshot, 'health_object_parts'), []);
  assert.deepEqual(snapshot.physical, []);
  const sources = [data.alpha, data.beta, data.alpha];
  const originals = data.original.map((vector, index) => {
    const source = sources[index], original = F.bank.recordInventory[index];
    const type = recordTypes[index];
    assert.equal(original.identity[2], type);
    assert.equal(original.identity[3], 'r0-shared-id');
    assert.equal(original.expectedUtf8Bytes, [380, 357, 557][index]);
    assert.equal(Buffer.byteLength(original.recordJson), original.expectedUtf8Bytes);
    assert.equal(I.sha(Buffer.from(original.recordJson)), original.expectedRecordDigest);
    const binding = { ...source.binding, generation: source.paired.streams[type].generation };
    assert.equal(binding.generation, '1');
    assert.deepEqual(vector.payload.binding, binding);
    assert.equal(vector.payload.recordType, type);
    assert.equal(vector.payload.sequence, '1');
    assert.equal(vector.payload.batchId, `owner-original-${index}`);
    assert.equal(vector.payload.changes.length, 1);
    assert.equal(vector.payload.changes[0].operation, 'upsert');
    assert.deepEqual(vector.payload.changes[0].identity, {
      tenantId: binding.tenantId, sourceStoreId: binding.sourceStoreId,
      recordType: type, nativeRecordId: 'r0-shared-id',
    });
    assert.equal(JSON.stringify(vector.payload.changes[0].record), original.recordJson);
    assert.equal(vector.wire.version, 1);
    assert.equal(vector.wire.kind, 'batch');
    assert.equal(vector.wire.payloadJson, JSON.stringify(vector.payload));
    assert.equal(vector.wire.payloadDigest, I.sha(Buffer.from(vector.wire.payloadJson)));
    const receipt = { version: 1, kind: 'durable-receipt', binding,
      recordType: type, sequence: '1', batchId: `owner-original-${index}`,
      payloadDigest: vector.wire.payloadDigest };
    assert.deepEqual(vector.receipt, receipt);
    const record = F.identityRows(snapshot, 'health_records', {
      tenantId: binding.tenantId, sourceStoreId: binding.sourceStoreId,
      recordType: type, nativeRecordId: 'r0-shared-id',
    });
    assert.equal(record.length, 1);
    assert.equal(record[0].record_json, original.recordJson);
    assert.equal(Buffer.byteLength(record[0].record_json), original.expectedUtf8Bytes);
    assert.equal(I.sha(Buffer.from(record[0].record_json)), original.expectedRecordDigest);
    const stream = JSON.stringify([binding.tenantId, binding.instanceId,
      binding.sourceStoreId, binding.installationId, type, binding.generation,
      binding.restoreEpoch]);
    return { source, type, binding, vector, receipt, stream };
  });
  assert.deepEqual(ordered(F.rows(snapshot, 'health_streams')), ordered(originals.map(item => ({
    stream_key: item.stream, record_type: item.type, acknowledged_sequence: '1',
  }))));
  assert.deepEqual(ordered(F.rows(snapshot, 'health_batch_receipts')), ordered(originals.map(item => ({
    stream_key: item.stream, sequence: '1', batch_id: item.vector.payload.batchId,
    payload_digest: item.vector.wire.payloadDigest, receipt_json: JSON.stringify(item.receipt),
  }))));
  assert.deepEqual(ordered(F.rows(snapshot, 'health_projection_outbox')), ordered(originals.map(item => ({
    stream_key: item.stream, sequence: '1', batch_id: item.vector.payload.batchId,
    payload_digest: item.vector.wire.payloadDigest, state: 'queued',
  }))));
  assert.ok(F.rows(snapshot, 'cards').some(row => row.card_id === O.LEGACY.meta.id));
  assert.ok(F.rows(snapshot, 'rows').some(row => row.card_id === O.LEGACY.meta.id &&
    row.doc === JSON.stringify(O.LEGACY.data[0])));
  const catalogue = JSON.parse(fs.readFileSync(path.join(data.home,
    'credentials', 'health-connect.json'), 'utf8'));
  assert.equal(catalogue.version, 1);
  assert.equal(catalogue.grants.length, 2);
  assert.equal(catalogue.connectors.length, 2);
  assert.equal(data.markers.length, 5);
  assert.notEqual(data.alpha.binding.sourceStoreId, data.beta.binding.sourceStoreId);
  const ownerId = data.owner.sessions[data.owner.token].userId;
  for (const [role, source, grantMarkerIndex, categories] of [
    ['alpha', data.alpha, 1, F.TYPES],
    ['beta', data.beta, 3, [...F.TYPES, 'WeightRecord']],
  ]) {
    assert.equal(source.paired.version, 1);
    assert.equal(source.paired.kind, 'paired');
    assert.equal(source.binding.tenantId, catalogue.tenantId);
    assert.equal(source.binding.instanceId, catalogue.instanceId);
    assert.equal(source.binding.restoreEpoch, catalogue.restoreEpoch);
    assert.equal(source.binding.sourceStoreId, source.paired.sourceStoreId);
    assert.equal(source.binding.installationId, `synthetic-owner-deletion-${role}`);
    assert.deepEqual(source.paired.categories, categories);
    assert.deepEqual(Object.keys(source.paired.streams).sort(I.ordinal),
      [...categories].sort(I.ordinal));
    const grants = catalogue.grants.filter(row => row.sourceStoreId === source.binding.sourceStoreId);
    const connectors = catalogue.connectors.filter(row => row.sourceStoreId === source.binding.sourceStoreId);
    assert.equal(grants.length, 1);
    assert.equal(connectors.length, 1);
    const grant = grants[0], connector = connectors[0];
    assert.equal(grant.verifier, I.sha(Buffer.from(data.markers[grantMarkerIndex])));
    assert.equal(grant.ownerId, ownerId);
    assert.equal(grant.instanceId, catalogue.instanceId);
    assert.equal(grant.restoreEpoch, catalogue.restoreEpoch);
    assert.deepEqual(grant.categories, categories);
    assert.equal(grant.name, `Synthetic owner deletion ${role}`);
    assert.ok(Number.isFinite(Date.parse(grant.consumedAt)));
    assert.ok(Number.isFinite(Date.parse(grant.expiresAt)));
    assert.ok(Date.parse(grant.consumedAt) < Date.parse(grant.expiresAt));
    assert.equal(connector.id, source.paired.connectorId);
    assert.equal(connector.ownerId, ownerId);
    assert.equal(connector.installationId, source.binding.installationId);
    assert.equal(connector.restoreEpoch, source.binding.restoreEpoch);
    assert.deepEqual(connector.categories, categories);
    assert.deepEqual(connector.generations, Object.fromEntries(categories.map(type => [type, '1'])));
    assert.equal(connector.credentialVerifier, I.sha(Buffer.from(source.paired.credential)));
    assert.equal(connector.revokedAt, null);
    assert.equal(connector.name, grant.name);
    assert.equal(connector.createdAt, grant.consumedAt);
  }
  const expectedIndex = originals.map(item => ({
    tenant_id: item.binding.tenantId, source_store_id: item.binding.sourceStoreId,
    record_type: item.type, native_record_id: 'r0-shared-id', entry_kind: 'record',
  }));
  assert.deepEqual(ordered(O.derivedRows(snapshot, 'health_source_index')), ordered(expectedIndex));
  const expectedFrontiers = originals.map(item => ({
    tenant_id: item.binding.tenantId, source_store_id: item.binding.sourceStoreId,
    stream_key: item.stream, record_type: item.type, acknowledged_sequence: '1',
  }));
  assert.deepEqual(ordered(O.derivedRows(snapshot, 'health_source_index_frontiers')),
    ordered(expectedFrontiers));
  const states = O.derivedRows(snapshot, 'health_source_index_state');
  assert.equal(states.length, 2);
  assert.equal(response.status, 200, 'ordinary browser owner reads current publication');
  assert.equal(response.json.target, 'source-index-v1');
  assert.deepEqual(response.json.sources.map(source => source.sourceStoreId).sort(I.ordinal),
    [data.alpha.binding.sourceStoreId, data.beta.binding.sourceStoreId].sort(I.ordinal));
  const observed = {};
  for (const [role, source, records] of [['alpha', data.alpha, 2], ['beta', data.beta, 1]]) {
    const stateRows = states.filter(row => row.source_store_id === source.binding.sourceStoreId);
    assert.equal(stateRows.length, 1);
    const state = stateRows[0];
    assert.equal(state.tenant_id, source.binding.tenantId);
    assert.equal(state.target_id, 'source-index-v1');
    assert.equal(state.state, 'current');
    assert.equal(state.requested_restore_epoch, source.binding.restoreEpoch);
    assert.equal(state.published_restore_epoch, source.binding.restoreEpoch);
    const components = expectedFrontiers.filter(row => row.source_store_id === source.binding.sourceStoreId)
      .map(row => [row.stream_key, row.acknowledged_sequence])
      .sort((a, b) => I.ordinal(a[0], b[0]));
    assert.equal(state.requested_vector_digest, I.sha(Buffer.from(JSON.stringify(components))));
    assert.equal(state.attempt_count, '1');
    assert.equal(state.next_attempt_at, null);
    assert.equal(state.error_code, null);
    const milliseconds = Number(state.published_at);
    assert.ok(Number.isSafeInteger(milliseconds), 'actual publication metadata is a safe integer');
    observed[role] = milliseconds;
    const status = response.json.sources.find(row => row.sourceStoreId === source.binding.sourceStoreId);
    assert.equal(status.state, 'current');
    assert.equal(status.saved.complete, true);
    assert.equal(status.saved.records, records);
    assert.equal(status.saved.tombstones, 0);
    assert.equal(status.saved.streams, records);
    const frontiers = originals.filter(item => item.source === source)
      .sort((a, b) => I.ordinal(a.stream, b.stream))
      .map(item => ({ binding: item.binding, recordType: item.type, acknowledgedSequence: '1' }));
    assert.deepEqual(status.saved.frontiers, frontiers);
    assert.deepEqual(status.published.frontiers, frontiers);
    assert.equal(status.published.records, records);
    assert.equal(status.published.tombstones, 0);
    assert.equal(status.published.restoreEpoch, source.binding.restoreEpoch);
    assert.equal(status.published.publishedAt, new Date(milliseconds).toISOString());
    assert.equal(status.currentRestoreEpoch, source.binding.restoreEpoch);
    assert.deepEqual(status.attempts, { count: 1, limit: 3, nextAt: null });
    assert.equal(status.errorCode, null);
  }
  F.noAuthority(JSON.stringify(snapshot), data);
  return observed;
}

test('default V1 owner fixture freezes initial publication and releases only its owned clock',
  async () => {
    assert.equal(clockInputs.base.milliseconds, BASE_MILLISECONDS);
    const callerEnv = { NODE_OPTIONS: '',
      OWNER_LIFECYCLE_CALLER_SENTINEL: 'synthetic-default-owner-v1' };
    let data, primaryError;
    try {
      // O.default remains unchanged for this first baseline; no caller clock.
      data = await O.fixture({ v2: false, extraEnv: callerEnv });
      const current = await O.status(data);
      await F.capabilities(data, data.alpha);
      await F.capabilities(data, data.beta);
      assert.deepEqual(F.coldRead(data.home), data.initial,
        'healthy browser and native reads have complete cold zero effects');
      assert.equal(O.catalogueDigest(data), data.initialCatalogueDigest);
      const observed = assertReady(data, data.initial, current);
      console.log(JSON.stringify({ kind: 'owner-lifecycle-v1-initial-publication-observation',
        alphaPublishedAt: observed.alpha, betaPublishedAt: observed.beta }));
      console.log(READY);
      assert.equal(observed.alpha, BASE_MILLISECONDS, PUBLICATION_ASSERTION);
      assert.equal(observed.beta, BASE_MILLISECONDS, PUBLICATION_ASSERTION);
      // Complete release/PID/env/later-ACK/error controls are separately held.
    } catch (error) { primaryError = error; }
    const errors = primaryError ? [primaryError] : [];
    if (data) {
      try { await F.close(data); } catch (error) { errors.push(error); }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors,
      'Default owner lifecycle assertion or fixture cleanup failed',
      { cause: primaryError || errors[0] });
  });


// L02-L04 use the previously frozen f8ba controls and the scoped forwarding
// witness adopted before this source. Every override lives in its own child.
async function defaultOwnerLifecycleChild(mode, ownerPath) {
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const O = require(ownerPath), { F, I } = O;
  const BASE = 1792540800123;
  const INSTANT = '2026-10-21T00:00:00.123Z';
  const EXPIRES = '2026-10-21T00:05:00.123Z';
  const SESSION_MAX_AGE = 2592000000;
  const realTemporaryRoot = fs.realpathSync(os.tmpdir());
  const originals = { restart: F.restart, close: F.close,
    coldRead: F.coldRead, rmSync: fs.rmSync };
  const callerEnv = Object.freeze(mode === 'L02' ? {
    NODE_OPTIONS: '  --no-warnings  ',
    OWNER_LIFECYCLE_CALLER_SENTINEL: 'synthetic-default-owner-v2',
  } : { NODE_OPTIONS: '', OWNER_LIFECYCLE_CALLER_SENTINEL: `synthetic-${mode}` });
  const callerCopy = { ...callerEnv };
  const globalClockKeys = ['NODE_OPTIONS', 'OWNER_INITIAL_PUBLICATION_CLOCK_DIRECTORY'];
  const globalBefore = globalClockKeys.map(key =>
    [key, Object.hasOwn(process.env, key), process.env[key]]);
  const primary = new Error('synthetic-default-owner-primary');
  const closeError = new Error('synthetic-default-owner-close');
  const externalError = new Error('synthetic-default-owner-external');
  let data, directory, originalSessions, originalCredentialsDigest, setupEnv;
  let initialWitness, setupRestarts = 0, phase = 'setup';
  let fixtureResult, caught, unexpected;
  const cleanupOrder = [];

  function verifyOwnedDirectory(target, prefix) {
    assert.equal(typeof target, 'string');
    assert.equal(path.resolve(target), target);
    assert.equal(path.dirname(target), realTemporaryRoot);
    assert.ok(path.basename(target).startsWith(prefix));
    const info = fs.lstatSync(target);
    assert.equal(info.isDirectory(), true);
    assert.equal(info.isSymbolicLink(), false);
    assert.equal(fs.realpathSync(target), target);
    if (process.platform !== 'win32') {
      assert.equal(info.mode & 0o777, 0o700);
      assert.equal(info.uid, process.getuid());
    }
    return info;
  }
  function absent(target) {
    assert.throws(() => fs.lstatSync(target), { code: 'ENOENT' },
      'absence must not silently accept a dangling symbolic link');
  }
  function verifyClock() {
    verifyOwnedDirectory(directory, 'eh-selection-observer-');
    const clock = path.join(directory, 'clock'), info = fs.lstatSync(clock);
    assert.equal(info.isFile(), true);
    assert.equal(info.isSymbolicLink(), false);
    assert.equal(fs.realpathSync(clock), clock);
    if (process.platform !== 'win32') {
      assert.equal(info.mode & 0o777, 0o600);
      assert.equal(info.uid, process.getuid());
    }
    assert.equal(fs.readFileSync(clock, 'utf8'), INSTANT);
    assert.throws(() => fs.writeFileSync(clock, 'must-not-replace-owned-clock',
      { flag: 'wx', mode: 0o600 }), { code: 'EEXIST' });
    assert.equal(fs.readFileSync(clock, 'utf8'), INSTANT);
  }
  function verifyPrivateWindowsClock() {
    if (process.platform !== 'win32') return;
    const quoted = directory.replaceAll("'", "''");
    const script = `
      $ErrorActionPreference = 'Stop'
      $root = [IO.Path]::GetFullPath('${quoted}')
      $temporary = (Get-Item -LiteralPath ([IO.Path]::GetTempPath())).FullName.TrimEnd('\\')
      if ([IO.Path]::GetDirectoryName($root) -ne $temporary -or
          -not [IO.Path]::GetFileName($root).StartsWith('eh-selection-observer-')) { throw 'Unexpected owned clock' }
      $current = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
      $allowed = @($current, 'S-1-5-18', 'S-1-5-32-544')
      foreach ($target in @($root, (Join-Path $root 'clock'))) {
        $item = Get-Item -LiteralPath $target
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Unexpected link' }
        $acl = Get-Acl -LiteralPath $target
        if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $current) { throw 'Unowned private clock' }
        $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
        if (@($rules | Where-Object { $_.AccessControlType -ne 'Allow' -or
            $allowed -notcontains $_.IdentityReference.Value }).Count -ne 0) { throw 'Unexpected clock access' }
      }`;
    const observed = spawnSync('powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, encoding: 'utf8', timeout: 10000 });
    assert.equal(observed.error === undefined, true, 'bounded private ACL observer completed');
    assert.equal(observed.signal, null);
    assert.equal(observed.status, 0, 'owned clock has independently observed private ACL');
  }
  function assertSessionPreserved() {
    const raw = fs.readFileSync(path.join(data.home, 'sessions', 'webauthn.json'), 'utf8');
    const sessions = JSON.parse(raw), original = originalSessions[data.owner.token];
    assert.equal(JSON.stringify(Object.keys(sessions).sort()) ===
      JSON.stringify(Object.keys(originalSessions).sort()), true, 'issued session keys unchanged');
    const actual = sessions[data.owner.token];
    assert.equal(typeof actual, 'object');
    assert.equal(actual.created, original.created, 'real parent-created value stays exact');
    assert.ok(Number.isSafeInteger(actual.lastSeen));
    assert.equal(JSON.stringify({ ...actual, lastSeen: original.lastSeen }) ===
      JSON.stringify(original), true, 'only ordinary current-token lastSeen may change');
    assert.equal(raw === JSON.stringify(sessions, null, 2), true,
      'ordinary authentication retains its exact existing serialization');
    assert.equal(I.sha(fs.readFileSync(path.join(data.home, 'credentials', 'webauthn.json'))),
      originalCredentialsDigest);
    assert.ok(Date.now() - original.created <= SESSION_MAX_AGE,
      'actual real parent session remains within the unchanged30-day lifetime');
  }

  F.restart = async function fixtureRestart(value, ...args) {
    if (!data) {
      data = value;
      verifyOwnedDirectory(data.home, 'eh-test-');
      originalSessions = structuredClone(data.owner.sessions);
      originalCredentialsDigest = I.sha(fs.readFileSync(path.join(data.home,
        'credentials', 'webauthn.json')));
      const created = originalSessions[data.owner.token].created;
      assert.ok(Number.isSafeInteger(created));
      assert.notEqual(created, BASE, 'parent authentication is not rewritten to the child clock');
      directory = data.extraEnv.OWNER_INITIAL_PUBLICATION_CLOCK_DIRECTORY;
      verifyClock();
      verifyPrivateWindowsClock();
      assert.equal(data.extraEnv.OWNER_LIFECYCLE_CALLER_SENTINEL,
        callerEnv.OWNER_LIFECYCLE_CALLER_SENTINEL);
      const options = data.extraEnv.NODE_OPTIONS;
      assert.equal(typeof options, 'string');
      assert.ok(options.startsWith(callerEnv.NODE_OPTIONS),
        'effective caller NODE_OPTIONS whitespace and order remain exact');
      const appended = options.slice(callerEnv.NODE_OPTIONS.length);
      const preload = path.join(path.dirname(ownerPath),
        'health-connect-removable-owner-clock-preload.cjs');
      assert.ok(appended.includes('--require'));
      assert.ok(appended.includes(preload) || appended.includes(JSON.stringify(preload)),
        'the unchanged removable preload follows the caller options');
      setupEnv = { ...data.extraEnv };
    }
    assert.equal(value === data, true);
    if (mode !== 'L02') { cleanupOrder.push('restart'); throw primary; }
    if (phase === 'setup') {
      setupRestarts++;
      verifyClock();
    } else {
      absent(directory);
      assert.deepEqual(data.extraEnv, callerCopy);
    }
    return originals.restart.call(F, value, ...args);
  };
  F.close = async function fixtureClose(value, ...args) {
    assert.equal(value === data, true);
    cleanupOrder.push('close');
    if (mode === 'L04') throw closeError;
    return originals.close.call(F, value, ...args);
  };
  if (mode === 'L02') {
    F.coldRead = function fixtureColdRead(home, ...args) {
      const snapshot = originals.coldRead.call(F, home, ...args);
      if (data && home === data.home && phase === 'setup') {
        verifyClock();
        assert.deepEqual(data.extraEnv, setupEnv,
          'the final pre-release setup retains the caller options and owned clock');
        assert.ok(data.server?.proc.pid > 1);
        initialWitness = { proc: data.server.proc, pid: data.server.proc.pid,
          snapshot, extraEnv: { ...data.extraEnv } };
      }
      return snapshot;
    };
  }
  fs.rmSync = function ownedExternalRemoval(target, ...args) {
    if (directory && path.resolve(String(target)) === directory) {
      verifyOwnedDirectory(directory, 'eh-selection-observer-');
      cleanupOrder.push('external');
      if (mode === 'L04') throw externalError;
      if (mode === 'L02') {
        absent(path.join(directory, 'clock'));
        assert.deepEqual(data.extraEnv, callerCopy,
          'caller key presence and values restored before external directory cleanup');
      }
    }
    return originals.rmSync.call(fs, target, ...args);
  };
  try {
    try {
      fixtureResult = await O.fixture({ v2: mode === 'L02', extraEnv: callerEnv });
    } catch (error) { caught = error; }
    if (mode === 'L02') {
      if (caught) throw caught;
      assert.equal(fixtureResult === data, true);
      assert.ok(initialWitness, 'the existing pre-release final cold read was observed');
      assert.equal(initialWitness.snapshot === data.initial, true,
        'scoped forwarding returns the original unmodified final initial snapshot');
      assert.deepEqual(initialWitness.extraEnv, setupEnv);
      assert.equal(data.server.proc === initialWitness.proc, true,
        'clock release retains the same final setup process');
      assert.equal(data.server.proc.pid, initialWitness.pid);
      assert.equal(setupRestarts, 1, 'release adds no exported restart after normal V2 migration');
      assert.deepEqual(cleanupOrder, ['external']);
      assert.equal(data.expectedPublishedAt, BASE);
      absent(path.join(directory, 'clock'));
      absent(directory);
      assert.notEqual(data.extraEnv, callerEnv);
      assert.deepEqual(data.extraEnv, callerCopy);
      assert.equal(Object.hasOwn(data.extraEnv, 'OWNER_INITIAL_PUBLICATION_CLOCK_DIRECTORY'), false);
      assert.deepEqual(callerEnv, callerCopy);
      phase = 'after-return';
      assert.equal(F.rows(data.initial, 'health_schema_version')[0].version, '2');
      O.assertBase(data, data.initial);
      assert.equal(data.original.length, 3);
      for (const [index, expectedBytes] of [380, 357, 557].entries()) {
        const original = F.bank.recordInventory[index];
        assert.equal(Buffer.byteLength(original.recordJson), expectedBytes);
        assert.equal(I.sha(Buffer.from(original.recordJson)), original.expectedRecordDigest);
        assert.equal(JSON.stringify(data.original[index].payload.changes[0].record), original.recordJson);
      }
      const catalogue = JSON.parse(fs.readFileSync(path.join(data.home,
        'credentials', 'health-connect.json'), 'utf8'));
      assert.equal(catalogue.grants.length, 2);
      assert.equal(catalogue.connectors.length, 2);
      for (const grant of catalogue.grants) {
        assert.equal(grant.consumedAt, INSTANT);
        assert.equal(grant.expiresAt, EXPIRES);
        assert.equal(Date.parse(grant.expiresAt) - Date.parse(grant.consumedAt), 300000);
        const connector = catalogue.connectors.filter(row => row.sourceStoreId === grant.sourceStoreId);
        assert.equal(connector.length, 1);
        assert.equal(connector[0].createdAt, INSTANT);
      }
      const initialStates = O.derivedRows(data.initial, 'health_source_index_state');
      assert.equal(initialStates.length, 2);
      for (const state of initialStates) {
        assert.equal(Number(state.published_at), BASE);
        assert.equal(state.state, 'current');
      }
      const healthy = await O.status(data);
      assert.equal(healthy.status, 200);
      assert.equal(healthy.json.sources.length, 2);
      for (const source of healthy.json.sources) {
        assert.equal(source.state, 'current');
        assert.equal(source.published.publishedAt, INSTANT);
        assert.deepEqual(source.published.frontiers, source.saved.frontiers);
      }
      await F.capabilities(data, data.alpha);
      await F.capabilities(data, data.beta);
      assert.deepEqual(F.coldRead(data.home), data.initial,
        'ordinary browser and native requests retain complete cold zero effects');
      assert.equal(O.catalogueDigest(data), data.initialCatalogueDigest);
      assertSessionPreserved();

      await F.restart(data);
      assert.deepEqual(data.extraEnv, callerCopy);
      absent(directory);
      const original = F.bank.recordInventory[0];
      const vector = F.batch(data.alpha, '2', [F.upsert(data.alpha, original)],
        { type: original.identity[2], id: 'owner-lifecycle-later-original-ack' });
      assert.equal(JSON.stringify(vector.payload.changes[0].record), original.recordJson);
      assert.equal(Buffer.byteLength(original.recordJson), 380);
      const receipt = { version: 1, kind: 'durable-receipt',
        binding: F.binding(data.alpha, original.identity[2]),
        recordType: original.identity[2], sequence: '2',
        batchId: 'owner-lifecycle-later-original-ack',
        payloadDigest: I.sha(Buffer.from(JSON.stringify(vector.payload))) };
      assert.deepEqual(vector.receipt, receipt);
      const acknowledged = await F.ack(data, data.alpha, vector);
      assert.equal(acknowledged.status, 200);
      assert.deepEqual(acknowledged.json, receipt);
      const current = await O.waitCurrent(data);
      assert.equal(current.status, 200);
      const after = F.coldRead(data.home);
      assert.equal(F.rows(after, 'health_records').length, 3);
      assert.deepEqual(F.rows(after, 'health_tombstones'), []);
      const stream = F.streamKey(data.alpha, original.identity[2]);
      const frontier = F.rows(after, 'health_streams').filter(row => row.stream_key === stream);
      assert.equal(frontier.length, 1);
      assert.equal(frontier[0].acknowledged_sequence, '2');
      const receipts = F.rows(after, 'health_batch_receipts').filter(row =>
        row.stream_key === stream && row.sequence === '2');
      assert.equal(receipts.length, 1);
      assert.equal(receipts[0].receipt_json, JSON.stringify(receipt));
      assert.deepEqual(orderedRows(O.derivedRows(after, 'health_source_index')),
        orderedRows(O.derivedRows(data.initial, 'health_source_index')));
      for (const [index, source] of [[0, data.alpha], [1, data.beta], [2, data.alpha]]) {
        const item = F.bank.recordInventory[index];
        const rows = F.identityRows(after, 'health_records',
          F.identity(source, item.identity[2]));
        assert.equal(rows.length, 1);
        assert.equal(rows[0].record_json, item.recordJson);
      }
      for (const source of current.json.sources) {
        assert.equal(source.state, 'current');
        assert.deepEqual(source.saved.frontiers, source.published.frontiers);
        assert.equal(source.published.records, source.sourceStoreId === data.beta.binding.sourceStoreId ? 1 : 2);
        assert.equal(source.published.tombstones, 0);
      }
      const expectedFrontiers = data.original.map(item => {
        const b = item.payload.binding;
        const key = JSON.stringify([b.tenantId, b.instanceId, b.sourceStoreId,
          b.installationId, item.payload.recordType, b.generation, b.restoreEpoch]);
        return { tenant_id: b.tenantId, source_store_id: b.sourceStoreId,
          stream_key: key, record_type: item.payload.recordType,
          acknowledged_sequence: key === stream ? '2' : '1' };
      });
      assert.deepEqual(orderedRows(O.derivedRows(after, 'health_source_index_frontiers')),
        orderedRows(expectedFrontiers));
      const laterStates = O.derivedRows(after, 'health_source_index_state');
      assert.equal(laterStates.length, 2);
      for (const state of laterStates) {
        const source = current.json.sources.filter(row => row.sourceStoreId === state.source_store_id);
        assert.equal(source.length, 1);
        assert.equal(state.state, 'current');
        assert.equal(state.target_id, 'source-index-v1');
        assert.equal(state.requested_restore_epoch, data.alpha.binding.restoreEpoch);
        assert.equal(state.published_restore_epoch, data.alpha.binding.restoreEpoch);
        const components = expectedFrontiers.filter(row => row.source_store_id === state.source_store_id)
          .map(row => [row.stream_key, row.acknowledged_sequence])
          .sort((a, b) => I.ordinal(a[0], b[0]));
        assert.equal(state.requested_vector_digest, I.sha(Buffer.from(JSON.stringify(components))));
        assert.equal(state.next_attempt_at, null);
        assert.equal(state.error_code, null);
        assert.ok(Number.isSafeInteger(Number(state.published_at)));
        assert.equal(source[0].published.publishedAt,
          new Date(Number(state.published_at)).toISOString());
      }
      assert.equal(data.expectedPublishedAt, BASE, 'later observations never reset the initial expectation');
      await F.capabilities(data, data.alpha);
      await F.capabilities(data, data.beta);
      assertSessionPreserved();
      F.noAuthority(JSON.stringify(after), data);
    } else {
      assert.equal(fixtureResult, undefined);
      assert.deepEqual(cleanupOrder, ['restart', 'close', 'external'],
        'external owned cleanup is attempted independently after F.close');
      if (mode === 'L03') {
        assert.equal(caught === primary, true, 'primary-only rejection retains original object identity');
        absent(data.home);
        absent(directory);
      } else {
        assert.equal(caught instanceof AggregateError, true);
        assert.equal(caught.errors.length, 3);
        assert.equal(caught.errors[0] === primary, true);
        assert.equal(caught.errors[1] === closeError, true);
        assert.equal(caught.errors[2] === externalError, true);
        assert.equal(caught.cause === primary, true);
      }
      assert.deepEqual(callerEnv, callerCopy);
    }
  } catch (error) { unexpected = error; }
  finally {
    F.restart = originals.restart;
    F.close = originals.close;
    F.coldRead = originals.coldRead;
    fs.rmSync = originals.rmSync;
    const cleanupErrors = [];
    try {
      if (data) {
        let homePresent = true;
        try { fs.lstatSync(data.home); }
        catch (error) {
          if (error.code !== 'ENOENT') throw error;
          homePresent = false;
        }
        if (homePresent) {
          verifyOwnedDirectory(data.home, 'eh-test-');
          await originals.close.call(F, data);
        }
      }
    } catch (error) { cleanupErrors.push(error); }
    try {
      if (directory) {
        try {
          fs.lstatSync(directory);
          verifyOwnedDirectory(directory, 'eh-selection-observer-');
          originals.rmSync.call(fs, directory, { recursive: true, force: false });
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    } catch (error) { cleanupErrors.push(error); }
    try {
      assert.equal(F.restart === originals.restart && F.close === originals.close &&
        F.coldRead === originals.coldRead && fs.rmSync === originals.rmSync, true);
      assert.deepEqual(globalClockKeys.map(key =>
        [key, Object.hasOwn(process.env, key), process.env[key]]), globalBefore);
      assert.deepEqual(callerEnv, callerCopy);
      if (data) absent(data.home);
      if (directory) absent(directory);
    } catch (error) { cleanupErrors.push(error); }
    const errors = [...(unexpected ? [unexpected] : []), ...cleanupErrors];
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors,
      'Isolated lifecycle assertion or independent final cleanup failed',
      { cause: unexpected || errors[0] });
  }
  process.stdout.write(JSON.stringify({ kind: 'owner-lifecycle-control-complete', caseId: mode }));

  function orderedRows(rows) { return rows.map(row => JSON.stringify(row)).sort(I.ordinal); }
}

const lifecycleControlCases = [
  ['L02', 'default V2 owner fixture preserves caller options and releases its clock before later exact ACK', 60000],
  ['L03', 'default owner setup failure rethrows its original error after independent owned cleanup', 10000],
  ['L04', 'default owner setup and both cleanup failures retain ordered original errors and cause', 10000],
];
for (const [caseId, title, timeout] of lifecycleControlCases) {
  test(title, { timeout: 60000 }, () => {
    const { spawnSync } = require('node:child_process');
    const ownerPath = path.resolve(__dirname, 'helpers/health-connect-owner-deletion-fixture.cjs');
    const script = `(${defaultOwnerLifecycleChild.toString()})(${JSON.stringify(caseId)},` +
      `${JSON.stringify(ownerPath)}).catch(error => { process.stderr.write(error.stack + '\\n'); process.exitCode = 1; });`;
    const child = spawnSync(process.execPath, ['-e', script], {
      cwd: F.product, env: { ...process.env }, encoding: 'utf8', windowsHide: true, timeout,
    });
    assert.equal(child.error === undefined, true, 'isolated lifecycle child completed within its fixed bound');
    assert.equal(child.signal, null);
    assert.equal(child.status, 0, child.stderr || 'isolated lifecycle child failed');
    assert.equal(child.stdout, JSON.stringify({
      kind: 'owner-lifecycle-control-complete', caseId,
    }), 'every independent lifecycle assertion and cleanup completed before the child marker');
  });
}
