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
