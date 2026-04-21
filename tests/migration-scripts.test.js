// tests/migration-scripts.test.js
// Integration tests for the three migration scripts:
//   1. scripts/migrate-to-klebb.js           — $schema string rewrite
//   2. scripts/migrate-cards-to-generic.js   — legacy component → generic-card
//   3. scripts/migrate-v1-to-v2.js           — legacy bare arrays → v2 manifests
//
// Each script is CLI-style; tests invoke via execSync against a tmp dir.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { createSandbox, cleanupSandbox } = require('./helpers/sandbox');

const REPO_ROOT = path.resolve(__dirname, '..');
const SCHEMA_SCRIPT = path.join(REPO_ROOT, 'scripts', 'migrate-to-klebb.js');
const CARDS_SCRIPT  = path.join(REPO_ROOT, 'scripts', 'migrate-cards-to-generic.js');
const V1_SCRIPT     = path.join(REPO_ROOT, 'scripts', 'migrate-v1-to-v2.js');

function run(script, args = []) {
  return execSync(`node ${script} ${args.join(' ')}`, {
    encoding: 'utf8',
    env: { ...process.env, HEALTH_HOME_WARNED: '1' },
  });
}

describe('migrate-to-klebb.js ($schema rewrite)', () => {
  test('rewrites eddzhealth.datafile.v1 → klebb.datafile.v1', () => {
    const sandbox = createSandbox();
    const file = path.join(sandbox, 'data', 'x.json');
    fs.writeFileSync(file, JSON.stringify({
      $schema: 'eddzhealth.datafile.v1',
      meta: { id: 'x', label: 'X' },
      description: 'keep me',
      data: [{ date: '2026-04-20', v: 1 }],
    }));
    try {
      run(SCHEMA_SCRIPT, [`--dir ${path.join(sandbox, 'data')}`]);
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(parsed.$schema, 'klebb.datafile.v1');
      assert.equal(parsed.description, 'keep me');
      assert.equal(parsed.data.length, 1);
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('--dry-run does not mutate files', () => {
    const sandbox = createSandbox();
    const file = path.join(sandbox, 'data', 'x.json');
    const original = JSON.stringify({
      $schema: 'eddzhealth.datafile.v1',
      meta: { id: 'x', label: 'X' },
      data: [],
    });
    fs.writeFileSync(file, original);
    try {
      const out = run(SCHEMA_SCRIPT, [`--dir ${path.join(sandbox, 'data')}`, '--dry-run']);
      assert.ok(out.includes('would-migrate'), 'should report would-migrate');
      assert.equal(fs.readFileSync(file, 'utf8'), original, 'file should be untouched');
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('idempotent — running twice on migrated file is a no-op', () => {
    const sandbox = createSandbox();
    const file = path.join(sandbox, 'data', 'x.json');
    fs.writeFileSync(file, JSON.stringify({
      $schema: 'klebb.datafile.v1',
      meta: { id: 'x', label: 'X' },
      data: [],
    }));
    try {
      const out = run(SCHEMA_SCRIPT, [`--dir ${path.join(sandbox, 'data')}`]);
      assert.ok(out.includes('already-migrated'), 'should report already-migrated');
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('skips files with unknown $schema', () => {
    const sandbox = createSandbox();
    const file = path.join(sandbox, 'data', 'x.json');
    fs.writeFileSync(file, JSON.stringify({
      $schema: 'some.other.schema.v2',
      meta: { id: 'x' },
      data: [],
    }));
    try {
      const out = run(SCHEMA_SCRIPT, [`--dir ${path.join(sandbox, 'data')}`]);
      assert.ok(out.includes('skipped'));
      // And the file is untouched
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(parsed.$schema, 'some.other.schema.v2');
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('skips invalid JSON silently', () => {
    const sandbox = createSandbox();
    const file = path.join(sandbox, 'data', 'broken.json');
    fs.writeFileSync(file, '{ not json');
    try {
      // Should not crash
      const out = run(SCHEMA_SCRIPT, [`--dir ${path.join(sandbox, 'data')}`]);
      assert.ok(out.includes('skipped'));
    } finally {
      cleanupSandbox(sandbox);
    }
  });
});

describe('migrate-cards-to-generic.js (component migration)', () => {
  test('migrates weight.json meta to generic-card', () => {
    const sandbox = createSandbox();
    const file = path.join(sandbox, 'data', 'weight.json');
    fs.writeFileSync(file, JSON.stringify({
      $schema: 'klebb.datafile.v1',
      meta: {
        id: 'weight',
        label: 'Weight',
        emoji: '⚖️',
        order: 20,
        view: { enabled: true, component: 'old-metric-card' },
        trends: { enabled: true, component: 'line-chart' },
        writeable: { fromWebapp: true, todayAllowed: true, pastAllowed: true },
      },
      description: 'must preserve',
      data: [{ date: '2026-04-20', kg: 85, note: 'morning' }],
    }));
    try {
      run(CARDS_SCRIPT, [`--dir ${path.join(sandbox, 'data')}`]);
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(parsed.meta.view.component, 'generic-card');
      assert.ok(parsed.meta.view.display.template, 'template should be set');
      assert.equal(parsed.meta.view.display.unit, 'kg');
      assert.ok(parsed.meta.view.display.trendArrow, 'trendArrow should be set');
      assert.ok(Array.isArray(parsed.meta.writeable.inputs));
      assert.ok(parsed.meta.writeable.inputs.find(i => i.key === 'kg'));
      // Preservation checks
      assert.equal(parsed.meta.id, 'weight');
      assert.equal(parsed.meta.order, 20);
      assert.equal(parsed.meta.emoji, '⚖️');
      assert.equal(parsed.meta.trends.component, 'line-chart', 'trends config preserved');
      assert.equal(parsed.description, 'must preserve');
      assert.equal(parsed.data.length, 1);
      assert.equal(parsed.data[0].kg, 85);
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('migrates bp.json with threshold rules', () => {
    const sandbox = createSandbox();
    const file = path.join(sandbox, 'data', 'bp.json');
    fs.writeFileSync(file, JSON.stringify({
      $schema: 'klebb.datafile.v1',
      meta: {
        id: 'bp',
        label: 'Blood Pressure',
        view: { enabled: true, component: 'old-metric-card' },
      },
      data: [],
    }));
    try {
      run(CARDS_SCRIPT, [`--dir ${path.join(sandbox, 'data')}`]);
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(parsed.meta.view.component, 'generic-card');
      assert.ok(Array.isArray(parsed.meta.view.display.thresholds));
      assert.ok(parsed.meta.view.display.thresholds.length >= 4, 'BP has 4 threshold tiers');
      assert.equal(parsed.meta.writeable.maxReadingsPerDay, 3);
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('migrates mood.json with emoji-picker + autoSubmit', () => {
    const sandbox = createSandbox();
    const file = path.join(sandbox, 'data', 'mood.json');
    fs.writeFileSync(file, JSON.stringify({
      $schema: 'klebb.datafile.v1',
      meta: { id: 'mood', label: 'Mood', view: { enabled: true, component: 'quick-action-card' } },
      data: [],
    }));
    try {
      run(CARDS_SCRIPT, [`--dir ${path.join(sandbox, 'data')}`]);
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(parsed.meta.view.component, 'generic-card');
      assert.ok(parsed.meta.view.display.emojiMap.mood, 'emojiMap set');
      const moodInput = parsed.meta.writeable.inputs.find(i => i.key === 'mood');
      assert.ok(moodInput);
      assert.equal(moodInput.type, 'emoji-picker');
      assert.equal(moodInput.autoSubmit, true);
      assert.equal(moodInput.emitIndex, true);
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('skips unknown ids untouched', () => {
    const sandbox = createSandbox();
    const file = path.join(sandbox, 'data', 'custom.json');
    const original = JSON.stringify({
      $schema: 'klebb.datafile.v1',
      meta: { id: 'custom', label: 'Custom', view: { enabled: true, component: 'my-custom-renderer' } },
      data: [],
    });
    fs.writeFileSync(file, original);
    try {
      const out = run(CARDS_SCRIPT, [`--dir ${path.join(sandbox, 'data')}`]);
      assert.ok(out.includes('skipped'));
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(parsed.meta.view.component, 'my-custom-renderer', 'custom id untouched');
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('idempotent — running twice gives already-migrated', () => {
    const sandbox = createSandbox();
    const file = path.join(sandbox, 'data', 'weight.json');
    fs.writeFileSync(file, JSON.stringify({
      $schema: 'klebb.datafile.v1',
      meta: { id: 'weight', label: 'Weight', view: { enabled: true, component: 'old-metric-card' } },
      data: [],
    }));
    try {
      run(CARDS_SCRIPT, [`--dir ${path.join(sandbox, 'data')}`]);
      const out2 = run(CARDS_SCRIPT, [`--dir ${path.join(sandbox, 'data')}`]);
      assert.ok(out2.includes('already-migrated'));
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('--dry-run does not mutate files', () => {
    const sandbox = createSandbox();
    const file = path.join(sandbox, 'data', 'weight.json');
    const original = JSON.stringify({
      $schema: 'klebb.datafile.v1',
      meta: { id: 'weight', label: 'Weight', view: { enabled: true, component: 'x' } },
      data: [],
    });
    fs.writeFileSync(file, original);
    try {
      run(CARDS_SCRIPT, [`--dir ${path.join(sandbox, 'data')}`, '--dry-run']);
      assert.equal(fs.readFileSync(file, 'utf8'), original);
    } finally {
      cleanupSandbox(sandbox);
    }
  });
});

describe('migrate-v1-to-v2.js (bare-array → v2 manifest)', () => {
  test('wraps a legacy weight array into a v2 manifest (dry-run mode)', () => {
    const sandbox = createSandbox();
    const file = path.join(sandbox, 'data', 'weight.json');
    const legacy = [{ date: '2026-04-20', kg: 85 }, { date: '2026-04-21', kg: 86 }];
    fs.writeFileSync(file, JSON.stringify(legacy, null, 2));
    try {
      // Dry-run by default
      const out = execSync(`node ${V1_SCRIPT}`, {
        encoding: 'utf8',
        env: { ...process.env, HEALTH_HOME: sandbox, HEALTH_HOME_WARNED: '1' },
      });
      assert.ok(out.includes('weight.json'));
      // Dry-run: file untouched
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.ok(Array.isArray(parsed), 'dry-run leaves file as legacy array');
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('--apply wraps a legacy weight array into v2 manifest', () => {
    const sandbox = createSandbox();
    const file = path.join(sandbox, 'data', 'weight.json');
    const legacy = [{ date: '2026-04-20', kg: 85 }];
    fs.writeFileSync(file, JSON.stringify(legacy, null, 2));
    try {
      execSync(`node ${V1_SCRIPT} --apply`, {
        encoding: 'utf8',
        env: { ...process.env, HEALTH_HOME: sandbox, HEALTH_HOME_WARNED: '1' },
      });
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(parsed.$schema, 'klebb.datafile.v1');
      assert.equal(parsed.meta.id, 'weight');
      assert.ok(parsed.meta.view);
      assert.ok(Array.isArray(parsed.data));
      assert.equal(parsed.data.length, 1);
      assert.equal(parsed.data[0].kg, 85);
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('already-migrated file is a no-op', () => {
    const sandbox = createSandbox();
    const file = path.join(sandbox, 'data', 'weight.json');
    fs.writeFileSync(file, JSON.stringify({
      $schema: 'klebb.datafile.v1',
      meta: { id: 'weight', label: 'Weight' },
      data: [{ date: '2026-04-20', kg: 85 }],
    }));
    try {
      const before = fs.readFileSync(file, 'utf8');
      execSync(`node ${V1_SCRIPT} --apply`, {
        encoding: 'utf8',
        env: { ...process.env, HEALTH_HOME: sandbox, HEALTH_HOME_WARNED: '1' },
      });
      const after = fs.readFileSync(file, 'utf8');
      assert.equal(before, after, 'already-migrated file should be untouched');
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('--apply archives the original to _archive/migration-<date>/', () => {
    const sandbox = createSandbox();
    const file = path.join(sandbox, 'data', 'weight.json');
    fs.writeFileSync(file, JSON.stringify([{ date: '2026-04-20', kg: 85 }], null, 2));
    try {
      execSync(`node ${V1_SCRIPT} --apply`, {
        encoding: 'utf8',
        env: { ...process.env, HEALTH_HOME: sandbox, HEALTH_HOME_WARNED: '1' },
      });
      // Look for an _archive/migration-YYYY-MM-DD/weight.json
      const archiveRoot = path.join(sandbox, 'data', '_archive');
      assert.ok(fs.existsSync(archiveRoot), 'archive root should exist');
      const stamps = fs.readdirSync(archiveRoot).filter(s => s.startsWith('migration-'));
      assert.ok(stamps.length >= 1, 'should have at least one migration-<date> dir');
      assert.ok(fs.existsSync(path.join(archiveRoot, stamps[0], 'weight.json')),
        'original file should be archived');
    } finally {
      cleanupSandbox(sandbox);
    }
  });
});
