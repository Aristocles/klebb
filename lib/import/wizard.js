// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// lib/import/wizard.js
// The live import job engine: one job at a time, wipe-first apply, persisted
// to <home>/import/job.json on every transition so a crash at any point is
// recoverable at the next boot (lib/import/recover.js).
//
//   const wizard = createWizard({ home, registry, store, samples,
//                                 samplesInbox, exportTo, importerFactory });
//   wizard.startFromTree(treePath)      // -> status, or {error, code:'JOB_ACTIVE'}
//   wizard.status()                     // confirmNonce delivered exactly once
//   wizard.confirmAndApply({ nonce, selection })
//                                       // detaches the pipeline; returns the
//                                       // applying snapshot immediately
//   wizard.rollback()                   // failed|done -> re-apply the snapshot,
//                                       // detached the same way
//   wizard.abort()                      // awaiting-confirm|failed|done -> clear
//   await wizard.awaitIdle()            // the running pipeline's terminal
//                                       // status (resolves at once when idle)
//
// confirmAndApply/rollback/resume DETACH the pipeline (#633): they keep every
// synchronous refusal (nonce, BAD_STATE, NO_SNAPSHOT), start runPipeline
// without awaiting it, and return the applying snapshot. A caller polls
// status() for progress (#632's drain yields keep the process responsive
// mid-pipeline). The pipeline is still one job at a time by construction:
// state and job.json move to 'applying', and the write freeze engages,
// synchronously before the caller regains control, so a second call in the
// window answers BAD_STATE/JOB_ACTIVE and no request can slip a read or
// write in between the answer and the gate.
//
// States: idle -> staging -> validating -> awaiting-confirm -> applying ->
// verifying -> done | failed. This phase takes an already-extracted tree
// path; upload/unzip and the HTTP surface are the router's concern.
//
// The apply pipeline is wipe-first by construction: snapshot (populated
// targets only), engage the write freeze, quiesce the watcher, WIPE
// everything (registered cards via deleteManifest so delete hooks fire, then
// any card file the registry did not know, orphaned rows, the HAE samples
// table, backup/tmp strays, reports), copy the tree in, drain the samples
// inbox, import each card through the boot importer, reload the registry so
// the live server serves the imported set without a restart, verify against
// the pristine tree, sweep exactly the backups this run created, release the
// freeze. INVARIANT: any retry after any failure re-runs the FULL wipe first
// (runPipeline always starts at the wipe), so a half-applied target can never
// stack rows or replay HAE pushes on top of a previous attempt's.
//
// An optional per-artefact SELECTION narrows what the archive restores
// (lib/import/selection.js). It does not narrow the wipe: this is filtered
// replace, never merge, so an unticked artefact is destroyed with everything
// else and simply does not come back. The selection is fixed at the first
// confirm and re-used verbatim by every retry, because the destruction it
// authorised has already happened. A rollback ignores it: the snapshot is the
// instance as it was, and it comes back whole.
//
// deps.store must be the registry's own datastore handle (registry.store()):
// a second handle on the same file would move rows under an in-memory Map
// that keeps serving the old values.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const freeze = require('./freeze');
const { validateTree } = require('./validate');
const { copyDir, isStrayName, verifyAgainstTree, MANIFEST_NAME } = require('./apply');
const {
  buildItems, normaliseSelection, filterPlan, copySets, accepts,
} = require('./selection');

const FRESH_GATE = 'VAL_TARGET_NOT_FRESH';

function jobFilePath(home) {
  return path.join(home, 'import', 'job.json');
}

function finding(phase, severity, scope, ref, code, message) {
  return { phase, severity, scope, ref, code, message };
}

function hardRefusals(findings) {
  return findings.filter(f => f.severity === 'refusal' && f.code !== FRESH_GATE);
}

function isCardManifest(parsed) {
  return !!(parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    && parsed.$schema && parsed.meta && parsed.meta.id);
}

function createWizard(deps) {
  const {
    home, registry, store, samples, samplesInbox, exportTo, importerFactory,
    onStage = null,
  } = deps;
  const importDir = path.join(home, 'import');
  const jobFile = jobFilePath(home);

  // The job record survives restarts on purpose: a done/failed job keeps its
  // snapshotPath so rollback() works across a reboot, and blocks a new start
  // until abort() clears it.
  let job = readJob();
  let nonceDelivered = false;
  // The one detached pipeline run (single job, single promise). Held so
  // awaitIdle() can hand tests and boot recovery the terminal status.
  let pipeline = null;

  function readJob() {
    try {
      const parsed = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  // tmp+rename: recovery reads this file after a crash, so it must never be
  // readable half-written.
  function persist() {
    fs.mkdirSync(importDir, { recursive: true });
    const tmp = jobFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(job, null, 2));
    fs.renameSync(tmp, jobFile);
  }

  function transition(state, extra = {}) {
    Object.assign(job, extra, { state });
    persist();
  }

  // Stage-marked BEFORE the step runs: recovery treats the recorded stage as
  // "this step may have started and not finished".
  function stage(name) {
    job.stage = name;
    persist();
    if (onStage) onStage(name, job);
  }

  function publicStatus() {
    if (!job) return { state: 'idle' };
    const s = {
      jobId: job.jobId,
      state: job.state,
      treePath: job.treePath,
      snapshotPath: job.snapshotPath,
      requiresConfirm: !!job.requiresConfirm,
      startedAt: job.startedAt,
      stage: job.stage,
      plan: job.plan || null,
      items: job.items || null,
      target: job.target || null,
      selection: job.selection || null,
      findings: job.findings || [],
      verified: job.verified || null,
    };
    if (job.rolledBack) s.rolledBack = true;
    if (job.recovered) s.recovered = true;
    return s;
  }

  // What this instance holds right now. The confirm panel needs it to say
  // plainly that ALL of it goes, whatever the selection restores afterwards;
  // read before the apply because after the wipe there is nothing to count.
  function targetSummary() {
    let reports = 0;
    try {
      for (const ent of fs.readdirSync(path.join(home, 'reports'), { withFileTypes: true })) {
        if (!ent.isFile() || !ent.name.endsWith('.md')) continue;
        if (ent.name.startsWith('.') || ent.name.startsWith('_')) continue;
        reports += 1;
      }
    } catch {}
    let pushes = 0;
    try { pushes = Number(samples.pushCount()); } catch {}
    return { cards: registry.list().length, reports, pushes };
  }

  function status() {
    const s = publicStatus();
    if (job && job.state === 'awaiting-confirm' && job.requiresConfirm && !nonceDelivered) {
      s.confirmNonce = job.confirmNonce;
      nonceDelivered = true;
    }
    return s;
  }

  function startFromTree(treePath) {
    if (job && job.state !== 'idle') {
      return { error: `a job is already active (state: ${job.state}); abort it first`, code: 'JOB_ACTIVE' };
    }
    job = {
      jobId: crypto.randomBytes(8).toString('hex'),
      state: 'staging',
      treePath: path.resolve(treePath),
      snapshotPath: null,
      confirmNonce: null,
      requiresConfirm: false,
      fresh: null,
      configPlan: 'none',
      items: null,
      selection: null,
      target: targetSummary(),
      startedAt: new Date().toISOString(),
      stage: null,
      wipedOnce: false,
      appliedOnce: false,
      findings: [],
      verified: null,
    };
    persist();

    transition('validating');
    const validation = validateTree(job.treePath, { targetHome: home });
    job.findings = validation.findings;
    job.configPlan = validation.plan.config;
    // Counts only, for the confirm preview: the full card list can be large
    // and the caller has no use for file paths.
    job.plan = {
      cards: validation.plan.cards.length,
      cardsWithData: validation.plan.cards
        .filter(c => c.data === 'embedded' || c.data === 'inline').length,
      samplesPushes: validation.plan.samplesPushes,
      reports: validation.plan.reports.length,
    };
    // The selectable universe: one entry per artefact the caller can tick.
    // Recorded alongside the counts so the preview and the selection it
    // produces describe the same archive.
    job.items = buildItems(job.treePath, validation.plan);
    if (hardRefusals(validation.findings).length > 0) {
      transition('failed');
      return publicStatus();
    }

    // The fresh gate is not a refusal here: a populated target moves to
    // awaiting-confirm behind a nonce the caller must echo back (the UI's
    // typed-REPLACE panel). A fresh target has nothing to lose and none of
    // that ceremony.
    job.fresh = !validation.findings.some(f => f.code === FRESH_GATE);
    job.requiresConfirm = !job.fresh;
    if (job.requiresConfirm) {
      job.confirmNonce = crypto.randomBytes(16).toString('hex');
    }
    nonceDelivered = false;
    transition('awaiting-confirm');
    return publicStatus();
  }

  // Start runPipeline without awaiting it and answer with the applying
  // snapshot. runPipeline transitions to 'applying' (persisted) and engages
  // the freeze before its first await, so both have happened by the time
  // this returns. runPipeline resolves every failure into a 'failed' status
  // through its own try/catch, so the held promise cannot reject; the catch
  // below is a last line whose only job is to make an impossible leak loud
  // instead of process-fatal.
  function detach(source) {
    pipeline = runPipeline(source).catch(e => {
      console.error('[import] pipeline crashed outside its own error handling:',
        (e && e.stack) || e);
      try { transition('failed'); } catch {}
      return publicStatus();
    });
    return publicStatus();
  }

  // The detached pipeline's terminal status; resolves at once when nothing
  // is running. For tests and for boot recovery's settled logging.
  function awaitIdle() {
    return pipeline || Promise.resolve(publicStatus());
  }

  function confirmAndApply({ nonce, selection } = {}) {
    if (!job || (job.state !== 'awaiting-confirm' && job.state !== 'failed')) {
      return { error: `no job awaiting apply (state: ${job ? job.state : 'idle'})`, code: 'BAD_STATE' };
    }
    if (job.state === 'failed' && !job.appliedOnce) {
      // Failed at validation: there is nothing to retry, the tree is bad.
      return { error: 'the job failed validation; abort and start again with a good tree', code: 'BAD_STATE' };
    }
    // A retry from 'failed' needs no nonce: the confirmed destruction already
    // happened, and the full re-wipe destroys nothing that was not already
    // authorised.
    if (job.state === 'awaiting-confirm' && job.requiresConfirm && nonce !== job.confirmNonce) {
      return { error: 'confirmation nonce missing or wrong; the job stays awaiting-confirm', code: 'CONFIRM_REQUIRED' };
    }
    // The selection is settled by the first apply and every retry re-uses it,
    // so a retry cannot change what a wipe that already ran was authorised to
    // restore. Refused here, synchronously, which is the whole point: an
    // unusable selection must never reach the pipeline that starts by wiping.
    if (job.state === 'awaiting-confirm') {
      const items = job.items || { cards: [], reports: [], history: { pushes: 0 } };
      const norm = normaliseSelection(items, selection);
      if (norm.errors.length) {
        return {
          error: norm.errors[0].message,
          code: norm.errors[0].code,
          findings: norm.errors,
        };
      }
      job.selection = norm.selection;
      persist();
    }
    return detach('tree');
  }

  function rollback() {
    if (!job || (job.state !== 'failed' && job.state !== 'done')) {
      return { error: `rollback is only possible from failed or done (state: ${job ? job.state : 'idle'})`, code: 'BAD_STATE' };
    }
    if (!job.snapshotPath || !fs.existsSync(job.snapshotPath)) {
      return { error: 'no rollback snapshot exists for this job (a fresh-target import takes none)', code: 'NO_SNAPSHOT' };
    }
    job.rolledBack = true;
    return detach('snapshot');
  }

  function abort() {
    if (!job || !['awaiting-confirm', 'failed', 'done'].includes(job.state)) {
      return { error: `abort is only possible from awaiting-confirm, failed or done (state: ${job ? job.state : 'idle'})`, code: 'BAD_STATE' };
    }
    try { fs.rmSync(jobFile, { force: true }); } catch {}
    // Staged trees under <home>/import are ours to delete; a caller-supplied
    // external path is not. Rollback snapshots stay (next job prunes them).
    const staged = job.treePath && path.resolve(job.treePath);
    if (staged && staged.startsWith(importDir + path.sep)) {
      try { fs.rmSync(staged, { recursive: true, force: true }); } catch {}
    }
    job = null;
    nonceDelivered = false;
    pipeline = null;
    return { ok: true, state: 'idle' };
  }

  // Boot recovery entry (lib/import/recover.js): re-run the pipeline for a
  // job interrupted mid-apply, from the staged tree or from the snapshot.
  // Detached like apply: recovery has no snapshot stage and the pre-freeze
  // prep is synchronous, so the freeze is engaged when this returns and the
  // boot can keep going while the pipeline runs.
  function resume(source) {
    if (!job) return { error: 'no persisted job to resume', code: 'BAD_STATE' };
    job.recovered = true;
    return detach(source);
  }

  function wipe() {
    // Registered cards first, so delete hooks (notification sidecars etc.)
    // fire; then any card file the registry does not know about (a crashed
    // run's half-copied tree, a boot that never inited the registry).
    for (const entry of registry.list()) {
      registry.deleteManifest(entry.id);
    }
    const dataDir = path.join(home, 'data');
    let entries = [];
    try {
      entries = fs.readdirSync(dataDir, { withFileTypes: true });
    } catch {}
    for (const ent of entries) {
      // Every directory under data/ is previous-instance state that the
      // export carries verbatim and the copy restores: auto-export/ (HAE
      // inbox, discovered metrics, quarantined payloads), _archive/ (a
      // migration's original card files), any info/ an operator added.
      // Left behind, they read as the new owner's, and a surviving
      // auto-export/samples.json is drained into the restored tree by the
      // stage below (#645). Files are still filtered: legacy credential and
      // session files sit at the top of data/ and must never be wiped.
      if (ent.isDirectory()) {
        fs.rmSync(path.join(dataDir, ent.name), { recursive: true, force: true });
        continue;
      }
      if (!ent.isFile()) continue;
      if (registry.isCardFileName(ent.name) || isStrayName(ent.name)) {
        fs.rmSync(path.join(dataDir, ent.name), { force: true });
      }
    }
    store.wipeAll();
    samples.wipeAll();
    // Reports are tree-defined post-import; anything already there is
    // old-instance state the snapshot preserved.
    const reportsDir = path.join(home, 'reports');
    try { fs.rmSync(reportsDir, { recursive: true, force: true }); } catch {}
    fs.mkdirSync(reportsDir, { recursive: true });
  }

  function copyIn(root, configPlan, findings, accept) {
    copyDir(root, home, 'data', accept);
    copyDir(root, home, 'reports', accept);
    fs.copyFileSync(path.join(root, MANIFEST_NAME), path.join(home, MANIFEST_NAME));
    if (configPlan === 'write' && fs.existsSync(path.join(root, 'config.json'))) {
      fs.copyFileSync(path.join(root, 'config.json'), path.join(home, 'config.json'));
    } else if (configPlan === 'keep-existing') {
      findings.push(finding('apply', 'info', 'config', 'config.json', 'APPLY_CONFIG_KEPT',
        "target already has a config.json; keeping it (the tree's copy was not imported)"));
    }
  }

  function importCards(findings) {
    const importer = importerFactory(store);
    const backups = [];
    const dataDir = path.join(home, 'data');
    for (const ent of fs.readdirSync(dataDir, { withFileTypes: true })) {
      if (!ent.isFile() || !registry.isCardFileName(ent.name)) continue;
      const file = path.join(dataDir, ent.name);
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!isCardManifest(parsed)) continue;
      const result = importer.importParsedFile(file, parsed);
      if (result.imported) backups.push(result.backup);
    }
    return backups;
  }

  async function runPipeline(source) {
    const root = source === 'snapshot' ? job.snapshotPath : job.treePath;
    const findings = [];
    job.findings = findings;
    job.verified = null;
    const firstWipe = !job.wipedOnce;
    job.appliedOnce = true;
    let engaged = false;
    let watchStopped = false;
    transition('applying');

    try {
      // Re-validate at apply time: the tree may have been touched since
      // staging, and a recovery run has no in-memory plan to trust. The fresh
      // gate is ignored: wiping the target is exactly what was authorised.
      const validation = validateTree(root, { targetHome: home });
      const hard = hardRefusals(validation.findings);
      if (hard.length > 0) {
        findings.push(...hard);
        transition('failed');
        return publicStatus();
      }
      const fullPlan = validation.plan;

      // A rollback restores the snapshot whole: the selection belonged to the
      // tree apply, not to the instance's own state. Re-normalised against the
      // APPLY-TIME tree so a card or report that left the staged tree between
      // confirm and apply fails the job loudly instead of quietly not coming
      // back, and so a job.json edited by hand cannot widen its own reach.
      const items = buildItems(root, fullPlan);
      const renorm = normaliseSelection(
        items, source === 'snapshot' ? null : (job.selection || null));
      if (renorm.errors.length) {
        findings.push(...renorm.errors);
        transition('failed');
        return publicStatus();
      }
      const selection = renorm.selection;
      // Filtered plan from here on: verification is plan-driven, and the copy
      // predicate is derived from this same plan, so the two cannot disagree
      // about what the import was meant to restore.
      const plan = filterPlan(fullPlan, items, selection);
      const sets = copySets(fullPlan, plan, selection);
      const accept = selection ? (rel => accepts(sets, rel)) : null;

      // The recorded plan decides config for tree runs (recovery re-runs must
      // not clobber a kept config just because the crashed run copied one in).
      // A rollback always restores the snapshot's config: it IS the original.
      const configPlan = source === 'snapshot'
        ? (fs.existsSync(path.join(root, 'config.json')) ? 'write' : 'none')
        : job.configPlan;

      // (a) Snapshot, only before the first wipe of a populated target: after
      // a wipe there is nothing left worth saving, a fresh target had nothing
      // to begin with, and a rollback run must not overwrite its own source.
      if (source === 'tree' && job.fresh === false && !job.snapshotPath && firstWipe) {
        stage('snapshot');
        const snapDir = path.join(importDir, `rollback-${job.jobId}`);
        fs.rmSync(snapDir, { recursive: true, force: true });
        // Secrets stay: this archive never leaves the instance, and a
        // rollback that restored a config with its HAE token stripped would
        // silently break ingest.
        exportTo(snapDir, { includeSecrets: true });
        job.snapshotPath = snapDir;
        persist();
        for (const name of fs.readdirSync(importDir)) {
          if (name.startsWith('rollback-') && name !== `rollback-${job.jobId}`) {
            fs.rmSync(path.join(importDir, name), { recursive: true, force: true });
          }
        }
      }

      // (b)+(c) Gate writes, then quiesce the watcher so a queued debounce
      // reload cannot fire mid-wipe.
      stage('freeze');
      freeze.engage('import');
      engaged = true;
      registry.stopWatch();
      watchStopped = true;

      // (d) FULL wipe, unconditionally, on every run through this pipeline:
      // retries and recoveries included. See the module header invariant.
      job.wipedOnce = true;
      stage('wipe');
      wipe();

      // (e) Copy the tree in: enumerated, strays skipped, selection applied,
      // manifest to the home root, config per plan.
      stage('copy');
      copyIn(root, configPlan, findings, accept);

      // (f) Drain the HAE samples inbox. The table was wiped in (d) of THIS
      // run, so replay recency inversion is impossible by construction. With
      // history deselected, (e) never lands the file and this finds nothing:
      // the copy filter decides, so there is no second gate to keep in step.
      // The first await in the pipeline: the freeze (b) is already engaged,
      // so a request landing in a drain yield can read but not write, and
      // the finally below releases across every await path.
      stage('drain');
      await samplesInbox.drain();

      // (g) Cards through the boot importer, exact backup paths collected.
      stage('import');
      const backups = importCards(findings);

      // (h) Re-register metas on the live registry (data is already served
      // through the shared store handle), then let the watcher resume.
      stage('reload');
      registry.reload();
      registry.resumeWatch();
      watchStopped = false;

      // (i) Verify durable state against the pristine tree.
      transition('verifying');
      stage('verify');
      store.load();
      const verified = verifyAgainstTree({
        root, home, plan, store,
        pushes: Number(samples.pushCount()),
        findings,
      });

      const fullSuccess = findings.every(f => f.severity !== 'refusal');
      if (!fullSuccess) {
        findings.push(finding('apply', 'warning', 'target', home, 'APPLY_BACKUPS_KEPT',
          `verification failed: the ${backups.length} .pre-import backup(s) are left in place, and the next boot re-imports any card file still carrying its data key`));
        transition('failed', { verified });
        return publicStatus();
      }

      // (j) Sweep exactly the paths the importer returned; never a glob or a
      // timestamp window.
      stage('sweep');
      for (const backup of backups) fs.rmSync(backup, { force: true });
      if (backups.length) {
        findings.push(finding('apply', 'info', 'target', 'data', 'APPLY_BACKUPS_SWEPT',
          `import verified; removed the ${backups.length} .pre-import backup(s) this run created`));
      }

      // (k) Open the gate, then record done.
      freeze.release();
      engaged = false;
      transition('done', { verified });
      return publicStatus();
    } catch (e) {
      findings.push(finding('apply', 'refusal', 'tree', root, 'APPLY_ERROR',
        `import failed: ${e.message}`));
      transition('failed');
      return publicStatus();
    } finally {
      if (engaged && freeze.frozen()) freeze.release();
      if (watchStopped) registry.resumeWatch();
    }
  }

  return { startFromTree, status, confirmAndApply, rollback, abort, resume, awaitIdle };
}

// Production wiring. Lazy requires: the registry must resolve against the
// process's real HEALTH_HOME, and nothing here should load before it is used.
function defaultDeps() {
  const PATHS = require('../../config/paths');
  const registry = require('../../manifests/registry');
  return {
    home: PATHS.HEALTH_HOME,
    registry,
    store: registry.store(),
    samples: require('../../health-auto-export/samples'),
    samplesInbox: require('../../health-auto-export/samples-inbox'),
    exportTo: require('../../scripts/export-embed').exportTo,
    importerFactory: require('../datastore/import').createImporter,
  };
}

function createDefaultWizard() {
  return createWizard(defaultDeps());
}

module.exports = { createWizard, createDefaultWizard, defaultDeps, jobFilePath };
