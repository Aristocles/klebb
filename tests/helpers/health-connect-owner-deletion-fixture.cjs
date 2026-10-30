// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { fakeAuthState } = require('./sandbox');
const F = require('./health-connect-sticky-admission-fixture.cjs');
const { registerMarkers } = require('./health-connect-sticky-admission-cold-readback.cjs');
const I = require('./health-connect-owner-deletion-independent.cjs');
const PREVIEW = `${F.BASE}/deletions/preview`, APPLY = `${F.BASE}/deletions/apply`;
const STATUS = `${F.BASE}/projections/status`;
const LEGACY = { $schema: 'klebb.datafile.v1',
  meta: { id: 'synthetic-sticky-legacy', label: 'Synthetic sticky legacy' },
  data: [{ date: '2026-10-20', kg: 35.5, note: 'preserve sticky admission sentinel' }] };
// Exact already-approved empty-fixture ACL setup, before any fixture population.
function owned(home) {
  assert.equal(path.dirname(home), path.resolve(os.tmpdir()));
  assert.ok(path.basename(home).startsWith('eh-test-'));
  assert.equal(fs.lstatSync(home).isSymbolicLink(), false);
}
function secureEmptyHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eh-test-'));
  owned(home);
  const databaseDirectory = path.join(home, 'db');
  fs.mkdirSync(databaseDirectory, { mode: 0o700 });
  if (process.platform === 'win32') {
    // Exact approved synthetic-empty-home profile. Never changes an existing
    // populated home or production ACL. No ACL identities leave this child.
    const quoted = home.replaceAll("'", "''");
    const script = `
      $ErrorActionPreference = 'Stop'
      $absoluteHome = [IO.Path]::GetFullPath('${quoted}')
      $temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\\')
      $databaseDirectory = [IO.Path]::GetFullPath((Join-Path $absoluteHome 'db'))
      if ([IO.Path]::GetDirectoryName($absoluteHome) -ne $temporaryRoot -or
          -not [IO.Path]::GetFileName($absoluteHome).StartsWith('eh-test-') -or
          [IO.Path]::GetDirectoryName($databaseDirectory) -ne $absoluteHome) { throw 'Unexpected empty fixture' }
      foreach ($target in @($absoluteHome, $databaseDirectory)) {
        $item = Get-Item -LiteralPath $target
        if (-not $item.PSIsContainer -or
            ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Unexpected link' }
      }
      $entries = @(Get-ChildItem -LiteralPath $absoluteHome -Force)
      if ($entries.Count -ne 1 -or $entries[0].FullName -ne $databaseDirectory -or
          @(Get-ChildItem -LiteralPath $databaseDirectory -Force).Count -ne 0) { throw 'Fixture is populated' }
      $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
      $systemSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
      $administratorSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
      $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
        [Security.AccessControl.InheritanceFlags]::ObjectInherit
      foreach ($target in @($absoluteHome, $databaseDirectory)) {
        $security = [Security.AccessControl.DirectorySecurity]::new()
        $security.SetAccessRuleProtection($true, $false)
        $security.SetOwner($currentSid)
        foreach ($principal in @($currentSid, $systemSid, $administratorSid)) {
          $rule = [Security.AccessControl.FileSystemAccessRule]::new(
            $principal, [Security.AccessControl.FileSystemRights]::FullControl, $inheritance,
            [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
          [void]$security.AddAccessRule($rule)
        }
        Set-Acl -LiteralPath $target -AclObject $security
        $observed = Get-Acl -LiteralPath $target
        if (-not $observed.AreAccessRulesProtected) { throw 'Private inheritance not protected' }
        $allowed = @($currentSid.Value, $systemSid.Value, $administratorSid.Value)
        foreach ($rule in $observed.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
          if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
              $allowed -notcontains $rule.IdentityReference.Value) { throw 'Unexpected effective allow' }
        }
      }`;
    const outcome = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive',
      '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true, encoding: 'utf8', timeout: 10000 });
    assert.equal(outcome.status, 0, 'new empty synthetic fixture must have private ACL before population');
  } else fs.chmodSync(home, 0o700);
  for (const directory of ['data', 'data/_archive', 'sessions', 'credentials', 'inbox/_failed',
    'reports/_archive', 'data/auto-export/sleep', 'data/auto-export/workouts',
    'data/auto-export/vitals', 'data/auto-export/activity']) {
    fs.mkdirSync(path.join(home, directory), { recursive: true, mode: 0o700 });
  }
  return home;
}

const derivedRows = (snapshot, table) => F.rows({ native: snapshot.derived }, table);
function catalogueDigest(data) {
  return I.sha(fs.readFileSync(path.join(data.home, 'credentials', 'health-connect.json')));
}
async function pair(data, name, categories) {
  const grant = await F.request(data, `${F.BASE}/pairing-grants`, {
    method: 'POST', browser: true,
    body: { name: `Synthetic owner deletion ${name}`, categories },
  });
  assert.equal(grant.status, 201, 'real owner-issued source grant');
  const response = await F.request(data, `${F.BASE}/v1/pairing/exchange`, {
    method: 'POST', body: { version: 1, kind: 'pairing-exchange',
      tenantId: grant.json.tenantId, instanceId: grant.json.instanceId,
      sourceStoreId: grant.json.sourceStoreId,
      installationId: `synthetic-owner-deletion-${name}`, categories, grant: grant.json.grant },
  });
  assert.equal(response.status, 200, 'real scoped native exchange');
  const paired = response.json;
  data.markers.push(grant.json.grant, paired.credential);
  return { paired, binding: { tenantId: paired.tenantId, instanceId: paired.instanceId,
    sourceStoreId: paired.sourceStoreId, installationId: paired.installationId,
    generation: paired.streams[F.TYPE].generation, restoreEpoch: paired.restoreEpoch } };
}
async function status(data) {
  const response = await F.request(data, STATUS, { browser: true });
  F.noAuthority(response.body, data);
  return response;
}
async function waitCurrent(data, betaRecords = 1) {
  const deadline = Date.now() + 10000;
  let response;
  do {
    response = await status(data);
    if (response.status === 200 && response.json.target === 'source-index-v1' &&
        response.json.sources.length === 2 && response.json.sources.every(source =>
          source.state === 'current' && source.published !== null &&
          source.published.records === (source.sourceStoreId === data.beta.binding.sourceStoreId ?
            betaRecords : 2) && source.published.tombstones === 0)) return response;
    await delay(25);
  } while (Date.now() < deadline);
  assert.fail(`bounded actual current source publication missing; last status ${response?.status}`);
}
function context(data, source) {
  return { tenantId: source.binding.tenantId, sourceStoreId: source.binding.sourceStoreId,
    restoreEpoch: source.binding.restoreEpoch,
    nativeSchemaVersion: Number(F.rows(F.coldRead(data.home), 'health_schema_version')[0].version) };
}
function tables(snapshot) {
  return Object.fromEntries(Object.keys(snapshot.native.tables)
    .map(name => [name, F.rows(snapshot, name)]));
}
function expectations(data, source, identities, snapshot) {
  const nativeTables = tables(snapshot);
  const schemaVersion = Number(nativeTables.health_schema_version[0].version);
  const boundary = { tenantId: source.binding.tenantId, sourceStoreId: source.binding.sourceStoreId,
    restoreEpoch: source.binding.restoreEpoch, nativeSchemaVersion: schemaVersion };
  const footprints = { [`${F.TYPE}\0${F.ID}`]:
    { kind: 'instant', time: '2026-01-02T03:04:05.123456789Z', zoneOffset: null } };
  return I.expected(boundary, identities, nativeTables, footprints);
}
function assertBase(data, snapshot) {
  assert.equal(F.rows(snapshot, 'health_schema_version')[0].version, '2');
  const records = F.rows(snapshot, 'health_records');
  assert.equal(records.length, 3);
  for (const [index, source] of [[0, data.alpha], [1, data.beta], [2, data.alpha]]) {
    const original = F.bank.recordInventory[index];
    const row = F.identityRows(snapshot, 'health_records',
      F.identity(source, original.identity[2]));
    assert.equal(row.length, 1);
    assert.equal(row[0].record_json, original.recordJson);
    assert.equal(Buffer.byteLength(row[0].record_json), original.expectedUtf8Bytes);
    assert.equal(I.sha(Buffer.from(row[0].record_json)), original.expectedRecordDigest);
  }
  assert.deepEqual(F.rows(snapshot, 'health_tombstones'), []);
  assert.deepEqual(F.rows(snapshot, 'health_deletion_guards'), []);
  assert.equal(F.rows(snapshot, 'health_batch_receipts').length, 3);
  assert.equal(F.rows(snapshot, 'health_streams').length, 3);
  assert.equal(F.rows(snapshot, 'health_projection_outbox').length, 3);
  const ordered = rows => rows.map(row => JSON.stringify(row)).sort(I.ordinal);
  const originals = data.original.map(vector => {
    const b = vector.payload.binding;
    return { vector, stream: JSON.stringify([b.tenantId, b.instanceId, b.sourceStoreId,
      b.installationId, vector.payload.recordType, b.generation, b.restoreEpoch]) };
  });
  assert.deepEqual(ordered(F.rows(snapshot, 'health_streams')), ordered(originals.map(item => ({
    stream_key: item.stream, record_type: item.vector.payload.recordType, acknowledged_sequence: '1',
  }))));
  assert.deepEqual(ordered(F.rows(snapshot, 'health_batch_receipts')), ordered(originals.map(item => ({
    stream_key: item.stream, sequence: '1', batch_id: item.vector.payload.batchId,
    payload_digest: item.vector.wire.payloadDigest, receipt_json: JSON.stringify(item.vector.receipt),
  }))));
  assert.deepEqual(ordered(F.rows(snapshot, 'health_projection_outbox')), ordered(originals.map(item => ({
    stream_key: item.stream, sequence: '1', batch_id: item.vector.payload.batchId,
    payload_digest: item.vector.wire.payloadDigest, state: 'queued',
  }))));
  const index = derivedRows(snapshot, 'health_source_index');
  const expectedIds = [[data.alpha, F.TYPE], [data.beta, F.TYPE], [data.alpha, F.TYPES[1]]]
    .map(([source, type]) => ({ tenant_id: source.binding.tenantId,
      source_store_id: source.binding.sourceStoreId, record_type: type,
      native_record_id: F.ID, entry_kind: 'record' }));
  assert.deepEqual(ordered(index), ordered(expectedIds));
  const expectedStreams = data.original.map(vector => ({
    tenant_id: vector.payload.binding.tenantId,
    source_store_id: vector.payload.binding.sourceStoreId,
    stream_key: JSON.stringify([vector.payload.binding.tenantId, vector.payload.binding.instanceId,
      vector.payload.binding.sourceStoreId, vector.payload.binding.installationId,
      vector.payload.recordType, vector.payload.binding.generation, vector.payload.binding.restoreEpoch]),
    record_type: vector.payload.recordType, acknowledged_sequence: '1',
  }));
  assert.deepEqual(ordered(derivedRows(snapshot, 'health_source_index_frontiers')),
    ordered(expectedStreams));
  const states = derivedRows(snapshot, 'health_source_index_state');
  assert.equal(states.length, 2);
  for (const state of states) {
    assert.equal(state.state, 'current');
    assert.equal(state.target_id, 'source-index-v1');
    assert.equal(state.requested_restore_epoch, data.alpha.binding.restoreEpoch);
    const components = expectedStreams.filter(row => row.source_store_id === state.source_store_id)
      .map(row => [row.stream_key, row.acknowledged_sequence])
      .sort((a, b) => I.ordinal(a[0], b[0]));
    assert.equal(state.requested_vector_digest, I.sha(Buffer.from(JSON.stringify(components))));
    assert.equal(state.attempt_count, '1');
    assert.equal(state.next_attempt_at, null);
    assert.equal(state.error_code, null);
    assert.equal(state.published_restore_epoch, data.alpha.binding.restoreEpoch);
    if (data.expectedPublishedAt === undefined) {
      assert.ok(Number(state.published_at) >= data.startedAt && Number(state.published_at) <= Date.now());
    } else {
      assert.ok(Number.isSafeInteger(data.expectedPublishedAt));
      assert.equal(Number(state.published_at), data.expectedPublishedAt,
        'actual publication uses the independently supplied child clock');
    }
  }
  assert.ok(F.rows(snapshot, 'cards').some(row => row.card_id === LEGACY.meta.id));
  assert.ok(F.rows(snapshot, 'rows').some(row => row.card_id === LEGACY.meta.id &&
    row.doc === JSON.stringify(LEGACY.data[0])));
  F.noAuthority(JSON.stringify(snapshot), data);
}
async function defaultFixture({ v2, extraEnv }) {
  const inputs = require('../fixtures/health-connect/fixed-child-clock-inputs-v1.json');
  assert.equal(inputs.base.milliseconds, 1792540800123);
  assert.equal(inputs.base.instant, '2026-10-21T00:00:00.123Z');
  assert.ok(Number.isSafeInteger(inputs.base.milliseconds));
  assert.equal(Date.parse(inputs.base.instant), inputs.base.milliseconds);
  const originalExtraEnv = { ...extraEnv };
  const callerOptions = Object.hasOwn(originalExtraEnv, 'NODE_OPTIONS') ?
    originalExtraEnv.NODE_OPTIONS : process.env.NODE_OPTIONS;
  assert.ok(callerOptions === undefined || typeof callerOptions === 'string');
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  let clockDirectory = null;
  function ownedClockDirectory() {
    assert.equal(path.dirname(clockDirectory), temporaryRoot);
    assert.ok(path.basename(clockDirectory).startsWith('eh-selection-observer-'));
    const info = fs.lstatSync(clockDirectory);
    assert.equal(info.isSymbolicLink(), false);
    assert.equal(info.isDirectory(), true);
    assert.equal(fs.realpathSync(clockDirectory), clockDirectory);
  }
  function removeClockDirectory() {
    if (clockDirectory === null) return;
    ownedClockDirectory();
    fs.rmSync(clockDirectory, { recursive: true, force: false });
    assert.throws(() => fs.lstatSync(clockDirectory), { code: 'ENOENT' });
    clockDirectory = null;
  }
  const owner = fakeAuthState('owner-deletion-fixture-owner'), startedAt = Date.now();
  const home = secureEmptyHome();
  const data = { home, owner, server: null, markers: [owner.token], logs: '',
    extraEnv: { ...originalExtraEnv }, original: [], startedAt,
    expectedPublishedAt: inputs.base.milliseconds };
  try {
    fs.writeFileSync(path.join(home, 'credentials', 'webauthn.json'), JSON.stringify(owner.credentials),
      { mode: 0o600 });
    fs.writeFileSync(path.join(home, 'sessions', 'webauthn.json'), JSON.stringify(owner.sessions),
      { mode: 0o600 });
    fs.writeFileSync(path.join(home, 'data', 'synthetic-sticky-legacy.json'), JSON.stringify(LEGACY),
      { mode: 0o600 });
    registerMarkers(home, data.markers);
    clockDirectory = fs.mkdtempSync(path.join(temporaryRoot, 'eh-selection-observer-'));
    ownedClockDirectory();
    const clock = path.join(clockDirectory, 'clock');
    fs.writeFileSync(clock, inputs.base.instant, { flag: 'wx', mode: 0o600 });
    const preload = path.join(__dirname, 'health-connect-removable-owner-clock-preload.cjs');
    data.extraEnv = { ...originalExtraEnv,
      NODE_OPTIONS: `${callerOptions === undefined ? '' : callerOptions} --require=${JSON.stringify(preload)}`,
      OWNER_INITIAL_PUBLICATION_CLOCK_DIRECTORY: clockDirectory };
    await F.restart(data);
    data.alpha = await pair(data, 'alpha', F.TYPES);
    // D08 must reach suppression under actual Weight authority, not fail scope403.
    data.beta = await pair(data, 'beta', [...F.TYPES, 'WeightRecord']);
    assert.ok(data.beta.paired.streams.WeightRecord);
    for (const [index, source] of [[0, data.alpha], [1, data.beta], [2, data.alpha]]) {
      const item = F.bank.recordInventory[index];
      const vector = F.batch(source, '1', [F.upsert(source, item)],
        { type: item.identity[2], id: `owner-original-${index}` });
      await F.ack(data, source, vector); data.original.push(vector);
    }
    await F.capabilities(data);
    if (v2) await F.migrate(data);
    await waitCurrent(data);
    data.initial = F.coldRead(home);
    if (v2) assertBase(data, data.initial);
    else {
      const states = derivedRows(data.initial, 'health_source_index_state');
      assert.equal(states.length, 2);
      for (const state of states)
        assert.equal(Number(state.published_at), inputs.base.milliseconds,
          'actual publication uses the independently supplied child clock');
    }
    const catalogue = JSON.parse(fs.readFileSync(path.join(home, 'credentials', 'health-connect.json'), 'utf8'));
    for (const source of [data.alpha, data.beta]) {
      const grants = catalogue.grants.filter(row => row.sourceStoreId === source.binding.sourceStoreId);
      assert.equal(grants.length, 1);
      assert.ok(Number.isFinite(Date.parse(grants[0].consumedAt)));
    }
    data.initialCatalogueDigest = catalogueDigest(data);
    ownedClockDirectory();
    const clockInfo = fs.lstatSync(clock);
    assert.equal(clockInfo.isSymbolicLink(), false);
    assert.equal(clockInfo.isFile(), true);
    fs.unlinkSync(clock);
    assert.throws(() => fs.lstatSync(clock), { code: 'ENOENT' });
    data.extraEnv = { ...originalExtraEnv };
    removeClockDirectory();
    return data;
  } catch (error) {
    const failures = [error];
    try { await F.close(data); } catch (cleanupError) { failures.push(cleanupError); }
    try { removeClockDirectory(); } catch (cleanupError) { failures.push(cleanupError); }
    if (failures.length > 1)
      throw new AggregateError(failures, 'default owner fixture and cleanup failed', { cause: error });
    throw error;
  }
}

async function fixture({ v2 = true, extraEnv = {}, expectedPublishedAt = null } = {}) {
  if (expectedPublishedAt === null) return defaultFixture({ v2, extraEnv });
  const home = secureEmptyHome(), owner = fakeAuthState('owner-deletion-fixture-owner');
  fs.writeFileSync(path.join(home, 'credentials', 'webauthn.json'), JSON.stringify(owner.credentials),
    { mode: 0o600 });
  fs.writeFileSync(path.join(home, 'sessions', 'webauthn.json'), JSON.stringify(owner.sessions),
    { mode: 0o600 });
  fs.writeFileSync(path.join(home, 'data', 'synthetic-sticky-legacy.json'), JSON.stringify(LEGACY),
    { mode: 0o600 });
  const data = { home, owner, server: null, markers: [owner.token], logs: '', extraEnv,
    original: [], startedAt: Date.now() };
  if (expectedPublishedAt !== null) {
    assert.ok(Number.isSafeInteger(expectedPublishedAt));
    data.expectedPublishedAt = expectedPublishedAt;
  }
  registerMarkers(home, data.markers);
  try {
    await F.restart(data);
    data.alpha = await pair(data, 'alpha', F.TYPES);
    // D08 must reach suppression under actual Weight authority, not fail scope403.
    data.beta = await pair(data, 'beta', [...F.TYPES, 'WeightRecord']);
    assert.ok(data.beta.paired.streams.WeightRecord);
    for (const [index, source] of [[0, data.alpha], [1, data.beta], [2, data.alpha]]) {
      const item = F.bank.recordInventory[index];
      const vector = F.batch(source, '1', [F.upsert(source, item)],
        { type: item.identity[2], id: `owner-original-${index}` });
      await F.ack(data, source, vector); data.original.push(vector);
    }
    await F.capabilities(data);
    if (v2) await F.migrate(data);
    await waitCurrent(data);
    data.initial = F.coldRead(home);
    if (v2) assertBase(data, data.initial);
    data.initialCatalogueDigest = catalogueDigest(data);
    return data;
  } catch (error) { await F.close(data); throw error; }
}
const preview = (data, source, identities) => F.request(data, PREVIEW, {
  method: 'POST', browser: true, body: { sourceStoreId: source.binding.sourceStoreId, identities },
});
const apply = (data, source, identities, revision) => F.request(data, APPLY, {
  method: 'POST', browser: true,
  body: { sourceStoreId: source.binding.sourceStoreId, identities, revision },
});
function payloadFree(response, data) {
  F.noAuthority(response.body, data);
  assert.equal(response.body.includes('43.125'), false);
  assert.equal(response.body.includes(data.alpha.binding.tenantId), false);
}
function assertPreview(response, expected, data) {
  assert.equal(response.status, 200, 'real owner deletion preview must succeed');
  assert.deepEqual(response.json, expected.preview);
  assert.equal(response.body, JSON.stringify(expected.preview), 'exact bounded field representation');
  payloadFree(response, data);
}
function assertApply(response, expected, data, projectionQueued = true) {
  assert.equal(response.status, 200, 'real owner deletion apply must commit');
  assert.deepEqual(response.json, expected.apply(projectionQueued));
  assert.equal(response.body, JSON.stringify(expected.apply(projectionQueued)));
  payloadFree(response, data);
}
const text = value => ({ type: 'text', value });
const integer = value => ({ type: 'integer', decimal: String(value) });
const absent = () => ({ type: 'null' });
function assertUserEffect(before, after, source, type, id, footprint) {
  const expected = structuredClone(before.native);
  expected.tables.health_records = expected.tables.health_records.filter(row => !(
    row.tenant_id.value === source.binding.tenantId &&
    row.source_store_id.value === source.binding.sourceStoreId &&
    row.record_type.value === type && row.native_record_id.value === id));
  expected.tables.health_deletion_guards.push({
    tenant_id: text(source.binding.tenantId), source_store_id: text(source.binding.sourceStoreId),
    record_type: text(type), native_record_id: text(id), source_deleted: integer(0),
    user_suppressed: integer(1), source_stream_key: absent(), source_sequence: absent(),
    footprint_json: footprint === null ? absent() : text(JSON.stringify(footprint)),
  });
  assert.deepEqual(after.native, expected, 'only independently fixed user guard and selected raw purge');
  assert.deepEqual(after.physical, before.physical);
  const alpha = source.binding.sourceStoreId;
  for (const name of Object.keys(before.derived.tables)) {
    const retained = rows => rows.filter(row => row.source_store_id?.value !== alpha);
    assert.deepEqual(retained(after.derived.tables[name]), retained(before.derived.tables[name]),
      'unrelated source publication must remain exact');
  }
}
function unseenWeight(source) {
  // Existing independent Weight golden, preserving every value except the
  // expressly selected previously unseen metadata ID. Not native SDK capture.
  const record = structuredClone(I.bank.unseenWeightRecord);
  record.metadata.id = I.bank.unseenWeightId;
  return F.batch(source, '1', [{ operation: 'upsert',
    identity: F.identity(source, 'WeightRecord', I.bank.unseenWeightId),
    dataFamily: 'ordinary', projection: 'raw-only', serializerId: 'health-connect-record',
    serializerVersion: 1, record }], { type: 'WeightRecord', id: 'owner-unseen-weight-upsert-1' });
}
module.exports = { F, I, PREVIEW, APPLY, STATUS, LEGACY, fixture, preview, apply, status,
  waitCurrent, context, tables, derivedRows, expectations, assertBase,
  assertPreview, assertApply, assertUserEffect, unseenWeight, catalogueDigest, payloadFree };

// Remaining original U03-U16 controls. Existing U01/U02 setup and assertions
// above are retained verbatim. No owner service or product digest is imported.
const http = require('node:http');
const { spawn } = require('node:child_process');
const standardFootprint = { kind: 'instant', time: '2026-01-02T03:04:05.123456789Z', zoneOffset: null };
const objectFootprint = { kind: 'instant', time: '2026-10-28T03:45:00.123456789Z', zoneOffset: '+11:00' };
function expected(data, source, identities, snapshot = F.coldRead(data.home), footprints = {}) {
  const fixed = {};
  for (const item of identities) {
    fixed[`${item.recordType}\0${item.nativeRecordId}`] =
      footprints[item.nativeRecordId] || standardFootprint;
  }
  const boundary = { tenantId: source.binding.tenantId, sourceStoreId: source.binding.sourceStoreId,
    restoreEpoch: source.binding.restoreEpoch,
    nativeSchemaVersion: Number(F.rows(snapshot, 'health_schema_version')[0].version) };
  const native = tables(snapshot);
  // Independent cold reader hashes actual large TEXT before reducing it to
  // bytes/digest evidence. Never turn an absent `.value` into source text.
  const rawRows = snapshot.native.tables.health_records;
  native.health_records = native.health_records.map(row => ({ ...row, record_json: row.record_json || '' }));
  const states = I.statesFromRows(boundary, identities, native, fixed);
  for (const state of states) {
    if (state[2] === null) continue;
    const raw = rawRows.find(row => row.tenant_id.value === boundary.tenantId &&
      row.source_store_id.value === boundary.sourceStoreId && row.record_type.value === state[0] &&
      row.native_record_id.value === state[1]).record_json;
    if (raw.bytes !== undefined) {
      assert.equal(raw.type, 'text'); state[2][4] = raw.bytes; state[2][5] = raw.digest;
    }
  }
  const content = I.revision(boundary, identities, I.verifiedVector(boundary, native), states);
  const effects = { newlyUserSuppressed: 0, removedRecords: 0,
    removedStagedObjects: 0, removedParts: 0, removedPartBytes: 0 };
  for (const state of states) {
    effects.newlyUserSuppressed += state[4]?.[1] === 1 ? 0 : 1;
    effects.removedRecords += state[2] === null ? 0 : 1;
    for (const staged of state[5]) {
      effects.removedStagedObjects++;
      for (const part of staged[5]) { effects.removedParts++; effects.removedPartBytes += part[1]; }
    }
  }
  const previewResult = { version: 1, kind: 'deletion-preview', sourceStoreId: boundary.sourceStoreId,
    revision: content.digest, identities: states.map(state => ({
      recordType: state[0], nativeRecordId: state[1], sourceDeleted: state[3] !== null || state[4]?.[0] === 1,
      userSuppressed: state[4]?.[1] === 1, currentRecord: state[2] !== null,
      footprint: I.footprintObject(state[4]?.[4] ?? state[2]?.[6] ?? null),
    })), effects };
  return { content, preview: previewResult, apply: projectionQueued => ({
    version: 1, kind: 'deletion-result', sourceStoreId: boundary.sourceStoreId,
    revision: content.digest, effects, projectionQueued,
  }) };
}
const selected = (id = F.ID, type = F.TYPE) => [{ recordType: type, nativeRecordId: id }];
async function stableFailure(data, action, statusCode, code) {
  const before = F.coldRead(data.home), authority = catalogueDigest(data), copies = F.copies(data);
  const response = await action();
  F.failure(response, statusCode, code, data);
  assert.deepEqual(F.coldRead(data.home), before, 'each refusal has complete cold zero effects');
  assert.equal(catalogueDigest(data), authority);
  assert.deepEqual(F.copies(data), copies);
  return response;
}
async function stableReceipt(data, action, receipt) {
  const before = F.coldRead(data.home), authority = catalogueDigest(data), copies = F.copies(data);
  const response = await action();
  assert.equal(response.status, 200); assert.deepEqual(response.json, receipt);
  assert.equal(response.body, JSON.stringify(receipt)); F.noAuthority(response.body, data);
  assert.deepEqual(F.coldRead(data.home), before);
  assert.equal(catalogueDigest(data), authority); assert.deepEqual(F.copies(data), copies);
}
async function waitOwnedCurrent(data, source, records, tombstones = 0) {
  const deadline = Date.now() + 10000;
  let response;
  do {
    response = await status(data);
    assert.equal(response.status, 200);
    const item = response.json.sources.find(row => row.sourceStoreId === source.binding.sourceStoreId);
    if (item?.state === 'current' && item.published?.records === records &&
        item.published.tombstones === tombstones) return item;
    await delay(25);
  } while (Date.now() < deadline);
  assert.fail('bounded actual matching source publication missing');
}
async function suppress(data, source = data.beta, identities = selected(), footprints = {}) {
  const before = F.coldRead(data.home), exp = expected(data, source, identities, before, footprints);
  assertPreview(await preview(data, source, identities), exp, data);
  assert.deepEqual(F.coldRead(data.home), before);
  assertApply(await apply(data, source, identities, exp.content.digest), exp, data, true);
  return { before, expected: exp };
}
async function control(data, input) {
  assert.equal(data.server, null, 'all inventory controls require a stopped server/publisher');
  owned(data.home);
  const child = spawn(process.execPath, [path.join(__dirname,
    'health-connect-owner-deletion-controlled-state.cjs')], {
    env: { ...process.env, ...F.ENV, HEALTH_HOME: data.home }, cwd: F.product,
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  let output = '', errors = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { errors += chunk; });
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('bounded stopped owner control')); }, 20000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, output }); });
    child.stdin.end(JSON.stringify(input));
  });
  F.noAuthority(errors, data);
  assert.equal(result.code, 0, 'disclosed stopped inventory must construct successfully');
  const reply = JSON.parse(result.output);
  assert.equal(reply.ok, true); return reply.result;
}
async function exhaust(data, source = data.beta) {
  await F.stop(data); await control(data, { command: 'exhaust', binding: source.binding });
  await F.restart(data); await F.capabilities(data);
  const state = derivedRows(F.coldRead(data.home), 'health_source_index_state')
    .find(row => row.source_store_id === source.binding.sourceStoreId);
  assert.equal(state.state, 'failed'); assert.equal(state.attempt_count, '3');
  assert.equal(state.next_attempt_at, null); assert.equal(state.error_code, 'storage-unavailable');
  return state;
}
function observations(data) {
  const directory = path.join(data.home, 'owner-delete-observations');
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter(name => /^\d{6}\.json$/.test(name)).sort()
    .map(name => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')));
}
async function observed(data, kind) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const item = observations(data).find(row => row.kind === kind);
    if (item) return item;
    await delay(20);
  }
  assert.fail(`bounded native observation missing: ${kind}`);
}
async function arm(data, mode) {
  const directory = path.join(data.home, 'owner-delete-observations');
  fs.mkdirSync(directory, { mode: 0o700 });
  const enabled = path.join(data.home, 'owner-delete-enabled');
  await F.restart(data, { ...data.extraEnv,
    NODE_OPTIONS: `--require="${path.join(__dirname, 'health-connect-owner-deletion-preload.cjs').replaceAll('\\', '/')}"`,
    OWNER_DELETE_OBSERVATIONS: directory, OWNER_DELETE_ENABLED: enabled, OWNER_DELETE_MODE: mode });
  await F.capabilities(data);
  fs.writeFileSync(enabled, 'enabled', { flag: 'wx', mode: 0o600 });
}
function witness(data, { nativeResult, prior = false, committed = false } = {}) {
  const events = observations(data);
  const begin = events.find(row => row.kind === 'own-writer-before-BEGIN');
  assert.ok(begin); assert.equal(begin.journalMode, 'wal'); assert.equal(begin.synchronous, 2);
  if (nativeResult !== undefined) {
    const fault = events.find(row => row.kind === 'actual-native-fault');
    assert.ok(fault); assert.equal(fault.nativeResult, nativeResult);
    assert.equal(fault.handleId, begin.handleId);
    assert.equal(events.some(row => row.kind === 'actual-COMMIT-returned'), false);
  }
  const event = events.find(row => row.kind === (committed ?
    'actual-COMMIT-returned' : prior ? 'earlier-successful-own-mutations' : 'own-writer-BEGIN-complete'));
  if (prior || committed) {
    assert.ok(event); assert.equal(event.handleId, begin.handleId);
    for (const name of ['guards', 'raw', 'parts', 'index']) assert.ok(event[name] > 0, name);
    for (const name of ['receipts', 'frontiers', 'jobs', 'tombstones']) assert.equal(event[name], 0);
    assert.equal(event.transactionActive, !committed);
  }
  return events;
}
function held(data, route, body) {
  const wire = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const split = Math.max(1, Math.floor(wire.length / 2));
  const agent = new http.Agent({ keepAlive: false });
  let outgoing;
  const response = new Promise((resolve, reject) => {
    outgoing = http.request(data.server.baseUrl + route, {
      method: 'POST', agent, headers: { Cookie: `klebb_session=${data.owner.token}`,
        Origin: F.ENV.HEALTH_ORIGIN, 'Content-Type': 'application/json', 'Content-Length': wire.length } },
    incoming => {
      let text = '';
      incoming.on('data', chunk => { text += chunk; });
      incoming.on('error', reject);
      incoming.on('end', () => {
        try { resolve({ status: incoming.statusCode, body: text, json: JSON.parse(text) }); }
        catch (error) { reject(error); }
        finally { agent.destroy(); }
      });
    });
    outgoing.once('error', reject);
    outgoing.setTimeout(10000, () => outgoing.destroy(new Error('bounded held owner request')));
    outgoing.write(wire.subarray(0, split));
  });
  void response.catch(() => {});
  return { response, bytes: wire.length, finish: () => outgoing.end(wire.subarray(split)),
    destroy: () => { outgoing.destroy(); agent.destroy(); } };
}
async function lostApply(data, source, identities, revision) {
  const child = data.server.proc;
  const exited = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('faulted actual server must close within 10 seconds')), 10000);
    child.once('close', (code, signal) => { clearTimeout(timer);
      assert.ok(code !== null || signal !== null); resolve({ code, signal }); });
  });
  void exited.catch(() => {});
  let lost = false;
  try { await apply(data, source, identities, revision); } catch { lost = true; }
  assert.equal(lost, true, 'actual process death interrupts the HTTP reply, not a discarded response');
  const result = await exited; data.server = null; return result;
}
function assertReferences(before, after) {
  for (const name of ['health_streams', 'health_batch_receipts', 'health_projection_outbox',
    'health_tombstones', 'health_object_receipts', 'cards', 'rows', 'sqlite_sequence']) {
    assert.deepEqual(after.native.tables[name], before.native.tables[name], `${name} exact`);
  }
}
function assertCommittedDeletion(before, after, source, footprints = {}) {
  assertReferences(before, after);
  const identity = F.identity(source);
  assert.deepEqual(F.identityRows(after, 'health_records', identity), []);
  const guard = F.identityRows(after, 'health_deletion_guards', identity);
  assert.equal(guard.length, 1); assert.equal(guard[0].user_suppressed, '1');
  assert.equal(guard[0].source_deleted, '0'); assert.equal(guard[0].source_stream_key, null);
  assert.equal(guard[0].source_sequence, null);
  assert.deepEqual(JSON.parse(guard[0].footprint_json), footprints[F.ID] || standardFootprint);
  assert.equal(after.physical.length, 0);
  assert.deepEqual(F.rows(after, 'health_object_staging'), []);
  for (const table of ['health_records', 'health_deletion_guards']) {
    const unrelated = rows => rows.filter(row => row.source_store_id !== source.binding.sourceStoreId);
    assert.deepEqual(unrelated(F.rows(after, table)), unrelated(F.rows(before, table)));
  }
  const oldStates = derivedRows(before, 'health_source_index_state');
  const states = derivedRows(after, 'health_source_index_state');
  const previous = oldStates.find(row => row.source_store_id === source.binding.sourceStoreId);
  const current = states.find(row => row.source_store_id === source.binding.sourceStoreId);
  assert.deepEqual(current, { ...previous, state: 'queued', attempt_count: '0',
    next_attempt_at: null, error_code: null });
  assert.deepEqual(after.derived.tables.health_source_index, before.derived.tables.health_source_index);
  assert.deepEqual(after.derived.tables.health_source_index_frontiers, before.derived.tables.health_source_index_frontiers);
  assert.deepEqual(states.filter(row => row.source_store_id !== source.binding.sourceStoreId),
    oldStates.filter(row => row.source_store_id !== source.binding.sourceStoreId));
}
function dump(data, destination, beforeFilename) {
  const args = [path.join(F.product, 'scripts/dump-card-data.js')];
  if (beforeFilename) args.push('--diff', beforeFilename, destination);
  else args.push('--base', data.server.baseUrl, '--cookie', `klebb_session=${data.owner.token}`,
    '--out', destination);
  const child = spawnSync(process.execPath, args, { cwd: F.product,
    env: { ...process.env, ...F.ENV, HEALTH_HOME: data.home }, encoding: 'utf8', timeout: 20000,
    windowsHide: true });
  assert.equal(child.status, 0, 'existing operator dump/diff exits successfully');
  F.noAuthority(child.stdout + child.stderr, data);
  return child;
}
Object.assign(module.exports, { pair, expected, selected, standardFootprint, objectFootprint,
  stableFailure, stableReceipt, waitOwnedCurrent, suppress, control, exhaust,
  observations, observed, arm, witness, held, lostApply, assertReferences,
  assertCommittedDeletion, dump });
