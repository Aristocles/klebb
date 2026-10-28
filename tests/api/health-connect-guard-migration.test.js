// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { fixture, close, run, versionTwo, unchanged, oneVerifiedCopy, noCopy, copies,
  coldReadDatabase, bank, sha } =
  require('../helpers/health-connect-guard-migration-fixture.cjs');

test('M01 full typed migration uses existing opt-in call and preserves the WAL-native-legacy-object-index snapshot', async () => {
  const data = await fixture();
  try {
    const result = await run(data);
    assert.equal(result.code, 0);
    assert.equal(result.json?.ok, true);
    assert.equal(result.json.result.version, 2, 'existing ignored option gives actual V1-versus-V2 baseline');
    assert.equal(result.json.result.guards, true);
    assert.equal(result.json.result.guardRows, 0);
    versionTwo(data);
    const copy = oneVerifiedCopy(data);
    assert.equal(result.json.result.metadata.safetyCopy, copy.split(/[\\/]/).at(-1));
    assert.equal(result.json.result.metadata.directoryDurability,
      process.platform === 'win32' ? 'windows-development' : 'posix');
    const copyDigest = sha(fs.readFileSync(copy));
    const retry = await run(data);
    assert.equal(retry.code, 0);
    assert.deepEqual(retry.json.result, { version: 2, guards: true, guardRows: 0, metadata: null });
    versionTwo(data);
    assert.equal(oneVerifiedCopy(data), copy);
    assert.equal(sha(fs.readFileSync(copy)), copyDigest);
    for (const command of ['snapshot', 'frontiers', 'default']) {
      const accepted = await run(data, command);
      assert.equal(accepted.code, 0, 'valid V2 remains compatible with existing shared boundaries');
      versionTwo(data);
      assert.equal(sha(fs.readFileSync(copy)), copyDigest);
    }
  } finally { close(data); }
});

function refused(result) {
  assert.equal(result.code, 1);
  assert.deepEqual(result.json, { ok: false, status: 503, code: 'storage-unavailable' });
}
function ownFull(result, event) {
  const before = result.events.find(item => item.kind === 'writer-before-begin' &&
    item.writerId === event.writerId);
  assert.ok(before, 'actual migration writer observed before native BEGIN');
  assert.equal(before.writerActive, false);
  assert.equal(before.journalMode, 'wal');
  assert.equal(before.synchronous, 2);
}
function fired(result, phase) {
  const faults = result.events.filter(item => item.kind === 'fault-fired');
  assert.equal(faults.length, 1);
  assert.equal(faults[0].phase, phase);
  ownFull(result, faults[0]);
  return faults[0];
}
function mutate(data, sql) {
  const db = new DatabaseSync(data.database);
  try { db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE'); db.exec(sql); db.exec('COMMIT'); }
  finally { db.close(); }
  data.before = coldReadDatabase(data.database);
}

test('M13 actual own WAL FULL reservation and copy flush rename directory order precede V2 writes', async () => {
  const data = await fixture();
  try {
    const result = await run(data, 'migrate', { fault: 'observe' });
    assert.equal(result.code, 0);
    versionTwo(data); oneVerifiedCopy(data);
    const at = kind => result.events.findIndex(item => item.kind === kind);
    const begin = at('writer-begin-complete'), vacuum = at('native-vacuum-success');
    const file = at('copy-file-fsync-success'), rename = at('copy-rename-success');
    const guard = at('guard-create-success'), marker = at('v2-marker-insert-success');
    const commit = at('writer-native-commit-success');
    assert.ok(begin >= 0 && vacuum > begin && file > vacuum && rename > file &&
      guard > rename && marker > guard && commit > marker);
    const reservation = result.events.find(item => item.kind === 'reservation-native-busy');
    assert.equal(reservation?.sqliteResult, 5, 'a competing real writer is refused during copy');
    assert.equal(reservation.writerActive, true);
    for (const item of result.events.filter(item =>
      ['native-vacuum-before', 'native-vacuum-success', 'copy-file-fsync-success',
        'copy-rename-success', 'guard-create-success', 'v2-marker-insert-success'].includes(item.kind))) {
      assert.equal(item.writerActive, true);
      ownFull(result, item);
    }
    const readers = result.events.filter(item => item.kind === 'copy-reader-open');
    assert.ok(readers.length > 0);
    assert.ok(readers.every(item => item.readOnly === true));
    if (process.platform === 'win32') {
      assert.equal(at('copy-directory-fsync-success'), -1);
      assert.equal(result.json.result.metadata.directoryDurability, 'windows-development');
    } else {
      assert.ok(at('copy-directory-fsync-success') > rename &&
        at('copy-directory-fsync-success') < guard);
      assert.equal(result.json.result.metadata.directoryDurability, 'posix');
    }
  } finally { close(data); }
});

for (const [operation, phase, sqliteResult, published] of [
  ['sqlite-full', 'before-native-guard-create', 13, true],
  ['sqlite-busy', 'before-original-native-begin', 5, false],
  ['vacuum-refusal', 'before-native-vacuum-occupied-output', 1, false],
  ['late-marker-refusal', 'before-native-v2-marker-insert-after-successful-guard-ddl', 1811, true],
]) {
  test(`M07 M10 actual migration ${operation} refuses with complete V1 rollback`, async () => {
    const data = await fixture();
    try {
      const result = await run(data, 'migrate', { fault: operation });
      refused(result);
      const fault = fired(result, phase);
      assert.ok(result.events.some(item => item.kind === 'sqlite-native-error' &&
        item.sqliteResult === sqliteResult), 'fixed actual SQLite result, not an invented status');
      if (operation === 'sqlite-full') assert.equal(fault.freePages, 0);
      if (operation === 'late-marker-refusal') {
        assert.equal(fault.guardCreated, true);
        const earlier = result.events.find(item => item.kind === 'guard-create-success');
        assert.equal(earlier.writerId, fault.writerId);
        assert.equal(earlier.writerActive, true);
        assert.ok(result.events.indexOf(earlier) < result.events.indexOf(fault));
      }
      unchanged(data);
      if (published) oneVerifiedCopy(data); else noCopy(data);
    } finally { close(data); }
  });
}

for (const operation of ['copy-corrupt', 'copy-row-change', 'copy-blob-change',
  'copy-int64-change', 'copy-sequence-change']) {
  test(`M08 ${operation} fails real integrity or typed row verification without source effects`, async () => {
    const data = await fixture();
    try {
      const result = await run(data, 'migrate', { fault: operation });
      refused(result);
      const fault = fired(result, 'after-successful-native-vacuum-before-real-copy-verification');
      assert.equal(fault.writerActive, true);
      assert.equal(fault.guardCreated, false);
      assert.ok(result.events.some(item => item.kind === 'native-vacuum-success'));
      unchanged(data); noCopy(data);
    } finally { close(data); }
  });
}

for (const [operation, phase] of [
  ['file-fsync-eio', 'at-copy-file-fsync-before-rename'],
  ['rename-eio', 'at-copy-rename-after-file-fsync'],
]) {
  test(`M09 actual copy ${operation} keeps complete V1 and no final safety name`, async () => {
    const data = await fixture();
    try {
      const result = await run(data, 'migrate', { fault: operation });
      refused(result); fired(result, phase);
      assert.equal(result.events.some(item => item.kind === 'guard-create-success'), false);
      if (operation === 'rename-eio') assert.ok(result.events.some(item => item.kind === 'copy-file-fsync-success'));
      unchanged(data); noCopy(data);
    } finally { close(data); }
  });
}

test('M09 POSIX directory EIO after actual copy rename refuses before V2 effects', {
  skip: process.platform === 'win32' ? 'Node Windows directory descriptors do not establish POSIX durability' : false,
}, async () => {
  const data = await fixture();
  try {
    const result = await run(data, 'migrate', { fault: 'directory-fsync-eio' });
    refused(result);
    const fault = fired(result, 'at-posix-parent-fsync-after-copy-rename');
    assert.equal(fault.renamed, true);
    assert.equal(fault.writerActive, true);
    assert.equal(fault.guardCreated, false);
    assert.ok(result.events.some(item => item.kind === 'copy-file-fsync-success'));
    assert.ok(result.events.some(item => item.kind === 'copy-rename-success'));
    unchanged(data); oneVerifiedCopy(data);
  } finally { close(data); }
});

for (const [operation, phase, version] of [
  ['before-commit-kill', 'immediately-before-original-native-commit', 1],
  ['after-commit-kill', 'immediately-after-original-native-commit', 2],
]) {
  test(`M11 M12 ${operation} proves actual cold atomic state before retry`, async () => {
    const data = await fixture();
    try {
      const result = await run(data, 'migrate', { fault: operation });
      if (process.platform === 'win32') assert.deepEqual({ code: result.code, signal: result.signal },
        { code: 1, signal: null });
      else assert.deepEqual({ code: result.code, signal: result.signal }, { code: null, signal: 'SIGKILL' });
      const fault = fired(result, phase);
      assert.ok(fault.guardCreated && fault.markerInserted && fault.renamed && fault.writerActive);
      oneVerifiedCopy(data);
      if (version === 1) unchanged(data); else versionTwo(data);
      if (version === 2) {
        const coldBeforeRetry = coldReadDatabase(data.database);
        const copy = copies(data)[0], digest = sha(fs.readFileSync(copy));
        const retry = await run(data);
        assert.equal(retry.code, 0);
        assert.equal(retry.json.result.metadata, null);
        assert.deepEqual(coldReadDatabase(data.database), coldBeforeRetry);
        assert.equal(copies(data).length, 1);
        assert.equal(sha(fs.readFileSync(copy)), digest);
      }
    } finally { close(data); }
  });
}

test('M03 CLI dry run is read only and apply is bounded idempotent explicit migration', async () => {
  const data = await fixture();
  try {
    const dry = await run(data, null, { cliArgs: ['--dry-run'], fault: 'observe' });
    assert.equal(dry.code, 0);
    assert.deepEqual(dry.json, { version: 1, migrated: false, safetyCopy: null, directoryDurability: null });
    const sourceReaders = dry.events.filter(item => item.kind === 'source-reader-open');
    assert.ok(sourceReaders.length > 0, 'dry run observes an actual source reader');
    assert.ok(sourceReaders.every(item => item.readOnly === true));
    for (const kind of ['original-writer-open', 'writer-before-begin', 'writer-begin-complete',
      'native-vacuum-before', 'copy-file-fsync-success', 'copy-rename-success',
      'copy-directory-fsync-success', 'guard-create-success', 'v2-marker-insert-success']) {
      assert.equal(dry.events.some(item => item.kind === kind), false,
        `read-only dry run cannot perform ${kind}`);
    }
    unchanged(data); noCopy(data);
    const args = ['--apply', ...(process.platform === 'win32' ? ['--windows-development'] : [])];
    const applied = await run(data, null, { cliArgs: args });
    assert.equal(applied.code, 0);
    const copy = oneVerifiedCopy(data);
    assert.deepEqual(applied.json, { version: 2, migrated: true, safetyCopy: path.basename(copy),
      directoryDurability: process.platform === 'win32' ? 'windows-development' : 'posix' });
    versionTwo(data);
    const retry = await run(data, null, { cliArgs: args });
    assert.equal(retry.code, 0);
    assert.deepEqual(retry.json, { version: 2, migrated: false, safetyCopy: null, directoryDurability: null });
    versionTwo(data); assert.equal(oneVerifiedCopy(data), copy);
    for (const output of [dry.stdout, dry.stderr, applied.stdout, applied.stderr, retry.stdout, retry.stderr]) {
      assert.equal(output.includes('37.250000000000000001'), false);
      assert.equal(output.includes('preserve fixed synthetic migration sentinel'), false);
      assert.equal(output.includes(data.database), false);
    }
  } finally { close(data); }
});

test('M14 Windows needs explicit development opt in and POSIX cannot select a directory bypass', async () => {
  const data = await fixture();
  try {
    if (process.platform === 'win32') {
      const noFlag = await run(data, 'migrate', { windowsDevelopment: false });
      refused(noFlag); unchanged(data); noCopy(data);
      const cliNoFlag = await run(data, null, { cliArgs: ['--apply'] });
      assert.equal(cliNoFlag.code, 1);
      unchanged(data); noCopy(data);
    } else {
      const bypass = await run(data, null, { cliArgs: ['--apply', '--windows-development'] });
      assert.notEqual(bypass.code, 0);
      unchanged(data); noCopy(data);
    }
  } finally { close(data); }
});

test('M15 occupied exclusive snapshot destination is preserved without overwrite or source effects', async () => {
  const data = await fixture();
  try {
    const result = await run(data, 'migrate', { fault: 'occupied-destination' });
    refused(result);
    const fault = fired(result, 'before-exclusive-temp-open-existing-destination');
    assert.equal(fault.guardCreated, false);
    assert.equal(fs.readFileSync(path.join(path.dirname(data.database), fault.occupiedBasename), 'utf8'),
      'pre-existing independently occupied copy destination');
    unchanged(data); noCopy(data);
  } finally { close(data); }
});

test('M15 POSIX symbolic-link source is refused without touching its original target', {
  skip: process.platform === 'win32' ? 'Windows synthetic symlink creation needs separate host privilege' : false,
}, async () => {
  const data = await fixture({ wal: false });
  try {
    const original = path.join(path.dirname(data.database), 'original-physical.db');
    fs.renameSync(data.database, original);
    fs.symlinkSync(original, data.database);
    const result = await run(data);
    refused(result);
    assert.equal(fs.lstatSync(data.database).isSymbolicLink(), true);
    assert.deepEqual(coldReadDatabase(original), data.before);
    noCopy(data);
  } finally { close(data); }
});

for (const [name, corrupt] of [
  ['missing-base-table', 'DROP TABLE health_tombstones'],
  ['mixed-v1-guard', `${bank.guardV2Ddl};`],
  ['unknown-marker', 'DROP TABLE health_schema_version; CREATE TABLE health_schema_version (version INTEGER); INSERT INTO health_schema_version VALUES (3)'],
  ['duplicate-marker', 'DROP TABLE health_schema_version; CREATE TABLE health_schema_version (version INTEGER); INSERT INTO health_schema_version VALUES (1),(1)'],
  ['partial-objects', 'DROP TABLE health_object_parts'],
  ['partial-derived', 'DROP TABLE health_source_index_frontiers'],
  ['missing-receipt-index', 'DROP INDEX health_receipt_sequence_order'],
  ['changed-receipt-index', 'DROP INDEX health_receipt_sequence_order; CREATE INDEX health_receipt_sequence_order ON health_batch_receipts (sequence)'],
  ['missing-object-expiry-index', 'DROP INDEX health_object_expiry'],
  ['changed-object-expiry-index', 'DROP INDEX health_object_expiry; CREATE INDEX health_object_expiry ON health_object_staging (created_at)'],
]) {
  test(`M04 M15 explicit migration refuses ${name} without native repair or copy`, async () => {
    const data = await fixture();
    try {
      mutate(data, corrupt);
      const result = await run(data);
      refused(result); unchanged(data); noCopy(data);
      const dry = await run(data, null, { cliArgs: ['--dry-run'] });
      assert.equal(dry.code, 1);
      unchanged(data); noCopy(data);
    } finally { close(data); }
  });
}

test('M04 native absent and missing database refuse explicit migration instead of initialising empty history', async () => {
  const data = await fixture({ emptyNative: true });
  try {
    const result = await run(data);
    refused(result); unchanged(data); noCopy(data);
    fs.unlinkSync(data.database);
    const missing = await run(data);
    refused(missing);
    assert.equal(fs.existsSync(data.database), false);
    noCopy(data);
  } finally { close(data); }
});

for (const [name, corruption] of [
  ['partial-object-tables', 'DROP TABLE health_object_parts'],
  ['changed-object-table', 'ALTER TABLE health_object_staging ADD COLUMN unwanted TEXT'],
  ['partial-derived-tables', 'DROP TABLE health_source_index_frontiers'],
  ['changed-derived-table', 'ALTER TABLE health_source_index_state ADD COLUMN unwanted TEXT'],
  ['missing-native-receipt-index', 'DROP INDEX health_receipt_sequence_order'],
  ['missing-object-expiry-index', 'DROP INDEX health_object_expiry'],
]) {
  test(`M04 M05 exact V2 migration and dry run refuse ${name} before any new copy or repair`, async () => {
    const data = await fixture();
    try {
      assert.equal((await run(data)).code, 0);
      versionTwo(data); oneVerifiedCopy(data);
      const previousCopies = copies(data).map(file => [file, sha(fs.readFileSync(file))]);
      mutate(data, corruption);
      const migration = await run(data);
      refused(migration); unchanged(data);
      assert.deepEqual(copies(data).map(file => [file, sha(fs.readFileSync(file))]), previousCopies);
      const dry = await run(data, null, { cliArgs: ['--dry-run'] });
      assert.equal(dry.code, 1);
      unchanged(data);
      assert.deepEqual(copies(data).map(file => [file, sha(fs.readFileSync(file))]), previousCopies);
    } finally { close(data); }
  });
}

test('M15 invalid duplicate and conflicting CLI modes cannot touch V1 native storage', async () => {
  const data = await fixture();
  try {
    for (const args of [[], ['--unknown'], ['--apply', '--apply'],
      ['--apply', '--dry-run'], ['--dry-run', '--dry-run'], ['--windows-development']]) {
      const result = await run(data, null, { cliArgs: args });
      assert.notEqual(result.code, 0);
      unchanged(data); noCopy(data);
    }
  } finally { close(data); }
});

for (const [name, corruption] of [
  ['missing-v2-guard', 'DROP TABLE health_deletion_guards'],
  ['changed-v2-guard', 'DROP TABLE health_deletion_guards; CREATE TABLE health_deletion_guards (wrong TEXT)'],
]) {
  test(`M05 all shared native boundaries refuse ${name} without repair`, async () => {
    const data = await fixture();
    try {
      const migration = await run(data);
      assert.equal(migration.code, 0);
      versionTwo(data); oneVerifiedCopy(data);
      const previousCopies = copies(data).map(file => [file, sha(fs.readFileSync(file))]);
      mutate(data, corruption);
      for (const command of ['snapshot', 'frontiers', 'default', 'object-default', 'index-default', 'migrate']) {
        const response = await run(data, command);
        refused(response);
        unchanged(data);
        assert.deepEqual(copies(data).map(file => [file, sha(fs.readFileSync(file))]), previousCopies);
      }
    } finally { close(data); }
  });
}

test('M16 exact guard storage constraints retain typed identity and UTF8 byte boundary without suppression claims', async () => {
  const data = await fixture();
  try {
    assert.equal((await run(data)).code, 0);
    versionTwo(data); oneVerifiedCopy(data);
    const db = new DatabaseSync(data.database);
    try {
      const insert = db.prepare('INSERT INTO health_deletion_guards '
        + '(tenant_id,source_store_id,record_type,native_record_id,source_deleted,user_suppressed,'
        + 'source_stream_key,source_sequence,footprint_json) VALUES (?,?,?,?,?,?,?,?,?)');
      const scope = ['11111111-1111-4111-8111-111111111111',
        '33333333-3333-4333-8333-333333333333', 'BodyWaterMassRecord'];
      const invalid = [
        [0, 0, null, null, null], [2, 0, 'source', '1', null],
        [0, -1, null, null, null], [1, 0, null, '1', null],
        [1, 0, 'source', null, null], [0, 1, 'source', '1', null],
        [0, 1, null, null, '[]'], [0, 1, null, null, 'not-json'],
      ];
      for (const [ordinal, values] of invalid.entries()) {
        assert.throws(() => insert.run(...scope, `invalid-${ordinal}`, ...values));
        assert.equal(db.prepare('SELECT count(*) AS n FROM health_deletion_guards').get().n, 0);
      }
      const exact = '{"x":"' + '\u03a9'.repeat(1020) + '"}';
      const oversized = '{"x":"' + '\u03a9'.repeat(1020) + 'X"}';
      assert.equal(Buffer.byteLength(exact), 2048);
      assert.equal(Buffer.byteLength(oversized), 2049);
      assert.throws(() => insert.run(...scope, 'oversized', 0, 1, null, null, oversized));
      insert.run(...scope, 'same-id', 0, 1, null, null, exact);
      assert.throws(() => insert.run(...scope, 'same-id', 0, 1, null, null, null));
      insert.run(scope[0], scope[1], 'StepsRecord', 'same-id', 0, 1, null, null, null);
      insert.run(scope[0], '55555555-5555-4555-8555-555555555555', scope[2],
        'same-id', 0, 1, null, null, null);
      const provenance = JSON.stringify([scope[0], '22222222-2222-4222-8222-222222222222',
        scope[1], 'synthetic-durable-installation', scope[2], '1',
        '44444444-4444-4444-8444-444444444444']);
      insert.run(...scope, 'source-only', 1, 0, provenance, '1', null);
      insert.run(...scope, 'both-flags', 1, 1, provenance, '1', '{"kind":"unknown-control"}');
      assert.equal(db.prepare('SELECT count(*) AS n FROM health_deletion_guards').get().n, 5);
      assert.equal(db.prepare("SELECT count(*) AS n FROM health_deletion_guards WHERE footprint_json IS NULL").get().n, 3);
      // Direct SQL controls only: no public API, native event or admission was claimed.
    } finally { db.close(); }
  } finally { close(data); }
});

test('M06 default initialised V1 transaction does not activate guards or make a migration copy', async () => {
  const data = await fixture();
  try {
    const result = await run(data, 'default');
    assert.equal(result.code, 0);
    assert.deepEqual(result.json.result, { version: 1, guards: false, guardRows: null, metadata: null });
    unchanged(data);
    noCopy(data);
  } finally { close(data); }
});

test('M06 fresh default transaction retains V1 creation and existing nonempty legacy rows', async () => {
  const data = await fixture({ emptyNative: true });
  try {
    const legacy = structuredClone(data.before.tables.untouched_legacy);
    const result = await run(data, 'default');
    assert.equal(result.code, 0);
    assert.deepEqual(result.json.result, { version: 1, guards: false, guardRows: null, metadata: null });
    const cold = coldReadDatabase(data.database);
    assert.deepEqual(cold.tables.untouched_legacy, legacy);
    assert.deepEqual(cold.tables.health_schema_version,
      [{ version: { type: 'integer', decimal: '1' } }]);
    assert.equal(cold.tables.health_deletion_guards, undefined);
    for (const table of ['health_records', 'health_tombstones', 'health_batch_receipts',
      'health_streams', 'health_projection_outbox']) assert.deepEqual(cold.tables[table], []);
    noCopy(data);
  } finally { close(data); }
});
