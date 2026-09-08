// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/registry-write-guards.test.js
// Structural guard for the #342/#701/#702/#703 class: every registry
// write seat must either rescue a double-serialised (JSON-string)
// structured argument or reject it with a typed error, and a rejection
// must provably change nothing. A new write seat that pushes a string
// verbatim should fail here, not in production.

const { test, describe } = require('node:test');
const assert = require('node:assert');
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
  const { dispatchToolCall } = require(path.join(REPO_ROOT, 'chat', 'tools.js'));
  return { registry, dispatchToolCall };
}

const MOOD = {
  $schema: 'klebb.datafile.v1',
  meta: {
    id: 'mood',
    label: 'Mood',
    view: { enabled: true, component: 'generic-card' },
    writeable: { fromWebapp: true, inputs: [{ key: 'mood', type: 'number' }] },
  },
  description: 'Write-guard fixture.',
  data: [
    { date: '2026-05-04', mood: 4 },
    { date: '2026-05-05', mood: 5 },
  ],
};

function withSandbox(fn) {
  const sandbox = createSandbox({ seed: { 'mood.json': MOOD } });
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    return fn(freshTools(sandbox));
  } finally {
    console.warn = origWarn;
    cleanupSandbox(sandbox);
  }
}

describe('registry write seats vs stringified structured args', () => {
  test('writeData rescues a stringified array (the #342 guard still holds)', () => {
    withSandbox(({ registry }) => {
      registry.writeData('mood', JSON.stringify([{ date: '2026-05-06', mood: 3 }]));
      const rows = registry.readRows('mood', '').value;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].mood, 3);
    });
  });

  test('appendRow rescues a stringified object row', () => {
    withSandbox(({ registry }) => {
      registry.appendRow('mood', '', JSON.stringify({ date: '2026-05-06', mood: 2 }));
      const rows = registry.readRows('mood', '').value;
      assert.equal(rows.length, 3);
      assert.equal(typeof rows[2], 'object');
      assert.equal(rows[2].mood, 2);
    });
  });

  test('updateRow rejects stringified changes with a typed error, row unchanged', () => {
    withSandbox(({ registry }) => {
      assert.throws(
        () => registry.updateRow('mood', '[date="2026-05-04"]', JSON.stringify({ mood: 1 })),
        (e) => e.code === 'WRONG_TYPE'
      );
      const row = registry.readRows('mood', '[date="2026-05-04"]').value;
      assert.equal(row.mood, 4, 'row unchanged after rejection');
    });
  });

  test('reorderRows rejects a stringified order with a typed error, rows unchanged', () => {
    withSandbox(({ registry }) => {
      assert.throws(
        () => registry.reorderRows('mood', '', 'date', JSON.stringify(['2026-05-05', '2026-05-04'])),
        (e) => e.code === 'WRONG_TYPE'
      );
      const rows = registry.readRows('mood', '').value;
      assert.equal(rows[0].date, '2026-05-04', 'order unchanged after rejection');
    });
  });

  test('patchManifest rescues a stringified meta and actually applies it', () => {
    withSandbox(({ registry }) => {
      registry.patchManifest('mood', { meta: JSON.stringify({ label: 'Mood log' }) });
      assert.equal(registry.get('mood').meta.label, 'Mood log');
    });
  });

  test('patchManifest rescues a wholly stringified patch', () => {
    withSandbox(({ registry }) => {
      registry.patchManifest('mood', JSON.stringify({ meta: { label: 'Mood log' } }));
      assert.equal(registry.get('mood').meta.label, 'Mood log');
    });
  });

  test('patchManifest rejects unknown top-level keys with a typed error, meta unchanged', () => {
    withSandbox(({ registry }) => {
      assert.throws(
        () => registry.patchManifest('mood', { label: 'Sneaky' }),
        (e) => e.code === 'UNKNOWN_KEY' && /unknown patch key: label/.test(e.message)
      );
      assert.equal(registry.get('mood').meta.label, 'Mood');
    });
  });

  test('patchManifest rejects non-object meta shapes with a typed error', () => {
    withSandbox(({ registry }) => {
      for (const bad of [null, 42, [{ label: 'x' }], '"scalar"']) {
        assert.throws(
          () => registry.patchManifest('mood', { meta: bad }),
          (e) => e.code === 'WRONG_TYPE' && /patch\.meta must be an object/.test(e.message),
          `meta=${JSON.stringify(bad)} must be rejected`
        );
      }
      assert.equal(registry.get('mood').meta.label, 'Mood');
    });
  });

  test('patch_manifest via chat dispatch applies a stringified meta', () => {
    withSandbox(({ registry, dispatchToolCall }) => {
      const ctx = { touches: [] };
      const out = JSON.parse(dispatchToolCall(
        { function: { name: 'patch_manifest', arguments: JSON.stringify({ id: 'mood', patch: { meta: JSON.stringify({ label: 'Mood log' }) } }) } },
        ctx
      ));
      assert.equal(out.ok, true);
      assert.equal(registry.get('mood').meta.label, 'Mood log');
      assert.equal(ctx.touches.length, 1, 'touch recorded for a write that happened');
    });
  });

  test('patch_manifest via chat dispatch surfaces unknown keys as a typed error, no touch', () => {
    withSandbox(({ registry, dispatchToolCall }) => {
      const ctx = { touches: [] };
      const out = JSON.parse(dispatchToolCall(
        { function: { name: 'patch_manifest', arguments: JSON.stringify({ id: 'mood', patch: { label: 'Sneaky' } }) } },
        ctx
      ));
      assert.match(out.error || '', /unknown patch key: label/);
      assert.equal(out.code, 'UNKNOWN_KEY', 'the typed code reaches the model');
      assert.equal(registry.get('mood').meta.label, 'Mood');
      assert.equal(ctx.touches.length, 0, 'no touch recorded for a write that never happened');
    });
  });

  test('update_row via chat dispatch surfaces stringified changes as a typed error', () => {
    withSandbox(({ registry, dispatchToolCall }) => {
      const out = JSON.parse(dispatchToolCall(
        { function: { name: 'update_row', arguments: JSON.stringify({ id: 'mood', path: '[date="2026-05-04"]', changes: JSON.stringify({ mood: 1 }) }) } }
      ));
      assert.equal(out.code, 'WRONG_TYPE');
      assert.equal(registry.readRows('mood', '[date="2026-05-04"]').value.mood, 4);
    });
  });

  test('write_manifest_data via chat dispatch rescues stringified data', () => {
    withSandbox(({ registry, dispatchToolCall }) => {
      const out = JSON.parse(dispatchToolCall(
        { function: { name: 'write_manifest_data', arguments: JSON.stringify({ id: 'mood', data: JSON.stringify([{ date: '2026-05-06', mood: 1 }]) }) } }
      ));
      assert.equal(out.ok, true);
      const rows = registry.readRows('mood', '').value;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].mood, 1);
    });
  });
});
