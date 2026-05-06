// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/welcome-card.test.js
// Unit tests for the welcome-card onboarding path.

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runFirstBoot, isDataDirEmpty, WELCOME_FILENAME } =
  require('../server/first-boot');

function mkTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'eh-welcome-'));
}

function rm(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

describe('first-boot welcome seed', () => {
  let root;
  beforeEach(() => { root = mkTempDir(); });
  afterEach(() => { rm(root); });

  test('seeds welcome card when data dir is empty', () => {
    const dataDir = path.join(root, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    const result = runFirstBoot({ dataDir, log: () => {} });
    assert.equal(result.ran, true);
    assert.equal(result.reason, 'seeded');
    const target = path.join(dataDir, WELCOME_FILENAME);
    assert.ok(fs.existsSync(target), 'welcome file was written');
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
    assert.equal(parsed.meta.id, 'welcome');
    assert.equal(parsed.meta.view.component, 'welcome-card');
    assert.equal(parsed.meta.welcome.autoHideApplied, false);
  });

  test('creates data dir if it does not exist', () => {
    const dataDir = path.join(root, 'data-not-yet');
    const result = runFirstBoot({ dataDir, log: () => {} });
    assert.equal(result.ran, true);
    assert.ok(fs.existsSync(path.join(dataDir, WELCOME_FILENAME)));
  });

  test('does not seed when data dir contains any manifest', () => {
    const dataDir = path.join(root, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'weight.json'), '{}');
    const result = runFirstBoot({ dataDir, log: () => {} });
    assert.equal(result.ran, false);
    assert.equal(result.reason, 'data-not-empty');
    assert.ok(!fs.existsSync(path.join(dataDir, WELCOME_FILENAME)));
  });

  test('ignores dot-prefixed files when checking emptiness', () => {
    const dataDir = path.join(root, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, '.gitkeep'), '');
    assert.equal(isDataDirEmpty(dataDir), true);
  });

  test('second boot with welcome present is a no-op', () => {
    const dataDir = path.join(root, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    runFirstBoot({ dataDir, log: () => {} });
    const firstMtime = fs.statSync(path.join(dataDir, WELCOME_FILENAME)).mtimeMs;
    const result = runFirstBoot({ dataDir, log: () => {} });
    assert.equal(result.ran, false);
    // welcome card now exists in data, so isDataDirEmpty returns false —
    // reason is 'data-not-empty', not 'welcome-already-exists'.
    assert.equal(result.reason, 'data-not-empty');
    const secondMtime = fs.statSync(path.join(dataDir, WELCOME_FILENAME)).mtimeMs;
    assert.equal(firstMtime, secondMtime, 'welcome file was not rewritten');
  });

  test('deleted welcome is not re-created when other manifests exist', () => {
    const dataDir = path.join(root, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    runFirstBoot({ dataDir, log: () => {} });
    fs.unlinkSync(path.join(dataDir, WELCOME_FILENAME));
    fs.writeFileSync(path.join(dataDir, 'weight.json'), '{}');
    const result = runFirstBoot({ dataDir, log: () => {} });
    assert.equal(result.ran, false);
    assert.ok(!fs.existsSync(path.join(dataDir, WELCOME_FILENAME)));
  });
});

describe('welcome auto-hide on first card creation', () => {
  let root;
  let prevHealthHome;

  beforeEach(() => {
    root = mkTempDir();
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    prevHealthHome = process.env.HEALTH_HOME;
    process.env.HEALTH_HOME = root;
    // Flush require cache so config/paths.js picks up the new HEALTH_HOME.
    for (const k of Object.keys(require.cache)) {
      if (k.includes('config\\paths') || k.includes('config/paths') ||
          k.includes('manifests\\registry') || k.includes('manifests/registry') ||
          k.includes('manifests\\merge-patch') || k.includes('manifests/merge-patch')) {
        delete require.cache[k];
      }
    }
  });

  afterEach(() => {
    if (prevHealthHome !== undefined) process.env.HEALTH_HOME = prevHealthHome;
    else delete process.env.HEALTH_HOME;
    rm(root);
  });

  function makeWelcome(overrides = {}) {
    return {
      $schema: 'klebb.datafile.v1',
      meta: {
        id: 'welcome',
        label: 'Welcome to Klebb',
        emoji: '👋',
        order: 1,
        view: { enabled: true, component: 'welcome-card' },
        welcome: { autoHideApplied: false },
        ...overrides,
      },
      description: '',
      data: {},
    };
  }

  function makeCard(id) {
    return {
      $schema: 'klebb.datafile.v1',
      meta: {
        id,
        label: id,
        view: { enabled: true, component: 'generic-card', display: { template: '{x}' } },
      },
      data: [],
    };
  }

  test('creating another card auto-hides the welcome card once', () => {
    fs.writeFileSync(
      path.join(root, 'data', 'welcome.klebb.json'),
      JSON.stringify(makeWelcome(), null, 2),
    );
    const registry = require('../manifests/registry');
    registry.init();

    const result = registry.createManifest(makeCard('weight'));
    assert.equal(result.welcomeAutoHidden, true);

    const welcome = JSON.parse(
      fs.readFileSync(path.join(root, 'data', 'welcome.klebb.json'), 'utf8'),
    );
    assert.equal(welcome.meta.enabled, false);
    assert.equal(welcome.meta.welcome.autoHideApplied, true);
  });

  test('second creation does not re-apply auto-hide', () => {
    fs.writeFileSync(
      path.join(root, 'data', 'welcome.klebb.json'),
      JSON.stringify(makeWelcome({
        enabled: true,
        welcome: { autoHideApplied: true },
      }), null, 2),
    );
    const registry = require('../manifests/registry');
    registry.init();

    const result = registry.createManifest(makeCard('weight'));
    assert.equal(result.welcomeAutoHidden, false);

    const welcome = JSON.parse(
      fs.readFileSync(path.join(root, 'data', 'welcome.klebb.json'), 'utf8'),
    );
    // The flag was already set, so meta.enabled stays as it was (true here:
    // the user had re-enabled it in Settings). Auto-hide does not fight
    // the user.
    assert.equal(welcome.meta.enabled, true);
    assert.equal(welcome.meta.welcome.autoHideApplied, true);
  });

  test('no welcome card present: createManifest works normally', () => {
    const registry = require('../manifests/registry');
    registry.init();
    const result = registry.createManifest(makeCard('weight'));
    assert.equal(result.welcomeAutoHidden, false);
  });

  test('creating the welcome card itself does not trigger auto-hide', () => {
    const registry = require('../manifests/registry');
    registry.init();
    const result = registry.createManifest(makeWelcome());
    assert.equal(result.welcomeAutoHidden, false);
  });
});
