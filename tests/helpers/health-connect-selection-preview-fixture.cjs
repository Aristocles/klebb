// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { setTimeout: delay } = require('node:timers/promises');
const O = require('./health-connect-owner-deletion-fixture.cjs');
const E = require('./health-connect-selection-preview-independent.cjs');
const { fakeAuthState } = require('./sandbox');
const { F, I } = O;
const ROUTE = `${F.BASE}/deletions/selection-preview`;
const preload = path.join(__dirname, 'health-connect-selection-preview-preload.cjs');
const fixedClock = require('../fixtures/health-connect/fixed-child-clock-inputs-v1.json');
const identities = (...values) => values.map(value => Array.isArray(value) ? value : [F.TYPE, value]);
const period = values => values === null ? null : { startTime: values[0], endTime: values[1] };
function body(sources, types = null, window = null, cutoff = E.bank.cutoff) {
  return { sourceStoreIds: sources === null ? null : sources.map(source => source.binding.sourceStoreId),
    recordTypes: types, period: period(window), cutoff };
}
async function fixture({ v2 = true, healthyClock = fixedClock.base } = {}) {
  assert.ok(healthyClock === fixedClock.base || healthyClock === fixedClock.advanced);
  const observer = fs.mkdtempSync(path.join(os.tmpdir(), 'eh-selection-observer-'));
  let data;
  try {
    fs.writeFileSync(path.join(observer, 'clock'), healthyClock.instant, { flag: 'wx', mode: 0o600 });
    data = await O.fixture({ v2, expectedPublishedAt: healthyClock.milliseconds, extraEnv: { NODE_OPTIONS: `--require=${JSON.stringify(preload)}`,
      SELECTION_PREVIEW_OBSERVATIONS: observer } });
    fs.unlinkSync(path.join(observer, 'clock')); // Restore real child clock before return and existing S11 inputs.
    data.observer = observer;
    assert.deepEqual(events(data).filter(event => event.kind.includes('worker-stop')), [],
      'initial actual worker has not been suppressed');
    return data;
  } catch (error) {
    const failures = [error];
    if (data) {
      try { await F.close(data); } catch (cleanupError) { failures.push(cleanupError); }
    }
    try { removeObserver(observer); } catch (cleanupError) { failures.push(cleanupError); }
    if (failures.length > 1) {
      throw new AggregateError(failures, 'selection fixture setup and cleanup failed', { cause: error });
    }
    throw error;
  }
}
function removeObserver(directory) {
  const resolved = fs.realpathSync(directory);
  assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('eh-selection-observer-'));
  assert.equal(fs.lstatSync(directory).isSymbolicLink(), false);
  fs.rmSync(resolved, { recursive: true });
}
async function close(data) {
  try { await F.close(data); } finally { removeObserver(data.observer); }
}
function files(home) {
  const result = [];
  function visit(directory, prefix = '') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => I.ordinal(a.name, b.name))) {
      const name = prefix + entry.name, filename = path.join(directory, entry.name);
      assert.equal(fs.lstatSync(filename).isSymbolicLink(), false, 'owned inventory has no symlink');
      if (entry.isDirectory()) { result.push([name, 'directory']); visit(filename, name + '/'); }
      else {
        assert.ok(entry.isFile(), 'owned inventory uses only files/directories');
        // SQLite physical sidecars can change on ordinary read/open. Complete
        // logical schema/control/all-table/actual BLOB state is compared separately.
        const physical = /^db\/[^/]+\.db(?:-wal|-shm)?$/.test(name);
        result.push(physical ? [name, 'sqlite-physical-file'] :
          [name, 'file', fs.statSync(filename).size, I.sha(fs.readFileSync(filename))]);
      }
    }
  }
  visit(home); return result;
}
function snapshot(data) {
  return { sql: F.coldRead(data.home), files: files(data.home) };
}
function session(data) {
  const raw = fs.readFileSync(path.join(data.home, 'sessions', 'webauthn.json'));
  let parsed;
  try { parsed = JSON.parse(raw.toString('utf8')); }
  catch { assert.fail('owned session payload must be valid JSON without disclosing bytes'); }
  return { raw, bytes: raw.length, digest: I.sha(raw), parsed };
}
function selectedClock(data) {
  const filename = path.join(data.observer, 'clock');
  if (!fs.existsSync(filename)) return null;
  assert.equal(fs.lstatSync(filename).isSymbolicLink(), false);
  const text = fs.readFileSync(filename, 'utf8');
  assert.ok([E.inputs.fixedClock.initialAfterHealthySetup, E.inputs.fixedClock.later].includes(text));
  const milliseconds = Date.parse(text);
  assert.ok(Number.isSafeInteger(milliseconds)); return { text, milliseconds };
}
function assertSessionMaintenance(data, before, after, interval) {
  const token = data.owner.token;
  assert.ok(token === interval.token, 'current issued browser identity stays exact');
  const changed = !before.raw.equals(after.raw);
  if (changed) {
    const prior = before.parsed[token], current = after.parsed[token], issued = data.owner.sessions[token];
    assert.ok(prior && current && issued, 'maintenance cannot add or revive an absent issued session');
    assert.ok(Object.hasOwn(prior, 'lastSeen') && Object.hasOwn(current, 'lastSeen'));
    assert.ok(Number.isSafeInteger(prior.lastSeen) && Number.isSafeInteger(current.lastSeen));
    const withoutStamp = value => ({ ...value, lastSeen: 'permitted-current-auth-maintenance' });
    assert.ok(isDeepStrictEqual(withoutStamp(prior), withoutStamp(issued)),
      'before session retains every originally issued authority field');
    const normalizedBefore = structuredClone(before.parsed), normalizedAfter = structuredClone(after.parsed);
    normalizedBefore[token].lastSeen = normalizedAfter[token].lastSeen = 'permitted-current-auth-maintenance';
    assert.ok(isDeepStrictEqual(normalizedAfter, normalizedBefore),
      'only this issued session lastSeen may change; no authority payload is printed');
    if (current.lastSeen !== prior.lastSeen) {
      assert.ok(interval.clock === null ?
        current.lastSeen >= interval.started && current.lastSeen <= interval.finished :
        current.lastSeen === interval.clock.milliseconds, 'actual authentication stamp matches the exact request clock');
    }
    const serialized = structuredClone(before.parsed);
    serialized[token].lastSeen = current.lastSeen;
    assert.ok(after.raw.equals(Buffer.from(JSON.stringify(serialized, null, 2))),
      'all changed bytes must follow the existing exact auth saveSessions serialization');
  }
  // Private in-memory witnesses retain raw payloads and times; never print or archive credentials.
  (data.selectionAuthWitnesses ??= []).push({ before, after, interval, changed });
  return changed;
}
async function checked(data, request, validate) {
  const before = snapshot(data), beforeSession = session(data), clock = selectedClock(data);
  const interval = { token: data.owner.token, clock, started: Date.now(), finished: null };
  let response, primaryFailure, effectFailure;
  try {
    response = await request();
  } catch (error) { primaryFailure = error; }
  interval.finished = Date.now();
  try {
    if (!primaryFailure) { O.payloadFree(response, data); validate(response, before.sql); }
  } catch (error) { primaryFailure = error; }
  try {
    assert.ok(isDeepStrictEqual(selectedClock(data), clock), 'selected child clock remains exact through settlement');
    const after = snapshot(data), afterSession = session(data);
    assert.deepEqual(after.sql, before.sql, 'every preview has complete cold SQL/schema/control/BLOB zero effects');
    const changed = assertSessionMaintenance(data, beforeSession, afterSession, interval);
    const row = value => value.files.find(item => item[0] === 'sessions/webauthn.json');
    assert.deepEqual(row(before), ['sessions/webauthn.json', 'file', beforeSession.bytes, beforeSession.digest]);
    assert.deepEqual(row(after), ['sessions/webauthn.json', 'file', afterSession.bytes, afterSession.digest]);
    const afterFiles = changed ? after.files.map(item =>
      item[0] === 'sessions/webauthn.json' ? [...row(before)] : item) : after.files;
    assert.deepEqual(afterFiles, before.files, 'all file paths/kinds and every other payload remain exact');
    F.noAuthority(data.logs, data);
  } catch (error) { effectFailure = error; }
  if (primaryFailure && effectFailure) throw new AggregateError([primaryFailure, effectFailure],
    'original request/status failure and independent zero-effects failure are both retained');
  if (primaryFailure) throw primaryFailure;
  if (effectFailure) throw effectFailure;
  return response;
}
async function success(data, requested, membership, { effectiveCutoff } = {}) {
  return checked(data, () => F.request(data, ROUTE, { method: 'POST', browser: true, body: requested }),
    (response, cold) => {
      assert.equal(response.status, 200, 'meaningful new real route must return exact readonly preview');
      const expected = E.expected(data, { ...requested, cutoff: effectiveCutoff ?? requested.cutoff }, membership, cold, F, O);
      assert.deepEqual(response.json, expected);
      assert.equal(response.body, JSON.stringify(expected));
    });
}
async function refuse(data, requested, status, code, options = {}, action) {
  return checked(data, action || (() => F.request(data, ROUTE,
    { method: 'POST', browser: true, body: requested, ...options })),
  response => F.failure(response, status, code, data));
}
function events(data) {
  return fs.readdirSync(data.observer).filter(name => name.endsWith('.json')).sort(I.ordinal)
    .map(name => JSON.parse(fs.readFileSync(path.join(data.observer, name), 'utf8')));
}
async function witnessAfter(data, kind, previous) {
  const deadline = Date.now() + 10000;
  do {
    const found = events(data).filter(event => event.kind === kind);
    if (found.length > previous) {
      const active = found.filter(event => event.pid === data.server.proc.pid)
        .sort((a, b) => a.eventSequence - b.eventSequence).at(-1);
      assert.ok(active, 'closed witness belongs to the current owned server PID'); return active;
    }
    await delay(25);
  } while (Date.now() < deadline);
  assert.fail('bounded actual selected fixture witness not observed');
}
async function restartControlled(data) {
  const name = path.join(data.observer, 'pause-startup');
  if (!fs.existsSync(name)) fs.writeFileSync(name, 'controlled-restart-only', { flag: 'wx', mode: 0o600 });
  const kind = 'actual-worker-stop-returned-before-startup-suppression';
  const previous = events(data).filter(event => event.kind === kind).length;
  await F.restart(data);
  const observed = await witnessAfter(data, kind, previous);
  assert.equal(observed.canonicalSourceSha256, '11531734f6a9da4deb227a86eb2bb80299b553a3e960f8bfb776c9b1f63e13d8');
}
async function sql(data, operations) {
  await F.stop(data); await F.control(data, { command: 'sql', operations });
  await restartControlled(data);
}
const rawUpdate = (source, type, id, recordJson) => ({ sql: 'UPDATE health_records SET record_json=? '
  + 'WHERE tenant_id=? AND source_store_id=? AND record_type=? AND native_record_id=?',
params: [recordJson, source.binding.tenantId, source.binding.sourceStoreId, type, id] });
async function ackVariant(data, source, name, sequence, expectedRecords, expectedTombs = 0) {
  const item = E.inputs.variants[name];
  const change = F.upsert(source, { recordJson: item.recordJson, identity: [null, null, item.recordType] }, item.nativeRecordId);
  await F.ack(data, source, F.batch(source, String(sequence), [change],
    { type: item.recordType, id: `selection-${name}-${sequence}` }));
  await O.waitOwnedCurrent(data, source, expectedRecords, expectedTombs);
  const saved = F.identityRows(F.coldRead(data.home), 'health_records',
    F.identity(source, item.recordType, item.nativeRecordId));
  assert.equal(saved.length, 1); assert.equal(saved[0].record_json, item.recordJson);
}
function variantFootprint(name) {
  const item = E.inputs.variants[name], raw = JSON.parse(item.recordJson);
  if (raw.time === undefined && raw.startTime === undefined) return null;
  return raw.time !== undefined ? { kind: 'instant', time: raw.time, zoneOffset: raw.zoneOffset } :
    { kind: 'interval', startTime: raw.startTime, endTime: raw.endTime,
      startZoneOffset: raw.startZoneOffset, endZoneOffset: raw.endZoneOffset };
}
async function capacity(data, count, { splitWindow = false } = {}) {
  const source = data.alpha, values = [];
  for (let index = 0; index < count; index++) {
    const raw = JSON.parse(E.bank.originalRecordsVerbatim[0].recordJson);
    const id = `selection-bound-${String(index).padStart(4, '0')}`;
    raw.metadata.id = id;
    if (splitWindow && index >= 100) raw.time = '2026-01-01T00:00:00Z';
    values.push([source.binding.tenantId, source.binding.sourceStoreId, F.TYPE, id,
      'health-connect-record', 1, 'ordinary', 'raw-only', JSON.stringify(raw)]);
  }
  await sql(data, [{ sql: 'DELETE FROM health_records WHERE tenant_id=? AND source_store_id=?',
    params: [source.binding.tenantId, source.binding.sourceStoreId] },
  { sql: 'INSERT INTO health_records VALUES (?,?,?,?,?,?,?,?,?)', repeat: values }]);
  const cold = F.coldRead(data.home);
  assert.equal(F.rows(cold, 'health_records').filter(row => row.source_store_id === source.binding.sourceStoreId).length, count);
  assert.equal(F.rows(cold, 'health_batch_receipts').length, 3, 'original real ACK controls retained');
  return values.map(value => [F.TYPE, value[3]]);
}
async function otherOwner(data) {
  const other = fakeAuthState('selection-other-owner');
  await F.stop(data);
  const credentialFile = path.join(data.home, 'credentials', 'webauthn.json');
  const sessionFile = path.join(data.home, 'sessions', 'webauthn.json');
  const credentials = JSON.parse(fs.readFileSync(credentialFile, 'utf8'));
  credentials.users = { ...credentials.users, ...other.credentials.users };
  fs.writeFileSync(credentialFile, JSON.stringify(credentials), { mode: 0o600 });
  fs.writeFileSync(sessionFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(sessionFile, 'utf8')),
    ...other.sessions }), { mode: 0o600 });
  data.markers.push(other.token);
  await F.restart(data);
  const owner = data.owner;
  try { data.owner = other; return await O.pair(data, 'selection-foreign', F.TYPES); }
  finally { data.owner = owner; }
}
function clock(data, value) {
  assert.ok([E.inputs.fixedClock.initialAfterHealthySetup, E.inputs.fixedClock.later].includes(value));
  const target = path.join(data.observer, 'clock'), temporary = target + `.${process.pid}.tmp`;
  fs.writeFileSync(temporary, value, { flag: 'wx', mode: 0o600 });
  fs.renameSync(temporary, target);
}
module.exports = { O, F, I, E, ROUTE, identities, period, body, fixture, close, snapshot,
  success, refuse, events, witnessAfter, restartControlled, sql, rawUpdate, ackVariant,
  variantFootprint, capacity, otherOwner, clock };
