// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/chat-tooldefs-types.test.js
// Structural guard for the #701 class: every TOOL_DEFS parameter must
// declare a JSON-Schema type, or the model is free to serialise a
// structured argument as a string and the handler inherits the mess.
// Params that are deliberately any-shape (rows can be objects OR bare
// strings) live on the allowlist; adding a new untyped param means
// either giving it a type or adding it here with intent.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { createSandbox, cleanupSandbox } = require('./helpers/sandbox');

const REPO_ROOT = path.resolve(__dirname, '..');

const ANY_SHAPE_ALLOWLIST = new Set([
  'write_manifest_data.data',
  'append_row.value',
]);

function loadToolDefs(sandboxRoot) {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(path.resolve(REPO_ROOT, 'manifests') + path.sep) ||
        key.startsWith(path.resolve(REPO_ROOT, 'config') + path.sep) ||
        key.startsWith(path.resolve(REPO_ROOT, 'chat') + path.sep)) {
      delete require.cache[key];
    }
  }
  process.env.HEALTH_HOME = sandboxRoot;
  return require(path.join(REPO_ROOT, 'chat', 'tools.js')).TOOL_DEFS;
}

describe('TOOL_DEFS parameter types', () => {
  test('every parameter declares a type unless allowlisted as any-shape', () => {
    const sandbox = createSandbox();
    try {
      const defs = loadToolDefs(sandbox);
      assert.ok(defs.length > 10, 'TOOL_DEFS loaded');
      const untyped = [];
      for (const def of defs) {
        const props = def.function.parameters?.properties || {};
        for (const [param, schema] of Object.entries(props)) {
          const key = `${def.function.name}.${param}`;
          if (ANY_SHAPE_ALLOWLIST.has(key)) continue;
          if (typeof schema.type !== 'string') untyped.push(key);
        }
      }
      assert.deepEqual(untyped, [],
        `untyped tool params (give them a type, or allowlist with intent): ${untyped.join(', ')}`);
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('the any-shape allowlist entries are genuinely untyped (shrink it when they gain one)', () => {
    const sandbox = createSandbox();
    try {
      const defs = loadToolDefs(sandbox);
      for (const key of ANY_SHAPE_ALLOWLIST) {
        const [tool, param] = key.split('.');
        const def = defs.find(d => d.function.name === tool);
        assert.ok(def, `allowlisted tool ${tool} exists`);
        const schema = def.function.parameters.properties[param];
        assert.ok(schema, `allowlisted param ${key} exists`);
        assert.equal(schema.type, undefined, `${key} gained a type; remove it from the allowlist`);
      }
    } finally {
      cleanupSandbox(sandbox);
    }
  });
});
