#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// scripts/run-tests.js
//
// Runs the unit suite, then re-runs ONLY the files whose process was killed by
// the OS rather than failing a test.
//
// Some test files intermittently die with Windows STATUS_STACK_BUFFER_OVERRUN
// (0xC0000409), the __fastfail path: the process is terminated below the C
// runtime, so Node runs no handler, writes nothing to stderr, and produces no
// diagnostic report even with --report-on-fatalerror. It is not a JavaScript
// fault and nothing in this repo can prevent it. Observed on a full run at a
// rate of roughly one file per few runs, and confirmed by re-running the
// affected files, which pass every time.
//
// The retry is gated on the exit code, hard. A genuine test failure reports
// exitCode `undefined` (the failure happened in-process), so it can never be
// retried into green. Only the native crash codes qualify, and only once.
//
//   node scripts/run-tests.js            the suite, with the crash retry
//   npm test                             the suite, no retry (what CI compares)
//   npm run test:diag                    the suite through the crash reporter
//
// This is deliberately NOT what `npm test` runs. A retry that hides a flake by
// default is how a real intermittent bug becomes invisible; you have to opt in.

'use strict';

const { spawn } = require('child_process');
const path = require('path');
const { pathToFileURL } = require('url');

const REPO_ROOT = path.resolve(__dirname, '..');
const REPORTER = path.join(REPO_ROOT, 'tests', 'helpers', 'crash-reporter.cjs');
const CONCURRENCY = process.env.KLEBB_TEST_CONCURRENCY || '6';

// Exit codes that mean "the OS killed this process", not "a test failed".
// 0xC0000409 is __fastfail; 0xC0000005 is an access violation. Both are native
// terminations with no JavaScript-level cause to find.
const NATIVE_CRASH = new Set([0xC0000409, 0xC0000005].map(n => n >>> 0));

function run(args) {
  return new Promise(resolve => {
    const proc = spawn(process.execPath, args, { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout.on('data', c => { out += c; process.stdout.write(c); });
    proc.stderr.on('data', c => { out += c; process.stderr.write(c); });
    proc.on('exit', code => resolve({ code, out }));
  });
}

// Split the reporter's output into per-failure blocks and bucket the files by
// whether the process was natively killed or the test genuinely failed.
//
// A single dead file produces more than one FAIL block (the runner reports the
// file's own failure and its enclosing summary), so the buckets are sets of FILE
// paths, not block counts. Counting blocks instead would make one crash look
// like several failures and suppress the retry.
function classifyFailures(output) {
  const crashed = new Set();
  const genuine = new Set();
  for (const block of output.split(/\nFAIL /).slice(1)) {
    const file = /^\s*file\s+(.+)$/m.exec(block);
    if (!file) continue;
    const name = file[1].trim();
    const code = /^\s*exitCode\s+(\d+)/m.exec(block);
    if (code && NATIVE_CRASH.has(Number(code[1]) >>> 0)) crashed.add(name);
    else genuine.add(name);
  }
  // A file that produced both kinds of block is a real failure: the crash
  // classification is only trustworthy when nothing else went wrong in it.
  for (const f of genuine) crashed.delete(f);
  return { crashed: [...crashed], genuine: [...genuine] };
}

async function main() {
  const base = [
    '--test',
    `--test-concurrency=${CONCURRENCY}`,
    `--test-reporter=${pathToFileURL(REPORTER).href}`,
  ];
  const first = await run([...base, 'tests/*.test.js', 'tests/api/*.test.js']);
  if (first.code === 0) return 0;

  const { crashed, genuine } = classifyFailures(first.out);
  if (crashed.length === 0) {
    console.error('\nSuite failed, and no file was natively killed: these are real failures.');
    return first.code || 1;
  }

  // Any file that failed for a reason OTHER than a native kill means the run is
  // genuinely red, and retrying the crashed files cannot change that.
  if (genuine.length > 0) {
    console.error(`\n${crashed.length} file(s) were natively killed, but ${genuine.length} `
      + 'file(s) have real failures. Not retrying.');
    for (const f of genuine) console.error(`  ${path.relative(REPO_ROOT, f)}`);
    return first.code || 1;
  }

  console.error(`\n${'='.repeat(70)}`);
  console.error(`${crashed.length} file(s) were killed by the OS (not a test failure).`);
  console.error('Re-running only those files once:');
  for (const f of crashed) console.error(`  ${path.relative(REPO_ROOT, f)}`);
  console.error(`${'='.repeat(70)}\n`);

  const second = await run([...base, ...crashed]);
  if (second.code === 0) {
    console.error('\nAll re-run files passed. Treating the run as green.');
    return 0;
  }
  console.error('\nRe-run still failing: this is not the native-crash flake.');
  return second.code || 1;
}

if (require.main === module) {
  main().then(code => process.exit(code), err => {
    console.error(err);
    process.exit(1);
  });
} else {
  module.exports = { classifyFailures, NATIVE_CRASH };
}
