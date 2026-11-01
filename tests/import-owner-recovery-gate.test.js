// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { card, seedHome, buildSourceTree, targetGen, teardownGen, readJobFile } =
  require('./helpers/import-wizard-harness');
const OWNER_A = 'synthetic-import-owner-a';
const OWNER_B = 'synthetic-import-owner-b';
const SOURCE_ROWS = [{ date: '2026-01-02', value: 13 }];
const OLD_ROWS = [{ date: '2026-01-01', value: 7 }];
const CORRUPT_ROWS = [{ corrupted: true }];

function actualOldSqlCounts(selectedDbFile) {
  const db = new DatabaseSync(path.resolve(selectedDbFile), { readOnly: true });
  try {
    return {
      cards: Number(db.prepare('SELECT COUNT(*) AS n FROM cards WHERE card_id = ?').get('old').n),
      rows: Number(db.prepare('SELECT COUNT(*) AS n FROM rows WHERE card_id = ?').get('old').n),
    };
  } finally { db.close(); }
}
function assertRealOldTargetExists(gen, home) {
  assert.ok(gen.registry.get('old'));
  assert.deepEqual(JSON.parse(JSON.stringify(gen.store.getData('old'))), OLD_ROWS);
  assert.equal(fs.existsSync(path.join(home, 'data', 'old.json')), true);
  assert.deepEqual(actualOldSqlCounts(gen.store.file), { cards: 1, rows: 1 });
}
function assertRealOldTargetWiped(gen, home) {
  assert.equal(gen.registry.get('old'), null);
  assert.equal(gen.store.dataUpdatedAt('old'), null);
  assert.equal(fs.existsSync(path.join(home, 'data', 'old.json')), false);
  // Real read-only SQL must return zero; missing schema/query errors cannot pass.
  assert.deepEqual(actualOldSqlCounts(gen.store.file), { cards: 0, rows: 0 });
}

test('lost current owner after a real legacy wipe keeps import frozen and refuses boot recovery', async () => {
  const dirs = []; let gen; let wizard;
  try {
    const { tree } = buildSourceTree({ cards: { 'source.json': card('source') },
      rows: { source: SOURCE_ROWS } }, dirs);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'import-owner-recovery-'));
    dirs.push(home);
    seedHome(home, { cards: { 'old.json': card('old') }, rows: { old: OLD_ROWS } });
    gen = targetGen(home);
    assertRealOldTargetExists(gen, home);
    let currentOwner = OWNER_A;
    const importActor = { ownerId: OWNER_A, check: () => currentOwner };
    let actualWipeObserved = false;
    const realDrain = gen.samplesInbox.drain.bind(gen.samplesInbox);
    const samplesInbox = { ...gen.samplesInbox, async drain(...args) {
      const result = await realDrain(...args);
      assertRealOldTargetWiped(gen, home);
      actualWipeObserved = true;
      currentOwner = OWNER_B;
      return result;
    } };
    wizard = gen.wizardMod.createWizard({ ...gen.deps, samplesInbox });
    const start = await wizard.startFromTree(tree, { importActor });
    assert.equal(start.state, 'awaiting-confirm');
    const own = wizard.status({ importActor });
    assert.equal(typeof own.confirmNonce, 'string');
    const applying = wizard.confirmAndApply({ nonce: own.confirmNonce, importActor });
    assert.equal(applying.state, 'applying');
    const failed = await wizard.awaitIdle();
    assert.equal(actualWipeObserved, true);
    assert.equal(failed.state, 'failed');
    const persisted = readJobFile(home);
    assert.equal(persisted.wipedOnce, true);
    assert.equal(persisted.ownerRecoveryRequired, true);
    assert.equal(gen.freeze.frozen(), 'import');
    const recovery = gen.recoverMod.recoverAtBoot({ ...gen.deps, home });
    assert.equal(recovery.action, 'refuse');
    assert.equal(gen.freeze.frozen(), 'import');
    assert.equal(readJobFile(home).state, 'failed');
    // Guarded failure after mutation is not atomic old-state refusal or native R0.
  } finally {
    if (wizard) await wizard.awaitIdle();
    // Teardown releases only this test's owned freeze, after all held-gate assertions.
    teardownGen(gen);
    for (const dir of dirs.reverse()) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stable owner verification mismatch preserves the recovery gate through abort and restart', async () => {
  const dirs = []; let gen; let wizard;
  try {
    const { tree } = buildSourceTree({ cards: { 'source.json': card('source') },
      rows: { source: SOURCE_ROWS } }, dirs);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'import-owner-verify-recovery-'));
    dirs.push(home);
    seedHome(home, { cards: { 'old.json': card('old') }, rows: { old: OLD_ROWS } });
    gen = targetGen(home);
    assertRealOldTargetExists(gen, home);
    const importActor = { ownerId: OWNER_A, check: () => OWNER_A };
    let actualWipeObserved = false;
    let corruptionApplied = false;
    let stopped = false;
    let stopCalls = 0;
    let resumeCalls = 0;
    const registry = { ...gen.registry,
      stopWatch(...args) {
        const result = gen.registry.stopWatch(...args);
        stopCalls += 1; stopped = true;
        return result;
      },
      resumeWatch(...args) {
        const result = gen.registry.resumeWatch(...args);
        resumeCalls += 1; stopped = false;
        return result;
      },
    };
    const realDrain = gen.samplesInbox.drain.bind(gen.samplesInbox);
    const samplesInbox = { ...gen.samplesInbox, async drain(...args) {
      const result = await realDrain(...args);
      assertRealOldTargetWiped(gen, home);
      assert.equal(stopped, true, 'actual registry stop precedes the wipe/drain');
      actualWipeObserved = true;
      return result;
    } };
    const deps = { ...gen.deps, registry, samplesInbox,
      importerFactory(store) {
        const real = gen.deps.importerFactory(store);
        return {
          importParsedFile(file, parsed) {
            const result = real.importParsedFile(file, parsed);
            if (result.imported && result.id === 'source') {
              assert.equal(actualWipeObserved, true);
              store.setData('source', CORRUPT_ROWS);
              corruptionApplied = true;
            }
            return result;
          },
        };
      },
    };
    wizard = gen.wizardMod.createWizard(deps);
    const start = await wizard.startFromTree(tree, { importActor });
    assert.equal(start.state, 'awaiting-confirm', 'healthy supported legacy tree is validated');
    const own = wizard.status({ importActor });
    assert.equal(typeof own.confirmNonce, 'string');
    assert.equal(wizard.confirmAndApply({ nonce: own.confirmNonce, importActor }).state, 'applying');
    const failed = await wizard.awaitIdle();
    assert.equal(actualWipeObserved, true);
    assert.equal(corruptionApplied, true, 'real supported importer ran before injected corruption');
    assert.equal(failed.state, 'failed');
    const mismatch = failed.findings.filter(finding => finding.code === 'VERIFY_CARD_MISMATCH');
    assert.equal(mismatch.length, 1, JSON.stringify(failed.findings));
    assert.equal(mismatch[0].ref, 'data/source.json');
    assert.equal(failed.findings.some(finding => finding.code === 'APPLY_BACKUPS_KEPT'), true);
    const persisted = readJobFile(home);
    assert.equal(persisted.wipedOnce, true);
    // On the old owner-code baseline, genuine verification failure reaches this oracle.
    assert.equal(persisted.ownerRecoveryRequired, true);
    assert.equal(gen.freeze.frozen(), 'import');
    assert.ok(stopCalls >= 2);
    assert.equal(resumeCalls, 1);
    assert.equal(stopped, true);
    const recovery = gen.recoverMod.recoverAtBoot({ ...deps, home });
    assert.equal(recovery.action, 'refuse');
    assert.equal(gen.freeze.frozen(), 'import');
    assert.equal(readJobFile(home).state, 'failed');
    assert.equal(resumeCalls, 1);
    assert.equal(stopped, true);
    assertRealOldTargetWiped(gen, home);
    const jobFile = gen.wizardMod.jobFilePath(home);
    const durableJob = fs.readFileSync(jobFile);
    assert.deepEqual(JSON.parse(JSON.stringify(gen.store.getData('source'))), CORRUPT_ROWS);
    const aborted = wizard.abort({ importActor });
    assert.equal(aborted.code, 'BAD_STATE', 'abort cannot clear a post-wipe recovery fence');
    assert.notEqual(aborted.ok, true);
    assert.deepEqual(fs.readFileSync(jobFile), durableJob);
    assert.equal(gen.freeze.frozen(), 'import');
    assert.equal(resumeCalls, 1);
    assert.equal(stopped, true);
    assertRealOldTargetWiped(gen, home);
    assert.deepEqual(JSON.parse(JSON.stringify(gen.store.getData('source'))), CORRUPT_ROWS);
    // Release only process memory to check that the durable fence alone refuses boot.
    const recoverAtBoot = gen.recoverMod.recoverAtBoot;
    teardownGen(gen);
    assert.equal(gen.freeze.frozen(), null);
    gen = null;
    wizard = null;
    assert.equal(recoverAtBoot({ home }).action, 'refuse');
    assert.deepEqual(fs.readFileSync(jobFile), durableJob);
    // The unmarked verify-fail/rollback control remains in import-wizard.test.js.
    // This marked failure guards a half-mutated target; it proves no native publication.
  } finally {
    if (wizard) await wizard.awaitIdle();
    teardownGen(gen);
    for (const dir of dirs.reverse()) fs.rmSync(dir, { recursive: true, force: true });
  }
});
