// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/chat-tools-crud.test.js
// Direct-dispatch tests for the new read/write/patch tools. Bypasses the
// chat agent loop (covered by chat-tool-use.test.js); verifies the dispatch
// contract the loop relies on.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createSandbox, cleanupSandbox } = require('./helpers/sandbox');

const REPO_ROOT = path.resolve(__dirname, '..');
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
  return {
    function: { name, arguments: JSON.stringify(args) },
  };
}

const MOOD = {
  $schema: 'klebb.datafile.v1',
  meta: {
    id: 'mood',
    label: 'Mood',
    writeable: {
      fromWebapp: true,
      inputs: [
        { key: 'mood', type: 'emoji-picker', autoSubmit: true, emitIndex: true },
        { key: 'notes', type: 'textarea' },
      ],
    },
  },
  description: 'Daily mood.',
  data: [
    { date: '2026-05-04', mood: 4 },
    { date: '2026-05-05', mood: 5, notes: 'great' },
  ],
};

const INGEST_ONLY = {
  $schema: 'klebb.datafile.v1',
  meta: {
    id: 'steps',
    label: 'Steps',
    view: { enabled: true, component: 'generic-card' },
    writeable: { fromWebapp: false },
  },
  description: 'Ingest-only.',
  data: [{ date: '2026-05-05', count: 7200 }],
};

describe('chat tools: read/write/patch', () => {
  test('TOOL_DEFS includes the three new tools', () => {
    const sandbox = createSandbox();
    try {
      const { TOOL_DEFS } = freshTools(sandbox);
      const names = TOOL_DEFS.map(t => t.function.name);
      assert.ok(names.includes('read_manifest'));
      assert.ok(names.includes('write_manifest_data'));
      assert.ok(names.includes('patch_manifest'));
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('read_manifest returns full content', () => {
    const sandbox = createSandbox({ seed: { 'mood.json': MOOD } });
    try {
      const { dispatchToolCall } = freshTools(sandbox);
      const res = JSON.parse(dispatchToolCall(makeToolCall('read_manifest', { id: 'mood' })));
      assert.ok(res.meta);
      assert.equal(res.meta.id, 'mood');
      assert.equal(res.description, 'Daily mood.');
      assert.deepEqual(res.data, MOOD.data);
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('read_manifest unknown id returns {error}', () => {
    const sandbox = createSandbox();
    try {
      const { dispatchToolCall } = freshTools(sandbox);
      const res = JSON.parse(dispatchToolCall(makeToolCall('read_manifest', { id: 'ghost' })));
      assert.match(res.error, /unknown manifest/);
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('write_manifest_data round-trip: read → modify → write → re-read matches', () => {
    const sandbox = createSandbox({ seed: { 'mood.json': MOOD } });
    try {
      const { dispatchToolCall } = freshTools(sandbox);
      const current = JSON.parse(dispatchToolCall(makeToolCall('read_manifest', { id: 'mood' })));
      // Remove the 2026-05-04 entry, add a new one for 2026-05-06
      const newData = current.data
        .filter(r => r.date !== '2026-05-04')
        .concat([{ date: '2026-05-06', mood: 3, notes: 'meh' }]);
      const write = JSON.parse(dispatchToolCall(makeToolCall('write_manifest_data', { id: 'mood', data: newData })));
      assert.equal(write.ok, true);
      const verify = JSON.parse(dispatchToolCall(makeToolCall('read_manifest', { id: 'mood' })));
      assert.equal(verify.data.length, 2);
      assert.ok(verify.data.find(r => r.date === '2026-05-05'));
      assert.ok(verify.data.find(r => r.date === '2026-05-06'));
      assert.ok(!verify.data.find(r => r.date === '2026-05-04'));
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('write_manifest_data rejects ingest-only card', () => {
    const sandbox = createSandbox({ seed: { 'steps.json': INGEST_ONLY } });
    try {
      const { dispatchToolCall } = freshTools(sandbox);
      const res = JSON.parse(dispatchToolCall(makeToolCall('write_manifest_data', { id: 'steps', data: [] })));
      assert.match(res.error, /not writeable/);
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('patch_manifest updates meta; data preserved', () => {
    const sandbox = createSandbox({ seed: { 'mood.json': MOOD } });
    try {
      const { dispatchToolCall } = freshTools(sandbox);
      const dataBefore = JSON.parse(dispatchToolCall(makeToolCall('read_manifest', { id: 'mood' }))).data;
      const res = JSON.parse(dispatchToolCall(makeToolCall('patch_manifest', {
        id: 'mood',
        patch: {
          meta: {
            writeable: {
              inputs: [
                { key: 'mood', type: 'emoji-picker', autoSubmit: false, emitIndex: true },
                { key: 'notes', type: 'textarea' },
              ],
            },
          },
        },
      })));
      assert.equal(res.ok, true);
      const after = JSON.parse(dispatchToolCall(makeToolCall('read_manifest', { id: 'mood' })));
      assert.equal(after.meta.writeable.inputs[0].autoSubmit, false);
      assert.deepEqual(after.data, dataBefore);
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('patch_manifest rejects protected fields (returns {error})', () => {
    const sandbox = createSandbox({ seed: { 'mood.json': MOOD } });
    try {
      const { dispatchToolCall } = freshTools(sandbox);
      const res = JSON.parse(dispatchToolCall(makeToolCall('patch_manifest', {
        id: 'mood',
        patch: { meta: { id: 'renamed' } },
      })));
      assert.match(res.error, /meta\.id/);
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('patch_manifest on unknown id returns {error}', () => {
    const sandbox = createSandbox();
    try {
      const { dispatchToolCall } = freshTools(sandbox);
      const res = JSON.parse(dispatchToolCall(makeToolCall('patch_manifest', {
        id: 'ghost',
        patch: { meta: { label: 'x' } },
      })));
      assert.match(res.error, /unknown manifest/);
    } finally {
      cleanupSandbox(sandbox);
    }
  });
});
