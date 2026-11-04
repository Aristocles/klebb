// SPDX-License-Identifier: AGPL-3.0-only
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { ROOT, REVISION, TREE, git, verifyProducer } =
  require('../tests/helpers/legacy-health-producer');

const repo = path.resolve(__dirname, '..');
try {
  if (!fs.existsSync(ROOT)) {
    // The current checkout must contain this immutable public source object.
    // CI fetches repository history; local shallow clones need the same history.
    if (git(['rev-parse', `${REVISION}^{tree}`], repo) !== TREE) {
      throw new Error('Pinned producer tree mismatch');
    }
    fs.mkdirSync(path.dirname(ROOT), { recursive: true });
    git(['worktree', 'add', '--detach', ROOT, REVISION], repo);
  }
  // Refuse a dirty or wrongly bound cache before installing anything.
  verifyProducer(false);
  const npmCLI = process.env.npm_execpath;
  if (!npmCLI || !fs.existsSync(npmCLI)) {
    throw new Error('Run provisioning through npm test');
  }
  // This runs the original lock in its own checkout. Lifecycle scripts cannot
  // recursively invoke the current checkout's pretest or mutate its source.
  execFileSync(process.execPath,
    [npmCLI, 'ci', '--ignore-scripts', '--no-audit', '--no-fund'],
    { cwd: ROOT, env: { ...process.env }, timeout: 120000,
      stdio: 'inherit', windowsHide: true });
  verifyProducer();
} catch {
  console.error('Original V1 producer provisioning failed. Ensure the pinned repository history is present and run npm test again.');
  process.exitCode = 1;
}
