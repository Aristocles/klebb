// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/feedback.test.js
// Unit tests for the anonymised feedback log. The anonymise() boundary is
// load-bearing: nothing else strips PII, so it must keep only a paraphrased
// intent + structural context + timestamp, and never leak raw values.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { anonymise } = require('../lib/feedback');
const { TOOL_DEFS } = require('../chat/tools');

const NOW = '2026-06-24T04:12:00.000Z';

describe('feedback: anonymise', () => {
  test('keeps intent, context, toolsConsidered, and the timestamp', () => {
    const line = anonymise({
      intent: 'wants to chart sleep as a heatmap',
      context: 'renderer=line-chart present; no heatmap renderer',
      toolsConsidered: ['create_manifest', 'write_manifest_data'],
    }, NOW);
    assert.deepStrictEqual(line, {
      ts: NOW,
      kind: 'feature',
      intent: 'wants to chart sleep as a heatmap',
      context: 'renderer=line-chart present; no heatmap renderer',
      toolsConsidered: ['create_manifest', 'write_manifest_data'],
    });
  });

  test('returns null when there is no usable intent', () => {
    assert.strictEqual(anonymise({}, NOW), null);
    assert.strictEqual(anonymise({ intent: '   ' }, NOW), null);
    assert.strictEqual(anonymise({ context: 'x' }, NOW), null);
    assert.strictEqual(anonymise(null, NOW), null);
  });

  test('drops context/tools when absent rather than emitting empties', () => {
    const line = anonymise({ intent: 'wants CSV export' }, NOW);
    assert.deepStrictEqual(line, { ts: NOW, kind: 'feature', intent: 'wants CSV export' });
    assert.strictEqual('context' in line, false);
    assert.strictEqual('toolsConsidered' in line, false);
  });

  test('caps intent and context length (no unbounded blobs)', () => {
    const longIntent = 'x'.repeat(1000);
    const longContext = 'y'.repeat(1000);
    const line = anonymise({ intent: longIntent, context: longContext }, NOW);
    assert.ok(line.intent.length <= 280);
    assert.ok(line.context.length <= 500);
  });

  test('caps and string-filters toolsConsidered', () => {
    const tools = Array.from({ length: 30 }, (_, i) => `tool_${i}`).concat([123, null, {}]);
    const line = anonymise({ intent: 'x', toolsConsidered: tools }, NOW);
    assert.ok(line.toolsConsidered.length <= 12);
    assert.ok(line.toolsConsidered.every(t => typeof t === 'string'));
  });

  test('does NOT pull any other field through (no leakage of raw transcript/values)', () => {
    const line = anonymise({
      intent: 'wants a heatmap',
      rawMessage: 'my weight is 84.2kg and I am worried about my diagnosis',
      values: [84.2, 83.1],
      userName: 'someone',
    }, NOW);
    // Only the allowed keys survive; nothing else.
    assert.deepStrictEqual(Object.keys(line).sort(), ['intent', 'kind', 'ts']);
    const serialised = JSON.stringify(line);
    assert.ok(!serialised.includes('84.2'));
    assert.ok(!serialised.includes('diagnosis'));
    assert.ok(!serialised.includes('someone'));
  });
});

describe('feedback: kind (#608)', () => {
  test("literal 'bug' is kept", () => {
    const line = anonymise({ kind: 'bug', intent: 'chart renders blank after a goal line is added' }, NOW);
    assert.strictEqual(line.kind, 'bug');
  });

  test("anything else degrades to 'feature', the historical meaning of the log", () => {
    for (const junk of [undefined, null, 'BUG', 'complaint', 42, {}]) {
      const line = anonymise({ kind: junk, intent: 'x' }, NOW);
      assert.strictEqual(line.kind, 'feature', `kind=${String(junk)}`);
    }
  });
});

describe('feedback: tool registration', () => {
  test('note_feedback is in TOOL_DEFS requiring kind + intent', () => {
    const def = TOOL_DEFS.find(t => t.function?.name === 'note_feedback');
    assert.ok(def, 'note_feedback missing from TOOL_DEFS');
    assert.deepStrictEqual(def.function.parameters.required, ['kind', 'intent']);
    assert.deepStrictEqual(def.function.parameters.properties.kind.enum, ['bug', 'feature']);
  });

  test('the old tool name is gone (renamed, not duplicated)', () => {
    assert.ok(!TOOL_DEFS.some(t => t.function?.name === 'note_feature_request'));
  });
});
