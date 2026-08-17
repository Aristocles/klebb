// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// lib/import/recover.js
// Boot-time crash recovery for the import wizard. The server calls this
// BEFORE first-boot welcome seeding and BEFORE the HAE samples drain: a crash
// mid-apply leaves a half-wiped or half-copied tree, and a boot that seeded a
// welcome card over it (or drained a half-staged samples file) would present
// the wreckage as truth.
//
//   const { action } = recoverAtBoot({ home, ...deps });
//   action: 'none'    nothing to do (no job, or one that never touched the
//                     target; a stale awaiting-confirm/staging/validating job
//                     is cleared, because its nonce died with the process)
//           'resumed' the apply pipeline re-ran from the staged tree, or from
//                     the rollback snapshot when the tree is gone; `result`
//                     carries the finished job status (done or failed)
//           'refuse'  neither tree nor snapshot survives: the caller must
//                     boot into a refuse-to-serve state rather than continue
//                     into seeding over a half-applied home
//
// A job recorded as done or failed is left alone: those states were persisted
// by a pipeline that finished, the target matches what the job reports, and
// the record must survive the reboot so rollback() stays possible.
//
// deps are createWizard's ({ registry, store, samples, samplesInbox,
// exportTo, importerFactory }); omitted ones are wired to the real modules.

'use strict';

const fs = require('fs');
const path = require('path');
const { createWizard, defaultDeps, jobFilePath } = require('./wizard');

const RESUMABLE = new Set(['applying', 'verifying']);
const NEVER_STARTED = new Set(['staging', 'validating', 'awaiting-confirm']);

function recoverAtBoot(opts) {
  const { home } = opts;
  if (!home) throw new Error('recoverAtBoot: home required');
  const jobFile = jobFilePath(home);

  let record = null;
  try {
    record = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
  } catch {}
  if (!record || typeof record !== 'object' || !record.state) {
    return { action: 'none' };
  }

  if (NEVER_STARTED.has(record.state)) {
    // Validation is read-only, so the target is untouched; and the confirm
    // nonce only ever lived in the dead process's memory, so the job can
    // never be confirmed again. Clear it, including a staged tree of ours.
    try { fs.rmSync(jobFile, { force: true }); } catch {}
    const importDir = path.join(home, 'import');
    const staged = record.treePath && path.resolve(record.treePath);
    if (staged && staged.startsWith(importDir + path.sep)) {
      try { fs.rmSync(staged, { recursive: true, force: true }); } catch {}
    }
    return { action: 'none', cleared: true };
  }

  if (!RESUMABLE.has(record.state)) {
    return { action: 'none' };
  }

  const deps = opts.registry ? opts : { ...defaultDeps(), ...opts };
  const wizard = createWizard(deps);
  if (record.treePath && fs.existsSync(record.treePath)) {
    return { action: 'resumed', source: 'tree', result: wizard.resume('tree') };
  }
  if (record.snapshotPath && fs.existsSync(record.snapshotPath)) {
    return { action: 'resumed', source: 'snapshot', result: wizard.resume('snapshot') };
  }
  return {
    action: 'refuse',
    reason: 'an import was interrupted mid-apply and neither the staged tree nor the '
      + 'rollback snapshot survives; refusing to serve or seed over a half-applied instance',
  };
}

module.exports = { recoverAtBoot };
