// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/manifest-registry.test.js
// Unit tests for the manifest registry — no server required, just module-level.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createSandbox, cleanupSandbox } = require('./helpers/sandbox');
const { readStored } = require('./helpers/datastore-readback');

// We need to isolate the registry module per test by clearing the require cache.
// The registry reads PATHS.DATA_DIR at call time (via config/paths.js which
// reads process.env.HEALTH_HOME), so we can swap sandboxes between tests.
const REPO_ROOT = path.resolve(__dirname, '..');
const MANIFESTS_DIR = path.resolve(REPO_ROOT, 'manifests') + path.sep;
const CONFIG_DIR = path.resolve(REPO_ROOT, 'config') + path.sep;

function freshRegistry(sandboxRoot) {
  // Clear all cached modules from our repo so paths.js re-reads HEALTH_HOME
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(MANIFESTS_DIR) || key.startsWith(CONFIG_DIR)) {
      delete require.cache[key];
    }
  }
  process.env.HEALTH_HOME = sandboxRoot;
  return require(path.join(REPO_ROOT, 'manifests', 'registry.js'));
}

describe('manifest registry', () => {
  test('empty data dir → 0 entries, 0 errors', () => {
    const sandbox = createSandbox();
    try {
      const registry = freshRegistry(sandbox);
      const stats = registry.init();
      assert.equal(stats.count, 0);
      assert.equal(stats.errors, 0);
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('valid v2 manifest loads and appears in list()', () => {
    const sandbox = createSandbox({
      seed: {
        'weight.json': {
          $schema: 'klebb.datafile.v1',
          meta: { id: 'weight', label: 'Weight', view: { enabled: true, component: 'generic-card' } },
          data: [{ date: '2026-04-20', kg: 85.5 }],
        },
      },
    });
    try {
      const registry = freshRegistry(sandbox);
      registry.init();
      const list = registry.list();
      assert.equal(list.length, 1);
      assert.equal(list[0].id, 'weight');
      assert.equal(list[0].meta.label, 'Weight');
      assert.equal(list[0].hasData, true);
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('file without $schema is silently skipped (legacy)', () => {
    const sandbox = createSandbox({
      seed: {
        'legacy.json': [{ some: 'array' }],
      },
    });
    try {
      const registry = freshRegistry(sandbox);
      const stats = registry.init();
      assert.equal(stats.count, 0);
      assert.equal(stats.errors, 0);
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('unsupported $schema version is rejected with error', () => {
    const sandbox = createSandbox({
      seed: {
        'weird.json': {
          $schema: 'klebb.datafile.v99',
          meta: { id: 'weird', label: 'Weird' },
          data: {},
        },
      },
    });
    try {
      const registry = freshRegistry(sandbox);
      const stats = registry.init();
      assert.equal(stats.count, 0);
      assert.equal(stats.errors, 1);
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('manifest without meta.id is rejected', () => {
    const sandbox = createSandbox({
      seed: {
        'noid.json': {
          $schema: 'klebb.datafile.v1',
          meta: { label: 'Missing ID' },
          data: {},
        },
      },
    });
    try {
      const registry = freshRegistry(sandbox);
      const stats = registry.init();
      assert.equal(stats.count, 0);
      assert.equal(stats.errors, 1);
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('duplicate ids across files → one wins, other errors', () => {
    const sandbox = createSandbox({
      seed: {
        'weight.json': {
          $schema: 'klebb.datafile.v1',
          meta: { id: 'weight', label: 'Weight A' },
          data: [],
        },
        'weight2.json': {
          $schema: 'klebb.datafile.v1',
          meta: { id: 'weight', label: 'Weight B' },
          data: [],
        },
      },
    });
    try {
      const registry = freshRegistry(sandbox);
      const stats = registry.init();
      assert.equal(stats.count, 1);
      assert.equal(stats.errors, 1);
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('reserved _archive dir is not scanned', () => {
    const sandbox = createSandbox();
    // Put a would-be-valid manifest in _archive — should NOT be picked up
    const archiveFile = path.join(sandbox, 'data', '_archive', 'sneaky.json');
    fs.writeFileSync(archiveFile, JSON.stringify({
      $schema: 'klebb.datafile.v1',
      meta: { id: 'sneaky', label: 'Sneaky' },
      data: [],
    }));
    try {
      const registry = freshRegistry(sandbox);
      const stats = registry.init();
      assert.equal(stats.count, 0);
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('listForView gates on enabled flags only; empty-data cards still render', () => {
    const sandbox = createSandbox({
      seed: {
        'a.json': {
          $schema: 'klebb.datafile.v1',
          meta: { id: 'a', label: 'A', view: { enabled: true, component: 'generic-card' } },
          data: [{ date: '2026-04-20', v: 1 }],
        },
        'b.json': {
          $schema: 'klebb.datafile.v1',
          meta: { id: 'b', label: 'B', view: { enabled: false, component: 'generic-card' } },
          data: [{ date: '2026-04-20', v: 2 }],
        },
        'c.json': {
          $schema: 'klebb.datafile.v1',
          meta: { id: 'c', label: 'C', view: { enabled: true, component: 'generic-card' } },
          data: [],
        },
        'd.json': {
          $schema: 'klebb.datafile.v1',
          meta: {
            id: 'd', label: 'D',
            enabled: false,
            view: { enabled: true, component: 'generic-card' },
          },
          data: [{ date: '2026-04-20', v: 3 }],
        },
      },
    });
    try {
      const registry = freshRegistry(sandbox);
      registry.init();
      const ids = registry.listForView('view').map(c => c.id);
      assert.ok(ids.includes('a'), 'a: view.enabled + data → in');
      assert.ok(ids.includes('c'), 'c: view.enabled + empty data → in (renderer handles empty state)');
      assert.ok(!ids.includes('b'), 'b: view.enabled=false → out');
      assert.ok(!ids.includes('d'), 'd: master enabled=false → out (hidden everywhere)');
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('writeData stores the data and leaves the meta-only file intact', () => {
    const sandbox = createSandbox({
      seed: {
        'weight.json': {
          $schema: 'klebb.datafile.v1',
          meta: { id: 'weight', label: 'Weight', view: { enabled: true, component: 'generic-card' } },
          description: 'preserve-me',
          data: [{ date: '2026-04-20', kg: 85 }],
        },
      },
    });
    try {
      const registry = freshRegistry(sandbox);
      registry.init();
      registry.writeData('weight', [{ date: '2026-04-20', kg: 86 }, { date: '2026-04-21', kg: 86.5 }]);
      // The file holds meta only (the seed's data was imported + stripped on
      // load); the write went to the datastore.
      const parsed = JSON.parse(fs.readFileSync(path.join(sandbox, 'data', 'weight.json'), 'utf8'));
      assert.equal(parsed.$schema, 'klebb.datafile.v1');
      assert.equal(parsed.meta.id, 'weight');
      assert.equal(parsed.description, 'preserve-me');
      assert.equal('data' in parsed, false, 'no data key in the manifest file');
      const stored = readStored(sandbox, 'weight');
      assert.equal(stored.length, 2);
      assert.equal(stored[1].kg, 86.5);
      // Served value matches the store.
      assert.deepEqual(registry.get('weight').data, stored);
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('writeData on unknown id throws', () => {
    const sandbox = createSandbox();
    try {
      const registry = freshRegistry(sandbox);
      registry.init();
      assert.throws(() => registry.writeData('nonexistent', []), /unknown manifest/);
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  // --- writeData hardening (#342) ---

  test('writeData rescues a JSON-string that parses to an object/array, with a warn', () => {
    const sandbox = createSandbox({
      seed: {
        'weight.json': {
          $schema: 'klebb.datafile.v1',
          meta: { id: 'weight', label: 'Weight', view: { enabled: true, component: 'generic-card' } },
          data: [{ date: '2026-04-20', kg: 85 }],
        },
      },
    });
    const origWarn = console.warn;
    let warned = '';
    console.warn = (msg) => { warned += String(msg); };
    try {
      const registry = freshRegistry(sandbox);
      registry.init();
      const payload = JSON.stringify([{ date: '2026-04-21', kg: 86 }]);
      registry.writeData('weight', payload);
      const stored = readStored(sandbox, 'weight');
      assert.ok(Array.isArray(stored), 'data persisted as array, not a string');
      assert.equal(stored[0].kg, 86);
      assert.match(warned, /rescued double-serialised/);
    } finally {
      console.warn = origWarn;
      cleanupSandbox(sandbox);
    }
  });

  test('writeData throws when data is a string that parses to a scalar', () => {
    const sandbox = createSandbox({
      seed: {
        'weight.json': {
          $schema: 'klebb.datafile.v1',
          meta: { id: 'weight', label: 'Weight', view: { enabled: true, component: 'generic-card' } },
          data: [],
        },
      },
    });
    try {
      const registry = freshRegistry(sandbox);
      registry.init();
      assert.throws(() => registry.writeData('weight', '"hello"'), /must be an object or array/);
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('writeData throws when data is a string that is not valid JSON', () => {
    const sandbox = createSandbox({
      seed: {
        'weight.json': {
          $schema: 'klebb.datafile.v1',
          meta: { id: 'weight', label: 'Weight', view: { enabled: true, component: 'generic-card' } },
          data: [],
        },
      },
    });
    try {
      const registry = freshRegistry(sandbox);
      registry.init();
      assert.throws(() => registry.writeData('weight', 'not json{'), /not valid JSON/);
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('writeData throws when newData shape conflicts with declared schema.type', () => {
    const sandbox = createSandbox({
      seed: {
        'mood.json': {
          $schema: 'klebb.datafile.v1',
          meta: { id: 'mood', label: 'Mood', view: { enabled: true, component: 'generic-card' } },
          schema: { type: 'array' },
          data: [],
        },
      },
    });
    try {
      const registry = freshRegistry(sandbox);
      registry.init();
      assert.throws(
        () => registry.writeData('mood', { items: [] }),
        /schema declares type "array" but received object/,
      );
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  // --- Malformed manifest handling ---

  test('invalid JSON is silently skipped as an error', () => {
    const sandbox = createSandbox();
    fs.writeFileSync(path.join(sandbox, 'data', 'broken.json'), '{ not valid json');
    try {
      const registry = freshRegistry(sandbox);
      const stats = registry.init();
      assert.equal(stats.count, 0);
      assert.equal(stats.errors, 1);
      const errs = registry.errors();
      assert.equal(errs.length, 1);
      assert.equal(errs[0].file, 'broken.json');
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('file without meta is skipped with descriptive error', () => {
    const sandbox = createSandbox({
      seed: {
        'nometa.json': { $schema: 'klebb.datafile.v1', data: [] },
      },
    });
    try {
      const registry = freshRegistry(sandbox);
      const stats = registry.init();
      assert.equal(stats.count, 0);
      assert.equal(stats.errors, 1);
      const errs = registry.errors();
      assert.ok(/meta/i.test(errs[0].error), `error should mention meta: ${errs[0].error}`);
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('top-level array (garbage shape) is skipped', () => {
    const sandbox = createSandbox();
    fs.writeFileSync(path.join(sandbox, 'data', 'array.json'), JSON.stringify([1, 2, 3]));
    try {
      const registry = freshRegistry(sandbox);
      const stats = registry.init();
      assert.equal(stats.count, 0);
      // Top-level array has no $schema so it's silently skipped (legacy),
      // not flagged as an error. Verify either behaviour is consistent.
      assert.ok(stats.errors === 0 || stats.errors === 1,
        `errors count should be 0 or 1, got ${stats.errors}`);
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('a data-carrying file dropped after init imports on reload (live demo-reset flow)', () => {
    const sandbox = createSandbox({
      seed: {
        'weight.json': {
          $schema: 'klebb.datafile.v1',
          meta: { id: 'weight', label: 'Weight', view: { enabled: true, component: 'generic-card' } },
          data: [{ date: '2026-04-20', kg: 85 }],
        },
      },
    });
    try {
      const registry = freshRegistry(sandbox);
      registry.init();
      assert.equal(registry.data('weight')[0].kg, 85);

      // Overwrite the (now meta-only) file with a fresh inline block, the
      // way reset-demo re-seeds fixtures under a running server.
      const file = path.join(sandbox, 'data', 'weight.json');
      fs.writeFileSync(file, JSON.stringify({
        $schema: 'klebb.datafile.v1',
        meta: { id: 'weight', label: 'Weight', view: { enabled: true, component: 'generic-card' } },
        data: [{ date: '2026-04-27', kg: 84 }],
      }, null, 2));

      registry.reload();
      const rows = registry.data('weight');
      assert.equal(rows.length, 1, 'full replace, not merge');
      assert.equal(rows[0].kg, 84, 'reload imported the re-seeded block');
      assert.ok(!('data' in JSON.parse(fs.readFileSync(file, 'utf8'))),
        'file stripped back to meta-only');
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('error list survives reload', () => {
    const sandbox = createSandbox();
    fs.writeFileSync(path.join(sandbox, 'data', 'broken.json'), 'xxx');
    try {
      const registry = freshRegistry(sandbox);
      registry.init();
      assert.equal(registry.errors().length, 1);
      registry.reload();
      assert.equal(registry.errors().length, 1, 'error list should persist across reload');
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('fixing a broken file clears its error on reload', () => {
    const sandbox = createSandbox();
    const file = path.join(sandbox, 'data', 'eventually-good.json');
    fs.writeFileSync(file, '{ broken');
    try {
      const registry = freshRegistry(sandbox);
      registry.init();
      assert.equal(registry.errors().length, 1);
      // Fix the file
      fs.writeFileSync(file, JSON.stringify({
        $schema: 'klebb.datafile.v1',
        meta: { id: 'good', label: 'Good' },
        data: [],
      }));
      registry.reload();
      assert.equal(registry.errors().length, 0, 'errors should clear after fix + reload');
      assert.equal(registry.list().length, 1, 'and the card should now be listed');
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  // --- createManifest / deleteManifest ---

  test('createManifest writes the file + populates list()', () => {
    const sandbox = createSandbox();
    try {
      const registry = freshRegistry(sandbox);
      registry.init();
      const result = registry.createManifest({
        $schema: 'klebb.datafile.v1',
        meta: { id: 'bp', label: 'Blood Pressure', view: { enabled: true, component: 'list-card' } },
        data: [{ date: '2026-04-20', systolic: 120, diastolic: 80 }],
      });
      assert.equal(result.id, 'bp');
      assert.ok(fs.existsSync(path.join(sandbox, 'data', 'bp.json')));
      const list = registry.list();
      assert.equal(list.length, 1);
      assert.equal(list[0].id, 'bp');
      assert.equal(list[0].meta.label, 'Blood Pressure');
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('createManifest rejects duplicate id (already in registry)', () => {
    const sandbox = createSandbox({
      seed: {
        'bp.json': {
          $schema: 'klebb.datafile.v1',
          meta: { id: 'bp', label: 'BP' },
          data: [],
        },
      },
    });
    try {
      const registry = freshRegistry(sandbox);
      registry.init();
      assert.throws(
        () => registry.createManifest({
          $schema: 'klebb.datafile.v1',
          meta: { id: 'bp', label: 'BP Again' },
          data: [],
        }),
        /duplicate id: bp/,
      );
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('createManifest rejects when a file already exists on disk (parse error, not in registry)', () => {
    const sandbox = createSandbox();
    // Pre-write a broken file so it fails to parse and never lands in _entries
    fs.writeFileSync(path.join(sandbox, 'data', 'bp.json'), '{broken');
    try {
      const registry = freshRegistry(sandbox);
      registry.init();
      assert.throws(
        () => registry.createManifest({
          $schema: 'klebb.datafile.v1',
          meta: { id: 'bp', label: 'BP' },
          data: [],
        }),
        /duplicate id: file already exists on disk/,
      );
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('createManifest rejects invalid id formats', () => {
    const sandbox = createSandbox();
    try {
      const registry = freshRegistry(sandbox);
      registry.init();
      for (const badId of ['../hack', 'Blood Pressure', 'blood pressure', 'UPPER', '-leading-dash', '.leading-dot']) {
        assert.throws(
          () => registry.createManifest({
            $schema: 'klebb.datafile.v1',
            meta: { id: badId, label: 'X' },
            data: [],
          }),
          /invalid id/,
          `id "${badId}" should be rejected`,
        );
      }
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('createManifest rejects reserved ids', () => {
    const sandbox = createSandbox();
    try {
      const registry = freshRegistry(sandbox);
      registry.init();
      for (const reserved of ['_archive', 'reports', 'index', 'auto-export']) {
        assert.throws(
          () => registry.createManifest({
            $schema: 'klebb.datafile.v1',
            meta: { id: reserved, label: 'X' },
            data: [],
          }),
          /invalid id/,
          `id "${reserved}" should be reserved`,
        );
      }
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('createManifest rejects missing $schema / meta.id / meta.label', () => {
    const sandbox = createSandbox();
    try {
      const registry = freshRegistry(sandbox);
      registry.init();
      assert.throws(
        () => registry.createManifest({ meta: { id: 'x', label: 'X' } }),
        /missing \$schema/,
      );
      assert.throws(
        () => registry.createManifest({ $schema: 'klebb.datafile.v1', meta: { label: 'X' } }),
        /missing meta\.id/,
      );
      assert.throws(
        () => registry.createManifest({ $schema: 'klebb.datafile.v1', meta: { id: 'x' } }),
        /missing meta\.label/,
      );
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('createManifest accepts ad-hoc unknown renderer names (escape hatch)', () => {
    const sandbox = createSandbox();
    try {
      const registry = freshRegistry(sandbox);
      registry.init();
      const result = registry.createManifest({
        $schema: 'klebb.datafile.v1',
        meta: {
          id: 'sleep-arch',
          label: 'Sleep Architecture',
          view: { enabled: true, component: 'sleep-stages-sunburst' },
        },
        data: { stages: [{ name: 'REM', pct: 22 }] },
      });
      assert.equal(result.id, 'sleep-arch');
      const entry = registry.get('sleep-arch');
      assert.equal(entry.meta.view.component, 'sleep-stages-sunburst');
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('deleteManifest removes the file and drops the entry', () => {
    const sandbox = createSandbox({
      seed: {
        'bp.json': {
          $schema: 'klebb.datafile.v1',
          meta: { id: 'bp', label: 'BP' },
          data: [],
        },
      },
    });
    try {
      const registry = freshRegistry(sandbox);
      registry.init();
      assert.equal(registry.list().length, 1);
      registry.deleteManifest('bp');
      assert.equal(registry.list().length, 0);
      assert.equal(registry.get('bp'), null);
      assert.ok(!fs.existsSync(path.join(sandbox, 'data', 'bp.json')));
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('deleteManifest unknown id throws', () => {
    const sandbox = createSandbox();
    try {
      const registry = freshRegistry(sandbox);
      registry.init();
      assert.throws(() => registry.deleteManifest('nonexistent'), /unknown manifest/);
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('one broken file does not stop siblings from loading', () => {
    const sandbox = createSandbox({
      seed: {
        'good.json': {
          $schema: 'klebb.datafile.v1',
          meta: { id: 'good', label: 'Good' },
          data: [{ date: '2026-04-20', v: 1 }],
        },
      },
    });
    // Add a broken file alongside
    fs.writeFileSync(path.join(sandbox, 'data', 'bad.json'), '{bad');
    try {
      const registry = freshRegistry(sandbox);
      const stats = registry.init();
      assert.equal(stats.count, 1, 'good file should load');
      assert.equal(stats.errors, 1, 'bad file should be an error');
      assert.equal(registry.list()[0].id, 'good');
    } finally {
      cleanupSandbox(sandbox);
    }
  });
});

