// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const product = path.resolve(process.env.INDEPENDENT_PRODUCT_ROOT || path.join(__dirname, '../..'));
const { createSandbox, cleanupSandbox } = require(path.join(product, 'tests/helpers/sandbox'));
const { coldReadDatabase, sha } = require('./health-connect-guard-migration-cold-readback.cjs');
const bank = require('../fixtures/health-connect/guard-migration-v2.json');
const runner = path.join(__dirname, 'health-connect-guard-migration-runner.cjs');
const preload = path.join(__dirname, 'health-connect-guard-migration-preload.cjs');
const ENV = {
  HEALTH_DATA_DIR: '', HEALTH_REPORTS_DIR: '', HEALTH_AUTO_EXPORT_DIR: '',
  HEALTH_SESSIONS_DIR: '', HEALTH_CREDENTIALS_DIR: '', HEALTH_ARCHIVE_DIR: '',
  HEALTH_CONFIG_PATH: '', HEALTH_DB_DIR: '', HEALTH_DB_FILE: '', HEALTH_CHAT_DIR: '',
  HEALTH_USER_FILE: '', HEALTH_NOTIFICATIONS_STATE_FILE: '', HEALTH_INBOX_DIR: '',
  HEALTH_KEYS_DIR: '', HEALTH_VAPID_FILE: '', HEALTH_PUSH_SUBSCRIPTIONS_FILE: '',
  HEALTH_CONNECT_STAGING_MAX_BYTES: '', HEALTH_AUTO_EXPORT_TOKEN: '',
  AGENT_API_TOKEN: '', KLEBB_ADMIN_TOKEN: '', KLEBB_CLOUD: '', KLEBB_DEMO: '',
  CHAT_API_KEY: '', FISH_AUDIO_API_KEY: '', NODE_OPTIONS: '',
  KLEBB_SKIP_HOME_ENV: '1', HEALTH_HOME_WARNED: '1',
};
function owned(data) {
  assert.equal(path.dirname(data.home), path.resolve(os.tmpdir()));
  assert.ok(path.basename(data.home).startsWith('eh-test-'));
  assert.equal(fs.lstatSync(data.home).isSymbolicLink(), false);
}
function run(data, command = 'migrate', { fault = null, windowsDevelopment = true,
  cliArgs = null } = {}) {
  owned(data);
  const observations = path.join(data.home, 'migration-observations.jsonl');
  if (fs.existsSync(observations)) fs.unlinkSync(observations);
  const env = { ...process.env, ...ENV, HEALTH_HOME: data.home,
    INDEPENDENT_PRODUCT_ROOT: product,
    INDEPENDENT_WINDOWS_DEVELOPMENT: windowsDevelopment ? '1' : '0',
    ...(fault ? { NODE_OPTIONS: `--require "${preload.replaceAll('\\', '/')}"`,
      INDEPENDENT_MIGRATION_FAULT: fault, INDEPENDENT_MIGRATION_OBSERVATIONS: observations } : {}) };
  const script = cliArgs ? path.join(product, 'scripts/migrate-health-connect-deletion-guards.js') : runner;
  const args = cliArgs ?? [command];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { env, cwd: product,
      stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    // Preserve the operation deadline but wait for the owned child's actual
    // close before the caller can remove its fixture files.
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 20000);
    child.stdout.on('data', bytes => { stdout += bytes.toString('utf8'); });
    child.stderr.on('data', bytes => { stderr += bytes.toString('utf8'); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) { reject(new Error('Bounded migration child result not observed')); return; }
      let json = null;
      try { json = JSON.parse(stdout.trim()); } catch {}
      const events = fs.existsSync(observations) ?
        fs.readFileSync(observations, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
      resolve({ code, signal, stdout, stderr, json, events });
    });
  });
}
async function fixture({ emptyNative = false, wal = true } = {}) {
  const data = { home: createSandbox(), holder: null };
  data.database = path.join(data.home, 'db/klebb.db');
  owned(data);
  try {
    if (!emptyNative) {
      const seeded = await run(data, 'seed');
      assert.equal(seeded.code, 0);
      assert.deepEqual(seeded.json, { ok: true, result: { seeded: true } });
    } else {
      fs.mkdirSync(path.dirname(data.database), { mode: 0o700 });
      const db = new DatabaseSync(data.database);
      db.exec('CREATE TABLE untouched_legacy (value TEXT NOT NULL)');
      db.prepare('INSERT INTO untouched_legacy VALUES (?)').run('nonempty native-absent sentinel');
      db.close();
    }
    if (wal && !emptyNative) {
      data.holder = new DatabaseSync(data.database);
      data.holder.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=0');
      const mainBefore = fs.readFileSync(data.database);
      const control = path.join(data.home, 'main-only-control.db');
      fs.writeFileSync(control, mainBefore, { flag: 'wx', mode: 0o600 });
      data.holder.prepare('INSERT INTO migration_wal_sentinel(id,value) VALUES (?,?)')
        .run(bank.walSentinel.id, bank.walSentinel.value);
      assert.equal(sha(fs.readFileSync(data.database)), sha(mainBefore),
        'committed sentinel was not checkpointed into main');
      assert.ok(fs.statSync(data.database + '-wal').size > 32);
      assert.deepEqual(coldReadDatabase(control).tables.migration_wal_sentinel, []);
    }
    data.before = coldReadDatabase(data.database);
    if (!emptyNative) {
      assert.deepEqual(data.before.tables.health_schema_version, [{ version: { type: 'integer', decimal: '1' } }]);
      assert.equal(data.before.tables.health_records.length, 3);
      assert.equal(data.before.tables.health_tombstones.length, 1);
      assert.equal(data.before.tables.health_batch_receipts.length, 2);
      assert.equal(data.before.tables.health_projection_outbox.length, 2);
      assert.equal(data.before.tables.health_object_parts.length, 1);
      assert.equal(data.before.tables.health_object_receipts.length, 1);
      assert.equal(data.before.tables.health_source_index.length, 4);
      assert.ok(data.before.tables.cards.length > 0 && data.before.tables.rows.length > 0);
      assert.ok(data.before.tables.hae_samples.length > 0);
    }
    return data;
  } catch (error) { close(data); throw error; }
}
function close(data) {
  owned(data);
  if (data.holder) { data.holder.close(); data.holder = null; }
  cleanupSandbox(data.home);
}
function copies(data) {
  const prefix = path.basename(data.database) + '.pre-health-deletion-v2-';
  return fs.readdirSync(path.dirname(data.database))
    .filter(name => name.startsWith(prefix) && name.endsWith('.db'))
    .map(name => path.join(path.dirname(data.database), name));
}
function noCopy(data) { assert.deepEqual(copies(data), []); }
function versionTwo(data) {
  const cold = coldReadDatabase(data.database);
  const expected = structuredClone(data.before);
  expected.schema = expected.schema.map(row => row.name === 'health_schema_version' ?
    { ...row, sql: bank.markerV2Ddl } : row);
  expected.schema.push({ type: 'table', name: 'health_deletion_guards',
    tbl_name: 'health_deletion_guards', sql: bank.guardV2Ddl });
  expected.schema.push({ type: 'index', name: 'sqlite_autoindex_health_deletion_guards_1',
    tbl_name: 'health_deletion_guards', sql: null });
  expected.schema.sort((a, b) => a.type < b.type ? -1 : a.type > b.type ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  expected.tables.health_schema_version = [{ version: { type: 'integer', decimal: '2' } }];
  expected.tables.health_deletion_guards = [];
  assert.deepEqual(cold, expected, 'only exact marker and empty guard schema may change');
  return cold;
}
function unchanged(data) { assert.deepEqual(coldReadDatabase(data.database), data.before); }
function oneVerifiedCopy(data) {
  const found = copies(data);
  assert.equal(found.length, 1);
  assert.deepEqual(coldReadDatabase(found[0]), data.before,
    'cold verified safety copy is the complete pre-migration V1 snapshot');
  return found[0];
}
module.exports = { product, bank, fixture, close, run, copies, noCopy, versionTwo,
  unchanged, oneVerifiedCopy, coldReadDatabase, sha };
