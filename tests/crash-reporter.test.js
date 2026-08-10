// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/crash-reporter.test.js
//
// The reporter that explains why a test file died, and two harness defects it
// exists to stop hiding.
//
// The default spec reporter discards the child's exit code, so a file whose
// process is killed mid-run prints a bare "'test failed'" with no subtests, no
// stderr and no stack. That is indistinguishable from "you broke something", and
// it has repeatedly sent people hunting a regression that was not there.
//
// Each case below runs a real child through the reporter, because the whole
// value is what the reporter prints for a process that died in a particular way,
// and that cannot be faked by calling it with a synthetic event stream.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const REPO_ROOT = path.resolve(__dirname, '..');
const REPORTER = path.join(__dirname, 'helpers', 'crash-reporter.cjs');

// Write a throwaway test file and run it under the reporter, returning the
// combined output.
//
// Spawns the real `node --test` CLI, because that is the path the reporter will
// actually be used on and its event granularity differs from the run() API's
// (run() reports a file as one unit, so a failing subtest arrives with a child
// exit code attached and the per-test distinction this reporter exists to draw
// disappears).
//
// NODE_TEST_CONTEXT has to be stripped from the child's environment: it is how a
// process learns it is already inside a test run, it is inherited, and with it
// set the nested runner declines to execute anything ("run() is being called
// recursively ... skipping running files") and reports zero tests, which looks
// exactly like the reporter producing no output.
function runUnderReporter(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klebb-reporter-'));
  const file = path.join(dir, 'subject.test.js');
  fs.writeFileSync(file, body);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  try {
    // --test-reporter goes through the ESM loader, which rejects a bare Windows
    // absolute path ("Received protocol 'c:'"), so it must be a file:// URL.
    const r = spawnSync(process.execPath,
      ['--test', `--test-reporter=${pathToFileURL(REPORTER).href}`, file],
      { encoding: 'utf8', cwd: REPO_ROOT, timeout: 120000, env });
    return `${r.stdout || ''}${r.stderr || ''}`;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('the crash reporter explains why a file died', () => {
  test('an ordinary assertion failure is reported as an in-process failure', () => {
    const out = runUnderReporter([
      "const { test } = require('node:test');",
      "const assert = require('node:assert');",
      "test('a real failure', () => { assert.equal(1, 2, 'deliberate'); });",
    ].join('\n'));

    assert.match(out, /exitCode\s+undefined/,
      'an in-process assertion should not report a child exit code');
    assert.match(out, /diagnosis\s+in-process failure/);
    // The actual assertion message has to survive, or the reporter is worse
    // than the default one for the common case.
    assert.match(out, /deliberate/, 'the assertion message was lost');
  });

  test('a child killed mid-file reports its exit code and how much it emitted', () => {
    // The signature this reporter exists for: one top-level describe, and the
    // process dies part-way. node:test streams results as suites resolve, so
    // nothing from the file reaches the parent and the default output is a bare
    // "'test failed'".
    const out = runUnderReporter([
      "const { test, describe } = require('node:test');",
      "describe('outer', () => {",
      "  test('first', async () => { await new Promise(r => setTimeout(r, 30)); });",
      "  test('second', () => { process.exit(7); });",
      '});',
    ].join('\n'));

    assert.match(out, /exitCode\s+7 \(0x7\)/,
      'the child exit code is not reported, which is the whole point');
    assert.match(out, /results emitted by this file:/,
      'the emitted-result count is missing, so a silent file cannot be recognised');
    assert.match(out, /diagnosis\s+child exited 7/);
  });

  test('an aborted child is distinguished from a test failure', () => {
    // An abort is what a real out-of-memory kill produces, and calling it a test
    // failure is how an infrastructure problem gets misattributed to whatever
    // changed last.
    //
    // How it surfaces is platform-dependent, which is worth pinning rather than
    // asserting one shape: Windows reports exit code 134 with no signal, Linux
    // reports exitCode null with signal SIGABRT. Asserting only the Windows
    // shape passed locally and failed on both CI Node lines.
    const out = runUnderReporter([
      "const { test, describe } = require('node:test');",
      "describe('outer', () => {",
      "  test('first', async () => { await new Promise(r => setTimeout(r, 30)); });",
      "  test('second', () => { process.abort(); });",
      '});',
    ].join('\n'));

    assert.match(out, /exitCode\s+134 \(0x86\)|signal\s+SIGABRT/,
      'neither an abort exit code nor an abort signal was reported');
    assert.match(out, /diagnosis\s+child aborted/,
      'an abort is being reported as an ordinary failure');
    // Either way it must NOT be described as an in-process failure, which is the
    // classification that would send someone looking at their own code.
    assert.doesNotMatch(out, /diagnosis\s+in-process failure/);
  });

  test('a native process kill is named as such, not blamed on the code', () => {
    // Exit 0xC0000409 is the Windows __fastfail path: the process is terminated
    // below the CRT, so Node runs no handler, writes nothing to stderr, and
    // produces no diagnostic report. Observed on this repo's suite. Nothing in
    // the repo can prevent it, so the only useful response is to say plainly
    // that it is not a code fault. This test drives the classifier directly
    // because a process cannot portably be made to fail-fast on demand.
    const mod = require('./helpers/crash-reporter.cjs');
    assert.equal(typeof mod, 'function', 'the reporter is not a generator function');

    // Feed it the exact event shape node:test emits for a crashed file.
    const events = [
      { type: 'test:fail',
        data: {
          name: 'tests/whatever.test.js',
          file: 'tests/whatever.test.js',
          details: { error: { exitCode: 0xC0000409, signal: null, failureType: 'testCodeFailure' } },
        } },
      { type: 'test:summary',
        data: { counts: { tests: 1, passed: 0, failed: 1, skipped: 0, suites: 0 } } },
    ];
    return (async () => {
      let out = '';
      for await (const chunk of mod((async function* () { yield* events; })())) out += chunk;
      assert.match(out, /NATIVE PROCESS KILL/,
        'a native fail-fast is not called out, so it reads as a code failure');
      assert.match(out, /not your change/i);
      assert.match(out, /0xC0000409/, 'the hex code is missing; it is the searchable part');
    })();
  });

  test('a signalled death is classified the same way on either platform', async () => {
    // Drives the classifier directly with the shapes each platform produces, so
    // the Linux path is covered when running on Windows and vice versa. Asserting
    // only the local shape is exactly how this test first passed here and failed
    // on both CI Node lines.
    const mod = require('./helpers/crash-reporter.cjs');
    const render = async (error) => {
      let out = '';
      const events = [
        { type: 'test:fail', data: { name: 'f.test.js', file: 'f.test.js', details: { error } } },
        { type: 'test:summary', data: { counts: { tests: 1, passed: 0, failed: 1, skipped: 0, suites: 0 } } },
      ];
      for await (const c of mod((async function* () { yield* events; })())) out += c;
      return out;
    };

    const linux = await render({ exitCode: null, signal: 'SIGABRT', failureType: 'testCodeFailure' });
    assert.match(linux, /diagnosis\s+child aborted/,
      'a SIGABRT death is not classified as an abort');
    assert.doesNotMatch(linux, /diagnosis\s+in-process failure/);

    const windows = await render({ exitCode: 134, signal: null, failureType: 'testCodeFailure' });
    assert.match(windows, /diagnosis\s+child aborted/,
      'exit 134 is not classified as an abort');

    // An external SIGKILL is a different story and should read differently: it
    // means something outside the test stopped the process.
    const killed = await render({ exitCode: null, signal: 'SIGKILL', failureType: 'testCodeFailure' });
    assert.match(killed, /killed by SIGKILL/);
    assert.match(killed, /outside the test/);
  });

  test('the reporter still reports passes, so it is usable for a whole run', () => {
    const out = runUnderReporter([
      "const { test } = require('node:test');",
      "test('fine', () => {});",
    ].join('\n'));
    assert.match(out, /ok\s+fine/);
    assert.match(out, /SUMMARY tests=1 pass=1 fail=0/);
  });
});

describe('sandbox harness: a failed spawn is reported, not timed out', () => {
  const { createSandbox, cleanupSandbox, spawnServer } = require('./helpers/sandbox');

  test('kill() does not leave a pending escalation timer', async () => {
    // The SIGKILL escalation timer used to stay pending after a prompt exit,
    // holding a ref'd handle for two more seconds per suite. Measured across
    // dozens of spawnServer files, that was a real slice of the runtime.
    const sandbox = createSandbox();
    const server = await spawnServer(sandbox);
    try {
      const started = Date.now();
      await server.kill();
      const elapsed = Date.now() - started;
      // A prompt SIGTERM exit is well under a second; the old code could not
      // resolve before the 2000 ms escalation in the worst case and always left
      // the timer behind.
      assert.ok(elapsed < 1900,
        `kill() took ${elapsed}ms, which suggests it waited for the escalation timer`);
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('spawnServer installs an error handler for a spawn that never starts', () => {
    // Structural: an 'error' event with no listener is an unhandled event, and
    // the visible symptom is the 30 s startup timeout plus a stack pointing at
    // the harness rather than at the missing binary. Forcing a real spawn
    // failure would mean giving the harness a test-only executable-path
    // override, which is a worse trade than pinning the wiring.
    const src = fs.readFileSync(path.join(__dirname, 'helpers', 'sandbox.js'), 'utf8');
    const at = src.indexOf('async function _spawnServerOnce');
    assert.ok(at > 0, 'could not find _spawnServerOnce');
    const body = src.slice(at, src.indexOf('\nfunction req(', at));
    assert.match(body, /proc\.on\('error'/,
      'a spawn failure is an unhandled error event again; it will surface as a timeout');
    assert.match(body, /failed to spawn/,
      'the spawn-failure rejection no longer says what went wrong');
  });
});

describe('the crash retry only ever retries a native kill', () => {
  const { classifyFailures } = require('../scripts/run-tests.js');

  // Reporter output for one natively killed file, including the duplicate block
  // the runner emits for the same file (its own failure plus its summary).
  const CRASHED = [
    '',
    'FAIL tests/api/loader.test.js',
    '  file        /repo/tests/api/loader.test.js',
    '  exitCode    3221226505 (0xC0000409)',
    '  failureType testCodeFailure',
    '  diagnosis   NATIVE PROCESS KILL',
    '',
    'FAIL tests/api/loader.test.js',
    '  file        /repo/tests/api/loader.test.js',
    '  exitCode    3221226505 (0xC0000409)',
    '  failureType testCodeFailure',
    '  diagnosis   NATIVE PROCESS KILL',
    '',
  ].join('\n');

  // A genuine in-process failure reports no child exit code at all.
  const GENUINE = [
    '',
    'FAIL a genuinely broken test',
    '  file        /repo/tests/broken.test.js',
    '  exitCode    undefined',
    '  failureType testCodeFailure',
    '  diagnosis   in-process failure',
    '',
  ].join('\n');

  test('one killed file reported twice counts as one file, not two failures', () => {
    // The runner emits a block for the file and another for its summary. Counting
    // blocks rather than files would make one crash look like several failures
    // and suppress the retry, which is how this safety net stops working
    // silently.
    const { crashed, genuine } = classifyFailures(CRASHED);
    assert.deepEqual(crashed, ['/repo/tests/api/loader.test.js']);
    assert.deepEqual(genuine, [], 'a duplicate crash block was read as a real failure');
  });

  test('a genuine test failure is never classified as a crash', () => {
    const { crashed, genuine } = classifyFailures(GENUINE);
    assert.deepEqual(crashed, [], 'a real failure would have been retried into green');
    assert.equal(genuine.length, 1);
  });

  test('a crash alongside a real failure is reported, so the retry is blocked', () => {
    // The dangerous case. If the real failure were lost here, the retry would
    // re-run only the crashed file, see it pass, and report a red run as green.
    const { crashed, genuine } = classifyFailures(CRASHED + GENUINE);
    assert.equal(crashed.length, 1);
    assert.equal(genuine.length, 1,
      'the real failure was lost, so the run could be retried into a false green');
  });

  test('a file that both crashed and failed a test counts as a real failure', () => {
    const mixed = [
      '',
      'FAIL some test',
      '  file        /repo/tests/x.test.js',
      '  exitCode    undefined',
      '  failureType testCodeFailure',
      '',
      'FAIL tests/x.test.js',
      '  file        /repo/tests/x.test.js',
      '  exitCode    3221226505 (0xC0000409)',
      '  failureType testCodeFailure',
      '',
    ].join('\n');
    const { crashed, genuine } = classifyFailures(mixed);
    assert.deepEqual(crashed, [],
      'a file with a real failure must not be eligible for the crash retry');
    assert.equal(genuine.length, 1);
  });
});
