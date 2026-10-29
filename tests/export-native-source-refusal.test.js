// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const { test } = require('node:test');
const G = require('./helpers/export-native-source-fixture.cjs');
const { F, H, fs, path, assert, equal } = G;
const dispose = f => F.dispose(f);
const runModes = async (modes, token) => {
  for (const mode of modes) { const f = G.fixture(mode); try { await G.refusal(f, token); } finally { dispose(f); } }
};

test('E01 native records refuse before portable-v1 success', async () => {
  const legacy = G.fixture(); try { G.success(legacy); } finally { dispose(legacy); }
  const missing = G.fixture();
  try {
    fs.unlinkSync(missing.dbFile);
    fs.writeFileSync(path.join(missing.home, 'data', 'weight.json'), JSON.stringify(H.card('weight', { data: G.WEIGHT_ROWS })));
    assert.equal(G.sql(missing.dbFile), null, 'actual absent DB control'); G.success(missing);
  } finally { dispose(missing); }
  const selected = G.fixture('records');
  try {
    G.control(selected); const defaultDb = selected.dbFile, defaultAuthority = selected.authorityFile;
    G.selectedLegacy(selected); const nativeBefore = fs.readFileSync(defaultDb), authBefore = fs.readFileSync(defaultAuthority);
    assert.equal(G.sql(selected.dbFile).ddl.some(x => x.name.startsWith('health_')), false);
    const unused = JSON.parse(fs.readFileSync(selected.authorityFile, 'utf8'));
    assert.equal(unused.grants.length + unused.connectors.length, 0);
    G.success(selected);
    assert.equal(fs.readFileSync(defaultDb).equals(nativeBefore), true, 'unselected native decoy exact');
    assert.equal(fs.readFileSync(defaultAuthority).equals(authBefore), true, 'unselected authority decoy exact');
  } finally { dispose(selected); }
  for (const placement of [null, 'file', 'dir']) {
    const f = G.fixture('records');
    try { if (placement) G.place(f, placement); await G.refusal(f); } finally { dispose(f); }
  }
});

test('E02 typed deletion-only sources refuse', async () => {
  await runModes(['tombstones', 'guards']); // Original unseen null-type and date policy stay pending R0.
});

test('E03 retained transport index and authority refuse', async () => {
  await runModes(['stream', 'batch-receipt', 'outbox', 'staging', 'parts', 'object-receipt',
    'index-entry', 'index-frontier', 'index-state', 'authority-grant', 'authority-connector']);
  const f = G.fixture('authority-grant');
  try { G.place(f, 'credentials'); await G.refusal(f); } finally { dispose(f); }
});

test('E04 initialized empty native schemas refuse', async () => {
  await runModes(['empty-v1', 'empty-v2', 'empty-v1-optional', 'empty-v2-optional']);
});

test('E05 native components and source read faults fail closed', async () => {
  await runModes(['native-partial', 'native-incompatible', 'native-unknown', 'native-missing-index',
    'native-view-only', 'native-unknown-view', 'objects-partial', 'index-partial']);
  await runModes(['authority-malformed', 'authority-duplicate', 'authority-oversize', 'authority-directory',
    'authority-extra-key', 'authority-wrong-version', 'authority-bad-uuid', 'authority-wrong-arrays',
    'authority-too-many', 'database-corrupt', 'database-directory'], G.unavailable);
});

// E06 remains the unchanged real HTTP/CLI tests/api/import-roundtrip.test.js fixture and assertions.
test('E07 real strict wizard snapshot refuses before wipe', async () => {
  const incoming = G.fixture('absent', 'incoming'), source = G.fixture('records'); let gen;
  try {
    const tree = G.success(incoming); G.control(source);
    await G.withEnv(source, async () => {
      gen = H.targetGen(source.home); assert.equal(gen.freeze.frozen(), null);
      const stages = []; const wizard = gen.wizardMod.createWizard({ ...gen.deps,
        onStage: name => stages.push([name, gen.freeze.frozen()]) }); // Observation only; no failure injected.
      const staged = await wizard.startFromTree(tree); assert.equal(staged.state, 'awaiting-confirm');
      const beforeJob = H.readJobFile(source.home);
      assert.equal(beforeJob.fresh, false); assert.equal(beforeJob.requiresConfirm, true);
      assert.equal(beforeJob.wipedOnce, false); assert.equal(beforeJob.appliedOnce, false);
      assert.equal(beforeJob.snapshotPath, null); assert.equal(beforeJob.verified, null); assert.equal(beforeJob.selection, null);
      G.control(source); const before = G.cold(source, true), nonce = wizard.status().confirmNonce;
      assert.equal(typeof nonce, 'string'); const confirmed = wizard.confirmAndApply({ nonce });
      assert.equal(confirmed.code, undefined, 'actual confirmation accepted, no authorisation/setup refusal');
      const settled = await wizard.awaitIdle(), afterJob = H.readJobFile(source.home), actualReleased = gen.freeze.frozen();
      H.teardownGen(gen); gen = null; const after = G.cold(source, true);
      const expectedJob = { ...beforeJob, state: 'failed', stage: 'snapshot', appliedOnce: true,
        findings: [{ phase: 'apply', severity: 'refusal', scope: 'tree', ref: path.resolve(tree),
          code: 'APPLY_ERROR', message: 'import failed: ' + G.unsupported }] };
      G.checks([() => assert.equal(settled.state, 'failed'), () => assert.equal(settled.stage, 'snapshot'),
        () => assert.equal(equal(afterJob, expectedJob), true, 'exact failed-job bookkeeping, all other fields retained'),
        () => assert.equal(equal(stages, [['freeze', null], ['snapshot', 'import']]), true, 'no wipe/copy stage reached'),
        () => G.invariant(before, after, true),
        () => assert.equal(fs.existsSync(path.join(source.home, 'import', 'rollback-' + beforeJob.jobId)), false,
          'no unsupported rollback snapshot output'),
        () => assert.equal(actualReleased, null, 'existing failure path releases freeze before test cleanup')]);
    });
  } finally { H.teardownGen(gen); dispose(source); dispose(incoming); }
});

test('E08 library refusal preserves process and shared samples handle', async () => {
  const source = G.fixture('records'), legacy = G.fixture();
  try {
    await G.refusalLibrary(source, G.unsupported, 2);
    await G.withEnv(legacy, async () => {
      H.purgeRepoModules(); const samples = require('../health-auto-export/samples');
      const { exportTo } = require('../scripts/export-embed');
      try {
        for (const [date, qty] of [['2026-06-01', 8123], ['2026-06-02', 9541]])
          samples.recordPush({ data: { metrics: [{ name: 'step_count', units: 'count', data: [{ date, qty }] }] } },
            { receivedAt: date + 'T00:00:00.000Z' });
        const wal = legacy.dbFile + '-wal'; assert.equal(fs.existsSync(wal), true, 'actual shared live handle before export');
        for (let i = 0; i < 2; i++) {
          const out = G.output(legacy), result = exportTo(out);
          assert.equal(result.counts.haePushes, 2); assert.equal(fs.existsSync(wal), true, 'shared handle not closed/reopened');
          assert.equal(Number(samples.pushCount()), 2);
          const payload = JSON.parse(fs.readFileSync(path.join(out, 'data', 'auto-export', 'samples.json'), 'utf8'));
          assert.equal(payload.pushes.length, 2); assert.equal(fs.existsSync(path.join(out, 'klebb-export.json')), true);
        }
      } finally { samples.close(); }
    });
  } finally { dispose(source); dispose(legacy); }
});
