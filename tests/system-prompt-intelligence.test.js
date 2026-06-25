// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/system-prompt-intelligence.test.js
// The v3.3.0 intelligence tools and steering blocks are present in the default
// system prompt. These are load-bearing: the tools exist in TOOL_DEFS but only
// do useful work if the prompt steers Klebbius to reach for them.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');

// Read the DEFAULT prompt, not an env override.
let PROMPT;
before(() => {
  const saved = { f: process.env.HEALTH_SYSTEM_PROMPT_FILE, p: process.env.HEALTH_SYSTEM_PROMPT };
  delete process.env.HEALTH_SYSTEM_PROMPT_FILE;
  delete process.env.HEALTH_SYSTEM_PROMPT;
  delete require.cache[require.resolve('../config/env')];
  PROMPT = require('../config/env').HEALTH_SYSTEM_PROMPT;
  if (saved.f !== undefined) process.env.HEALTH_SYSTEM_PROMPT_FILE = saved.f;
  if (saved.p !== undefined) process.env.HEALTH_SYSTEM_PROMPT = saved.p;
});

describe('system prompt: new intelligence tools are documented', () => {
  for (const tool of ['get_recent_activity', 'hygiene_scan', 'validate_manifest', 'note_feature_request']) {
    test(`mentions ${tool}`, () => {
      assert.ok(PROMPT.includes(tool), `prompt should document the ${tool} tool`);
    });
  }
});

describe('system prompt: intent-engine steering', () => {
  test('has a "Reading intent and acting" block', () => {
    assert.ok(/Reading intent and acting/.test(PROMPT));
  });
  test('codifies act-by-default for unambiguous requests', () => {
    assert.ok(/Reads run immediately/.test(PROMPT));
    assert.ok(/unambiguous create or update runs immediately/.test(PROMPT));
  });
  test('codifies the one-question rule (destructive AND ambiguous)', () => {
    assert.ok(/AT MOST one question/.test(PROMPT));
    assert.ok(/destructive or multi-card mutation/.test(PROMPT));
  });
  test('steers pre-fill from sibling cards via get_recent_activity', () => {
    assert.ok(/Pre-fill from sibling cards/.test(PROMPT));
    assert.ok(/get_recent_activity/.test(PROMPT));
  });
});

describe('system prompt: validate-before-write gate', () => {
  test('directs calling validate_manifest before create/patch', () => {
    assert.ok(/Validate before you write/.test(PROMPT));
    assert.ok(/Before EVERY .?create_manifest.? or .?patch_manifest.?/.test(PROMPT));
  });
  test('bounds the self-correction loop', () => {
    assert.ok(/at most two correction attempts/.test(PROMPT));
  });
});

describe('system prompt: unsupported-request rubric', () => {
  test('distinguishes unsupported from needs-a-question and logs the gap', () => {
    assert.ok(/Unsupported vs just-needs-a-question/.test(PROMPT));
    assert.ok(/genuinely unsupported/.test(PROMPT));
    assert.ok(/note_feature_request/.test(PROMPT));
  });
  test('the stale "no reorder primitive" example is gone (reorder_rows exists)', () => {
    assert.ok(!/there's no reorder primitive/.test(PROMPT),
      'the reorder refusal example contradicts the reorder_rows tool and must be removed');
  });
});
