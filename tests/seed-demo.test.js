// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/seed-demo.test.js
// Verifies the demo seed:
//   - Generator produces 15 valid klebb.datafile.v1 manifests
//   - Every manifest passes the same sanity checks as data.example/
//   - Seed writes cards + reports + sentinel into a sandbox HEALTH_HOME
//   - First-boot helper respects the sentinel + the opt-out env var
//   - Existing-data installs are not touched

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { generateDemoCards } = require('../scripts/lib/demo-cards');
const {
  runDemoSeed,
  runFirstBootDemoSeed,
  isDataDirEmptyForSeed,
  SENTINEL_NAME
} = require('../scripts/seed-demo');

const REPO_ROOT = path.join(__dirname, '..');
const REPORTS_SRC = path.join(REPO_ROOT, 'data.demo', 'reports');

// Keep in lock-step with tests/example-manifests.test.js
const KNOWN_COMPONENTS = new Set([
  'generic-card', 'schedule-card', 'checklist-card', 'markdown-doc',
  'line-chart', 'schedule-timeline', 'table-list', 'adherence-report',
  'greeting-banner', 'progress-bars-card', 'list-card', 'day-marker',
]);
const KNOWN_INPUT_TYPES = new Set([
  'number', 'stepper', 'text', 'textarea', 'select', 'emoji-picker',
  'colour', 'color', 'checkbox', 'date', 'time', 'rating',
]);

function assertValidManifest(m, label) {
  assert.equal(m.$schema, 'klebb.datafile.v1', `${label}: bad $schema`);
  assert.ok(m.meta, `${label}: missing meta`);
  assert.ok(m.meta.id, `${label}: missing meta.id`);
  assert.ok(m.meta.label, `${label}: missing meta.label`);
  assert.ok('data' in m, `${label}: missing data`);
  for (const viewName of ['view', 'trends', 'calendar', 'reports']) {
    const v = m.meta[viewName];
    if (!v || !v.component) continue;
    assert.ok(
      KNOWN_COMPONENTS.has(v.component),
      `${label}: meta.${viewName}.component "${v.component}" unknown`
    );
  }
  const inputs = m.meta.writeable && m.meta.writeable.inputs;
  if (Array.isArray(inputs)) {
    for (const inp of inputs) {
      assert.ok(inp.key, `${label}: input missing key`);
      assert.ok(KNOWN_INPUT_TYPES.has(inp.type),
        `${label}: input "${inp.key}" has unknown type "${inp.type}"`);
    }
  }
}

function mkSandbox() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'klebb-seed-demo-'));
}
function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} }

// ---------------------------------------------------------------------------

describe('demo-cards generator', () => {
  test('produces exactly 15 cards', () => {
    const cards = generateDemoCards({ today: new Date('2026-04-24T00:00:00Z') });
    assert.equal(Object.keys(cards).length, 15);
  });

  test('every card is a valid v1 manifest', () => {
    const cards = generateDemoCards({ today: new Date('2026-04-24T00:00:00Z') });
    for (const [filename, m] of Object.entries(cards)) {
      assertValidManifest(m, filename);
    }
  });

  test('every card id is unique', () => {
    const cards = generateDemoCards({ today: new Date('2026-04-24T00:00:00Z') });
    const ids = new Set();
    for (const [, m] of Object.entries(cards)) {
      assert.ok(!ids.has(m.meta.id), `duplicate id ${m.meta.id}`);
      ids.add(m.meta.id);
    }
  });

  test('filename matches meta.id', () => {
    const cards = generateDemoCards({ today: new Date('2026-04-24T00:00:00Z') });
    for (const [filename, m] of Object.entries(cards)) {
      assert.equal(filename, `${m.meta.id}.json`,
        `${filename}: id "${m.meta.id}" should yield "${m.meta.id}.json"`);
    }
  });

  test('pre-populates metric cards with non-empty data', () => {
    const cards = generateDemoCards({ today: new Date('2026-04-24T00:00:00Z') });
    for (const name of ['weight.json', 'bp.json', 'mood.json', 'sleep-hours.json',
                        'hydration.json', 'steps.json', 'caffeine.json', 'energy.json',
                        'heart-rate-resting.json']) {
      const m = cards[name];
      assert.ok(Array.isArray(m.data), `${name}: data should be array`);
      assert.ok(m.data.length > 0, `${name}: data array is empty (would be hidden by registry)`);
    }
  });

  test('roster/checklist cards have items[]', () => {
    const cards = generateDemoCards({ today: new Date('2026-04-24T00:00:00Z') });
    for (const name of ['symptoms.json', 'medications.json', 'habits.json']) {
      const m = cards[name];
      assert.ok(m.data && Array.isArray(m.data.items),
        `${name}: expected data.items array`);
      assert.ok(m.data.items.length > 0, `${name}: items[] is empty`);
    }
  });

  test('at least 5 cards opt into meta.trends', () => {
    const cards = generateDemoCards({ today: new Date('2026-04-24T00:00:00Z') });
    const count = Object.values(cards).filter(m => m.meta.trends && m.meta.trends.enabled).length;
    assert.ok(count >= 5, `expected ≥5 trend-enabled cards, got ${count}`);
  });

  test('at least 5 cards opt into meta.reports', () => {
    const cards = generateDemoCards({ today: new Date('2026-04-24T00:00:00Z') });
    const count = Object.values(cards).filter(m => m.meta.reports && m.meta.reports.enabled).length;
    assert.ok(count >= 5, `expected ≥5 report-enabled cards, got ${count}`);
  });

  test('dates are anchored to the "today" argument', () => {
    const today = new Date('2026-04-24T00:00:00Z');
    const cards = generateDemoCards({ today });
    const last = cards['weight.json'].data[cards['weight.json'].data.length - 1];
    // The reference date is normalised to local midnight; last entry should
    // match that same local-calendar date.
    const norm = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const expected = `${norm.getFullYear()}-${String(norm.getMonth() + 1).padStart(2, '0')}-${String(norm.getDate()).padStart(2, '0')}`;
    assert.equal(last.date, expected, `expected last weight entry on ${expected}, got ${last.date}`);
  });

  test('generator is deterministic for the same today', () => {
    const today = new Date('2026-04-24T00:00:00Z');
    const a = generateDemoCards({ today });
    const b = generateDemoCards({ today });
    assert.deepEqual(a['weight.json'].data, b['weight.json'].data);
    assert.deepEqual(a['mood.json'].data, b['mood.json'].data);
  });
});

// ---------------------------------------------------------------------------

describe('runDemoSeed', () => {
  test('writes 15 cards, 5 reports, and sentinel into empty HEALTH_HOME', () => {
    const sandbox = mkSandbox();
    try {
      const summary = runDemoSeed({ healthHome: sandbox });
      assert.equal(summary.cardsWritten.length, 15);
      assert.equal(summary.cardsSkipped.length, 0);
      assert.equal(summary.reportsWritten.length, 5);
      assert.equal(summary.reportsSkipped.length, 0);
      assert.ok(summary.sentinelWritten);

      // On disk
      const dataFiles = fs.readdirSync(path.join(sandbox, 'data'))
        .filter(f => f.endsWith('.json'));
      assert.equal(dataFiles.length, 15);
      const reportFiles = fs.readdirSync(path.join(sandbox, 'reports'))
        .filter(f => f.endsWith('.md'));
      assert.equal(reportFiles.length, 5);
      assert.ok(fs.existsSync(path.join(sandbox, SENTINEL_NAME)));

      // Every JSON file parses
      for (const f of dataFiles) {
        const raw = fs.readFileSync(path.join(sandbox, 'data', f), 'utf8');
        const parsed = JSON.parse(raw);
        assertValidManifest(parsed, f);
      }
    } finally {
      rmrf(sandbox);
    }
  });

  test('dry-run writes nothing', () => {
    const sandbox = mkSandbox();
    try {
      const summary = runDemoSeed({ healthHome: sandbox, dryRun: true });
      assert.equal(summary.cardsWritten.length, 15); // reported as "would write"
      assert.equal(summary.sentinelWritten, false);
      const dataExists = fs.existsSync(path.join(sandbox, 'data')) &&
        fs.readdirSync(path.join(sandbox, 'data')).length > 0;
      assert.equal(dataExists, false, 'dry-run should not create files');
    } finally {
      rmrf(sandbox);
    }
  });

  test('second run without --force skips every existing file', () => {
    const sandbox = mkSandbox();
    try {
      runDemoSeed({ healthHome: sandbox });
      const summary2 = runDemoSeed({ healthHome: sandbox });
      assert.equal(summary2.cardsWritten.length, 0);
      assert.equal(summary2.cardsSkipped.length, 15);
      assert.equal(summary2.reportsWritten.length, 0);
      assert.equal(summary2.reportsSkipped.length, 5);
    } finally {
      rmrf(sandbox);
    }
  });

  test('--force overwrites existing files', () => {
    const sandbox = mkSandbox();
    try {
      runDemoSeed({ healthHome: sandbox });
      // Corrupt one card to prove force actually rewrites
      const weightPath = path.join(sandbox, 'data', 'weight.json');
      fs.writeFileSync(weightPath, '{"corrupt":true}', 'utf8');
      const summary = runDemoSeed({ healthHome: sandbox, force: true });
      assert.equal(summary.cardsWritten.length, 15);
      const restored = JSON.parse(fs.readFileSync(weightPath, 'utf8'));
      assert.equal(restored.meta.id, 'weight');
    } finally {
      rmrf(sandbox);
    }
  });
});

// ---------------------------------------------------------------------------

describe('isDataDirEmptyForSeed', () => {
  test('returns true when dir is missing', () => {
    const sandbox = mkSandbox();
    try {
      assert.equal(isDataDirEmptyForSeed(path.join(sandbox, 'does-not-exist')), true);
    } finally { rmrf(sandbox); }
  });

  test('returns true when dir exists but is empty', () => {
    const sandbox = mkSandbox();
    try {
      fs.mkdirSync(path.join(sandbox, 'data'));
      assert.equal(isDataDirEmptyForSeed(path.join(sandbox, 'data')), true);
    } finally { rmrf(sandbox); }
  });

  test('ignores dotfiles and _reserved dirs', () => {
    const sandbox = mkSandbox();
    try {
      const dd = path.join(sandbox, 'data');
      fs.mkdirSync(dd);
      fs.writeFileSync(path.join(dd, '.DS_Store'), '');
      fs.mkdirSync(path.join(dd, '_archive'));
      assert.equal(isDataDirEmptyForSeed(dd), true);
    } finally { rmrf(sandbox); }
  });

  test('returns false when any real file is present', () => {
    const sandbox = mkSandbox();
    try {
      const dd = path.join(sandbox, 'data');
      fs.mkdirSync(dd);
      fs.writeFileSync(path.join(dd, 'weight.json'), '{}');
      assert.equal(isDataDirEmptyForSeed(dd), false);
    } finally { rmrf(sandbox); }
  });
});

// ---------------------------------------------------------------------------

describe('runFirstBootDemoSeed', () => {
  const silent = { log: () => {}, warn: () => {}, error: () => {} };

  test('seeds on empty fresh install', () => {
    const sandbox = mkSandbox();
    try {
      const r = runFirstBootDemoSeed({ healthHome: sandbox, env: {}, logger: silent });
      assert.equal(r.ran, true);
      assert.equal(r.reason, 'seeded');
      assert.ok(fs.existsSync(path.join(sandbox, SENTINEL_NAME)));
      const cards = fs.readdirSync(path.join(sandbox, 'data')).filter(f => f.endsWith('.json'));
      assert.equal(cards.length, 15);
    } finally { rmrf(sandbox); }
  });

  test('no-op when sentinel already present', () => {
    const sandbox = mkSandbox();
    try {
      fs.writeFileSync(path.join(sandbox, SENTINEL_NAME), '{}');
      const r = runFirstBootDemoSeed({ healthHome: sandbox, env: {}, logger: silent });
      assert.equal(r.ran, false);
      assert.equal(r.reason, 'sentinel-present');
      // data/ must remain empty
      const dataExists = fs.existsSync(path.join(sandbox, 'data')) &&
        fs.readdirSync(path.join(sandbox, 'data')).length > 0;
      assert.equal(dataExists, false);
    } finally { rmrf(sandbox); }
  });

  test('no-op when KLEBB_SKIP_DEMO_SEED is set', () => {
    const sandbox = mkSandbox();
    try {
      const r = runFirstBootDemoSeed({
        healthHome: sandbox,
        env: { KLEBB_SKIP_DEMO_SEED: '1' },
        logger: silent
      });
      assert.equal(r.ran, false);
      assert.equal(r.reason, 'opt-out-env');
      assert.equal(fs.existsSync(path.join(sandbox, SENTINEL_NAME)), false);
    } finally { rmrf(sandbox); }
  });

  test('existing-data install: writes skip-sentinel, does not seed', () => {
    const sandbox = mkSandbox();
    try {
      const dd = path.join(sandbox, 'data');
      fs.mkdirSync(dd, { recursive: true });
      fs.writeFileSync(path.join(dd, 'my-own-card.json'), '{"$schema":"klebb.datafile.v1","meta":{"id":"x","label":"x"},"data":[]}');
      const r = runFirstBootDemoSeed({ healthHome: sandbox, env: {}, logger: silent });
      assert.equal(r.ran, false);
      assert.equal(r.reason, 'existing-data');
      // User's file is untouched
      assert.ok(fs.existsSync(path.join(dd, 'my-own-card.json')));
      // No demo cards were added
      const files = fs.readdirSync(dd).filter(f => f.endsWith('.json'));
      assert.deepEqual(files, ['my-own-card.json']);
      // Skip-sentinel IS written so we don't re-check every boot
      assert.ok(fs.existsSync(path.join(sandbox, SENTINEL_NAME)));
    } finally { rmrf(sandbox); }
  });

  test('second call after successful seed is a no-op', () => {
    const sandbox = mkSandbox();
    try {
      runFirstBootDemoSeed({ healthHome: sandbox, env: {}, logger: silent });
      const before = fs.readdirSync(path.join(sandbox, 'data')).sort();
      const beforeMtime = fs.statSync(path.join(sandbox, 'data', 'weight.json')).mtimeMs;
      // Second run
      const r2 = runFirstBootDemoSeed({ healthHome: sandbox, env: {}, logger: silent });
      assert.equal(r2.ran, false);
      assert.equal(r2.reason, 'sentinel-present');
      const after = fs.readdirSync(path.join(sandbox, 'data')).sort();
      assert.deepEqual(after, before);
      const afterMtime = fs.statSync(path.join(sandbox, 'data', 'weight.json')).mtimeMs;
      assert.equal(afterMtime, beforeMtime, 'weight.json should not have been rewritten');
    } finally { rmrf(sandbox); }
  });
});

// ---------------------------------------------------------------------------

describe('data.demo/reports', () => {
  test('ships exactly 5 markdown reports', () => {
    const files = fs.readdirSync(REPORTS_SRC).filter(f => f.endsWith('.md'));
    assert.equal(files.length, 5);
  });

  test('every report opens with a DEMO warning banner', () => {
    const files = fs.readdirSync(REPORTS_SRC).filter(f => f.endsWith('.md'));
    for (const f of files) {
      const body = fs.readFileSync(path.join(REPORTS_SRC, f), 'utf8');
      assert.ok(/DEMO/i.test(body), `${f}: no DEMO marker`);
      assert.ok(body.includes('$HEALTH_HOME/reports/'),
        `${f}: doesn't tell the user where the file lives`);
    }
  });

  test('every report links to the docs', () => {
    const files = fs.readdirSync(REPORTS_SRC).filter(f => f.endsWith('.md'));
    for (const f of files) {
      const body = fs.readFileSync(path.join(REPORTS_SRC, f), 'utf8');
      assert.ok(/docs\/(CARDS|RECIPES)\.md/.test(body),
        `${f}: no link to docs/CARDS.md or docs/RECIPES.md`);
    }
  });
});
