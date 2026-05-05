// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/registry-patch.test.js
// Unit tests for registry.patchManifest — data preserved, meta merged,
// protected fields rejected.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createSandbox, cleanupSandbox } = require('./helpers/sandbox');

const REPO_ROOT = path.resolve(__dirname, '..');
const MANIFESTS_DIR = path.resolve(REPO_ROOT, 'manifests') + path.sep;
const CONFIG_DIR = path.resolve(REPO_ROOT, 'config') + path.sep;

function freshRegistry(sandboxRoot) {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(MANIFESTS_DIR) || key.startsWith(CONFIG_DIR)) {
      delete require.cache[key];
    }
  }
  process.env.HEALTH_HOME = sandboxRoot;
  return require(path.join(REPO_ROOT, 'manifests', 'registry.js'));
}

const MOOD_MANIFEST = {
  $schema: 'klebb.datafile.v1',
  meta: {
    id: 'mood',
    label: 'Mood',
    emoji: '🙂',
    writeable: {
      fromWebapp: true,
      inputs: [
        { key: 'mood', type: 'emoji-picker', autoSubmit: true, emitIndex: true },
        { key: 'notes', type: 'textarea' },
      ],
    },
  },
  description: 'Daily mood tracker.',
  data: [
    { date: '2026-05-04', mood: 4, notes: 'good day' },
    { date: '2026-05-05', mood: 5 },
  ],
};

describe('registry.patchManifest', () => {
  test('patches meta; data preserved byte-for-byte', () => {
    const sandbox = createSandbox({ seed: { 'mood.json': MOOD_MANIFEST } });
    try {
      const registry = freshRegistry(sandbox);
      registry.init();
      const before = JSON.parse(fs.readFileSync(path.join(sandbox, 'data', 'mood.json'), 'utf8'));
      assert.equal(before.meta.writeable.inputs[0].autoSubmit, true);

      registry.patchManifest('mood', {
        meta: {
          writeable: {
            inputs: [
              { key: 'mood', type: 'emoji-picker', autoSubmit: false, emitIndex: true },
              { key: 'notes', type: 'textarea' },
            ],
          },
        },
      });

      const after = JSON.parse(fs.readFileSync(path.join(sandbox, 'data', 'mood.json'), 'utf8'));
      assert.equal(after.meta.writeable.inputs[0].autoSubmit, false);
      assert.equal(after.meta.writeable.fromWebapp, true, 'unrelated meta kept');
      assert.deepEqual(after.data, before.data, 'data unchanged');
      assert.equal(after.description, before.description);
      assert.equal(after.$schema, 'klebb.datafile.v1');
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('null in patch removes a meta key', () => {
    const sandbox = createSandbox({ seed: { 'mood.json': MOOD_MANIFEST } });
    try {
      const registry = freshRegistry(sandbox);
      registry.init();
      registry.patchManifest('mood', { meta: { emoji: null } });
      const after = JSON.parse(fs.readFileSync(path.join(sandbox, 'data', 'mood.json'), 'utf8'));
      assert.equal('emoji' in after.meta, false, 'emoji key removed');
      assert.equal(after.meta.label, 'Mood', 'other meta preserved');
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('description patch: string replaces, null removes', () => {
    const sandbox = createSandbox({ seed: { 'mood.json': MOOD_MANIFEST } });
    try {
      const registry = freshRegistry(sandbox);
      registry.init();
      registry.patchManifest('mood', { description: 'New description.' });
      let after = JSON.parse(fs.readFileSync(path.join(sandbox, 'data', 'mood.json'), 'utf8'));
      assert.equal(after.description, 'New description.');
      registry.patchManifest('mood', { description: null });
      after = JSON.parse(fs.readFileSync(path.join(sandbox, 'data', 'mood.json'), 'utf8'));
      assert.equal('description' in after, false);
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('rejects patch to $schema', () => {
    const sandbox = createSandbox({ seed: { 'mood.json': MOOD_MANIFEST } });
    try {
      const registry = freshRegistry(sandbox);
      registry.init();
      assert.throws(
        () => registry.patchManifest('mood', { $schema: 'other.v2' }),
        /protected field: \$schema/,
      );
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('rejects patch to meta.id', () => {
    const sandbox = createSandbox({ seed: { 'mood.json': MOOD_MANIFEST } });
    try {
      const registry = freshRegistry(sandbox);
      registry.init();
      assert.throws(
        () => registry.patchManifest('mood', { meta: { id: 'renamed' } }),
        /protected field: meta\.id/,
      );
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('rejects patch touching data', () => {
    const sandbox = createSandbox({ seed: { 'mood.json': MOOD_MANIFEST } });
    try {
      const registry = freshRegistry(sandbox);
      registry.init();
      assert.throws(
        () => registry.patchManifest('mood', { data: [] }),
        /protected field: data/,
      );
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('rejects unknown id', () => {
    const sandbox = createSandbox();
    try {
      const registry = freshRegistry(sandbox);
      registry.init();
      assert.throws(
        () => registry.patchManifest('ghost', { meta: { label: 'x' } }),
        /unknown manifest: ghost/,
      );
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('rejects non-object patch', () => {
    const sandbox = createSandbox({ seed: { 'mood.json': MOOD_MANIFEST } });
    try {
      const registry = freshRegistry(sandbox);
      registry.init();
      assert.throws(() => registry.patchManifest('mood', null), /must be an object/);
      assert.throws(() => registry.patchManifest('mood', 'string'), /must be an object/);
      assert.throws(() => registry.patchManifest('mood', [1,2]), /must be an object/);
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('validation failure leaves file on disk unchanged', () => {
    const sandbox = createSandbox({ seed: { 'mood.json': MOOD_MANIFEST } });
    try {
      const registry = freshRegistry(sandbox);
      registry.init();
      const filePath = path.join(sandbox, 'data', 'mood.json');
      const before = fs.readFileSync(filePath, 'utf8');
      // meta.label required; a null removes it -> validation fails.
      assert.throws(
        () => registry.patchManifest('mood', { meta: { label: null } }),
        /missing meta\.label/,
      );
      const after = fs.readFileSync(filePath, 'utf8');
      assert.equal(after, before, 'file untouched on validation failure');
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('in-memory cache updated after successful patch', () => {
    const sandbox = createSandbox({ seed: { 'mood.json': MOOD_MANIFEST } });
    try {
      const registry = freshRegistry(sandbox);
      registry.init();
      registry.patchManifest('mood', { meta: { label: 'Feelings' } });
      const entry = registry.get('mood');
      assert.equal(entry.meta.label, 'Feelings');
    } finally {
      cleanupSandbox(sandbox);
    }
  });
});
