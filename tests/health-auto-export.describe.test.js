// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/health-auto-export.describe.test.js
// Pure unit tests for the catalogue describe helper.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { describeCatalogue, describeMetric } = require('../health-auto-export/describe');
const catalogue = require('../health-auto-export/catalogue');

describe('describeCatalogue', () => {
  test('produces a non-empty multi-line block', () => {
    const out = describeCatalogue();
    assert.equal(typeof out, 'string');
    assert.ok(out.split('\n').length > 10);
  });

  test('includes the rule about using catalogue fields only', () => {
    const out = describeCatalogue();
    assert.match(out, /catalogue/i);
    assert.match(out, /only use fields/i);
    assert.match(out, /do not invent fields/i);
  });

  test('lists every catalogue metric', () => {
    const out = describeCatalogue();
    for (const key of Object.keys(catalogue)) {
      assert.ok(out.includes(key), `describe missing metric: ${key}`);
    }
  });

  test('each metric line names its aggregate and source', () => {
    const out = describeCatalogue();
    assert.match(out, /step_count.*sum-per-date/);
    assert.match(out, /heart_rate_variability.*mean-per-date/);
    assert.match(out, /workouts.*boolean-any-per-date/);
    assert.match(out, /data\.workouts\[\]/);
  });

  test('carries display-template guidance for HAE-backed cards', () => {
    const out = describeCatalogue();
    assert.match(out, /round\(N\)/);
    assert.match(out, /fallbackToLatest.*true/i);
  });

  test('flags workouts as the fallbackToLatest exception (per #234)', () => {
    // Boolean-shaped cards like workouts/meditation must render the
    // empty state on rest days, not carry the most recent prior row
    // forward as if it were today. Make sure the agent guidance says
    // so explicitly + suggests the {trained:check} modifier.
    const out = describeCatalogue();
    assert.match(out, /DO NOT set `fallbackToLatest/i);
    assert.match(out, /workout/i);
    assert.match(out, /\{trained:check\}/);
  });

  test('each metric line prefixes its category in brackets', () => {
    const out = describeCatalogue();
    assert.match(out, /\[sleep\] sleep_analysis/);
    assert.match(out, /\[activity\] step_count/);
    assert.match(out, /\[recovery\] heart_rate_variability/);
    assert.match(out, /\[vitals\] blood_oxygen_saturation/);
    assert.match(out, /\[body\] body_mass/);
    assert.match(out, /\[mindfulness\] mindful_minutes/);
  });
});

describe('describeMetric', () => {
  test('step_count exposes {date, count}', () => {
    const line = describeMetric('step_count', catalogue.step_count);
    assert.match(line, /date/);
    assert.match(line, /count/);
    assert.match(line, /sum-per-date/);
  });

  test('blood_oxygen_saturation exposes {date, pct}', () => {
    const line = describeMetric('blood_oxygen_saturation', catalogue.blood_oxygen_saturation);
    assert.match(line, /pct/);
  });

  test('workouts marks its source as data.workouts[]', () => {
    const line = describeMetric('workouts', catalogue.workouts);
    assert.match(line, /data\.workouts\[\]/);
    assert.match(line, /trained/);
  });

  test('output includes date first in the field list', () => {
    const line = describeMetric('step_count', catalogue.step_count);
    // "row = { date, count }" — date before count
    const match = line.match(/row = \{ ([^}]+) \}/);
    assert.ok(match, 'should match row = { ... }');
    const fields = match[1].split(',').map(s => s.trim());
    assert.equal(fields[0], 'date');
  });
});
