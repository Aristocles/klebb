// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/orphans-tools.test.js
// The orphan_report / rename_data_field chat tools dispatched against the
// real registry + datastore (fresh-required per the manifest-registry
// harness pattern). HTTP surface in tests/orphans-api.test.js.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { createSandbox, cleanupSandbox } = require('./helpers/sandbox');
const { readStored } = require('./helpers/datastore-readback');

const WEIGHT = {
  $schema: 'klebb.datafile.v1',
  meta: {
    id: 'weight', label: 'Weight',
    view: { enabled: true, component: 'generic-card', display: { template: '{kg:round(1)}' } },
    writeable: { fromWebapp: true, inputs: [{ key: 'kg', label: 'kg', type: 'number' }] },
    trends: { enabled: true, component: 'line-chart', field: 'kg' },
  },
  // waist_cm was captured by an input that has since been removed.
  data: [
    { date: '2026-06-01', kg: 84, waist_cm: 90 },
    { date: '2026-06-02', kg: 83.6, waist_cm: 89 },
  ],
};

describe('orphan_report + rename_data_field chat tools', () => {
  let sandbox, registry, tools;

  function freshModules(sandboxRoot) {
    const REPO_ROOT = path.resolve(__dirname, '..');
    for (const key of Object.keys(require.cache)) {
      if (key.startsWith(path.join(REPO_ROOT, 'manifests'))
        || key.startsWith(path.join(REPO_ROOT, 'config'))
        || key.startsWith(path.join(REPO_ROOT, 'chat'))
        || key.startsWith(path.join(REPO_ROOT, 'lib'))) {
        delete require.cache[key];
      }
    }
    process.env.HEALTH_HOME = sandboxRoot;
    process.env.HEALTH_HOME_WARNED = '1';
    registry = require(path.join(REPO_ROOT, 'manifests', 'registry.js'));
    tools = require(path.join(REPO_ROOT, 'chat', 'tools.js'));
    registry.init();
  }

  function call(name, args) {
    const out = tools.dispatchToolCall({
      function: { name, arguments: JSON.stringify(args) },
    }, {});
    return JSON.parse(out);
  }

  before(() => {
    sandbox = createSandbox({ seed: { 'weight.json': WEIGHT } });
    freshModules(sandbox);
  });
  after(() => { cleanupSandbox(sandbox); });

  test('both tools are registered in TOOL_DEFS', () => {
    const names = tools.TOOL_DEFS.map(t => t.function?.name);
    assert.ok(names.includes('orphan_report'));
    assert.ok(names.includes('rename_data_field'));
  });

  test('orphan_report round-trips through dispatch', () => {
    const report = call('orphan_report', { id: 'weight' });
    assert.deepStrictEqual(report.orphans, ['waist_cm']);
  });

  test('rename_data_field rewrites rows durably; rename lands in the datastore', () => {
    const r = call('rename_data_field', { id: 'weight', from_key: 'waist_cm', to_key: 'waist' });
    assert.equal(r.ok, true);
    assert.equal(r.rowsRenamed, 2);

    const served = registry.data('weight');
    assert.equal(served[0].waist, 90);
    assert.ok(!('waist_cm' in served[0]));

    const stored = readStored(sandbox, 'weight');
    assert.equal(stored[0].waist, 90, 'rename committed to the datastore');
    assert.equal(stored[1].waist, 89);
  });

  test('rename errors surface as {error} strings, not throws', () => {
    const r = call('rename_data_field', { id: 'weight', from_key: 'date', to_key: 'when' });
    assert.match(r.error, /structural/);
  });
});
