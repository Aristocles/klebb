// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const { spawnServer, fakeAuthState } = require('./sandbox');
const { ENV: ORIGINAL_ENV } = require('./health-connect-object-test-fixture.cjs');
const { makeObject } = require('./health-connect-independent-object-fixtures.cjs');
const { coldRead, rows, identityRows, sha, registerMarkers } = require('./health-connect-sticky-admission-cold-readback.cjs');
const bank = require('../fixtures/health-connect/sticky-admission-independent-vectors.json');
const product = path.resolve(__dirname, '../..');
const BASE = '/api/connectors/health-connect';
const BATCH = `${BASE}/v1/batches`, PART = `${BASE}/v1/object-parts`;
const FINAL = `${BASE}/v1/object-finalise`;
const TYPES = ['BodyWaterMassRecord', 'CyclingPedalingCadenceRecord', 'StepsRecord'];
const TYPE = TYPES[0], ID = 'r0-shared-id';
const ORIGIN = 'https://sticky-fixture.example.test';
const ENV = { ...ORIGINAL_ENV, HEALTH_ORIGIN: ORIGIN, HEALTH_RP_ID: 'sticky-fixture.example.test',
  KLEBB_SKIP_HOME_ENV: '1', HEALTH_HOME_WARNED: '1' };
const LEGACY = { $schema: 'klebb.datafile.v1',
  meta: { id: 'synthetic-sticky-legacy', label: 'Synthetic sticky legacy' },
  data: [{ date: '2026-10-20', kg: 35.5, note: 'preserve sticky admission sentinel' }] };
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
// Dedicated nonpooled synthetic transport: one attempt, same bounded deadline.
function request(data, route, { method = 'GET', body, headers = {}, browser = false } = {}) {
  const bytes = body === undefined ? null : Buffer.isBuffer(body) ? body :
    Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
  const agent = new http.Agent({ keepAlive: false });
  return new Promise((resolve, reject) => {
    const outgoing = http.request(data.server.baseUrl + route, {
      method, agent, headers: { ...headers,
        ...(browser ? { Cookie: data.owner.cookie, Origin: ORIGIN } : {}),
        ...(bytes ? { 'Content-Type': 'application/json', 'Content-Length': bytes.length } : {}) },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        try {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: response.statusCode, body: text, json: JSON.parse(text) });
        } catch (error) { reject(error); }
        finally { agent.destroy(); }
      });
    });
    outgoing.on('error', error => { agent.destroy(); reject(error); });
    outgoing.setTimeout(10000, () => outgoing.destroy(new Error('bounded synthetic request timeout')));
    outgoing.end(bytes);
  });
}
function noAuthority(text, data) {
  for (const marker of data.markers) {
    assert.equal(typeof marker, 'string'); assert.ok(marker.length > 20);
    assert.equal(text.includes(marker), false, 'issued authority must not enter response/log/native state');
  }
}
function watch(data) {
  for (const stream of [data.server.proc.stdout, data.server.proc.stderr]) {
    stream.on('data', bytes => { data.logs += bytes.toString('utf8'); });
  }
}
function binding(source, type = TYPE) {
  return { ...source.binding, generation: source.paired.streams[type].generation };
}
function headers(source, type = TYPE) {
  return { Authorization: `Bearer ${source.paired.credential}`,
    'Klebb-Health-Protocol': '1', 'Klebb-Health-Generation': binding(source, type).generation,
    'Klebb-Health-Restore-Epoch': source.binding.restoreEpoch };
}
async function pair(data, name) {
  const grant = await request(data, `${BASE}/pairing-grants`, { method: 'POST', browser: true,
    body: { name: `Synthetic sticky ${name}`, categories: TYPES } });
  assert.equal(grant.status, 201);
  const exchanged = await request(data, `${BASE}/v1/pairing/exchange`, { method: 'POST',
    body: { version: 1, kind: 'pairing-exchange', tenantId: grant.json.tenantId,
      instanceId: grant.json.instanceId, sourceStoreId: grant.json.sourceStoreId,
      installationId: `synthetic-sticky-${name}`, categories: TYPES, grant: grant.json.grant } });
  assert.equal(exchanged.status, 200);
  const paired = exchanged.json;
  data.markers.push(grant.json.grant, paired.credential);
  return { paired, binding: { tenantId: paired.tenantId, instanceId: paired.instanceId,
    sourceStoreId: paired.sourceStoreId, installationId: paired.installationId,
    generation: paired.streams[TYPE].generation, restoreEpoch: paired.restoreEpoch } };
}
function identity(source, type = TYPE, id = ID) {
  return { tenantId: source.binding.tenantId, sourceStoreId: source.binding.sourceStoreId,
    recordType: type, nativeRecordId: id };
}
function streamKey(source, type = TYPE) {
  const b = binding(source, type);
  return JSON.stringify([b.tenantId, b.instanceId, b.sourceStoreId,
    b.installationId, type, b.generation, b.restoreEpoch]);
}
function upsert(source, item = bank.recordInventory[0], id = ID, common = null) {
  const record = JSON.parse(item.recordJson);
  if (id !== ID) record.metadata.id = id;
  if (common) Object.assign(record, common);
  return { operation: 'upsert', identity: identity(source, item.identity[2], id),
    dataFamily: 'ordinary', projection: 'raw-only', serializerId: 'health-connect-record',
    serializerVersion: 1, record };
}
const deletion = (source, type = TYPE, id = ID) =>
  ({ operation: 'delete', identity: identity(source, type, id) });
function batch(source, sequence, changes, { type = TYPE, id = `sticky-${sequence}` } = {}) {
  const payload = { binding: binding(source, type), recordType: type,
    sequence: String(sequence), batchId: id, changes };
  const payloadJson = JSON.stringify(payload), digest = sha(Buffer.from(payloadJson));
  return { payload, wire: { version: 1, kind: 'batch', payloadJson, payloadDigest: digest },
    receipt: { version: 1, kind: 'durable-receipt', binding: payload.binding,
      recordType: type, sequence: payload.sequence, batchId: id, payloadDigest: digest } };
}
const post = (data, source, route, body, customHeaders) =>
  request(data, route, { method: 'POST', body, headers: customHeaders || headers(source,
    body.recordType || (body.kind === 'batch' ? JSON.parse(body.payloadJson).recordType : TYPE)) });
async function ack(data, source, vector) {
  const result = await post(data, source, BATCH, vector.wire);
  assert.equal(result.status, 200); assert.deepEqual(result.json, vector.receipt);
  noAuthority(result.body, data); return result;
}
async function stop(data) {
  if (data.server) { await data.server.kill(); data.server = null; }
}
async function restart(data, extraEnv = data.extraEnv) {
  await stop(data);
  data.extraEnv = { ...extraEnv };
  data.server = await spawnServer(data.home, { ...ENV, ...data.extraEnv });
  watch(data);
}
async function capabilities(data, source = data.alpha, expectedStatus = 200) {
  const response = await request(data, `${BASE}/v1/capabilities`, { headers: headers(source) });
  assert.equal(response.status, expectedStatus);
  noAuthority(response.body, data);
  return response;
}
async function control(data, input) {
  assert.equal(data.server, null, 'synthetic controls require a stopped server/publisher');
  owned(data.home);
  const child = spawn(process.execPath, [path.join(__dirname,
    'health-connect-sticky-admission-controlled-state.cjs')], {
    env: { ...process.env, ...ENV, HEALTH_HOME: data.home }, cwd: product,
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString('utf8'); });
  const result = await new Promise((resolve, reject) => {
    let expired = false;
    const timer = setTimeout(() => { expired = true; child.kill('SIGKILL'); }, 20000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (expired) reject(new Error('bounded synthetic control timeout'));
      else resolve({ code, json: JSON.parse(output) });
    });
    child.stdin.end(JSON.stringify(input));
  });
  assert.equal(result.code, 0); assert.equal(result.json.ok, true);
  return result.json.result;
}
async function mutate(data, operations, options = {}) {
  await stop(data);
  await control(data, { command: 'sql', operations, ...options });
  await restart(data);
}
function copies(data) {
  return fs.readdirSync(path.join(data.home, 'db'))
    .filter(name => /^klebb\.db\.pre-health-deletion-v2-.+\.db$/.test(name));
}
async function migrate(data) {
  await stop(data);
  const before = coldRead(data.home);
  const result = await control(data, { command: 'migrate' });
  assert.equal(result.version, 2); assert.equal(result.guardCount, 0);
  assert.equal(result.metadata.directoryDurability,
    process.platform === 'win32' ? 'windows-development' : 'posix');
  const files = copies(data); assert.equal(files.length, 1);
  const { coldReadDatabase } = require('./health-connect-guard-migration-cold-readback.cjs');
  const copy = coldReadDatabase(path.join(data.home, 'db', files[0]));
  const reunited = { ...before.native,
    schema: [...before.native.schema, ...before.derived.schema].sort((a, b) =>
      a.type < b.type ? -1 : a.type > b.type ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    tables: { ...before.native.tables, ...before.derived.tables } };
  assert.deepEqual(copy.tables, reunited.tables, 'actual safety copy preserves all typed rows');
  assert.deepEqual(copy.schema, reunited.schema, 'actual safety copy preserves complete schema');
  await restart(data); await capabilities(data);
}
async function fixture({ v2 = false, extraEnv = {} } = {}) {
  for (const item of bank.recordInventory) {
    assert.equal(Buffer.byteLength(item.recordJson), item.expectedUtf8Bytes);
    assert.equal(sha(Buffer.from(item.recordJson)), item.expectedRecordDigest);
  }
  const home = secureEmptyHome(), owner = fakeAuthState('sticky-fixture-owner');
  fs.writeFileSync(path.join(home, 'credentials', 'webauthn.json'), JSON.stringify(owner.credentials),
    { mode: 0o600 });
  fs.writeFileSync(path.join(home, 'sessions', 'webauthn.json'), JSON.stringify(owner.sessions),
    { mode: 0o600 });
  fs.writeFileSync(path.join(home, 'data', 'synthetic-sticky-legacy.json'), JSON.stringify(LEGACY),
    { mode: 0o600 });
  const data = { home, owner, server: null, markers: [owner.token], logs: '', extraEnv, original: [] };
  registerMarkers(home, data.markers);
  try {
    await restart(data);
    data.alpha = await pair(data, 'alpha'); data.beta = await pair(data, 'beta');
    for (const [index, source] of [[0, data.alpha], [1, data.beta], [2, data.alpha]]) {
      const item = bank.recordInventory[index];
      const vector = batch(source, '1', [upsert(source, item)],
        { type: item.identity[2], id: `sticky-original-${index}` });
      await ack(data, source, vector); data.original.push(vector);
    }
    await capabilities(data);
    data.initial = coldRead(home);
    assert.equal(rows(data.initial, 'health_records').length, 3);
    for (const [index, source] of [[0, data.alpha], [1, data.beta], [2, data.alpha]]) {
      const item = bank.recordInventory[index];
      const matches = identityRows(data.initial, 'health_records', identity(source, item.identity[2]));
      assert.equal(matches.length, 1); assert.equal(matches[0].record_json, item.recordJson);
    }
    assert.ok(rows(data.initial, 'cards').length > 0);
    assert.ok(rows(data.initial, 'rows').some(row => row.card_id === LEGACY.meta.id &&
      row.doc === JSON.stringify(LEGACY.data[0])));
    noAuthority(JSON.stringify(data.initial), data);
    if (v2) await migrate(data);
    return data;
  } catch (error) { await close(data); throw error; }
}
async function close(data) {
  await stop(data);
  try { noAuthority(data.logs, data); }
  finally {
    registerMarkers(data.home, []);
    owned(data.home); fs.rmSync(data.home, { recursive: true, force: true });
  }
}
function failure(response, status, code, data) {
  assert.equal(response.status, status); assert.equal(response.json.code, code);
  if (!code.startsWith('IMPORT_')) {
    assert.equal(response.json.kind, 'error'); assert.equal(response.json.retryable, status === 503);
  }
  noAuthority(response.body, data);
}
async function unchanged(data, action, { status = 409, code = 'deletion-suppressed', receipt } = {}) {
  const before = coldRead(data.home), copyBefore = copies(data);
  const response = await action();
  if (receipt) {
    assert.equal(response.status, 200); assert.deepEqual(response.json, receipt);
    noAuthority(response.body, data);
  } else failure(response, status, code, data);
  const after = coldRead(data.home);
  assert.deepEqual(after.native, before.native);
  assert.deepEqual(after.physical, before.physical);
  assert.deepEqual(copies(data), copyBefore);
  noAuthority(JSON.stringify(after), data);
  return response;
}
function object(source, options = {}) {
  const result = makeObject(binding(source, options.type || TYPE), {
    nativeRecordId: ID, sequence: '2', batchId: 'sticky-object-2',
    objectId: 'sticky-object-2', ...options,
    mutatePayload(payload) {
      if (options.type && options.type !== TYPE) {
        payload.recordType = options.type;
        payload.changes[0].identity.recordType = options.type;
      }
      if (options.mutatePayload) options.mutatePayload(payload);
    },
  });
  if (options.type && options.type !== TYPE) {
    for (const frame of [result.header, result.finalise, result.receipt,
      ...result.partFrames, ...result.partReceipts]) frame.recordType = options.type;
  }
  return result;
}
async function stage(data, source, item, indices = item.manifest.map(part => part.index)) {
  for (const index of indices) {
    const response = await post(data, source, PART, item.partFrames[index]);
    assert.equal(response.status, 200); assert.deepEqual(response.json, item.partReceipts[index]);
    noAuthority(response.body, data);
  }
}
module.exports = { fixture, close, stop, restart, capabilities, control, mutate, migrate, copies,
  request, post, ack, unchanged, failure, noAuthority, batch, upsert, deletion, identity,
  binding, headers, streamKey, object, stage, coldRead, rows, identityRows, sha,
  bank, product, ENV, BASE, BATCH, PART, FINAL, TYPE, TYPES, ID };
