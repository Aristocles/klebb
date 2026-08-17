// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/helpers/import-recover-runner.js
// Subprocess for the crash-recovery suite: a fresh process (as a real boot
// would be) that calls recoverAtBoot against a home. Mirrors the intended
// server call site: the registry is NOT inited first, because recovery runs
// before first-boot seeding, before the samples drain, and before
// registry.init().
//
//   node import-recover-runner.js <home>
//
// Prints one line: RECOVER_RESULT {action, source, cleared, reason, state,
// verified, refusalCodes}.

'use strict';

const [home] = process.argv.slice(2);
if (!home) {
  console.error('usage: import-recover-runner.js <home>');
  process.exit(2);
}
process.env.HEALTH_HOME = home;
process.env.HEALTH_HOME_WARNED = '1';

const registry = require('../../manifests/registry');
const samples = require('../../health-auto-export/samples');
const samplesInbox = require('../../health-auto-export/samples-inbox');
const { exportTo } = require('../../scripts/export-embed');
const { createImporter } = require('../../lib/datastore/import');
const { recoverAtBoot } = require('../../lib/import/recover');

(async () => {
  const out = await recoverAtBoot({
    home,
    registry,
    store: registry.store(),
    samples,
    samplesInbox,
    exportTo,
    importerFactory: createImporter,
  });

  console.log('RECOVER_RESULT ' + JSON.stringify({
    action: out.action,
    source: out.source || null,
    cleared: out.cleared || false,
    reason: out.reason || null,
    state: out.result ? out.result.state : null,
    verified: out.result ? out.result.verified : null,
    refusalCodes: out.result
      ? out.result.findings.filter(f => f.severity === 'refusal').map(f => f.code)
      : [],
  }));
  samples.close();
  registry.closeStore();
  process.exit(0);
})();
