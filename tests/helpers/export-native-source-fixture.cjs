// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const F = require('./import-native-freshness-fixture.cjs');
const H = require('./import-wizard-harness');
const WEIGHT_ROWS = [{ date: '2026-06-01', kg: 81.2 }, { date: '2026-06-02', kg: 80.9 },
  { date: '2026-06-03', kg: 80.4 }]; // Existing independently fixed API roundtrip literals.
const unsupported = 'native-history-export-unsupported';
const unavailable = 'native-history-source-unavailable';
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const quote = name => '"' + name.replaceAll('"', '""') + '"';
const table = (sql, name) => sql.tables.find(t => t.name === name);
function env(f) {
  const next = { ...process.env };
  for (const key of Object.keys(next)) if (key.startsWith('HEALTH_')) delete next[key];
  return { ...next, HEALTH_HOME: f.home, HEALTH_HOME_WARNED: '1', KLEBB_SKIP_HOME_ENV: '1', ...f.overrides };
}
async function withEnv(f, fn) {
  const old = { ...process.env };
  for (const k of Object.keys(process.env)) if (k.startsWith('HEALTH_')) delete process.env[k];
  Object.assign(process.env, env({ ...f, overrides: f.overrides }));
  try { return await fn(); } finally {
    for (const k of Object.keys(process.env)) if (k.startsWith('HEALTH_')) delete process.env[k];
    for (const [k, v] of Object.entries(old)) if (k.startsWith('HEALTH_')) process.env[k] = v;
    if (old.KLEBB_SKIP_HOME_ENV === undefined) delete process.env.KLEBB_SKIP_HOME_ENV;
    else process.env.KLEBB_SKIP_HOME_ENV = old.KLEBB_SKIP_HOME_ENV;
  }
}
function legacyDb(file, id = 'weight') {
  const store = require('../../lib/datastore').open(file); store.load();
  try { store.setData(id, WEIGHT_ROWS); } finally { store.close(); }
  const samples = require('../../health-auto-export/samples');
  samples.pushCount({ dbFile: file }); samples.close();
  const db = new DatabaseSync(file);
  try { assert.equal(db.prepare('PRAGMA journal_mode=DELETE').get().journal_mode, 'delete'); }
  finally { db.close(); }
}
function fixture(mode = 'absent', id = 'weight') {
  const f = F.fixture(mode); Object.assign(f, { mode, id, next: 0, overrides: {} });
  f.dbFile = path.join(f.home, 'db', 'klebb.db');
  f.authorityFile = path.join(f.home, 'credentials', 'health-connect.json');
  const badDb = mode === 'database-corrupt' || mode === 'database-directory';
  fs.writeFileSync(path.join(f.home, 'data', id + '.json'), JSON.stringify(H.card(id,
    badDb ? { data: WEIGHT_ROWS } : {})));
  if (!badDb) legacyDb(f.dbFile, id);
  return f;
}
function place(f, kind) {
  const dir = path.join(f.root, 'selected-' + kind); fs.mkdirSync(dir);
  if (kind === 'credentials') {
    const file = path.join(dir, 'health-connect.json'); fs.renameSync(f.authorityFile, file);
    f.authorityFile = file; f.overrides.HEALTH_CREDENTIALS_DIR = dir;
  } else {
    const file = path.join(dir, kind === 'file' ? 'selected.sqlite' : 'klebb.db');
    fs.renameSync(f.dbFile, file); f.dbFile = file;
    if (kind === 'file') f.overrides.HEALTH_DB_FILE = file;
    else f.overrides.HEALTH_DB_DIR = dir;
  }
}
function selectedLegacy(f) {
  const dir = path.join(f.root, 'selected-legacy'); fs.mkdirSync(dir);
  f.dbFile = path.join(dir, 'selected.sqlite'); legacyDb(f.dbFile, f.id);
  const grants = F.fixture('authority-grant'), empty = F.fixture('authority-empty');
  try {
    fs.copyFileSync(path.join(grants.home, 'credentials', 'health-connect.json'), f.authorityFile);
    f.authorityFile = path.join(dir, 'health-connect.json');
    fs.copyFileSync(path.join(empty.home, 'credentials', 'health-connect.json'), f.authorityFile);
  } finally { F.dispose(grants); F.dispose(empty); }
  f.overrides = { HEALTH_DB_FILE: f.dbFile, HEALTH_DB_DIR: path.join(f.root, 'unselected-dir'),
    HEALTH_CREDENTIALS_DIR: dir };
}
function sql(file) {
  let stat; try { stat = fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  if (!stat.isFile() || stat.isSymbolicLink()) return { nonregular: true };
  let db;
  const value = v => typeof v === 'bigint' ? { integer: String(v) } : ArrayBuffer.isView(v)
    ? { blob: Buffer.from(v).toString('hex') } : v;
  try {
    db = new DatabaseSync(file, { readOnly: true }); db.exec('BEGIN');
    const integrity = db.prepare('PRAGMA integrity_check(1)').get().integrity_check;
    const ddl = db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();
    const tables = ddl.filter(x => x.type === 'table').map(x => {
      const cols = db.prepare(`PRAGMA table_info(${quote(x.name)})`).all();
      const order = cols.flatMap(c => [`typeof(${quote(c.name)})`, `${quote(c.name)} COLLATE BINARY`]).join(',');
      const stmt = db.prepare(`SELECT * FROM ${quote(x.name)} ORDER BY ${order}`); stmt.setReadBigInts(true);
      return { name: x.name, rows: stmt.all().map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, value(v)]))) };
    }); db.exec('ROLLBACK'); return { integrity, ddl, tables };
  } catch (e) { return { readError: e.code || e.name }; } finally { if (db) db.close(); }
}
function cold(f, wizard = false) {
  const dbs = [...new Set([f.dbFile, path.join(f.home, 'db', 'klebb.db')])].map(file => ({ file, sql: sql(file) }));
  const inventory = F.files(f.root);
  const physical = [f.dbFile, f.dbFile + '-wal', f.dbFile + '-shm'].map(x => path.relative(f.root, x).split(path.sep).join('/'));
  return { dbs, files: wizard ? inventory.filter(x => !physical.includes(x.path) &&
    x.path !== path.relative(f.root, path.join(f.home, 'import', 'job.json')).split(path.sep).join('/')) : inventory,
    physicalDb: wizard ? inventory.filter(x => physical.includes(x.path)) : null };
}
function invariant(a, b, wizard = false) {
  assert.equal(equal(a.dbs, b.dbs), true, 'complete source SQL/schema unchanged');
  assert.equal(equal(a.files, b.files), true, 'complete source files/authority unchanged');
  if (!wizard) assert.equal(equal(a.physicalDb, b.physicalDb), true);
}
function control(f) {
  const state = sql(f.dbFile);
  if (f.mode === 'database-corrupt' || f.mode === 'database-directory') {
    assert.equal(!!(state.readError || state.nonregular), true, 'actual bad source activates real read refusal'); return;
  }
  assert.equal(state.integrity, 'ok', 'healthy source SQLite control');
  assert.equal(table(state, 'cards').rows.some(r => r.card_id === f.id), true, 'nonempty actual legacy sentinel');
  assert.equal(table(state, 'hae_pushes').rows.length, 0, 'no native HAE projection');
  if (f.mode === 'records') {
    const rows = table(state, 'health_records').rows; assert.equal(rows.length, 3);
    for (const rec of F.RECORDS) {
      assert.equal(Buffer.byteLength(rec.recordJson), rec.expectedUtf8Bytes);
      assert.equal('sha256:' + sha(Buffer.from(rec.recordJson)), rec.expectedRecordDigest);
      assert.equal(rows.some(row => equal([row.tenant_id, row.source_store_id, row.record_type, row.native_record_id],
        rec.identity) && row.record_json === rec.recordJson && row.projection === 'raw-only'), true, 'fixed complete raw record control');
    }
  }
  const retained = { tombstones: 'health_tombstones', guards: 'health_deletion_guards', stream: 'health_streams',
    'batch-receipt': 'health_batch_receipts', outbox: 'health_projection_outbox', staging: 'health_object_staging',
    parts: 'health_object_parts', 'object-receipt': 'health_object_receipts', 'index-entry': 'health_source_index',
    'index-frontier': 'health_source_index_frontiers', 'index-state': 'health_source_index_state' };
  if (retained[f.mode]) assert.equal(table(state, retained[f.mode]).rows.length, 1, 'actual nonempty retained control');
  if (f.mode.startsWith('empty-')) for (const t of state.tables.filter(t => t.name.startsWith('health_'))) {
    assert.equal(t.rows.length, t.name === 'health_schema_version' ? 1 : 0, 'initialized empty native control');
  }
  if (f.mode === 'authority-grant' || f.mode === 'authority-connector') {
    const a = JSON.parse(fs.readFileSync(f.authorityFile, 'utf8'));
    assert.equal(a[f.mode === 'authority-grant' ? 'grants' : 'connectors'].length, 1);
  }
}
let evidenceCount = 0;
function record(f, out, r) {
  const configured = process.env.NATIVE_SOURCE_EXPORT_TEST_EVIDENCE_DIR; if (!configured) return;
  assert(path.isAbsolute(configured)); const root = path.resolve(configured), st = fs.lstatSync(root);
  assert(st.isDirectory() && !st.isSymbolicLink()); assert(!root.startsWith(f.root + path.sep) && root !== f.root);
  if (!evidenceCount) assert.equal(fs.readdirSync(root).length, 0, 'root-owned evidence namespace is fresh');
  assert(++evidenceCount <= 64); const dir = path.join(root, 'child-' + String(evidenceCount).padStart(2, '0'));
  fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'native.json'), JSON.stringify({ pid: r.pid, status: r.status,
    signal: r.signal, errorCode: r.error?.code || null, nativeSavedBeforeOutputInspection: true,
    automaticRetry: false }), { flag: 'wx', mode: 0o600 });
  assert(Buffer.byteLength((r.stdout || '') + (r.stderr || '')) <= 2097152);
  fs.writeFileSync(path.join(dir, 'stdout'), r.stdout || '', { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'stderr'), r.stderr || '', { flag: 'wx', mode: 0o600 });
  if (!fs.existsSync(out)) return;
  assert(out.startsWith(f.root + path.sep)); const entries = F.files(out);
  assert(entries.length <= 32); assert(entries.filter(x => x.kind === 'file').reduce((n, x) => n + x.bytes, 0) <= 1048576);
  const copy = path.join(dir, 'output'); fs.mkdirSync(copy);
  for (const entry of entries) {
    const target = path.join(copy, entry.path); assert(target.startsWith(copy + path.sep));
    if (entry.kind === 'directory') fs.mkdirSync(target, { recursive: true });
    else { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(path.join(out, entry.path), target, fs.constants.COPYFILE_EXCL); }
  }
}
const output = f => path.join(f.root, 'export-' + (++f.next));
function cli(f, out) {
  const r = spawnSync(process.execPath, [path.join(H.REPO_ROOT, 'scripts', 'export-embed.js'), out],
    { cwd: H.REPO_ROOT, env: env(f), encoding: 'utf8', timeout: 60000, maxBuffer: 2097152 });
  try { record(f, out, r); } catch (e) { r.captureError = e; } // Native facts retained before assertions/parse.
  return r;
}
function checks(actions) {
  const errors = []; for (const action of actions) try { action(); } catch (e) { errors.push(e); }
  if (errors.length) { if (errors.length > 1) errors[0].cause = new AggregateError(errors.slice(1), 'additional effect/capture assertions'); throw errors[0]; }
}
function cleanOutput(out) { assert.equal(!fs.existsSync(out) || fs.readdirSync(out).length === 0, true, 'refusal has no output/manifest'); }
function refusalCli(f, token = unsupported) {
  control(f); const out = output(f), before = cold(f), r = cli(f, out), after = cold(f);
  checks([() => assert.equal(r.status, 2, 'CLI native source refusal exit'), () => assert.ifError(r.error),
    () => assert.equal(r.signal, null), () => assert.ifError(r.captureError),
    () => assert.equal((r.stderr || '').includes('error: ' + token), true, 'fixed payload-free refusal token'),
    () => assert.equal([...F.RETAINED_SECRETS, ...F.RECORDS.flatMap(x => [x.recordJson, x.identity[0], x.identity[1], x.identity[3]])]
      .some(value => ((r.stdout || '') + (r.stderr || '')).includes(value)), false, 'no native payload/identity/verifier diagnostics'),
    () => cleanOutput(out), () => invariant(before, after)]);
}
async function refusalLibrary(f, token = unsupported, repeat = 1) {
  await withEnv(f, async () => {
    H.purgeRepoModules(); const { exportTo } = require('../../scripts/export-embed');
    try {
      for (let n = 0; n < repeat; n++) for (const opts of [{}, { strict: true }]) {
        control(f); const out = output(f), before = cold(f); let thrown;
        try { exportTo(out, opts); } catch (e) { thrown = e; }
        const after = cold(f);
        checks([() => assert.equal(thrown instanceof Error, true, 'library throws instead of exiting'),
          () => assert.equal(thrown?.message, token, 'fixed library refusal token'), () => cleanOutput(out),
          () => invariant(before, after)]);
      }
    } finally { require('../../health-auto-export/samples').close(); }
  });
}
async function refusal(f, token = unsupported) { refusalCli(f, token); await refusalLibrary(f, token); }
function success(f) {
  const out = output(f), r = cli(f, out); assert.ifError(r.error); assert.ifError(r.captureError);
  assert.equal(r.signal, null); assert.equal(r.status, 0, 'genuine legacy export succeeds');
  const manifest = JSON.parse(fs.readFileSync(path.join(out, 'klebb-export.json'), 'utf8'));
  assert.equal(manifest.formatVersion, 1); assert.equal(manifest.inventory.cards.length, 1);
  assert.equal(manifest.inventory.cards[0].id, f.id);
  assert.equal(equal(JSON.parse(fs.readFileSync(path.join(out, 'data', f.id + '.json'), 'utf8')).data,
    WEIGHT_ROWS), true, 'independently fixed nonempty legacy values'); return out;
}
module.exports = { F, H, fs, path, assert, equal, table, fixture, place, selectedLegacy, sql, cold,
  invariant, control, withEnv, output, cli, checks, refusal, refusalLibrary, success, unsupported, unavailable, WEIGHT_ROWS };
