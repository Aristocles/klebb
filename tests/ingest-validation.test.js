// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/ingest-validation.test.js
//
// meta.ingest, the HAE subscription (#589): lenient at load (drop the bad
// field so the card still renders and its metric resumes appearing on the
// hidden-metrics discovery surface), strict at create / PATCH (throw
// "invalid ingest: ...", which the server maps to 422).
//
// Dropping at load is load-bearing. An unknown metric used to validate fine,
// store nothing forever, AND graduate the metric off discovery: quiet in
// every direction.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createSandbox, cleanupSandbox } = require('./helpers/sandbox');
const { findSubscribers } = require('../health-auto-export/ingest');
const catalogue = require('../health-auto-export/catalogue');

const REPO_ROOT = path.resolve(__dirname, '..');
const MANIFESTS_DIR = path.resolve(REPO_ROOT, 'manifests') + path.sep;
const CONFIG_DIR = path.resolve(REPO_ROOT, 'config') + path.sep;
const HAE_DIR = path.resolve(REPO_ROOT, 'health-auto-export') + path.sep;

// Purge the repo modules that capture HEALTH_HOME (paths, registry, and the
// HAE modules createManifest lazy-requires for replay/discovery) so each test
// binds to its own sandbox.
function freshRegistry(sandboxRoot) {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(MANIFESTS_DIR) || key.startsWith(CONFIG_DIR) || key.startsWith(HAE_DIR)) {
      delete require.cache[key];
    }
  }
  process.env.HEALTH_HOME = sandboxRoot;
  return require(path.join(REPO_ROOT, 'manifests', 'registry.js'));
}

function manifest(id, ingest) {
  const meta = { id, label: 'Test card', view: { enabled: true, component: 'generic-card' } };
  if (ingest !== undefined) meta.ingest = ingest;
  return { $schema: 'klebb.datafile.v1', meta };
}

describe('meta.ingest validation: strict (create)', () => {
  test('rejects an uncatalogued metric with the 422 prefix', () => {
    const sandbox = createSandbox();
    const registry = freshRegistry(sandbox);
    try {
      registry.init();
      assert.throws(
        () => registry.createManifest(manifest('vo2', { source: 'hae', metric: 'vo2_max' })),
        /^Error: invalid ingest: unknown metric "vo2_max"/,
      );
      assert.equal(registry.get('vo2'), null, 'nothing should have been created');
    } finally {
      registry.closeStore();
      cleanupSandbox(sandbox);
    }
  });

  test('rejects a missing or non-string metric', () => {
    const sandbox = createSandbox();
    const registry = freshRegistry(sandbox);
    try {
      registry.init();
      for (const bad of [undefined, 42, null, true, [], '']) {
        const ingest = { source: 'hae' };
        if (bad !== undefined) ingest.metric = bad;
        assert.throws(
          () => registry.createManifest(manifest('steps', ingest)),
          /^Error: invalid ingest: metric must name an HAE catalogue entry/,
          `metric ${JSON.stringify(bad)} should have thrown`,
        );
      }
    } finally {
      registry.closeStore();
      cleanupSandbox(sandbox);
    }
  });

  test('rejects a non-object ingest', () => {
    const sandbox = createSandbox();
    const registry = freshRegistry(sandbox);
    try {
      registry.init();
      for (const bad of ['hae', ['hae'], null]) {
        assert.throws(
          () => registry.createManifest(manifest('steps', bad)),
          /^Error: invalid ingest: must be an object/,
          `ingest ${JSON.stringify(bad)} should have thrown`,
        );
      }
    } finally {
      registry.closeStore();
      cleanupSandbox(sandbox);
    }
  });

  test('accepts a catalogued metric and keeps meta.ingest intact', () => {
    const sandbox = createSandbox();
    const registry = freshRegistry(sandbox);
    try {
      registry.init();
      const res = registry.createManifest(manifest('steps', { source: 'hae', metric: 'step_count' }));
      assert.equal(res.id, 'steps');
      assert.deepEqual(registry.get('steps').meta.ingest, { source: 'hae', metric: 'step_count' });
      const onDisk = JSON.parse(fs.readFileSync(path.join(sandbox, 'data', 'steps.json'), 'utf8'));
      assert.deepEqual(onDisk.meta.ingest, { source: 'hae', metric: 'step_count' });
    } finally {
      registry.closeStore();
      cleanupSandbox(sandbox);
    }
  });

  test('accepts the workouts pseudo-metric', () => {
    const sandbox = createSandbox();
    const registry = freshRegistry(sandbox);
    try {
      registry.init();
      registry.createManifest(manifest('gym', { source: 'hae', metric: 'workouts' }));
      assert.deepEqual(registry.get('gym').meta.ingest, { source: 'hae', metric: 'workouts' });
    } finally {
      registry.closeStore();
      cleanupSandbox(sandbox);
    }
  });

  test('a non-hae source is inert: passes through untouched, metric unvalidated', () => {
    const sandbox = createSandbox();
    const registry = freshRegistry(sandbox);
    try {
      registry.init();
      registry.createManifest(manifest('custom', { source: 'other', metric: 'vo2_max' }));
      assert.deepEqual(registry.get('custom').meta.ingest, { source: 'other', metric: 'vo2_max' });
    } finally {
      registry.closeStore();
      cleanupSandbox(sandbox);
    }
  });

  test('accepts an absent ingest', () => {
    const sandbox = createSandbox();
    const registry = freshRegistry(sandbox);
    try {
      registry.init();
      registry.createManifest(manifest('notes'));
      assert.equal('ingest' in registry.get('notes').meta, false);
    } finally {
      registry.closeStore();
      cleanupSandbox(sandbox);
    }
  });
});

describe('meta.ingest validation: strict (PATCH)', () => {
  test('rejects patching a subscribed card to an uncatalogued metric; entry untouched', () => {
    const sandbox = createSandbox({
      seed: { 'steps.json': manifest('steps', { source: 'hae', metric: 'step_count' }) },
    });
    const registry = freshRegistry(sandbox);
    try {
      registry.init();
      assert.throws(
        () => registry.patchManifest('steps', { meta: { ingest: { metric: 'stepcount' } } }),
        /^Error: invalid ingest: unknown metric "stepcount"/,
      );
      assert.deepEqual(registry.get('steps').meta.ingest, { source: 'hae', metric: 'step_count' });
    } finally {
      registry.closeStore();
      cleanupSandbox(sandbox);
    }
  });

  test('rejects patching a bad subscription onto an unsubscribed card', () => {
    const sandbox = createSandbox({ seed: { 'mood.json': manifest('mood') } });
    const registry = freshRegistry(sandbox);
    try {
      registry.init();
      assert.throws(
        () => registry.patchManifest('mood', { meta: { ingest: { source: 'hae', metric: 'vo2_max' } } }),
        /^Error: invalid ingest: unknown metric "vo2_max"/,
      );
      assert.equal('ingest' in registry.get('mood').meta, false);
    } finally {
      registry.closeStore();
      cleanupSandbox(sandbox);
    }
  });

  test('accepts patching to another catalogued metric', () => {
    const sandbox = createSandbox({
      seed: { 'steps.json': manifest('steps', { source: 'hae', metric: 'step_count' }) },
    });
    const registry = freshRegistry(sandbox);
    try {
      registry.init();
      registry.patchManifest('steps', { meta: { ingest: { metric: 'apple_exercise_time' } } });
      assert.deepEqual(registry.get('steps').meta.ingest, { source: 'hae', metric: 'apple_exercise_time' });
    } finally {
      registry.closeStore();
      cleanupSandbox(sandbox);
    }
  });
});

describe('meta.ingest validation: lenient (load)', () => {
  const SEED = {
    'vo2.json': manifest('vo2', { source: 'hae', metric: 'vo2_max' }),
    'steps.json': manifest('steps', { source: 'hae', metric: 'step_count' }),
  };

  test('a bad subscription is dropped; the card still loads', () => {
    const sandbox = createSandbox({ seed: SEED });
    const registry = freshRegistry(sandbox);
    try {
      const stats = registry.init();
      assert.equal(stats.count, 2);
      assert.equal(stats.errors, 0);
      const vo2 = registry.get('vo2');
      assert.ok(vo2, 'the card with the bad ingest should still load');
      assert.equal('ingest' in vo2.meta, false);
    } finally {
      registry.closeStore();
      cleanupSandbox(sandbox);
    }
  });

  test('a valid subscription survives the load', () => {
    const sandbox = createSandbox({ seed: SEED });
    const registry = freshRegistry(sandbox);
    try {
      registry.init();
      assert.deepEqual(registry.get('steps').meta.ingest, { source: 'hae', metric: 'step_count' });
    } finally {
      registry.closeStore();
      cleanupSandbox(sandbox);
    }
  });

  test('a non-object ingest is dropped; the card still loads', () => {
    const sandbox = createSandbox({ seed: { 'weird.json': manifest('weird', 'hae') } });
    const registry = freshRegistry(sandbox);
    try {
      const stats = registry.init();
      assert.equal(stats.count, 1);
      assert.equal(stats.errors, 0);
      assert.equal('ingest' in registry.get('weird').meta, false);
    } finally {
      registry.closeStore();
      cleanupSandbox(sandbox);
    }
  });

  test('findSubscribers sees the kept subscription and not the dropped one', () => {
    const sandbox = createSandbox({ seed: SEED });
    const registry = freshRegistry(sandbox);
    try {
      registry.init();
      assert.deepEqual(findSubscribers(registry), [{ id: 'steps', metric: 'step_count' }]);
    } finally {
      registry.closeStore();
      cleanupSandbox(sandbox);
    }
  });
});

describe('shipped starters: every HAE subscription names a catalogued metric', () => {
  // Meta-only reads: the never-parse-card-files rule is about card data.
  function readStarters(dir, suffix) {
    return fs.readdirSync(dir)
      .filter((name) => name.endsWith(suffix))
      .map((name) => ({
        file: path.join(path.basename(dir), name),
        manifest: JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')),
      }));
  }

  test('templates/ and demo/fixtures/ metrics are all in the catalogue', () => {
    const starters = [
      ...readStarters(path.join(REPO_ROOT, 'templates'), '.klebb.json'),
      ...readStarters(path.join(REPO_ROOT, 'demo', 'fixtures'), '.json'),
    ];
    const hae = starters.filter((s) => s.manifest?.meta?.ingest?.source === 'hae');
    assert.ok(hae.length > 0, 'no HAE starters found; scan broken');
    for (const s of hae) {
      const metric = s.manifest.meta.ingest.metric;
      assert.ok(Object.prototype.hasOwnProperty.call(catalogue, metric),
        `${s.file}: metric "${metric}" is not in the HAE catalogue`);
    }
  });
});
