// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/helpers/import-kill-runner.js
// Subprocess for the crash-recovery suite: runs a real wizard apply against
// a scratch home and SIGKILLs its own process the moment the named stage
// begins. Each stage drops a marker file first, so the parent can prove
// where the kill landed; if the pipeline somehow finishes, a `finished`
// marker exposes the kill as vacuous and the parent fails the test.
//
//   node import-kill-runner.js <home> <tree> <markerDir> <killStage>

'use strict';

const fs = require('fs');
const path = require('path');

const [home, tree, markerDir, killStage] = process.argv.slice(2);
if (!home || !tree || !markerDir || !killStage) {
  console.error('usage: import-kill-runner.js <home> <tree> <markerDir> <killStage>');
  process.exit(2);
}
process.env.HEALTH_HOME = home;
process.env.HEALTH_HOME_WARNED = '1';

const registry = require('../../manifests/registry');
const samples = require('../../health-auto-export/samples');
const samplesInbox = require('../../health-auto-export/samples-inbox');
const { exportTo } = require('../../scripts/export-embed');
const { createImporter } = require('../../lib/datastore/import');
const { createWizard } = require('../../lib/import/wizard');

registry.init();
const wizard = createWizard({
  home,
  registry,
  store: registry.store(),
  samples,
  samplesInbox,
  exportTo,
  importerFactory: createImporter,
  onStage(stage) {
    fs.writeFileSync(path.join(markerDir, `${stage}.begun`), '');
    if (stage === killStage) {
      // SIGKILL on self: no exit handlers, no WAL checkpoint, no persist —
      // the closest a test can get to power loss.
      process.kill(process.pid, 'SIGKILL');
    }
  },
});

(async () => {
  const started = wizard.startFromTree(tree);
  if (started.error || started.state !== 'awaiting-confirm') {
    console.error(`start did not reach awaiting-confirm: ${JSON.stringify(started)}`);
    process.exit(2);
  }
  const applied = wizard.confirmAndApply({ nonce: wizard.status().confirmNonce });
  if (applied.code) {
    console.error(`apply refused: ${JSON.stringify(applied)}`);
    process.exit(2);
  }
  // The apply detaches (#633); the kill must land inside the running
  // pipeline, so wait for it rather than exiting under it.
  const result = await wizard.awaitIdle();
  fs.writeFileSync(path.join(markerDir, 'finished'), JSON.stringify(result));
  samples.close();
  registry.closeStore();
  process.exit(0);
})();
