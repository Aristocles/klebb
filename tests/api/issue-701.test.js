// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/api/issue-701.test.js
// Regression seed for #701: validate_manifest rejected a manifest argument
// the model had double-serialised (sent as a JSON string), returning
// "manifest must be an object" for perfectly valid manifests. Because the
// system prompt mandates validate-before-write, that locked chat card
// creation and conversion out entirely. create_manifest gets the same
// rescue so the dry-run verdict keeps mirroring the write path.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { createSandbox, cleanupSandbox } = require('../helpers/sandbox');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const MANIFESTS_DIR = path.resolve(REPO_ROOT, 'manifests') + path.sep;
const CONFIG_DIR = path.resolve(REPO_ROOT, 'config') + path.sep;
const CHAT_DIR = path.resolve(REPO_ROOT, 'chat') + path.sep;

function freshTools(sandboxRoot) {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(MANIFESTS_DIR) ||
        key.startsWith(CONFIG_DIR) ||
        key.startsWith(CHAT_DIR)) {
      delete require.cache[key];
    }
  }
  process.env.HEALTH_HOME = sandboxRoot;
  const registry = require(path.join(REPO_ROOT, 'manifests', 'registry.js'));
  registry.init();
  const { TOOL_DEFS, dispatchToolCall } = require(path.join(REPO_ROOT, 'chat', 'tools.js'));
  return { registry, TOOL_DEFS, dispatchToolCall };
}

function makeToolCall(name, args) {
  return { function: { name, arguments: JSON.stringify(args) } };
}

function candidateManifest(id) {
  return {
    $schema: 'klebb.datafile.v1',
    meta: {
      id,
      label: 'Candidate',
      view: { enabled: true, component: 'generic-card' },
      writeable: { fromWebapp: true, inputs: [{ key: 'kg', type: 'number' }] },
    },
    description: 'Seed fixture for #701.',
  };
}

describe('issue #701: stringified manifest argument', () => {
  test('validate_manifest accepts a double-serialised manifest', () => {
    const sandbox = createSandbox();
    const origWarn = console.warn;
    let warned = '';
    console.warn = (msg) => { warned += String(msg); };
    try {
      const { dispatchToolCall } = freshTools(sandbox);
      const out = JSON.parse(dispatchToolCall(
        makeToolCall('validate_manifest', { manifest: JSON.stringify(candidateManifest('candidate')) })
      ));
      assert.deepEqual(out.errors, undefined, `expected no errors, got ${JSON.stringify(out.errors)}`);
      assert.equal(out.ok, true);
      assert.match(warned, /rescued double-serialised/);
    } finally {
      console.warn = origWarn;
      cleanupSandbox(sandbox);
    }
  });

  test('validate_manifest still accepts a real object (no regression)', () => {
    const sandbox = createSandbox();
    try {
      const { dispatchToolCall } = freshTools(sandbox);
      const out = JSON.parse(dispatchToolCall(
        makeToolCall('validate_manifest', { manifest: candidateManifest('candidate') })
      ));
      assert.equal(out.ok, true);
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('validate_manifest still rejects a non-JSON string with the shape error', () => {
    const sandbox = createSandbox();
    try {
      const { dispatchToolCall } = freshTools(sandbox);
      const out = JSON.parse(dispatchToolCall(
        makeToolCall('validate_manifest', { manifest: 'not a manifest at all' })
      ));
      assert.equal(out.ok, false);
      assert.match(out.errors[0].message, /manifest must be an object/);
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('create_manifest accepts a double-serialised manifest (validate/write parity)', () => {
    const sandbox = createSandbox();
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      const { registry, dispatchToolCall } = freshTools(sandbox);
      const out = JSON.parse(dispatchToolCall(
        makeToolCall('create_manifest', { manifest: JSON.stringify(candidateManifest('created-701')) })
      ));
      assert.equal(out.ok, true, `expected ok, got ${JSON.stringify(out)}`);
      assert.ok(registry.get('created-701'), 'manifest was actually created');
    } finally {
      console.warn = origWarn;
      cleanupSandbox(sandbox);
    }
  });

  test('validate_manifest tool schema declares manifest as an object', () => {
    const sandbox = createSandbox();
    try {
      const { TOOL_DEFS } = freshTools(sandbox);
      const def = TOOL_DEFS.find(t => t.function.name === 'validate_manifest');
      assert.equal(def.function.parameters.properties.manifest.type, 'object');
    } finally {
      cleanupSandbox(sandbox);
    }
  });
});
