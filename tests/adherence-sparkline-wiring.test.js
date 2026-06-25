// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/adherence-sparkline-wiring.test.js
// Source-level coverage for wiring the adherence sparkline into checklist-card
// and schedule-card (#446). The components can't run under Node (esm.sh Lit);
// the adherence maths is already unit-tested in series-helpers.test.js, so this
// pins the wiring facts: imports, default-off + Today-only guards, the >=2
// signal-day guard, and the critical isScheduled === 'scheduled' comparison.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'components', f), 'utf8');
const CHECK = read('eh-checklist-card.js');
const SCHED = read('eh-schedule-card.js');

describe('checklist-card adherence wiring', () => {
  test('imports adherenceSeries and the eh-sparkline element', () => {
    assert.ok(/import\s*\{[^}]*\badherenceSeries\b[^}]*\}\s*from\s*'\.\.\/lib\/adherence-series\.esm\.js'/.test(CHECK));
    assert.ok(/import\s*'\.\/eh-sparkline\.js'/.test(CHECK));
  });
  test('gated on showSparkline and Today', () => {
    assert.ok(/_renderAdherence\(\)/.test(CHECK));
    assert.ok(/this\._config\.showSparkline/.test(CHECK));
    assert.ok(/dateMode === 'today'/.test(CHECK));
  });
  test('predicates are date-parameterised so they evaluate per-day', () => {
    assert.ok(/_isDue\(item, date = this\.date\)/.test(CHECK), '_isDue takes an explicit date');
    assert.ok(/_isDone\(item, date = this\.date\)/.test(CHECK), '_isDone takes an explicit date');
    assert.ok(/isDueOn:\s*\(item, day\)\s*=>\s*this\._isDue\(item, day\)/.test(CHECK));
    assert.ok(/isTakenOn:\s*\(item, day\)\s*=>\s*this\._isDone\(item, day\)/.test(CHECK));
  });
  test('requires >=2 non-null signal days', () => {
    assert.ok(/filter\(v => v !== null\)\.length < 2/.test(CHECK));
  });
  test('mounts eh-sparkline in adherence mode', () => {
    assert.ok(/<eh-sparkline mode="adherence" \.values=\$\{series\}>/.test(CHECK));
  });
});

describe('schedule-card adherence wiring', () => {
  test('imports itemAdherenceSeries and the eh-sparkline element', () => {
    assert.ok(/import\s*\{[^}]*\bitemAdherenceSeries\b[^}]*\}\s*from\s*'\.\.\/lib\/adherence-series\.esm\.js'/.test(SCHED));
    assert.ok(/import\s*'\.\/eh-sparkline\.js'/.test(SCHED));
  });
  test('gated on showSparkline and Today', () => {
    assert.ok(/_renderAdherenceSpark\(item\)/.test(SCHED));
    assert.ok(/this\._config\.showSparkline/.test(SCHED));
    assert.ok(/dateMode === 'today'/.test(SCHED));
  });
  test('CRITICAL: isScheduled compares === "scheduled" (not truthiness)', () => {
    // isScheduledOnDate returns 'scheduled'|'rest'|'off'|false; rest/off are
    // truthy, so a truthiness check would count rest days as scheduled.
    assert.ok(/isScheduled:\s*\(it, day\)\s*=>\s*isScheduledOnDate\(it, day\)\s*===\s*'scheduled'/.test(SCHED));
    assert.ok(/isTaken:\s*\(it, day\)\s*=>\s*this\._isTakenOn\(it, day\)/.test(SCHED));
  });
  test('requires >=2 non-null signal days', () => {
    assert.ok(/filter\(v => v !== null\)\.length < 2/.test(SCHED));
  });
});
