// tests/registry-master-enabled.test.js
// Additional registry tests specifically for the master meta.enabled flag
// and its interaction with multiple views.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { createSandbox, cleanupSandbox } = require('./helpers/sandbox');

function freshRegistry(sandboxRoot) {
  for (const key of Object.keys(require.cache)) {
    if (key.includes('/health/webapp/manifests/') ||
        key.includes('/health/webapp/config/')) {
      delete require.cache[key];
    }
  }
  process.env.HEALTH_HOME = sandboxRoot;
  return require(path.join(__dirname, '..', 'manifests', 'registry.js'));
}

describe('registry master meta.enabled', () => {
  test('meta.enabled: false hides from ALL views', () => {
    const sandbox = createSandbox({
      seed: {
        'weight.json': {
          $schema: 'eddzhealth.datafile.v1',
          meta: {
            id: 'weight',
            label: 'Weight',
            enabled: false,   // master kill
            view:   { enabled: true, component: 'metric-card' },
            trends: { enabled: true, component: 'line-chart' },
            reports:{ enabled: true, component: 'adherence-report' },
          },
          data: [{ date: '2026-04-20', kg: 85 }],
        },
      },
    });
    try {
      const registry = freshRegistry(sandbox);
      registry.init();
      assert.equal(registry.listForView('view').length, 0);
      assert.equal(registry.listForView('trends').length, 0);
      assert.equal(registry.listForView('reports').length, 0);
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('absent meta.enabled defaults to enabled', () => {
    const sandbox = createSandbox({
      seed: {
        'weight.json': {
          $schema: 'eddzhealth.datafile.v1',
          meta: {
            id: 'weight',
            label: 'Weight',
            // no meta.enabled field at all
            view: { enabled: true, component: 'metric-card' },
          },
          data: [{ date: '2026-04-20', kg: 85 }],
        },
      },
    });
    try {
      const registry = freshRegistry(sandbox);
      registry.init();
      assert.equal(registry.listForView('view').length, 1);
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('meta.enabled: true explicit also shows', () => {
    const sandbox = createSandbox({
      seed: {
        'weight.json': {
          $schema: 'eddzhealth.datafile.v1',
          meta: {
            id: 'weight',
            label: 'Weight',
            enabled: true,
            view: { enabled: true, component: 'metric-card' },
          },
          data: [{ date: '2026-04-20', kg: 85 }],
        },
      },
    });
    try {
      const registry = freshRegistry(sandbox);
      registry.init();
      assert.equal(registry.listForView('view').length, 1);
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('setMasterEnabled(false) persists and hides', () => {
    const sandbox = createSandbox({
      seed: {
        'weight.json': {
          $schema: 'eddzhealth.datafile.v1',
          meta: {
            id: 'weight',
            label: 'Weight',
            view: { enabled: true, component: 'metric-card' },
          },
          data: [{ date: '2026-04-20', kg: 85 }],
        },
      },
    });
    try {
      const registry = freshRegistry(sandbox);
      registry.init();
      assert.equal(registry.listForView('view').length, 1);

      registry.setMasterEnabled('weight', false);

      // File on disk has meta.enabled: false
      const raw = JSON.parse(fs.readFileSync(path.join(sandbox, 'data', 'weight.json'), 'utf8'));
      assert.equal(raw.meta.enabled, false);

      // And it's hidden
      assert.equal(registry.listForView('view').length, 0);

      // Flip back
      registry.setMasterEnabled('weight', true);
      assert.equal(registry.listForView('view').length, 1);
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('setMasterEnabled on unknown id throws', () => {
    const sandbox = createSandbox();
    try {
      const registry = freshRegistry(sandbox);
      registry.init();
      assert.throws(() => registry.setMasterEnabled('nonexistent', true), /unknown manifest/);
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('list() includes enabled field', () => {
    const sandbox = createSandbox({
      seed: {
        'a.json': {
          $schema: 'eddzhealth.datafile.v1',
          meta: { id: 'a', label: 'A', enabled: false, view: { enabled: true, component: 'metric-card' } },
          data: [{ date: '2026-04-20', v: 1 }],
        },
        'b.json': {
          $schema: 'eddzhealth.datafile.v1',
          meta: { id: 'b', label: 'B', view: { enabled: true, component: 'metric-card' } },
          data: [{ date: '2026-04-20', v: 2 }],
        },
      },
    });
    try {
      const registry = freshRegistry(sandbox);
      registry.init();
      const list = registry.list();
      const byId = Object.fromEntries(list.map(x => [x.id, x]));
      assert.equal(byId.a.enabled, false);
      assert.equal(byId.b.enabled, true);
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('setMasterEnabled preserves data + description', () => {
    const sandbox = createSandbox({
      seed: {
        'keep.json': {
          $schema: 'eddzhealth.datafile.v1',
          meta: {
            id: 'keep',
            label: 'Keep',
            view: { enabled: true, component: 'metric-card' },
          },
          description: 'must preserve me',
          data: [{ date: '2026-04-20', v: 1 }, { date: '2026-04-21', v: 2 }],
        },
      },
    });
    try {
      const registry = freshRegistry(sandbox);
      registry.init();
      registry.setMasterEnabled('keep', false);
      registry.setMasterEnabled('keep', true);
      const raw = JSON.parse(fs.readFileSync(path.join(sandbox, 'data', 'keep.json'), 'utf8'));
      assert.equal(raw.description, 'must preserve me');
      assert.equal(raw.data.length, 2);
      assert.equal(raw.data[1].v, 2);
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('writeData after setMasterEnabled preserves enabled flag', () => {
    const sandbox = createSandbox({
      seed: {
        'weight.json': {
          $schema: 'eddzhealth.datafile.v1',
          meta: { id: 'weight', label: 'Weight', view: { enabled: true, component: 'metric-card' } },
          data: [{ date: '2026-04-20', kg: 85 }],
        },
      },
    });
    try {
      const registry = freshRegistry(sandbox);
      registry.init();
      registry.setMasterEnabled('weight', false);
      registry.writeData('weight', [{ date: '2026-04-20', kg: 86 }]);
      const raw = JSON.parse(fs.readFileSync(path.join(sandbox, 'data', 'weight.json'), 'utf8'));
      assert.equal(raw.meta.enabled, false, 'writeData must preserve the master-disabled flag');
      assert.equal(raw.data[0].kg, 86);
    } finally {
      cleanupSandbox(sandbox);
    }
  });
});
