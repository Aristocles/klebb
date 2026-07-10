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
const { evalTurn, evalCardShape } = require('../evals/lib/assert');

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

describe('#501 cardShape assertion', () => {
  const snapshot = {
    cards: {
      weight: {
        meta: {
          id: 'weight', label: 'Weight',
          trends: { enabled: true, component: 'line-chart' },
          notifications: { enabled: true, items: [{ id: 'log', trigger: { type: 'daily', time: '08:00' } }] },
        },
        data: [{ date: '2026-07-01', value: 82.4 }, { date: '2026-07-05', value: 82.1 }],
      },
      combo: {
        meta: {
          id: 'combo',
          view: {
            component: 'combination-card',
            combines: [{ sourceId: 'sleep', role: 'primary' }, { sourceId: 'rhr', role: 'secondary' }],
          },
        },
        data: [],
      },
    },
  };
  const diff = { created: [], deleted: [], modified: ['weight'], untouched: [] };

  test('meta path equality passes and mismatch is flagged', () => {
    assert.deepEqual(
      evalCardShape({ weight: { 'meta.trends.enabled': { equals: true } } }, { snapshot, diff }),
      [],
    );
    const bad = evalCardShape({ weight: { 'meta.trends.component': { equals: 'schedule-timeline' } } }, { snapshot, diff });
    assert.equal(bad.length, 1);
    assert.match(bad[0], /expected equals/);
  });

  test('data row addressed by equality filter', () => {
    assert.deepEqual(
      evalCardShape({ weight: { 'data[date="2026-07-05"].value': { equals: 82.1 } } }, { snapshot, diff }),
      [],
    );
    const bad = evalCardShape({ weight: { 'data[date="2026-07-05"].value': { equals: 99 } } }, { snapshot, diff });
    assert.match(bad[0], /expected equals 99, got 82.1/);
  });

  test('combines[] shape: array minLength, index filter, sourceId exists', () => {
    assert.deepEqual(
      evalCardShape({
        combo: {
          'meta.view.component': { equals: 'combination-card' },
          'meta.view.combines': { type: 'array', minLength: 2 },
          'meta.view.combines[index=0].sourceId': { exists: true },
        },
      }, { snapshot, diff }),
      [],
    );
  });

  test('type, length, oneOf matchers', () => {
    assert.deepEqual(evalCardShape({ weight: { 'data': { type: 'array', length: 2 } } }, { snapshot, diff }), []);
    assert.deepEqual(evalCardShape({ weight: { 'meta.notifications.items[index=0].trigger.type': { oneOf: ['daily', 'weekly'] } } }, { snapshot, diff }), []);
    const badLen = evalCardShape({ weight: { data: { length: 5 } } }, { snapshot, diff });
    assert.match(badLen[0], /expected length 5, got 2/);
    const badOne = evalCardShape({ weight: { 'meta.trends.component': { oneOf: ['a', 'b'] } } }, { snapshot, diff });
    assert.match(badOne[0], /expected one of/);
  });

  test('exists:false passes for an absent path, fails for a present one', () => {
    assert.deepEqual(evalCardShape({ weight: { 'meta.reports': { exists: false } } }, { snapshot, diff }), []);
    const present = evalCardShape({ weight: { 'meta.trends': { exists: false } } }, { snapshot, diff });
    assert.match(present[0], /expected NOT to exist/);
  });

  test('a value matcher on a missing path fails cleanly (no crash)', () => {
    const findings = evalCardShape({ weight: { 'meta.reports.component': { equals: 'adherence-report' } } }, { snapshot, diff });
    assert.equal(findings.length, 1);
    assert.match(findings[0], /resolves to nothing/);
  });

  test('$created resolves to the single created card', () => {
    const created = { created: ['combo'], deleted: [], modified: [], untouched: [] };
    assert.deepEqual(
      evalCardShape({ $created: { 'meta.view.component': { equals: 'combination-card' } } }, { snapshot, diff: created }),
      [],
    );
  });

  test('$created flags when zero or many cards were created', () => {
    const zero = evalCardShape({ $created: { 'meta.id': { exists: true } } }, { snapshot, diff: { created: [], deleted: [], modified: [], untouched: [] } });
    assert.match(zero[0], /expected exactly one created card/);
    const many = evalCardShape({ $created: { 'meta.id': { exists: true } } }, { snapshot, diff: { created: ['a', 'b'], deleted: [], modified: [], untouched: [] } });
    assert.match(many[0], /expected exactly one created card/);
  });

  test('unknown card id is flagged', () => {
    const findings = evalCardShape({ nope: { 'meta.id': { exists: true } } }, { snapshot, diff });
    assert.match(findings[0], /no card "nope"/);
  });

  test('missing snapshot degrades to a single clear finding', () => {
    const findings = evalCardShape({ weight: { 'meta.id': { exists: true } } }, { snapshot: null, diff });
    assert.equal(findings.length, 1);
    assert.match(findings[0], /no snapshot available/);
  });

  test('evalTurn threads cardShape through', () => {
    const facts = {
      reply: '', followup: null, status: 200, tools: [],
      diff, snapshot, registryErrors: [],
    };
    assert.deepEqual(evalTurn({ cardShape: { weight: { 'meta.trends.enabled': { equals: true } } } }, facts), []);
    const bad = evalTurn({ cardShape: { weight: { 'meta.trends.enabled': { equals: false } } } }, facts);
    assert.match(bad[0], /cardShape\[weight\]/);
  });
});
