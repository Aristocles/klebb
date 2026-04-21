// tests/manifest-registry.test.js
// Unit tests for the manifest registry — no server required, just module-level.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createSandbox, cleanupSandbox } = require('./helpers/sandbox');

// We need to isolate the registry module per test by clearing the require cache.
// The registry reads PATHS.DATA_DIR at call time (via config/paths.js which
// reads process.env.HEALTH_HOME), so we can swap sandboxes between tests.
function freshRegistry(sandboxRoot) {
  // Clear all cached modules from our repo so paths.js re-reads HEALTH_HOME
  for (const key of Object.keys(require.cache)) {
    if (key.includes('/health/webapp/manifests/') ||
        key.includes('/health/webapp/config/')) {
      delete require.cache[key];
    }
  }
  process.env.HEALTH_HOME = sandboxRoot;
  return require(path.join(__dirname, '..', 'manifests', 'registry.js'));
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

  test('listForView filters by enabled: true AND non-empty data', () => {
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
      },
    });
    try {
      const registry = freshRegistry(sandbox);
      registry.init();
      const viewCards = registry.listForView('view');
      const ids = viewCards.map(c => c.id);
      assert.ok(ids.includes('a'), 'a should be in view (enabled + has data)');
      assert.ok(!ids.includes('b'), 'b should NOT be in view (disabled)');
      assert.ok(!ids.includes('c'), 'c should NOT be in view (empty data)');
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('writeData rewrites the .data block and preserves meta + description', () => {
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
      const raw = fs.readFileSync(path.join(sandbox, 'data', 'weight.json'), 'utf8');
      const parsed = JSON.parse(raw);
      assert.equal(parsed.$schema, 'klebb.datafile.v1');
      assert.equal(parsed.meta.id, 'weight');
      assert.equal(parsed.description, 'preserve-me');
      assert.equal(parsed.data.length, 2);
      assert.equal(parsed.data[1].kg, 86.5);
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
});
