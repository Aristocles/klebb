// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { card, seedHome, buildSourceTree, targetGen, teardownGen } =
  require('./helpers/import-wizard-harness');
const OWNER_A = 'synthetic-import-owner-a';
const OWNER_B = 'synthetic-import-owner-b';
const actor = ownerId => ({ ownerId, check: () => ownerId });
const SOURCE_ROWS = [{ date: '2026-01-02', value: 13 }];
const OLD_ROWS = [{ date: '2026-01-01', value: 7 }];
function committed(home) {
  const db = new DatabaseSync(path.join(home, 'db', 'klebb.db'), { readOnly: true });
  try {
    db.exec('BEGIN');
    const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema "
      + "WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
    const tables = schema.filter(row => row.type === 'table');
    const rows = tables.map(({ name }) => {
      assert.match(name, /^[A-Za-z0-9_]+$/);
      return [name, db.prepare(`SELECT * FROM "${name}"`).all()];
    });
    db.exec('COMMIT'); return { schema, rows };
  } finally { db.close(); }
}
function credentialBytes(home) {
  const result = {};
  const dir = path.join(home, 'credentials');
  if (fs.existsSync(dir)) for (const name of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, name);
    if (fs.statSync(file).isFile()) result[name] = fs.readFileSync(file);
  }
  return result;
}
async function exercise(fn) {
  const dirs = []; let gen; let wizard;
  try {
    const { tree } = buildSourceTree({ cards: { 'source.json': card('source') },
      rows: { source: SOURCE_ROWS } }, dirs);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'import-owner-'));
    dirs.push(home);
    seedHome(home, { cards: { 'old.json': card('old') }, rows: { old: OLD_ROWS } });
    gen = targetGen(home); wizard = gen.wizardMod.createWizard(gen.deps);
    // Complete the real empty samples schema before freezing the refusal inventory.
    assert.equal(gen.samples.pushCount({ dbFile: gen.store.file }), 0);
    assert.deepEqual(JSON.parse(JSON.stringify(gen.store.getData('old'))), OLD_ROWS,
      'real independently fixed old history exists before the feature assertion');
    await fn({ tree, home, gen, wizard, before: committed(home), secrets: credentialBytes(home) });
  } finally {
    // Old wrong-owner confirm can already start a detached apply; close it even on RED.
    if (wizard) await wizard.awaitIdle();
    teardownGen(gen);
    for (const dir of dirs.reverse()) fs.rmSync(dir, { recursive: true, force: true });
  }
}
function refused(result, code, status) {
  assert.equal(result.code, code);
  assert.equal(result.status, status);
  assert.equal(typeof result.error, 'string');
}
test('owner-bound legacy import refuses another current owner at status before mutation', async () => {
  await exercise(async ({ tree, home, wizard, before, secrets }) => {
    const start = await wizard.startFromTree(tree, { importActor: actor(OWNER_A) });
    assert.equal(start.state, 'awaiting-confirm', 'valid supported legacy setup reaches existing job');
    assert.equal(start.requiresConfirm, true);
    // B is the FIRST status request: denial must not disclose or spend A's nonce.
    // The supported old baseline reaches this independently expected 403 assertion.
    const foreign = wizard.status({ importActor: actor(OWNER_B) });
    refused(foreign, 'IMPORT_OWNER_MISMATCH', 403);
    assert.equal(foreign.confirmNonce, undefined);
    const own = wizard.status({ importActor: actor(OWNER_A) });
    assert.equal(own.state, 'awaiting-confirm');
    assert.equal(typeof own.confirmNonce, 'string');
    assert.ok(own.confirmNonce.length > 0);
    const secondOwn = wizard.status({ importActor: actor(OWNER_A) });
    assert.equal(secondOwn.state, 'awaiting-confirm');
    assert.equal(secondOwn.confirmNonce, undefined, 'A receives the actual nonce exactly once');
    assert.deepEqual(committed(home), before);
    assert.deepEqual(credentialBytes(home), secrets);
  });
});
test('owner-bound legacy import refuses a foreign owner even with the valid confirm nonce', async () => {
  await exercise(async ({ tree, home, wizard, before, secrets }) => {
    const start = await wizard.startFromTree(tree, { importActor: actor(OWNER_A) });
    assert.equal(start.state, 'awaiting-confirm');
    const own = wizard.status({ importActor: actor(OWNER_A) });
    assert.equal(typeof own.confirmNonce, 'string');
    const denied = wizard.confirmAndApply({ nonce: own.confirmNonce, importActor: actor(OWNER_B) });
    refused(denied, 'IMPORT_OWNER_MISMATCH', 403);
    assert.deepEqual(committed(home), before);
    assert.deepEqual(credentialBytes(home), secrets);
    assert.equal(wizard.status({ importActor: actor(OWNER_A) }).state, 'awaiting-confirm');
    // The wrong-owner request did not spend the right owner's nonce.
    const admitted = wizard.confirmAndApply({ nonce: own.confirmNonce, importActor: actor(OWNER_A) });
    assert.equal(admitted.state, 'applying');
    assert.equal((await wizard.awaitIdle()).state, 'done');
  });
});
test('owner-bound import requires a current synchronous owner and notices changed live identity', async () => {
  await exercise(async ({ tree, home, wizard, before, secrets }) => {
    let current = OWNER_A;
    const live = { ownerId: OWNER_A, check: () => current };
    assert.equal((await wizard.startFromTree(tree, { importActor: live })).state, 'awaiting-confirm');
    current = OWNER_B;
    refused(wizard.status({ importActor: live }), 'IMPORT_OWNER_MISMATCH', 403);
    current = false;
    refused(wizard.status({ importActor: live }), 'IMPORT_OWNER_REQUIRED', 401);
    refused(wizard.status({ importActor: { ownerId: OWNER_A, check: async () => OWNER_A } }),
      'IMPORT_OWNER_REQUIRED', 401);
    refused(wizard.status({}), 'IMPORT_OWNER_REQUIRED', 401);
    assert.deepEqual(committed(home), before);
    assert.deepEqual(credentialBytes(home), secrets);
    current = OWNER_A;
    assert.equal(wizard.status({ importActor: live }).state, 'awaiting-confirm');
  });
});
test('unactorized legacy imports retain their supported default behavior', async () => {
  await exercise(async ({ tree, wizard }) => {
    assert.equal((await wizard.startFromTree(tree)).state, 'awaiting-confirm');
    const status = wizard.status();
    const started = wizard.confirmAndApply({ nonce: status.confirmNonce });
    assert.equal(started.state, 'applying');
    assert.equal((await wizard.awaitIdle()).state, 'done');
  });
});
