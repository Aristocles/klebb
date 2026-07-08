// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/eval-harness.test.js
// Deterministic coverage for the evals/ harness internals (#498): the
// chat-debug tool-line parser, the snapshot differ, and the assertion
// vocabulary. The probabilistic scenario runs live in evals/run.js and
// never in CI; these pin the machinery it stands on.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { parseChatLog, createLogCollector } = require('../evals/lib/toollog');
const { diffSnapshots } = require('../evals/lib/diff');
const { evalTurn } = require('../evals/lib/assert');

describe('#498 toollog parser', () => {
  const LOG = [
    '[chat:ab12cd] start turns=1 voice=false',
    'unrelated noise line',
    '[chat:ab12cd] tool create_manifest id=water took=12ms ok',
    '[chat:ab12cd] tool patch_manifest id=water took=3ms err',
    '[chat:ab12cd] done total=8123ms iters=3 capped=false',
    '[chat:ff00aa] start turns=2 voice=true',
    '[chat:ff00aa] tool read_manifest id=- took=1ms ok',
  ].join('\n');

  test('groups tool lines by request id with ok/err and timing', () => {
    const reqs = parseChatLog(LOG);
    assert.equal(reqs.length, 2);
    const first = reqs.find(r => r.reqId === 'ab12cd');
    assert.deepEqual(first.tools.map(t => t.name), ['create_manifest', 'patch_manifest']);
    assert.equal(first.tools[0].ok, true);
    assert.equal(first.tools[1].ok, false);
    assert.equal(first.tools[0].manifestId, 'water');
    assert.equal(first.totalMs, 8123);
    assert.equal(first.iters, 3);
    assert.equal(first.capped, false);
  });

  test('dash manifest id parses as null', () => {
    const reqs = parseChatLog(LOG);
    const second = reqs.find(r => r.reqId === 'ff00aa');
    assert.equal(second.tools[0].manifestId, null);
  });

  test('collector sinceMark only reports lines after the mark', () => {
    const c = createLogCollector();
    c.feed('[chat:aaa111] tool create_manifest id=x took=1ms ok\n');
    c.mark();
    c.feed('[chat:bbb222] tool delete_manifest id=y took=1ms ok\n');
    const since = c.sinceMark();
    assert.equal(since.length, 1);
    assert.equal(since[0].tools[0].name, 'delete_manifest');
    assert.equal(c.all().length, 2);
  });
});

describe('#498 snapshot differ', () => {
  const before = { cards: {
    a: { meta: { id: 'a' }, data: [1] },
    b: { meta: { id: 'b' }, data: [2] },
    c: { meta: { id: 'c' }, data: [3] },
  } };
  const after = { cards: {
    a: { meta: { id: 'a' }, data: [1] },
    b: { meta: { id: 'b' }, data: [2, 9] },
    d: { meta: { id: 'd' }, data: [] },
  } };

  test('classifies created, deleted, modified, untouched', () => {
    const d = diffSnapshots(before, after);
    assert.deepEqual(d.created, ['d']);
    assert.deepEqual(d.deleted, ['c']);
    assert.deepEqual(d.modified, ['b']);
    assert.deepEqual(d.untouched, ['a']);
  });
});

describe('#498 assertion vocabulary', () => {
  const cleanDiff = { created: [], deleted: [], modified: [], untouched: ['a'] };
  const baseFacts = {
    reply: 'Done! I created the Water card for you.',
    followup: { text: 'Want to flesh it out?', embellishments: [{ id: 'add-emoji', label: 'Pick an emoji', prompt: 'Pick an emoji for the Water card.' }] },
    status: 200,
    tools: [{ name: 'create_manifest', manifestId: 'water', ms: 10, ok: true }],
    diff: { created: ['water'], deleted: [], modified: [], untouched: ['a'] },
    registryErrors: [],
  };

  test('a fully-satisfied expectation returns no findings', () => {
    const findings = evalTurn({
      http: { status: 200 },
      reply: { match: ['water'], noMatch: ['error'] },
      tools: { required: ['create_manifest'], forbidden: ['delete_manifest'], noErrors: true },
      state: { created: ['water'], noDeletes: true },
      registryClean: true,
      chips: { present: true, labelsInclude: ['emoji'], maxCount: 3 },
    }, baseFacts);
    assert.deepEqual(findings, []);
  });

  test('forbidden tool call is flagged', () => {
    const findings = evalTurn({ tools: { forbidden: ['create_manifest'] } }, baseFacts);
    assert.equal(findings.length, 1);
    assert.match(findings[0], /forbidden create_manifest/);
  });

  test('allowOnly flags strays', () => {
    const findings = evalTurn({ tools: { allowOnly: ['read_manifest'] } }, baseFacts);
    assert.match(findings[0], /outside allowOnly/);
  });

  test('noChanges catches any mutation', () => {
    const findings = evalTurn({ state: { noChanges: true } }, baseFacts);
    assert.equal(findings.length, 1);
    assert.match(findings[0], /expected no changes/);
  });

  test('modifiedOnly rejects creates and out-of-list modifications', () => {
    const facts = { ...baseFacts, diff: { created: ['x'], deleted: [], modified: ['a', 'b'], untouched: [] } };
    const findings = evalTurn({ state: { modifiedOnly: ['a'] } }, facts);
    assert.equal(findings.length, 2);
  });

  test('tool errors are flagged under noErrors', () => {
    const facts = { ...baseFacts, tools: [{ name: 'patch_manifest', manifestId: 'a', ms: 2, ok: false }] };
    const findings = evalTurn({ tools: { noErrors: true } }, facts);
    assert.match(findings[0], /returned an error/);
  });

  test('registry errors are flagged under registryClean', () => {
    const facts = { ...baseFacts, registryErrors: [{ file: 'water.json', error: 'bad shape' }] };
    const findings = evalTurn({ registryClean: true }, facts);
    assert.match(findings[0], /loader error/);
  });

  test('reply regex directions both enforce', () => {
    const noMatch = evalTurn({ reply: { match: ['nonexistent-token'] } }, baseFacts);
    assert.match(noMatch[0], /missing/);
    const matched = evalTurn({ reply: { noMatch: ['water'] } }, baseFacts);
    assert.match(matched[0], /forbidden/);
  });

  test('chip expectations enforce presence, labels and cap', () => {
    const none = evalTurn({ chips: { present: true } }, { ...baseFacts, followup: null });
    assert.match(none[0], /expected followup chips/);
    const label = evalTurn({ chips: { labelsInclude: ['calendar'] } }, baseFacts);
    assert.match(label[0], /no label containing/);
    const cap = evalTurn({ chips: { maxCount: 0 } }, baseFacts);
    assert.match(cap[0], /exceeds max/);
  });
});
