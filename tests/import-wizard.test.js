// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/import-wizard.test.js
// The live import job engine (lib/import/wizard.js) and the write-freeze
// gate (lib/import/freeze.js): a fresh target applies without ceremony, a
// populated target hides behind a single-delivery confirm nonce, the wipe is
// total (old cards, rows, pushes, strays), verification failure keeps the
// backups and rollback restores the pre-import state deep-equal, a retry
// re-runs the FULL wipe so nothing doubles, the sweep touches exactly the
// backup paths this run created, and the freeze engages around apply and
// releases on both the done and failed paths.
//
// Fresh-require generation tests only (import-wizard-harness) — never mix
// spawnServer sandbox tests into this file (require-cache purge makes the
// runner hang).

const { test, describe, before, after, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  card, norm, stepPush, purgeRepoModules, seedHome, buildSourceTree,
  targetGen, teardownGen, preImportBackups, readJobFile,
} = require('./helpers/import-wizard-harness');

process.env.HEALTH_HOME_WARNED = '1';

let sqliteAvailable = true;
try { require('node:sqlite'); } catch { sqliteAvailable = false; }
const skip = sqliteAvailable ? false : 'node:sqlite unavailable on this Node';

const EMBEDDED_ROWS = [{ date: '2026-01-01', kg: 80 }, { date: '2026-01-02', kg: 79.5 }];
const INLINE_ROWS = [{ date: '2026-05-01', note: 'pre-migration' }];
const OLD_ROWS = [{ date: '2025-12-01', mood: 3 }, { date: '2025-12-02', mood: 4 }];
const TREE_PUSHES = [stepPush('2026-05-01', 4100), stepPush('2026-05-02', 5200)];
const REPORT_BODY = '# Bloods\n\nAll fine.\n';

const tmpDirs = [];
function newHome(prefix = 'eh-wiz-tgt-') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(home);
  fs.mkdirSync(path.join(home, 'data'), { recursive: true });
  return home;
}

// The standard source: two datastore-backed cards, one inline, one no-data,
// one null-data, two HAE pushes, a config and a report.
function standardSpec() {
  return {
    cards: {
      'embedded.json': card('embedded'),
      'inline.json': card('inline', { data: INLINE_ROWS }),
      'nodata.json': card('nodata'),
      'nulldata.json': card('nulldata'),
    },
    rows: { embedded: EMBEDDED_ROWS, nulldata: null },
    pushes: TREE_PUSHES,
    config: { display: { theme: 'dark' } },
    reports: { 'bloods.md': REPORT_BODY },
  };
}
const STANDARD_VERIFIED = { cards: 4, pushes: 2, reports: 1 };

function populatedSeed() {
  return {
    cards: { 'old.json': card('old') },
    rows: { old: OLD_ROWS },
    pushes: [stepPush('2025-12-01', 900)],
  };
}

// Apply/rollback detach since #633: they answer with the applying snapshot
// and the pipeline settles behind awaitIdle(). These wrappers assert the
// detach shape at every call site and hand back the terminal status, so the
// end-state assertions below read exactly as they did when the calls
// blocked. Refusals still answer synchronously and pass through untouched.
// The answer is 'applying' unless the pipeline died before its first await
// (an injected failure in the synchronous prefix settles synchronously).
async function applySettled(wizard, args) {
  const started = wizard.confirmAndApply(args);
  if (started.code) return started;
  assert.ok(started.state === 'applying' || started.state === 'failed',
    `detach answered '${started.state}', not a job snapshot`);
  return wizard.awaitIdle();
}

async function rollbackSettled(wizard) {
  const started = wizard.rollback();
  if (started.code) return started;
  assert.ok(started.state === 'applying' || started.state === 'failed',
    `detach answered '${started.state}', not a job snapshot`);
  return wizard.awaitIdle();
}

describe('import wizard', { skip }, () => {
  let tree;
  let gen = null;

  before(() => {
    ({ tree } = buildSourceTree(standardSpec(), tmpDirs));
  });

  after(() => {
    while (tmpDirs.length) {
      try { fs.rmSync(tmpDirs.pop(), { recursive: true, force: true }); } catch {}
    }
  });

  afterEach(() => {
    teardownGen(gen);
    gen = null;
  });

  describe('freeze gate', () => {
    test('engage/frozen/release, and a second engage throws', async () => {
      purgeRepoModules();
      const freeze = require('../lib/import/freeze');
      try {
        assert.strictEqual(freeze.frozen(), null);
        assert.strictEqual(freeze.engage('import'), true);
        assert.strictEqual(freeze.frozen(), 'import');
        assert.throws(() => freeze.engage('second'), /already engaged \(import\)/);
        assert.strictEqual(freeze.frozen(), 'import', 'a refused engage must not disturb the gate');
        assert.strictEqual(freeze.release(), true);
        assert.strictEqual(freeze.frozen(), null);
        assert.strictEqual(freeze.release(), false, 'release is idempotent');
      } finally {
        freeze.release();
      }
    });
  });

  test('fresh target: no confirm ceremony, applies end to end, serves live', async () => {
    gen = targetGen(seedHome(newHome(), { welcome: true }));
    const wizard = gen.wizardMod.createWizard(gen.deps);

    const started = await wizard.startFromTree(tree);
    assert.strictEqual(started.state, 'awaiting-confirm');
    assert.strictEqual(started.requiresConfirm, false);
    assert.ok(!('confirmNonce' in started));
    assert.deepStrictEqual(started.plan,
      { cards: 4, cardsWithData: 2, samplesPushes: 2, reports: 1 },
      'the status snapshot carries the plan counts for the confirm preview');

    const res = await applySettled(wizard, {});
    assert.strictEqual(res.state, 'done', JSON.stringify(res.findings, null, 2));
    assert.deepStrictEqual(res.verified, STANDARD_VERIFIED);
    assert.strictEqual(res.snapshotPath, null, 'a fresh target must not be snapshotted');

    // The LIVE registry serves the imported set with no restart: meta via
    // reload, data via the shared store handle.
    assert.deepStrictEqual(norm(gen.registry.get('embedded').data), norm(EMBEDDED_ROWS));
    assert.deepStrictEqual(norm(gen.registry.get('inline').data), norm(INLINE_ROWS));
    assert.strictEqual(gen.registry.get('nulldata').data, null);
    assert.strictEqual(gen.registry.get('welcome'), null, 'the seeded welcome card must be gone');
    assert.ok(!fs.existsSync(path.join(gen.home, 'data', 'welcome.klebb.json')));
    assert.strictEqual(gen.store.dataUpdatedAt('welcome'), null);

    assert.deepStrictEqual(preImportBackups(gen.home), [], 'backups must be swept on full success');
    assert.strictEqual(Number(gen.samples.pushCount()), 2);
    assert.strictEqual(readJobFile(gen.home).state, 'done');
    assert.strictEqual(gen.freeze.frozen(), null, 'freeze must be released after done');
  });

  test('populated target: nonce delivered exactly once, wrong nonce holds, right nonce replaces everything', async () => {
    gen = targetGen(seedHome(newHome(), populatedSeed()));
    const wizard = gen.wizardMod.createWizard(gen.deps);

    const started = await wizard.startFromTree(tree);
    assert.strictEqual(started.state, 'awaiting-confirm');
    assert.strictEqual(started.requiresConfirm, true);
    assert.ok(!('confirmNonce' in started), 'startFromTree must not hand out the nonce');

    const st1 = wizard.status();
    assert.match(st1.confirmNonce, /^[0-9a-f]{32}$/);
    const st2 = wizard.status();
    assert.ok(!('confirmNonce' in st2), 'the nonce is delivered exactly once');

    const wrong = await wizard.confirmAndApply({ nonce: 'not-it' });
    assert.strictEqual(wrong.code, 'CONFIRM_REQUIRED');
    const missing = await applySettled(wizard, {});
    assert.strictEqual(missing.code, 'CONFIRM_REQUIRED');
    assert.strictEqual(wizard.status().state, 'awaiting-confirm', 'a refused confirm must not move the job');
    assert.deepStrictEqual(norm(gen.registry.get('old').data), norm(OLD_ROWS), 'a refused confirm must not touch data');

    const res = await applySettled(wizard, { nonce: st1.confirmNonce });
    assert.strictEqual(res.state, 'done', JSON.stringify(res.findings, null, 2));
    assert.deepStrictEqual(res.verified, STANDARD_VERIFIED);

    // Old instance state is gone in every plane: file, registry, rows, pushes.
    assert.strictEqual(gen.registry.get('old'), null);
    assert.ok(!fs.existsSync(path.join(gen.home, 'data', 'old.json')));
    assert.strictEqual(gen.store.dataUpdatedAt('old'), null);
    assert.strictEqual(Number(gen.samples.pushCount()), 2, 'target pushes must be replaced, not merged');
    assert.deepStrictEqual(norm(gen.registry.get('embedded').data), norm(EMBEDDED_ROWS));

    // The snapshot holds the pre-import state.
    assert.ok(res.snapshotPath, 'a populated target must be snapshotted');
    assert.ok(fs.existsSync(path.join(res.snapshotPath, 'klebb-export.json')));
    const snapCard = JSON.parse(fs.readFileSync(path.join(res.snapshotPath, 'data', 'old.json'), 'utf8'));
    assert.deepStrictEqual(norm(snapCard.data), norm(OLD_ROWS));
  });

  test('the wipe spares the raw archives nothing else can restore (#656)', async () => {
    // auto-export/raw and raw.migrated-* are excluded from every export and
    // therefore from the rollback snapshot too: destroying them at wipe
    // time loses the only copy. Everything else under auto-export/ is
    // restorable from the archive and must still go.
    const home = newHome();
    gen = targetGen(seedHome(home, populatedSeed()));
    const rawDir = path.join(home, 'data', 'auto-export', 'raw');
    const migratedDir = path.join(home, 'data', 'auto-export', 'raw.migrated-20260810T000000000Z');
    fs.mkdirSync(rawDir, { recursive: true });
    fs.mkdirSync(migratedDir, { recursive: true });
    fs.writeFileSync(path.join(rawDir, 'push-1.json'), '{"data":{"metrics":[]}}');
    fs.writeFileSync(path.join(migratedDir, 'old.json'), '{"kept":true}');
    fs.writeFileSync(path.join(home, 'data', 'auto-export', 'stray.json'), '{}');

    const wizard = gen.wizardMod.createWizard(gen.deps);
    await wizard.startFromTree(tree);
    const res = await applySettled(wizard, { nonce: wizard.status().confirmNonce });
    assert.strictEqual(res.state, 'done', JSON.stringify(res.findings, null, 2));

    assert.strictEqual(fs.readFileSync(path.join(rawDir, 'push-1.json'), 'utf8'),
      '{"data":{"metrics":[]}}', 'the raw archive must survive the wipe');
    assert.strictEqual(fs.readFileSync(path.join(migratedDir, 'old.json'), 'utf8'), '{"kept":true}');
    assert.ok(!fs.existsSync(path.join(home, 'data', 'auto-export', 'stray.json')),
      'restorable auto-export content must still be wiped');

    // The rollback is a second full wipe + snapshot restore: same spares.
    // stray.json comes back BY the restore (the snapshot holds pre-import
    // state); the raw archives survive despite being in no snapshot.
    const rolled = await rollbackSettled(wizard);
    assert.strictEqual(rolled.state, 'done', JSON.stringify(rolled.findings, null, 2));
    assert.ok(fs.existsSync(path.join(rawDir, 'push-1.json')), 'rollback must spare the raw archive');
    assert.ok(fs.existsSync(path.join(migratedDir, 'old.json')));
    assert.ok(fs.existsSync(path.join(home, 'data', 'auto-export', 'stray.json')),
      'the snapshot carries restorable auto-export content and rollback brings it back');
  });

  test('verify failure: failed with findings, backups kept, rollback restores pre-import state deep-equal', async () => {
    const home = newHome();
    gen = targetGen(seedHome(home, { ...populatedSeed(), config: { mine: true } }));
    // Corrupt one card between import and verify, through the same store
    // handle, so verification has something real to catch.
    const deps = {
      ...gen.deps,
      importerFactory: (store) => {
        const real = gen.deps.importerFactory(store);
        return {
          importParsedFile(file, parsed) {
            const r = real.importParsedFile(file, parsed);
            if (r.imported && r.id === 'embedded') store.setData('embedded', [{ corrupted: true }]);
            return r;
          },
        };
      },
    };
    const wizard = gen.wizardMod.createWizard(deps);
    await wizard.startFromTree(tree);
    const res = await applySettled(wizard, { nonce: wizard.status().confirmNonce });

    assert.strictEqual(res.state, 'failed');
    const mismatch = res.findings.filter(f => f.code === 'VERIFY_CARD_MISMATCH');
    assert.strictEqual(mismatch.length, 1, JSON.stringify(res.findings, null, 2));
    assert.strictEqual(mismatch[0].ref, 'data/embedded.json');
    assert.ok(res.findings.some(f => f.code === 'APPLY_BACKUPS_KEPT'));
    assert.strictEqual(preImportBackups(home).length, 3, 'backups must be kept on failure');
    assert.strictEqual(gen.freeze.frozen(), null, 'freeze must be released after failed');
    assert.strictEqual(readJobFile(home).state, 'failed');

    // Rollback: the same pipeline fed the snapshot, no nonce, no new snapshot.
    const rb = await rollbackSettled(wizard);
    assert.strictEqual(rb.state, 'done', JSON.stringify(rb.findings, null, 2));
    assert.strictEqual(rb.rolledBack, true);
    assert.deepStrictEqual(norm(gen.registry.get('old').data), norm(OLD_ROWS));
    assert.strictEqual(gen.registry.get('embedded'), null, 'imported cards must be gone after rollback');
    assert.strictEqual(Number(gen.samples.pushCount()), 1, 'the original push history must be back');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')),
      { mine: true }, 'the pre-import config must survive');
  });

  test('rollback without a snapshot fails cleanly', async () => {
    gen = targetGen(seedHome(newHome(), { welcome: true }));
    const deps = {
      ...gen.deps,
      importerFactory: (store) => {
        const real = gen.deps.importerFactory(store);
        return {
          importParsedFile(file, parsed) {
            const r = real.importParsedFile(file, parsed);
            if (r.imported && r.id === 'embedded') store.setData('embedded', [{ corrupted: true }]);
            return r;
          },
        };
      },
    };
    const wizard = gen.wizardMod.createWizard(deps);
    await wizard.startFromTree(tree);
    const res = await applySettled(wizard, {});
    assert.strictEqual(res.state, 'failed');
    const rb = await rollbackSettled(wizard);
    assert.strictEqual(rb.code, 'NO_SNAPSHOT');
    assert.strictEqual(wizard.status().state, 'failed', 'a refused rollback must not move the job');
  });

  test('single job at a time: JOB_ACTIVE on a second start, abort clears', async () => {
    gen = targetGen(seedHome(newHome(), { welcome: true }));
    const wizard = gen.wizardMod.createWizard(gen.deps);

    assert.strictEqual(wizard.abort().code, 'BAD_STATE', 'abort with no job must refuse');

    await wizard.startFromTree(tree);
    const second = await wizard.startFromTree(tree);
    assert.strictEqual(second.code, 'JOB_ACTIVE');

    const aborted = wizard.abort();
    assert.strictEqual(aborted.ok, true);
    assert.strictEqual(wizard.status().state, 'idle');
    assert.strictEqual(readJobFile(gen.home), null, 'abort must clear job.json');

    const again = await wizard.startFromTree(tree);
    assert.strictEqual(again.state, 'awaiting-confirm');
    const done = await applySettled(wizard, {});
    assert.strictEqual(done.state, 'done');
    assert.strictEqual((await wizard.startFromTree(tree)).code, 'JOB_ACTIVE',
      'a done job still blocks a new start until abort');
    assert.strictEqual(wizard.abort().ok, true, 'abort from done clears the record');
  });

  test('a tree that fails validation ends the job failed, and cannot be retried', async () => {
    gen = targetGen(seedHome(newHome(), { welcome: true }));
    const wizard = gen.wizardMod.createWizard(gen.deps);
    const badTree = fs.mkdtempSync(path.join(os.tmpdir(), 'eh-wiz-bad-'));
    tmpDirs.push(badTree);
    fs.mkdirSync(path.join(badTree, 'data'), { recursive: true });

    const res = await wizard.startFromTree(badTree);
    assert.strictEqual(res.state, 'failed');
    assert.ok(res.findings.some(f => f.code === 'VAL_NO_MANIFEST'), JSON.stringify(res.findings));
    assert.strictEqual((await applySettled(wizard, {})).code, 'BAD_STATE');
    assert.strictEqual((await rollbackSettled(wizard)).code, 'NO_SNAPSHOT');
    assert.strictEqual(wizard.abort().ok, true);
  });

  test('freeze engages around apply and releases on the failed finally path', async () => {
    gen = targetGen(seedHome(newHome(), populatedSeed()));
    const frozenAt = {};
    let throwAtCopy = true;
    const deps = {
      ...gen.deps,
      onStage: (stage) => {
        frozenAt[stage] = gen.freeze.frozen();
        if (stage === 'copy' && throwAtCopy) {
          throwAtCopy = false;
          throw new Error('injected copy failure');
        }
      },
    };
    const wizard = gen.wizardMod.createWizard(deps);
    await wizard.startFromTree(tree);
    const res = await applySettled(wizard, { nonce: wizard.status().confirmNonce });

    assert.strictEqual(res.state, 'failed');
    assert.ok(res.findings.some(f => f.code === 'APPLY_ERROR' && /injected copy failure/.test(f.message)));
    assert.strictEqual(frozenAt.snapshot, 'import',
      'the snapshot must run behind the gate: a write landing after the async re-validate would otherwise reach neither the snapshot nor the wiped target');
    assert.strictEqual(frozenAt.wipe, 'import', 'the wipe must run behind the freeze');
    assert.strictEqual(frozenAt.copy, 'import', 'the copy must run behind the freeze');
    assert.strictEqual(gen.freeze.frozen(), null, 'freeze must be released by the finally path');

    // And the retry (full pipeline again) completes behind the freeze too.
    const retry = await applySettled(wizard, {});
    assert.strictEqual(retry.state, 'done', JSON.stringify(retry.findings, null, 2));
    assert.strictEqual(frozenAt.drain, 'import');
    assert.strictEqual(frozenAt.import, 'import');
    assert.strictEqual(frozenAt.verify, 'import');
    assert.strictEqual(gen.freeze.frozen(), null, 'freeze must be released after done');
  });

  test('retry after a mid-pipeline failure re-runs the FULL wipe: no doubled pushes or rows', async () => {
    const home = newHome();
    gen = targetGen(seedHome(home, populatedSeed()));
    let failImport = true;
    const deps = {
      ...gen.deps,
      importerFactory: (store) => {
        const real = gen.deps.importerFactory(store);
        return {
          importParsedFile(file, parsed) {
            if (failImport) {
              failImport = false;
              throw new Error('injected import failure');
            }
            return real.importParsedFile(file, parsed);
          },
        };
      },
    };
    const wizard = gen.wizardMod.createWizard(deps);
    await wizard.startFromTree(tree);
    const first = await applySettled(wizard, { nonce: wizard.status().confirmNonce });
    assert.strictEqual(first.state, 'failed');
    // The failed run already drained the tree's pushes: the exact state a
    // wipe-less retry would double.
    assert.strictEqual(Number(gen.samples.pushCount()), 2);

    const retry = await applySettled(wizard, {});
    assert.strictEqual(retry.state, 'done', JSON.stringify(retry.findings, null, 2));
    assert.deepStrictEqual(retry.verified, STANDARD_VERIFIED);
    assert.strictEqual(Number(gen.samples.pushCount()), 2, 'pushes doubled: the retry skipped the wipe');
    const { countSql } = require('./helpers/import-wizard-harness');
    assert.strictEqual(countSql(home, "SELECT COUNT(*) AS n FROM rows WHERE card_id = 'embedded'"),
      EMBEDDED_ROWS.length, 'rows doubled: the retry skipped the wipe');
    assert.strictEqual(countSql(home, 'SELECT COUNT(*) AS n FROM hae_samples'), 2);
  });

  test('sweep removes exactly the backup paths this run created', async () => {
    const home = newHome();
    gen = targetGen(seedHome(home, { welcome: true }));
    const decoy = 'decoy.json.pre-import-20260101T000000000Z.json';
    const deps = {
      ...gen.deps,
      onStage: (stage) => {
        // Planted after verify, before the sweep runs: an exact-path sweep
        // cannot see it, a glob or timestamp-window sweep eats it.
        if (stage === 'sweep') fs.writeFileSync(path.join(home, 'data', decoy), '{}');
      },
    };
    const wizard = gen.wizardMod.createWizard(deps);
    await wizard.startFromTree(tree);
    const res = await applySettled(wizard, {});
    assert.strictEqual(res.state, 'done', JSON.stringify(res.findings, null, 2));
    assert.ok(res.findings.some(f => f.code === 'APPLY_BACKUPS_SWEPT'));
    assert.deepStrictEqual(preImportBackups(home), [decoy],
      'the sweep must remove exactly its own backups and nothing else');
    const audit = fs.readdirSync(path.join(home, 'data', 'auto-export'))
      .filter(n => n.startsWith('samples.json.imported-'));
    assert.strictEqual(audit.length, 1, 'the drain audit file must survive the sweep');
  });

  test('hole 12: an HAE-backed card without a data key verifies ok even when replay backfilled it', async () => {
    const { tree: haeTree } = buildSourceTree({
      cards: { 'steps.json': card('steps', { meta: { ingest: { source: 'hae', metric: 'step_count' } } }) },
      pushes: TREE_PUSHES,
    }, tmpDirs);
    gen = targetGen(seedHome(newHome(), { welcome: true }));
    const deps = {
      ...gen.deps,
      onStage: (stage) => {
        // Simulate the boot replay writing the card between reload and
        // verify; without the HAE exemption this reads as a mismatch.
        if (stage === 'verify') gen.store.setData('steps', [{ date: '2026-05-01', steps: 4100 }]);
      },
    };
    const wizard = gen.wizardMod.createWizard(deps);
    await wizard.startFromTree(haeTree);
    const res = await applySettled(wizard, {});
    assert.strictEqual(res.state, 'done', JSON.stringify(res.findings, null, 2));
    assert.deepStrictEqual(res.verified, { cards: 1, pushes: 2, reports: 0 });
    assert.ok(!res.findings.some(f => f.code === 'VERIFY_CARD_MISMATCH'));
  });

  test('hole 12 is scoped: a non-HAE card that grew data still mismatches', async () => {
    const { tree: mixedTree } = buildSourceTree({
      cards: {
        'steps.json': card('steps', { meta: { ingest: { source: 'hae', metric: 'step_count' } } }),
        'plain.json': card('plain'),
      },
      pushes: TREE_PUSHES,
    }, tmpDirs);
    gen = targetGen(seedHome(newHome(), { welcome: true }));
    const deps = {
      ...gen.deps,
      onStage: (stage) => {
        if (stage === 'verify') {
          gen.store.setData('steps', [{ date: '2026-05-01', steps: 4100 }]);
          gen.store.setData('plain', [{ date: '2026-05-01', oops: true }]);
        }
      },
    };
    const wizard = gen.wizardMod.createWizard(deps);
    await wizard.startFromTree(mixedTree);
    const res = await applySettled(wizard, {});
    assert.strictEqual(res.state, 'failed');
    const mismatch = res.findings.filter(f => f.code === 'VERIFY_CARD_MISMATCH');
    assert.strictEqual(mismatch.length, 1, JSON.stringify(res.findings, null, 2));
    assert.strictEqual(mismatch[0].ref, 'data/plain.json', 'only the non-HAE card may mismatch');
  });

  test('config keep-existing: a populated target keeps its config and the finding says so', async () => {
    const home = newHome();
    gen = targetGen(seedHome(home, { ...populatedSeed(), config: { mine: true } }));
    const wizard = gen.wizardMod.createWizard(gen.deps);
    await wizard.startFromTree(tree);
    const res = await applySettled(wizard, { nonce: wizard.status().confirmNonce });
    assert.strictEqual(res.state, 'done', JSON.stringify(res.findings, null, 2));
    assert.ok(res.findings.some(f => f.code === 'APPLY_CONFIG_KEPT'));
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')),
      { mine: true });
  });

  test('wipe clears directories under data/: no previous-owner state survives', async () => {
    const home = newHome();
    gen = targetGen(seedHome(home, populatedSeed()));
    // State the archive knows nothing about, so the copy cannot overwrite
    // it: HAE ingest discovery, diagnostics, a quarantined payload, and a
    // migration archive holding the old owner's original card files.
    const autoDir = path.join(home, 'data', 'auto-export');
    const migDir = path.join(home, 'data', '_archive', 'migration-2025-12-01');
    fs.mkdirSync(path.join(autoDir, 'unparsed'), { recursive: true });
    fs.mkdirSync(migDir, { recursive: true });
    fs.writeFileSync(path.join(autoDir, 'discovered.json'),
      JSON.stringify({ metrics: [{ name: 'previous_owner_metric' }] }));
    fs.writeFileSync(path.join(autoDir, 'last-push.json'), JSON.stringify({ at: '2025-12-01' }));
    fs.writeFileSync(path.join(autoDir, 'unparsed', 'body.json'), '{"theirs":true}');
    fs.writeFileSync(path.join(migDir, 'old.json'), JSON.stringify(card('old')));
    assert.ok(fs.existsSync(path.join(autoDir, 'discovered.json')), 'precondition: state seeded');

    const wizard = gen.wizardMod.createWizard(gen.deps);
    await wizard.startFromTree(tree);
    const res = await applySettled(wizard, { nonce: wizard.status().confirmNonce });
    assert.strictEqual(res.state, 'done', JSON.stringify(res.findings, null, 2));

    assert.ok(!fs.existsSync(path.join(autoDir, 'discovered.json')),
      "the previous owner's discovered metrics must not survive a wipe-first replace");
    assert.ok(!fs.existsSync(path.join(autoDir, 'last-push.json')));
    assert.ok(!fs.existsSync(path.join(autoDir, 'unparsed')));
    assert.ok(!fs.existsSync(path.join(home, 'data', '_archive')),
      "a migration archive of the previous owner's card files must not survive either");
    // The wipe is indiscriminate about directories, so prove the copy still
    // restored the tree's own: the four standard cards are back.
    assert.strictEqual(gen.registry.list().length, STANDARD_VERIFIED.cards);
  });

  test('wipe clears a stale samples inbox: a history-less archive imports no old pushes', async () => {
    // Reachable whenever a samples.json is sitting in the target's inbox slot
    // at apply time: dropped in by hand, or left behind by a drain whose
    // rename-aside failed. The drain runs after the copy regardless of what
    // the archive carries, so without the wipe it imports the OLD history
    // into the restored tree and verification fails against a plan that
    // expected none.
    const { tree: noHistoryTree } = buildSourceTree({
      cards: { 'embedded.json': card('embedded') },
      rows: { embedded: EMBEDDED_ROWS },
    }, tmpDirs);
    const home = newHome();
    gen = targetGen(seedHome(home, populatedSeed()));
    const autoDir = path.join(home, 'data', 'auto-export');
    fs.mkdirSync(autoDir, { recursive: true });
    const stale = path.join(autoDir, 'samples.json');
    fs.writeFileSync(stale, JSON.stringify({ version: 1, pushes: [stepPush('2025-11-01', 700)] }));

    const wizard = gen.wizardMod.createWizard(gen.deps);
    const started = await wizard.startFromTree(noHistoryTree);
    assert.strictEqual(started.plan.samplesPushes, 0, 'precondition: the archive carries no history');
    assert.ok(fs.existsSync(stale), 'precondition: a stale inbox file is present');

    const res = await applySettled(wizard, { nonce: wizard.status().confirmNonce });
    assert.strictEqual(res.state, 'done', JSON.stringify(res.findings, null, 2));
    assert.strictEqual(Number(gen.samples.pushCount()), 0,
      "the previous instance's pushes must not be drained into the restored tree");
    assert.ok(!fs.existsSync(stale), 'the stale inbox file must be gone, not merely undrained');
    let left = [];
    try { left = fs.readdirSync(autoDir); } catch {}
    assert.deepStrictEqual(left.filter(n => n.startsWith('samples.json')), [],
      'a stale inbox file must be wiped, not drained and renamed aside');
  });

  test('detach: applying is persisted, the freeze is engaged and rivals refuse before control returns', async () => {
    gen = targetGen(seedHome(newHome(), { welcome: true }));
    const wizard = gen.wizardMod.createWizard(gen.deps);
    await wizard.startFromTree(tree);

    const started = wizard.confirmAndApply({});
    // Every assertion below runs before ANY pipeline await has resolved:
    // the detach contract is synchronous or it is a race. A transition (or
    // freeze engage) deferred past the first await would let a concurrent
    // apply start a second pipeline, or a read slip through unfrozen.
    assert.strictEqual(started.state, 'applying');
    assert.strictEqual(readJobFile(gen.home).state, 'applying',
      'the applying state must be persisted before the caller regains control');
    assert.strictEqual(gen.freeze.frozen(), 'import',
      'the write freeze must be engaged before the caller regains control');
    assert.strictEqual(wizard.confirmAndApply({}).code, 'BAD_STATE',
      'a concurrent apply must refuse synchronously');
    assert.strictEqual(wizard.abort().code, 'BAD_STATE', 'abort while applying must refuse');
    assert.strictEqual(wizard.rollback().code, 'BAD_STATE', 'rollback while applying must refuse');
    assert.strictEqual(wizard.status().state, 'applying');

    const res = await wizard.awaitIdle();
    assert.strictEqual(res.state, 'done', JSON.stringify(res.findings, null, 2));
    assert.deepStrictEqual(res.verified, STANDARD_VERIFIED);
    assert.strictEqual(gen.freeze.frozen(), null, 'freeze must be released after done');
    assert.deepStrictEqual(norm(gen.registry.get('embedded').data), norm(EMBEDDED_ROWS));
  });

  test('detached boot resume: recoverAtBoot answers resuming with the freeze already engaged, then settles', async () => {
    gen = targetGen(seedHome(newHome(), populatedSeed()));
    const wizard = gen.wizardMod.createWizard(gen.deps);
    await wizard.startFromTree(tree);
    const done = await applySettled(wizard, { nonce: wizard.status().confirmNonce });
    assert.strictEqual(done.state, 'done', JSON.stringify(done.findings, null, 2));
    // Rewind the record to mid-apply: exactly what a crash leaves behind.
    const record = readJobFile(gen.home);
    record.state = 'applying';
    record.stage = 'copy';
    fs.writeFileSync(path.join(gen.home, 'import', 'job.json'), JSON.stringify(record, null, 2));

    const rec = gen.recoverMod.recoverAtBoot({ ...gen.deps });
    assert.strictEqual(rec.action, 'resuming', JSON.stringify(rec.status || rec));
    assert.strictEqual(rec.source, 'tree');
    // recoverAtBoot is synchronous: by here the resume pipeline has
    // persisted 'applying' and engaged the freeze, and its first await has
    // not yet resolved, so a boot releasing its request gate on this return
    // can never expose an unfrozen mid-wipe home.
    assert.strictEqual(rec.status.state, 'applying');
    assert.strictEqual(gen.freeze.frozen(), 'import',
      'the freeze must be engaged before recoverAtBoot returns');

    const result = await rec.settled;
    assert.strictEqual(result.state, 'done', JSON.stringify(result.findings, null, 2));
    assert.strictEqual(result.recovered, true);
    assert.strictEqual(gen.freeze.frozen(), null, 'freeze must be released after the resume settles');
    assert.deepStrictEqual(norm(gen.registry.get('embedded').data), norm(EMBEDDED_ROWS));
  });

  // Filtered replace (#646): a selection narrows what comes BACK, never what
  // the wipe takes. Every test here also asserts the destruction the operator
  // authorised still happened in full, because that is the property a user
  // reading "import only these cards" is most likely to get wrong.
  describe('selection', () => {
    function selectionOf(status, over = {}) {
      return {
        cards: status.items.cards.map(c => c.id),
        reports: status.items.reports.map(r => r.key),
        history: true,
        ...over,
      };
    }

    function liveIds(g) {
      return g.registry.list().map(e => e.id).sort();
    }

    test('the archive is offered artefact by artefact, next to what the instance holds today', async () => {
      gen = targetGen(seedHome(newHome(), populatedSeed()));
      const wizard = gen.wizardMod.createWizard(gen.deps);
      const started = await wizard.startFromTree(tree);

      assert.deepStrictEqual(started.items.cards, [
        { id: 'embedded', file: 'data/embedded.json', label: 'embedded', rows: EMBEDDED_ROWS.length, hae: false, data: 'embedded' },
        { id: 'inline', file: 'data/inline.json', label: 'inline', rows: INLINE_ROWS.length, hae: false, data: 'inline' },
        { id: 'nodata', file: 'data/nodata.json', label: 'nodata', rows: 0, hae: false, data: 'none' },
        { id: 'nulldata', file: 'data/nulldata.json', label: 'nulldata', rows: 0, hae: false, data: 'null' },
      ]);
      assert.deepStrictEqual(started.items.reports, [{
        key: 'reports/bloods.md',
        label: 'bloods',
        files: ['reports/bloods.md'],
        original: null,
        bytes: REPORT_BODY.length,
      }]);
      assert.deepStrictEqual(started.items.history, { pushes: 2 });
      // What the confirm panel needs to say plainly that all of THIS goes,
      // whatever the selection restores afterwards.
      assert.deepStrictEqual(started.target, { cards: 1, reports: 0, pushes: 1 });
      assert.strictEqual(started.selection, null, 'no selection until one is confirmed');
    });

    test('everything ticked is the wholesale import, and the recorded selection says so', async () => {
      gen = targetGen(seedHome(newHome(), { welcome: true }));
      const wizard = gen.wizardMod.createWizard(gen.deps);
      const started = await wizard.startFromTree(tree);
      const selection = selectionOf(started);

      const res = await applySettled(wizard, { selection });
      assert.strictEqual(res.state, 'done', JSON.stringify(res.findings, null, 2));
      assert.deepStrictEqual(res.verified, STANDARD_VERIFIED,
        'an all-ticked selection must import exactly what no selection imports');
      assert.deepStrictEqual(res.selection, selection);
      assert.deepStrictEqual(liveIds(gen), ['embedded', 'inline', 'nodata', 'nulldata']);
      assert.deepStrictEqual(norm(gen.registry.get('embedded').data), norm(EMBEDDED_ROWS));
      assert.strictEqual(Number(gen.samples.pushCount()), 2);
      assert.ok(fs.existsSync(path.join(gen.home, 'reports', 'bloods.md')));
    });

    test('cards only: unticked artefacts stay out, and the target still lost everything', async () => {
      const home = newHome();
      gen = targetGen(seedHome(home, populatedSeed()));
      const wizard = gen.wizardMod.createWizard(gen.deps);
      const started = await wizard.startFromTree(tree);
      const res = await applySettled(wizard, {
        nonce: wizard.status().confirmNonce,
        selection: { cards: ['embedded', 'nulldata'], reports: [], history: false },
      });

      assert.strictEqual(res.state, 'done', JSON.stringify(res.findings, null, 2));
      assert.deepStrictEqual(res.verified, { cards: 2, pushes: 0, reports: 0 });
      assert.deepStrictEqual(liveIds(gen), ['embedded', 'nulldata']);
      assert.deepStrictEqual(norm(gen.registry.get('embedded').data), norm(EMBEDDED_ROWS));
      assert.strictEqual(gen.registry.get('nulldata').data, null);
      assert.ok(!fs.existsSync(path.join(home, 'data', 'inline.json')),
        'an unticked card must not be copied in at all');
      assert.ok(!fs.existsSync(path.join(home, 'reports', 'bloods.md')));
      assert.strictEqual(Number(gen.samples.pushCount()), 0);

      // The inbox file is the only gate history needs: never copied, so the
      // drain finds nothing and leaves no audit rename behind either.
      const autoDir = path.join(home, 'data', 'auto-export');
      let left = [];
      try { left = fs.readdirSync(autoDir); } catch {}
      assert.deepStrictEqual(left.filter(n => n.startsWith('samples.json')), []);

      // Filtered replace, not merge: what was here before is gone regardless
      // of what came back. This is the honest-panel property.
      assert.strictEqual(gen.registry.get('old'), null);
      assert.strictEqual(gen.store.dataUpdatedAt('old'), null);
      assert.ok(!fs.existsSync(path.join(home, 'data', 'old.json')));
      assert.strictEqual(started.target.pushes, 1, "precondition: the target's own push history existed");
    });

    test('an HAE card with history unticked comes back empty, and says so in the counts', async () => {
      const { tree: haeTree } = buildSourceTree({
        cards: { 'steps.json': card('steps', { meta: { ingest: { source: 'hae', metric: 'step_count' } } }) },
        pushes: TREE_PUSHES,
      }, tmpDirs);
      gen = targetGen(seedHome(newHome(), { welcome: true }));
      const wizard = gen.wizardMod.createWizard(gen.deps);
      const started = await wizard.startFromTree(haeTree);
      assert.strictEqual(started.items.cards[0].hae, true,
        'the preview must be able to warn that this card is history-fed');

      const res = await applySettled(wizard, {
        selection: { cards: ['steps'], reports: [], history: false },
      });
      assert.strictEqual(res.state, 'done', JSON.stringify(res.findings, null, 2));
      assert.deepStrictEqual(res.verified, { cards: 1, pushes: 0, reports: 0 });
      assert.ok(gen.registry.get('steps'), 'the card itself must be restored');
      assert.strictEqual(gen.registry.get('steps').data, null,
        'its rows live in the push history, which was not selected');
      assert.strictEqual(gen.store.dataUpdatedAt('steps'), null);
      assert.strictEqual(Number(gen.samples.pushCount()), 0);
    });

    test('an ingested report drags its archived original along; the unticked one stays out', async () => {
      const ARCHIVE_NAME = '2026-08-01-bloods.pdf';
      const ARCHIVE_BYTES = 'PDF BYTES';
      const INGESTED = [
        '---',
        'klebb_ingest: v2',
        'ingested_at: 2026-08-01T00:00:00.000Z',
        `source_file: ${ARCHIVE_NAME}`,
        'source_format: pdf',
        `archive_path: reports/_archive/${ARCHIVE_NAME}`,
        'title: Blood panel',
        '---',
        '',
        '# Blood panel',
        '',
      ].join('\n');
      const { tree: reportTree } = buildSourceTree({
        cards: { 'embedded.json': card('embedded') },
        rows: { embedded: EMBEDDED_ROWS },
        reports: { 'bloods.md': INGESTED, 'notes.md': REPORT_BODY },
      }, tmpDirs);
      // The archive dir is hand-added: the export CLI's report set comes from
      // the source home, and seeding a nested reports path is not its job.
      fs.mkdirSync(path.join(reportTree, 'reports', '_archive'), { recursive: true });
      fs.writeFileSync(path.join(reportTree, 'reports', '_archive', ARCHIVE_NAME), ARCHIVE_BYTES);

      const home = newHome();
      gen = targetGen(seedHome(home, { welcome: true }));
      const wizard = gen.wizardMod.createWizard(gen.deps);
      const started = await wizard.startFromTree(reportTree);
      const bloods = started.items.reports.find(r => r.key === 'reports/bloods.md');
      assert.deepStrictEqual(bloods.files,
        ['reports/bloods.md', `reports/_archive/${ARCHIVE_NAME}`]);
      assert.strictEqual(bloods.label, 'Blood panel');
      assert.deepStrictEqual(started.items.reports.map(r => r.key),
        ['reports/bloods.md', 'reports/notes.md'],
        'the archived original is not an item of its own while a report claims it');

      const res = await applySettled(wizard, {
        selection: { cards: [], reports: ['reports/bloods.md'], history: false },
      });
      assert.strictEqual(res.state, 'done', JSON.stringify(res.findings, null, 2));
      assert.deepStrictEqual(res.verified, { cards: 0, pushes: 0, reports: 2 },
        'the report and its original both count as restored');
      assert.ok(fs.existsSync(path.join(home, 'reports', 'bloods.md')));
      assert.strictEqual(
        fs.readFileSync(path.join(home, 'reports', '_archive', ARCHIVE_NAME), 'utf8'),
        ARCHIVE_BYTES, 'the original must come back with the report that cites it');
      assert.ok(!fs.existsSync(path.join(home, 'reports', 'notes.md')));
      assert.deepStrictEqual(liveIds(gen), [], 'no card was ticked, so none came back');
    });

    test('a selection that restores nothing is refused BEFORE the wipe, and so is an unknown id', async () => {
      const home = newHome();
      gen = targetGen(seedHome(home, populatedSeed()));
      const wizard = gen.wizardMod.createWizard(gen.deps);
      await wizard.startFromTree(tree);
      const nonce = wizard.status().confirmNonce;

      const empty = await applySettled(wizard, {
        nonce, selection: { cards: [], reports: [], history: false },
      });
      assert.strictEqual(empty.code, 'SELECTION_EMPTY');
      assert.match(empty.error, /replaces everything on this instance/);

      const unknown = await applySettled(wizard, {
        nonce, selection: { cards: ['embedded', '../../etc/passwd'] },
      });
      assert.strictEqual(unknown.code, 'SELECTION_INVALID');
      assert.strictEqual(unknown.findings[0].ref, '../../etc/passwd');

      // Nothing moved: no wipe, no freeze, no state change, job record intact.
      assert.strictEqual(wizard.status().state, 'awaiting-confirm');
      assert.strictEqual(readJobFile(home).state, 'awaiting-confirm');
      assert.strictEqual(gen.freeze.frozen(), null);
      assert.deepStrictEqual(norm(gen.registry.get('old').data), norm(OLD_ROWS));
      assert.strictEqual(Number(gen.samples.pushCount()), 1);

      // And the refusals did not burn the confirm: a good selection still runs.
      const res = await applySettled(wizard, {
        nonce, selection: { cards: ['embedded'], reports: [], history: false },
      });
      assert.strictEqual(res.state, 'done', JSON.stringify(res.findings, null, 2));
      assert.deepStrictEqual(res.verified, { cards: 1, pushes: 0, reports: 0 });
    });

    test('a retry re-uses the selection the wipe was authorised for, and ignores a wider one', async () => {
      const home = newHome();
      gen = targetGen(seedHome(home, populatedSeed()));
      let failImport = true;
      const deps = {
        ...gen.deps,
        importerFactory: (store) => {
          const real = gen.deps.importerFactory(store);
          return {
            importParsedFile(file, parsed) {
              if (failImport) {
                failImport = false;
                throw new Error('injected import failure');
              }
              return real.importParsedFile(file, parsed);
            },
          };
        },
      };
      const wizard = gen.wizardMod.createWizard(deps);
      const started = await wizard.startFromTree(tree);
      const narrow = { cards: ['embedded'], reports: [], history: false };
      const first = await applySettled(wizard, { nonce: wizard.status().confirmNonce, selection: narrow });
      assert.strictEqual(first.state, 'failed');
      assert.deepStrictEqual(first.selection, narrow, 'the selection is recorded on the job');

      // The retry needs no nonce, so it must not be a way to widen what a
      // wipe that already ran was authorised to restore.
      const retry = await applySettled(wizard, { selection: selectionOf(started) });
      assert.strictEqual(retry.state, 'done', JSON.stringify(retry.findings, null, 2));
      assert.deepStrictEqual(retry.verified, { cards: 1, pushes: 0, reports: 0 });
      assert.deepStrictEqual(retry.selection, narrow);
      assert.deepStrictEqual(liveIds(gen), ['embedded']);
      assert.strictEqual(Number(gen.samples.pushCount()), 0);
    });

    test('a resumed job honours the selection persisted in its record', async () => {
      gen = targetGen(seedHome(newHome(), populatedSeed()));
      const wizard = gen.wizardMod.createWizard(gen.deps);
      await wizard.startFromTree(tree);
      const narrow = { cards: ['embedded', 'inline'], reports: [], history: true };
      const done = await applySettled(wizard, { nonce: wizard.status().confirmNonce, selection: narrow });
      assert.strictEqual(done.state, 'done', JSON.stringify(done.findings, null, 2));

      // Rewind to mid-apply, exactly as a crash leaves it. The resume has no
      // caller to ask, so it reads the selection off the record or it silently
      // restores more than the operator asked for.
      const record = readJobFile(gen.home);
      assert.deepStrictEqual(record.selection, narrow, 'precondition: persisted with the job');
      record.state = 'applying';
      record.stage = 'copy';
      fs.writeFileSync(path.join(gen.home, 'import', 'job.json'), JSON.stringify(record, null, 2));

      const rec = gen.recoverMod.recoverAtBoot({ ...gen.deps });
      assert.strictEqual(rec.action, 'resuming', JSON.stringify(rec.status || rec));
      const result = await rec.settled;
      assert.strictEqual(result.state, 'done', JSON.stringify(result.findings, null, 2));
      assert.deepStrictEqual(result.verified, { cards: 2, pushes: 2, reports: 0 });
      assert.deepStrictEqual(liveIds(gen), ['embedded', 'inline']);
    });

    test('rollback ignores the selection: the snapshot is the instance as it was', async () => {
      const home = newHome();
      gen = targetGen(seedHome(home, { ...populatedSeed(), config: { mine: true } }));
      const deps = {
        ...gen.deps,
        importerFactory: (store) => {
          const real = gen.deps.importerFactory(store);
          return {
            importParsedFile(file, parsed) {
              const r = real.importParsedFile(file, parsed);
              if (r.imported && r.id === 'embedded') store.setData('embedded', [{ corrupted: true }]);
              return r;
            },
          };
        },
      };
      const wizard = gen.wizardMod.createWizard(deps);
      await wizard.startFromTree(tree);
      const res = await applySettled(wizard, {
        nonce: wizard.status().confirmNonce,
        selection: { cards: ['embedded'], reports: [], history: false },
      });
      assert.strictEqual(res.state, 'failed');
      assert.strictEqual(res.findings.filter(f => f.code === 'VERIFY_CARD_MISMATCH').length, 1);

      // The snapshot holds a card the selection never mentions. Applied with
      // that selection it would restore nothing at all (and refuse), so a
      // rollback that came back whole is the only passing outcome.
      const rb = await rollbackSettled(wizard);
      assert.strictEqual(rb.state, 'done', JSON.stringify(rb.findings, null, 2));
      assert.strictEqual(rb.rolledBack, true);
      assert.deepStrictEqual(liveIds(gen), ['old']);
      assert.deepStrictEqual(norm(gen.registry.get('old').data), norm(OLD_ROWS));
      assert.strictEqual(Number(gen.samples.pushCount()), 1);
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')),
        { mine: true });
    });

    test('a card that left the staged tree between confirm and apply fails the job, unwiped', async () => {
      // The selection is re-normalised against the APPLY-TIME tree, so drift
      // in the window between confirm and apply is loud. Without that, a card
      // that vanished would quietly not come back, and a hand-edited job.json
      // could name artefacts the archive never had.
      const { tree: driftTree } = buildSourceTree({
        cards: { 'embedded.json': card('embedded'), 'inline.json': card('inline', { data: INLINE_ROWS }) },
        rows: { embedded: EMBEDDED_ROWS },
      }, tmpDirs);
      const home = newHome();
      gen = targetGen(seedHome(home, { welcome: true }));
      const wizard = gen.wizardMod.createWizard(gen.deps);
      const started = await wizard.startFromTree(driftTree);
      assert.deepStrictEqual(started.items.cards.map(c => c.id), ['embedded', 'inline']);

      // A tree the operator edited by hand: the card is gone and the manifest
      // agrees, so validation passes and only the selection notices.
      fs.rmSync(path.join(driftTree, 'data', 'inline.json'), { force: true });
      const manifestPath = path.join(driftTree, 'klebb-export.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      manifest.inventory.cards = manifest.inventory.cards.filter(e => e.file !== 'data/inline.json');
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

      const settled = await applySettled(wizard, {
        selection: { cards: ['embedded', 'inline'], reports: [], history: false },
      });
      assert.strictEqual(settled.state, 'failed');
      const refused = settled.findings.filter(f => f.code === 'SELECTION_INVALID');
      assert.strictEqual(refused.length, 1, JSON.stringify(settled.findings, null, 2));
      assert.strictEqual(refused[0].ref, 'inline');
      assert.strictEqual(refused[0].phase, 'select');
      // Refused before the pipeline's first destructive stage: only the
      // write gate (engaged before the first await, released by the finally)
      // may have run.
      assert.strictEqual(settled.stage, 'freeze', 'no destructive stage may have run');
      assert.ok(gen.registry.get('welcome'), 'the target must be exactly as it was');
    });
  });
});
