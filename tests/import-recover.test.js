// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/import-recover.test.js
// Boot-time crash recovery (lib/import/recover.js), driven the hard way: a
// subprocess runs a real wizard apply and SIGKILLs itself as each pipeline
// stage begins (wipe, copy, drain, import), then a second fresh process
// calls recoverAtBoot the way the server boot will: before first-boot
// seeding, before the samples drain, before registry.init(). Every kill is
// proven non-vacuous by its stage marker: the killed stage began, the next
// never did, no `finished` marker exists, and job.json still says applying.
//
// Also pinned here: the refuse path when both the tree and the snapshot are
// gone, recovery from the snapshot when only the tree is gone, stale
// awaiting-confirm jobs clearing at boot, done/failed records surviving the
// boot untouched, and the seeding hazard itself (first-boot seeding over a
// half-applied home plants a welcome card unless recovery runs first).
//
// Subprocess-driven on purpose: the parent never purges the require cache
// and never spawns a server, so this file mixes with neither harness style.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  REPO_ROOT, card, norm, stepPush, seedHome, buildSourceTree,
  withStore, pushCountOf, preImportBackups, readJobFile,
} = require('./helpers/import-wizard-harness');

process.env.HEALTH_HOME_WARNED = '1';

let sqliteAvailable = true;
try { require('node:sqlite'); } catch { sqliteAvailable = false; }
const skip = sqliteAvailable ? false : 'node:sqlite unavailable on this Node';

const KILL_RUNNER = path.join(REPO_ROOT, 'tests', 'helpers', 'import-kill-runner.js');
const RECOVER_RUNNER = path.join(REPO_ROOT, 'tests', 'helpers', 'import-recover-runner.js');

const EMBEDDED_ROWS = [{ date: '2026-01-01', kg: 80 }, { date: '2026-01-02', kg: 79.5 }];
const OLD_ROWS = [{ date: '2025-12-01', mood: 3 }];
const TREE_PUSHES = [stepPush('2026-05-01', 4100), stepPush('2026-05-02', 5200)];

// The stage that begins right after each kill point; its marker must be
// absent or the kill landed too late to test anything.
const NEXT_STAGE = { wipe: 'copy', copy: 'drain', drain: 'import', import: 'reload' };

const tmpDirs = [];
function newDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function populatedSeed() {
  return {
    cards: { 'old.json': card('old') },
    rows: { old: OLD_ROWS },
    pushes: [stepPush('2025-12-01', 900)],
  };
}

function killAt(stage, treePath) {
  const home = newDir('eh-rec-home-');
  seedHome(home, populatedSeed());
  const marker = newDir('eh-rec-marker-');
  const r = spawnSync(process.execPath, [KILL_RUNNER, home, treePath, marker, stage], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
  });
  return { home, marker, r };
}

function assertKilledMidApply({ home, marker, r }, stage) {
  assert.ok(fs.existsSync(path.join(marker, `${stage}.begun`)),
    `the ${stage} stage never began: ${r.stdout}${r.stderr}`);
  assert.ok(!fs.existsSync(path.join(marker, 'finished')),
    `vacuous kill: the pipeline finished before the SIGKILL landed`);
  assert.ok(!fs.existsSync(path.join(marker, `${NEXT_STAGE[stage]}.begun`)),
    `the kill landed after the ${NEXT_STAGE[stage]} stage began`);
  const rec = readJobFile(home);
  assert.ok(rec, 'job.json missing after the kill');
  assert.strictEqual(rec.state, 'applying');
  assert.strictEqual(rec.stage, stage);
}

function runRecovery(home) {
  const r = spawnSync(process.execPath, [RECOVER_RUNNER, home], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
  });
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  const line = (r.stdout || '').split('\n').find(l => l.startsWith('RECOVER_RESULT '));
  assert.ok(line, `no RECOVER_RESULT line: ${r.stdout}${r.stderr}`);
  return JSON.parse(line.slice('RECOVER_RESULT '.length));
}

// The imported tree, restored whole: every card deep-equal through the
// datastore, old state gone, pushes exact, backups swept, job recorded done.
function assertTreeApplied(home) {
  withStore(home, (store) => {
    assert.deepStrictEqual(norm(store.getData('embedded')), norm(EMBEDDED_ROWS));
    assert.strictEqual(store.getData('nulldata'), null);
    assert.notStrictEqual(store.dataUpdatedAt('nulldata'), null);
    assert.strictEqual(store.dataUpdatedAt('old'), null, 'old rows survived the recovery wipe');
    assert.strictEqual(store.dataUpdatedAt('welcome'), null);
  });
  assert.ok(!fs.existsSync(path.join(home, 'data', 'old.json')), 'the old card file survived');
  assert.strictEqual(pushCountOf(home), 2);
  assert.deepStrictEqual(preImportBackups(home), []);
  assert.ok(fs.existsSync(path.join(home, 'klebb-export.json')));
  assert.strictEqual(readJobFile(home).state, 'done');
}

describe('import boot recovery', { skip }, () => {
  let tree;

  before(() => {
    ({ tree } = buildSourceTree({
      cards: {
        'embedded.json': card('embedded'),
        'nulldata.json': card('nulldata'),
      },
      rows: { embedded: EMBEDDED_ROWS, nulldata: null },
      pushes: TREE_PUSHES,
    }, tmpDirs));
  });

  after(() => {
    while (tmpDirs.length) {
      try { fs.rmSync(tmpDirs.pop(), { recursive: true, force: true }); } catch {}
    }
  });

  for (const stage of ['wipe', 'copy', 'drain', 'import']) {
    test(`SIGKILL as the ${stage} stage begins: recovery resumes from the tree and verifies`, () => {
      const killed = killAt(stage, tree);
      assertKilledMidApply(killed, stage);

      const rec = runRecovery(killed.home);
      assert.strictEqual(rec.action, 'resuming', JSON.stringify(rec));
      assert.strictEqual(rec.source, 'tree');
      // Detached (#633): recoverAtBoot returned while the pipeline was
      // still applying; the terminal state comes from the settled promise.
      assert.strictEqual(rec.promptState, 'applying', JSON.stringify(rec));
      assert.strictEqual(rec.state, 'done', JSON.stringify(rec));
      assert.deepStrictEqual(rec.verified, { cards: 2, pushes: 2, reports: 0 });
      assertTreeApplied(killed.home);
    });
  }

  test('tree gone, snapshot intact: recovery restores the pre-import state from the snapshot', () => {
    const disposable = path.join(newDir('eh-rec-tree-'), 'tree');
    fs.cpSync(tree, disposable, { recursive: true });
    const killed = killAt('import', disposable);
    assertKilledMidApply(killed, 'import');
    fs.rmSync(disposable, { recursive: true, force: true });

    const rec = runRecovery(killed.home);
    assert.strictEqual(rec.action, 'resuming', JSON.stringify(rec));
    assert.strictEqual(rec.source, 'snapshot');
    assert.strictEqual(rec.promptState, 'applying', JSON.stringify(rec));
    assert.strictEqual(rec.state, 'done', JSON.stringify(rec));
    withStore(killed.home, (store) => {
      assert.deepStrictEqual(norm(store.getData('old')), norm(OLD_ROWS),
        'the snapshot must bring the pre-import card back');
      assert.strictEqual(store.dataUpdatedAt('embedded'), null,
        'half-imported tree cards must be gone');
    });
    assert.strictEqual(pushCountOf(killed.home), 1, 'the original push history must be back');
  });

  test('tree AND snapshot gone: recovery refuses and leaves the job record as evidence', () => {
    const disposable = path.join(newDir('eh-rec-tree-'), 'tree');
    fs.cpSync(tree, disposable, { recursive: true });
    const killed = killAt('copy', disposable);
    assertKilledMidApply(killed, 'copy');
    fs.rmSync(disposable, { recursive: true, force: true });
    const snapshotPath = readJobFile(killed.home).snapshotPath;
    assert.ok(snapshotPath, 'a populated target must have recorded a snapshot before the wipe');
    fs.rmSync(snapshotPath, { recursive: true, force: true });

    const rec = runRecovery(killed.home);
    assert.strictEqual(rec.action, 'refuse', JSON.stringify(rec));
    assert.match(rec.reason, /refusing to serve or seed over a half-applied instance/);
    assert.strictEqual(readJobFile(killed.home).state, 'applying',
      'a refused recovery must not clear the evidence');
  });

  test('first-boot seeding over a half-applied home plants a welcome card; recovery first prevents it', () => {
    const killed = killAt('copy', tree);
    assertKilledMidApply(killed, 'copy');
    // Clone the wreckage so both legs start from the identical half-applied
    // state: the wipe ran, the copy never did, data/ holds no cards.
    const clone = path.join(newDir('eh-rec-clone-'), 'home');
    fs.cpSync(killed.home, clone, { recursive: true });

    // WITHOUT recovery (the next phase calling seeding first): the exact bug
    // the boot-order contract exists to prevent.
    const { runFirstBoot } = require('../server/first-boot');
    const seededOverWreckage = runFirstBoot({ dataDir: path.join(killed.home, 'data'), log: () => {} });
    assert.strictEqual(seededOverWreckage.ran, true,
      'expected the hazard: first-boot sees an empty data/ and seeds');
    assert.ok(fs.existsSync(path.join(killed.home, 'data', 'welcome.klebb.json')),
      'the welcome card was planted over a half-applied home');

    // WITH recovery first: the home is whole again, so seeding stands down.
    const rec = runRecovery(clone);
    assert.strictEqual(rec.action, 'resuming', JSON.stringify(rec));
    assert.strictEqual(rec.state, 'done', JSON.stringify(rec));
    const seededAfterRecovery = runFirstBoot({ dataDir: path.join(clone, 'data'), log: () => {} });
    assert.strictEqual(seededAfterRecovery.ran, false);
    assert.strictEqual(seededAfterRecovery.reason, 'data-not-empty');
    assert.ok(!fs.existsSync(path.join(clone, 'data', 'welcome.klebb.json')));
    assertTreeApplied(clone);
  });

  test('a stale awaiting-confirm job clears at boot: the nonce died with the process', () => {
    const home = newDir('eh-rec-home-');
    seedHome(home, populatedSeed());
    const staged = path.join(home, 'import', 'staging-abc');
    fs.mkdirSync(staged, { recursive: true });
    fs.writeFileSync(path.join(staged, 'placeholder'), '');
    fs.mkdirSync(path.join(home, 'import'), { recursive: true });
    fs.writeFileSync(path.join(home, 'import', 'job.json'), JSON.stringify({
      jobId: 'stale', state: 'awaiting-confirm', treePath: staged,
      snapshotPath: null, confirmNonce: 'dead', requiresConfirm: true,
      startedAt: new Date().toISOString(), stage: null,
    }));

    const rec = runRecovery(home);
    assert.strictEqual(rec.action, 'none');
    assert.strictEqual(rec.cleared, true);
    assert.strictEqual(readJobFile(home), null, 'the stale job must be cleared');
    assert.ok(!fs.existsSync(staged), 'the staged tree under import/ must be cleared');
    withStore(home, (store) => {
      assert.deepStrictEqual(norm(store.getData('old')), norm(OLD_ROWS),
        'clearing a stale job must not touch the instance');
    });
  });

  test('done and failed records survive the boot untouched (rollback stays possible)', () => {
    for (const state of ['done', 'failed']) {
      const home = newDir('eh-rec-home-');
      seedHome(home, populatedSeed());
      fs.mkdirSync(path.join(home, 'import'), { recursive: true });
      const record = {
        jobId: 'settled', state, treePath: tree, snapshotPath: null,
        startedAt: new Date().toISOString(), stage: 'verify',
      };
      fs.writeFileSync(path.join(home, 'import', 'job.json'), JSON.stringify(record));

      const rec = runRecovery(home);
      assert.strictEqual(rec.action, 'none', `${state}: ${JSON.stringify(rec)}`);
      assert.deepStrictEqual(readJobFile(home), record,
        `a ${state} record must survive the boot for rollback`);
    }
  });

  test('no job.json at all: recovery is a no-op', () => {
    const home = newDir('eh-rec-home-');
    seedHome(home, populatedSeed());
    const rec = runRecovery(home);
    assert.strictEqual(rec.action, 'none');
    assert.strictEqual(rec.cleared, false);
  });
});
