// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Implementation regression file; never use a missing new module as old-feature RED.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { card, seedHome, buildSourceTree, targetGen, teardownGen } =
  require('./helpers/import-wizard-harness');
const OWNER_A = 'synthetic-import-owner-a';
const OWNER_B = 'synthetic-import-owner-b';
const actor = ownerId => ({ ownerId, check: () => ownerId });
const errorIs = (code, status) => error => error.code === code && error.status === status;
test('opaque import approval rejects structural copies and independently valid other owners', () => {
  const { issueOwnerApproval, assertOwnerApproval } = require('../lib/import/owner-approval');
  const home = path.resolve(os.tmpdir(), 'synthetic-approval-target');
  const tree = path.resolve(os.tmpdir(), 'synthetic-approval-tree');
  const approval = issueOwnerApproval(actor(OWNER_A), { jobId: 'synthetic-approval-job',
    treePath: tree, targetHome: home, selectedDbFile: path.resolve(home, 'db', 'klebb.db') });
  const expected = { ownerId: OWNER_A, jobId: 'synthetic-approval-job', treePath: tree, targetHome: home, selectedDbFile: path.resolve(home, 'db', 'klebb.db') };
  assert.deepEqual(assertOwnerApproval(approval, actor(OWNER_A)), expected);
  assert.deepEqual(approval.check(), expected);
  assert.equal(Object.isFrozen(approval.check()), true);
  assert.throws(() => assertOwnerApproval({ ...approval }, actor(OWNER_A)),
    errorIs('IMPORT_APPROVAL_REQUIRED', 409));
  assert.throws(() => assertOwnerApproval(JSON.parse(JSON.stringify(approval)), actor(OWNER_A)),
    errorIs('IMPORT_APPROVAL_REQUIRED', 409));
  assert.throws(() => assertOwnerApproval(approval, actor(OWNER_B)),
    errorIs('IMPORT_OWNER_MISMATCH', 403));
});
test('opaque approval rechecks the live owner instead of persisting consent or request data', () => {
  const { issueOwnerApproval, assertOwnerApproval } = require('../lib/import/owner-approval');
  let current = OWNER_A;
  const context = { ownerId: OWNER_A, check: () => current };
  const approval = issueOwnerApproval(context, { jobId: 'synthetic-live-job',
    treePath: path.resolve(os.tmpdir(), 'synthetic-live-tree'),
    targetHome: path.resolve(os.tmpdir(), 'synthetic-live-target'),
    selectedDbFile: path.resolve(os.tmpdir(), 'synthetic-live-target', 'db', 'klebb.db') });
  current = OWNER_B;
  assert.throws(() => approval.check(), errorIs('IMPORT_OWNER_MISMATCH', 403));
  current = false;
  assert.throws(() => approval.check(), errorIs('IMPORT_OWNER_REQUIRED', 401));
  assert.throws(() => issueOwnerApproval({ ownerId: OWNER_A, check: async () => OWNER_A },
    { jobId: 'async', treePath: '.', targetHome: '.', selectedDbFile: path.resolve('db', 'klebb.db') }), errorIs('IMPORT_OWNER_REQUIRED', 401));
  assert.throws(() => assertOwnerApproval({}, context), errorIs('IMPORT_APPROVAL_REQUIRED', 409));
});
test('reloaded actor-bound import refuses to resume from mutable job data without process approval', async () => {
  const dirs = []; let gen; let firstWizard; let reloaded;
  try {
    const { tree } = buildSourceTree({ cards: { 'source.json': card('source') },
      rows: { source: [{ date: '2026-01-02', value: 13 }] } }, dirs);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'import-approval-recovery-'));
    dirs.push(home); seedHome(home, { cards: { 'old.json': card('old') },
      rows: { old: [{ date: '2026-01-01', value: 7 }] } });
    gen = targetGen(home); firstWizard = gen.wizardMod.createWizard(gen.deps);
    assert.equal((await firstWizard.startFromTree(tree, { importActor: actor(OWNER_A) })).state,
      'awaiting-confirm');
    const approval = firstWizard.currentOwnerApproval({ importActor: actor(OWNER_A) });
    assert.equal(approval.check().ownerId, OWNER_A);
    assert.equal(approval.check().selectedDbFile, path.resolve(gen.store.file));
    const jobFile = path.join(home, 'import', 'job.json');
    const stored = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
    // A process restart loses the WeakMap capability; job strings cannot recreate it.
    stored.state = 'applying'; stored.ownerId = OWNER_A;
    stored.importActor = { ownerId: OWNER_A }; stored.approved = true;
    fs.writeFileSync(jobFile, JSON.stringify(stored));
    reloaded = gen.wizardMod.createWizard(gen.deps);
    const denied = reloaded.resume('tree');
    assert.equal(denied.code, 'IMPORT_APPROVAL_REQUIRED'); assert.equal(denied.status, 409);
    assert.deepEqual(JSON.parse(JSON.stringify(gen.store.getData('old'))),
      [{ date: '2026-01-01', value: 7 }]);
    assert.throws(() => reloaded.currentOwnerApproval({ importActor: actor(OWNER_A) }),
      errorIs('IMPORT_APPROVAL_REQUIRED', 409));
  } finally {
    if (firstWizard) await firstWizard.awaitIdle();
    if (reloaded) await reloaded.awaitIdle();
    teardownGen(gen);
    for (const dir of dirs.reverse()) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('current owner approval refuses a changed actual selected datastore path', async () => {
  const dirs = []; let gen; let wizard;
  try {
    const { tree } = buildSourceTree({ cards: { 'source.json': card('source') },
      rows: { source: [{ date: '2026-01-02', value: 13 }] } }, dirs);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'import-owner-store-binding-'));
    dirs.push(home); seedHome(home, { cards: { 'old.json': card('old') },
      rows: { old: [{ date: '2026-01-01', value: 7 }] } });
    gen = targetGen(home);
    let selectedDbFile = gen.store.file;
    assert.equal(path.resolve(selectedDbFile), path.resolve(home, 'db', 'klebb.db'));
    const store = Object.create(gen.store);
    Object.defineProperty(store, 'file', { enumerable: true, get: () => selectedDbFile });
    wizard = gen.wizardMod.createWizard({ ...gen.deps, store });
    const importActor = actor(OWNER_A);
    assert.equal((await wizard.startFromTree(tree, { importActor })).state, 'awaiting-confirm');
    const approval = wizard.currentOwnerApproval({ importActor });
    assert.equal(approval.check().selectedDbFile, path.resolve(selectedDbFile));
    selectedDbFile = path.resolve(home, 'db', 'different-selected.db');
    assert.throws(() => wizard.currentOwnerApproval({ importActor }),
      errorIs('IMPORT_APPROVAL_REQUIRED', 409));
    assert.deepEqual(JSON.parse(JSON.stringify(gen.store.getData('old'))),
      [{ date: '2026-01-01', value: 7 }]);
    assert.equal(fs.existsSync(selectedDbFile), false);
  } finally {
    if (wizard) await wizard.awaitIdle();
    teardownGen(gen);
    for (const dir of dirs.reverse()) fs.rmSync(dir, { recursive: true, force: true });
  }
});
