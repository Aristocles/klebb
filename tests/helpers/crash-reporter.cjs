// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/helpers/crash-reporter.cjs
//
// A node:test reporter that says WHY a test file died.
//
// The default spec reporter throws away the child process's exit code. When a
// test file's process dies mid-run, every result it had not yet flushed is lost
// (node:test streams a file's results to the parent as suites resolve, so a file
// wrapped in one top-level describe reports nothing at all), and the output is a
// bare:
//
//     ✖ tests\some-file.test.js (2132.945ms)
//       'test failed'
//
// No exit code, no stderr, no subtests, no stack. That is indistinguishable from
// "the code you just changed is broken", and it has cost real investigation time
// more than once on this repo. The information exists on the event; nothing
// prints it.
//
// This reporter prints, for every failure, the child's exit code in hex, the
// signal, the failure type, how many results the file managed to emit, and the
// tail of its stderr. That is enough to classify a failure in one glance:
//
//   exitCode=undefined, a real stack, children>0   an ordinary test failure: yours
//   exitCode=1 with EADDRINUSE in stderr           lost the port race (harness retries)
//   exitCode=134 (0x86) with a GC dump             the child ran out of memory
//   exitCode=3221226505 (0xC0000409), no stderr    Windows __fastfail: the OS killed
//                                                  the process below the CRT. Not a
//                                                  JavaScript fault, not your change.
//
// Usage:
//   npm run test:diag                 (a full run through this reporter)
//   node --test --test-reporter=./tests/helpers/crash-reporter.cjs <files>
//
// Deliberately NOT the default reporter: the spec output is what you want while
// working. This is the thing you reach for when a file aborts and the default
// output tells you nothing.
//
// .cjs rather than .js because a reporter is loaded by path and the repo is
// CommonJS-by-default; the explicit extension keeps it working regardless.

'use strict';

const MAX_STDERR_LINES = 500;
const STDERR_TAIL_CHARS = 2000;

// Windows STATUS_STACK_BUFFER_OVERRUN. Node never runs a handler for this: the
// process is terminated below the CRT, which is why stderr comes back empty and
// why --report-on-fatalerror produces nothing.
const NATIVE_FAIL_FAST = 0xC0000409 >>> 0;

function classify(exitCode, signal, stderr) {
  // How an abort surfaces is platform-dependent: Linux reports signal SIGABRT
  // with a null exit code, Windows reports exit code 134 and no signal. Both are
  // the same event (usually the child running out of memory), so both get the
  // same wording, and the out-of-memory hint only appears when the stderr backs
  // it up rather than being guessed.
  if (signal === 'SIGABRT') {
    return /Last few GCs|heap limit|out of memory/i.test(stderr)
      ? 'child aborted: out of memory (killed by SIGABRT)'
      : 'child aborted (killed by SIGABRT; process.abort() or a native assertion)';
  }
  if (signal === 'SIGKILL' || signal === 'SIGTERM') {
    return `killed by ${signal}: something outside the test stopped this process`;
  }
  if (signal) return `killed by ${signal}`;
  if (exitCode === undefined || exitCode === null) {
    return 'in-process failure (an assertion or a throw; see the stack above)';
  }
  if ((exitCode >>> 0) === NATIVE_FAIL_FAST) {
    return 'NATIVE PROCESS KILL (Windows __fastfail). Not a JavaScript fault and '
      + 'almost certainly not your change: retry the file before investigating.';
  }
  if (exitCode === 134) return 'child aborted (out of memory, or process.abort())';
  if (exitCode === 1 && /EADDRINUSE/.test(stderr)) {
    return 'lost the port race (EADDRINUSE); the harness retries this, so seeing it '
      + 'here means it lost every attempt';
  }
  if (exitCode === 1) return 'child exited 1 (an uncaught throw, or an explicit exit)';
  return `child exited ${exitCode}`;
}

module.exports = async function* crashReporter(source) {
  const stderrByFile = new Map();
  const emitted = new Map();
  const failures = [];

  for await (const event of source) {
    const file = event.data && event.data.file;

    if (event.type === 'test:stderr' && file) {
      const lines = stderrByFile.get(file) || [];
      lines.push(event.data.message);
      // Bounded: a chatty file must not be able to exhaust memory in the
      // reporter, and only the tail is ever useful.
      while (lines.length > MAX_STDERR_LINES) lines.shift();
      stderrByFile.set(file, lines);
      continue;
    }

    if (event.type === 'test:pass' || event.type === 'test:fail') {
      if (file) emitted.set(file, (emitted.get(file) || 0) + 1);
    }

    if (event.type === 'test:pass') {
      yield `  ok   ${event.data.name}\n`;
      continue;
    }

    if (event.type === 'test:fail') {
      const err = (event.data.details && event.data.details.error) || {};
      const cause = err.cause || {};
      const stderr = (stderrByFile.get(file) || []).join('');
      const { exitCode, signal, failureType } = err;

      const report = [
        '',
        `FAIL ${event.data.name}`,
        `  file        ${file || '(unknown)'}`,
        `  exitCode    ${exitCode === undefined ? 'undefined' : `${exitCode} (0x${(exitCode >>> 0).toString(16).toUpperCase()})`}`,
        `  signal      ${signal === undefined ? 'undefined' : signal}`,
        `  failureType ${failureType}`,
        `  results emitted by this file: ${emitted.get(file) || 0}`,
        `  diagnosis   ${classify(exitCode, signal, stderr)}`,
      ];

      const message = String(cause.message || err.message || '').trim();
      if (message) report.push(`  message     ${message.split('\n').join('\n              ')}`);
      const stack = String(cause.stack || '').trim();
      if (stack) report.push(`  stack\n${stack.split('\n').map(l => `    ${l}`).join('\n')}`);
      if (stderr) report.push(`  stderr tail\n${stderr.slice(-STDERR_TAIL_CHARS)}`);

      report.push('');
      const text = report.join('\n');
      failures.push(text);
      yield text;
      continue;
    }

    if (event.type === 'test:summary' && event.data.file === undefined) {
      const c = event.data.counts;
      yield `\nSUMMARY tests=${c.tests} pass=${c.passed} fail=${c.failed} `
        + `skipped=${c.skipped} suites=${c.suites}\n`;
      // Repeat every failure at the very end. In a run of this size the first
      // one scrolls thousands of lines out of reach.
      if (failures.length) {
        yield `\n${'='.repeat(70)}\nFAILURES (${failures.length})\n${'='.repeat(70)}`;
        for (const f of failures) yield f;
      }
    }
  }
};
