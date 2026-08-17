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
    test('engage/frozen/release, and a second engage throws', () => {
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

    const started = wizard.startFromTree(tree);
    assert.strictEqual(started.state, 'awaiting-confirm');
    assert.strictEqual(started.requiresConfirm, false);
    assert.ok(!('confirmNonce' in started));
    assert.deepStrictEqual(started.plan,
      { cards: 4, cardsWithData: 2, samplesPushes: 2, reports: 1 },
      'the status snapshot carries the plan counts for the confirm preview');

    const res = await wizard.confirmAndApply({});
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

    const started = wizard.startFromTree(tree);
    assert.strictEqual(started.state, 'awaiting-confirm');
    assert.strictEqual(started.requiresConfirm, true);
    assert.ok(!('confirmNonce' in started), 'startFromTree must not hand out the nonce');

    const st1 = wizard.status();
    assert.match(st1.confirmNonce, /^[0-9a-f]{32}$/);
    const st2 = wizard.status();
    assert.ok(!('confirmNonce' in st2), 'the nonce is delivered exactly once');

    const wrong = await wizard.confirmAndApply({ nonce: 'not-it' });
    assert.strictEqual(wrong.code, 'CONFIRM_REQUIRED');
    const missing = await wizard.confirmAndApply({});
    assert.strictEqual(missing.code, 'CONFIRM_REQUIRED');
    assert.strictEqual(wizard.status().state, 'awaiting-confirm', 'a refused confirm must not move the job');
    assert.deepStrictEqual(norm(gen.registry.get('old').data), norm(OLD_ROWS), 'a refused confirm must not touch data');

    const res = await wizard.confirmAndApply({ nonce: st1.confirmNonce });
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
    wizard.startFromTree(tree);
    const res = await wizard.confirmAndApply({ nonce: wizard.status().confirmNonce });

    assert.strictEqual(res.state, 'failed');
    const mismatch = res.findings.filter(f => f.code === 'VERIFY_CARD_MISMATCH');
    assert.strictEqual(mismatch.length, 1, JSON.stringify(res.findings, null, 2));
    assert.strictEqual(mismatch[0].ref, 'data/embedded.json');
    assert.ok(res.findings.some(f => f.code === 'APPLY_BACKUPS_KEPT'));
    assert.strictEqual(preImportBackups(home).length, 3, 'backups must be kept on failure');
    assert.strictEqual(gen.freeze.frozen(), null, 'freeze must be released after failed');
    assert.strictEqual(readJobFile(home).state, 'failed');

    // Rollback: the same pipeline fed the snapshot, no nonce, no new snapshot.
    const rb = await wizard.rollback();
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
    wizard.startFromTree(tree);
    const res = await wizard.confirmAndApply({});
    assert.strictEqual(res.state, 'failed');
    const rb = await wizard.rollback();
    assert.strictEqual(rb.code, 'NO_SNAPSHOT');
    assert.strictEqual(wizard.status().state, 'failed', 'a refused rollback must not move the job');
  });

  test('single job at a time: JOB_ACTIVE on a second start, abort clears', async () => {
    gen = targetGen(seedHome(newHome(), { welcome: true }));
    const wizard = gen.wizardMod.createWizard(gen.deps);

    assert.strictEqual(wizard.abort().code, 'BAD_STATE', 'abort with no job must refuse');

    wizard.startFromTree(tree);
    const second = wizard.startFromTree(tree);
    assert.strictEqual(second.code, 'JOB_ACTIVE');

    const aborted = wizard.abort();
    assert.strictEqual(aborted.ok, true);
    assert.strictEqual(wizard.status().state, 'idle');
    assert.strictEqual(readJobFile(gen.home), null, 'abort must clear job.json');

    const again = wizard.startFromTree(tree);
    assert.strictEqual(again.state, 'awaiting-confirm');
    const done = await wizard.confirmAndApply({});
    assert.strictEqual(done.state, 'done');
    assert.strictEqual(wizard.startFromTree(tree).code, 'JOB_ACTIVE',
      'a done job still blocks a new start until abort');
    assert.strictEqual(wizard.abort().ok, true, 'abort from done clears the record');
  });

  test('a tree that fails validation ends the job failed, and cannot be retried', async () => {
    gen = targetGen(seedHome(newHome(), { welcome: true }));
    const wizard = gen.wizardMod.createWizard(gen.deps);
    const badTree = fs.mkdtempSync(path.join(os.tmpdir(), 'eh-wiz-bad-'));
    tmpDirs.push(badTree);
    fs.mkdirSync(path.join(badTree, 'data'), { recursive: true });

    const res = wizard.startFromTree(badTree);
    assert.strictEqual(res.state, 'failed');
    assert.ok(res.findings.some(f => f.code === 'VAL_NO_MANIFEST'), JSON.stringify(res.findings));
    assert.strictEqual((await wizard.confirmAndApply({})).code, 'BAD_STATE');
    assert.strictEqual((await wizard.rollback()).code, 'NO_SNAPSHOT');
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
    wizard.startFromTree(tree);
    const res = await wizard.confirmAndApply({ nonce: wizard.status().confirmNonce });

    assert.strictEqual(res.state, 'failed');
    assert.ok(res.findings.some(f => f.code === 'APPLY_ERROR' && /injected copy failure/.test(f.message)));
    assert.strictEqual(frozenAt.snapshot, null, 'the snapshot runs before the gate closes');
    assert.strictEqual(frozenAt.wipe, 'import', 'the wipe must run behind the freeze');
    assert.strictEqual(frozenAt.copy, 'import', 'the copy must run behind the freeze');
    assert.strictEqual(gen.freeze.frozen(), null, 'freeze must be released by the finally path');

    // And the retry (full pipeline again) completes behind the freeze too.
    const retry = await wizard.confirmAndApply({});
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
    wizard.startFromTree(tree);
    const first = await wizard.confirmAndApply({ nonce: wizard.status().confirmNonce });
    assert.strictEqual(first.state, 'failed');
    // The failed run already drained the tree's pushes: the exact state a
    // wipe-less retry would double.
    assert.strictEqual(Number(gen.samples.pushCount()), 2);

    const retry = await wizard.confirmAndApply({});
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
    wizard.startFromTree(tree);
    const res = await wizard.confirmAndApply({});
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
    wizard.startFromTree(haeTree);
    const res = await wizard.confirmAndApply({});
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
    wizard.startFromTree(mixedTree);
    const res = await wizard.confirmAndApply({});
    assert.strictEqual(res.state, 'failed');
    const mismatch = res.findings.filter(f => f.code === 'VERIFY_CARD_MISMATCH');
    assert.strictEqual(mismatch.length, 1, JSON.stringify(res.findings, null, 2));
    assert.strictEqual(mismatch[0].ref, 'data/plain.json', 'only the non-HAE card may mismatch');
  });

  test('config keep-existing: a populated target keeps its config and the finding says so', async () => {
    const home = newHome();
    gen = targetGen(seedHome(home, { ...populatedSeed(), config: { mine: true } }));
    const wizard = gen.wizardMod.createWizard(gen.deps);
    wizard.startFromTree(tree);
    const res = await wizard.confirmAndApply({ nonce: wizard.status().confirmNonce });
    assert.strictEqual(res.state, 'done', JSON.stringify(res.findings, null, 2));
    assert.ok(res.findings.some(f => f.code === 'APPLY_CONFIG_KEPT'));
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')),
      { mine: true });
  });
});
