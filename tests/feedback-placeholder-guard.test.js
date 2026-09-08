// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/feedback-placeholder-guard.test.js
// #724: note_feedback used to accept placeholder intents ('placeholder',
// 'skip', 'noop', 'n/a - ...'), and half the collected log was such lines.
// appendFeedback now rejects them with a reason the model can read, while
// real reports that merely OPEN with an ambiguous word still log.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createSandbox, cleanupSandbox } = require('./helpers/sandbox');

const REPO_ROOT = path.resolve(__dirname, '..');

function freshFeedback(sandboxRoot) {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(path.resolve(REPO_ROOT, 'lib') + path.sep) ||
        key.startsWith(path.resolve(REPO_ROOT, 'config') + path.sep)) {
      delete require.cache[key];
    }
  }
  process.env.HEALTH_HOME = sandboxRoot;
  return require(path.join(REPO_ROOT, 'lib', 'feedback.js'));
}

function logLines(sandboxRoot) {
  const file = path.join(sandboxRoot, 'data', '_meta', 'feedback.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
}

describe('#724: placeholder intents are rejected', () => {
  test('every observed placeholder shape is refused with a readable reason', () => {
    const sandbox = createSandbox();
    try {
      const { appendFeedback } = freshFeedback(sandbox);
      const placeholders = [
        'placeholder',
        'placeholder - not used',
        'skip',
        'noop',
        'none',
        'test',
        'n/a - no gap, just noting a data question',
        'accidental duplicate feedback call, ignore',
        'ignore this one',
      ];
      for (const intent of placeholders) {
        const out = appendFeedback({ kind: 'bug', intent });
        assert.equal(out.logged, false, `"${intent}" must not log`);
        assert.match(out.reason, /placeholder/, `"${intent}" reason names the rejection`);
      }
      assert.equal(logLines(sandbox).length, 0, 'nothing was appended');
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('real reports that open with an ambiguous word still log', () => {
    const sandbox = createSandbox();
    try {
      const { appendFeedback } = freshFeedback(sandbox);
      const real = [
        'skip button on the prompt modal does nothing',
        'test results table misaligns its unit column',
        'none of the cards refresh after an import',
        'wants to chart sleep as a heatmap',
      ];
      for (const intent of real) {
        const out = appendFeedback({ kind: 'feature', intent });
        assert.equal(out.logged, true, `"${intent}" must log`);
      }
      assert.equal(logLines(sandbox).length, real.length);
    } finally {
      cleanupSandbox(sandbox);
    }
  });
});
