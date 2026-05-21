// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/reset-demo.test.js
//
// Coverage for #271. Three guarantees:
//   1. Every fixture in demo/fixtures/ is a valid klebb.datafile.v1 manifest
//      after placeholder rewriting.
//   2. resetDemo() refuses to run unless KLEBB_DEMO=1.
//   3. resetDemo() wipes the data dir, copies all fixtures, and rewrites
//      __OFFSET_DAYS:N__ placeholders against the supplied "today".

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  resetDemo,
  rewritePlaceholders,
  isoDateNDaysFromToday,
  listFixtures,
  listReportFixtures,
  copyFixtures,
  copyReportFixtures,
  wipeReportsDir,
  FIXTURES_DIR,
  REPORTS_FIXTURES_DIR,
} = require('../scripts/reset-demo');
const { validateManifestShape } = require('../manifests/registry');

function tmpDir(prefix = 'klebb-reset-demo-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

describe('reset-demo: placeholder rewrite', () => {
  test('isoDateNDaysFromToday: today + N produces a YYYY-MM-DD string', () => {
    const today = new Date(2026, 4, 21); // 2026-05-21 local
    assert.equal(isoDateNDaysFromToday(0, today), '2026-05-21');
    assert.equal(isoDateNDaysFromToday(-7, today), '2026-05-14');
    assert.equal(isoDateNDaysFromToday(7, today), '2026-05-28');
  });

  test('rewritePlaceholders replaces every __OFFSET_DAYS:N__ token', () => {
    const today = new Date(2026, 4, 21);
    const input = 'a=__OFFSET_DAYS:0__ b=__OFFSET_DAYS:-7__ c=__OFFSET_DAYS:14__';
    assert.equal(
      rewritePlaceholders(input, today),
      'a=2026-05-21 b=2026-05-14 c=2026-06-04',
    );
  });

  test('rewritePlaceholders leaves non-placeholder text unchanged', () => {
    const today = new Date(2026, 4, 21);
    assert.equal(rewritePlaceholders('hello world', today), 'hello world');
  });

  test('rewritePlaceholders accepts the underscore separator (filename-safe form)', () => {
    const today = new Date(2026, 4, 21);
    assert.equal(rewritePlaceholders('BLOODS-__OFFSET_DAYS_-30__.md', today), 'BLOODS-2026-04-21.md');
    assert.equal(rewritePlaceholders('a=__OFFSET_DAYS_0__ b=__OFFSET_DAYS:7__', today), 'a=2026-05-21 b=2026-05-28');
  });
});

describe('reset-demo: fixture validity', () => {
  test('every fixture parses + validates as klebb.datafile.v1 after rewrite', () => {
    const today = new Date();
    const fixtures = listFixtures();
    assert.ok(fixtures.length >= 8, `expected at least 8 fixtures, found ${fixtures.length}`);
    for (const file of fixtures) {
      const raw = fs.readFileSync(file, 'utf8');
      const resolved = rewritePlaceholders(raw, today);
      let parsed;
      try {
        parsed = JSON.parse(resolved);
      } catch (e) {
        assert.fail(`${path.basename(file)}: invalid JSON after rewrite — ${e.message}`);
      }
      assert.doesNotThrow(
        () => validateManifestShape(parsed),
        `${path.basename(file)}: failed shape validation`,
      );
      // Ensure no placeholder leaked through.
      assert.ok(
        !/__OFFSET_DAYS:/.test(resolved),
        `${path.basename(file)}: placeholder not fully resolved`,
      );
    }
  });
});

describe('reset-demo: resetDemo()', () => {
  test('refuses to run when KLEBB_DEMO is unset', () => {
    const dir = tmpDir();
    const reportsDir = tmpDir();
    try {
      const orig = process.env.KLEBB_DEMO;
      delete process.env.KLEBB_DEMO;
      try {
        assert.throws(() => resetDemo({ dataDir: dir, reportsDir }), /KLEBB_DEMO=1/);
      } finally {
        if (orig !== undefined) process.env.KLEBB_DEMO = orig;
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(reportsDir, { recursive: true, force: true });
    }
  });

  test('refuses to run when KLEBB_DEMO is set to something other than "1"', () => {
    const dir = tmpDir();
    const reportsDir = tmpDir();
    try {
      const orig = process.env.KLEBB_DEMO;
      process.env.KLEBB_DEMO = 'true';
      try {
        assert.throws(() => resetDemo({ dataDir: dir, reportsDir }), /KLEBB_DEMO=1/);
      } finally {
        if (orig === undefined) delete process.env.KLEBB_DEMO;
        else process.env.KLEBB_DEMO = orig;
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(reportsDir, { recursive: true, force: true });
    }
  });

  test('with KLEBB_DEMO=1: wipes existing JSON, copies all fixtures', () => {
    const dir = tmpDir();
    const reportsDir = tmpDir();
    fs.writeFileSync(path.join(dir, 'stale.json'), '{"$schema":"x"}');
    fs.writeFileSync(path.join(dir, 'keep.txt'), 'not a manifest');
    const orig = process.env.KLEBB_DEMO;
    process.env.KLEBB_DEMO = '1';
    try {
      const today = new Date(2026, 4, 21);
      const result = resetDemo({ dataDir: dir, reportsDir, today });
      assert.equal(result.dataDir, dir);
      assert.ok(result.removed.includes('stale.json'), 'stale.json should be removed');
      assert.ok(result.written.length >= 8, 'should write at least 8 fixtures');
      // Non-JSON file is untouched.
      assert.ok(fs.existsSync(path.join(dir, 'keep.txt')), 'keep.txt should survive');
      // Every written fixture parses + validates.
      for (const name of result.written) {
        const parsed = readJson(path.join(dir, name));
        assert.doesNotThrow(() => validateManifestShape(parsed), `${name} should validate`);
      }
    } finally {
      if (orig === undefined) delete process.env.KLEBB_DEMO;
      else process.env.KLEBB_DEMO = orig;
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(reportsDir, { recursive: true, force: true });
    }
  });

  test('rewrites __OFFSET_DAYS:0__ to today', () => {
    const dir = tmpDir();
    const orig = process.env.KLEBB_DEMO;
    process.env.KLEBB_DEMO = '1';
    try {
      const today = new Date(2026, 4, 21);
      const expectedToday = '2026-05-21';
      copyFixtures({ dataDir: dir, today });
      // Pick the weight fixture; the last entry uses __OFFSET_DAYS:0__.
      const w = readJson(path.join(dir, 'weight.json'));
      const last = w.data[w.data.length - 1];
      assert.equal(last.date, expectedToday, 'last weight entry should be dated today');
    } finally {
      if (orig === undefined) delete process.env.KLEBB_DEMO;
      else process.env.KLEBB_DEMO = orig;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('written count matches the fixture count', () => {
    const dir = tmpDir();
    const reportsDir = tmpDir();
    const orig = process.env.KLEBB_DEMO;
    process.env.KLEBB_DEMO = '1';
    try {
      const result = resetDemo({ dataDir: dir, reportsDir });
      const fixtures = listFixtures(FIXTURES_DIR)
        .map(f => path.basename(f));
      assert.deepEqual(result.written.sort(), fixtures.sort());
    } finally {
      if (orig === undefined) delete process.env.KLEBB_DEMO;
      else process.env.KLEBB_DEMO = orig;
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(reportsDir, { recursive: true, force: true });
    }
  });
});

describe('reset-demo: report fixtures', () => {
  test('listReportFixtures returns the .md files only', () => {
    const files = listReportFixtures();
    assert.ok(files.length >= 4, `expected at least 4 report fixtures, found ${files.length}`);
    for (const f of files) {
      assert.ok(f.endsWith('.md'), `${f} should end with .md`);
    }
  });

  test('every report fixture has a markdown H1 after rewrite', () => {
    const today = new Date(2026, 4, 21);
    for (const file of listReportFixtures()) {
      const raw = fs.readFileSync(file, 'utf8');
      const resolved = rewritePlaceholders(raw, today);
      assert.ok(/^#\s+/m.test(resolved), `${path.basename(file)}: missing H1 heading`);
      assert.ok(!/__OFFSET_DAYS[:_]/.test(resolved), `${path.basename(file)}: placeholder leaked through`);
    }
  });

  test('copyReportFixtures resolves placeholders in filenames', () => {
    const reportsDir = tmpDir();
    try {
      const today = new Date(2026, 4, 21);
      const written = copyReportFixtures({ reportsDir, today });
      // No filename should still contain a placeholder.
      for (const name of written) {
        assert.ok(!/__OFFSET_DAYS[:_]/.test(name), `${name}: filename placeholder unresolved`);
      }
      // The bloods report should be dated 30 days before the supplied today.
      const bloods = written.find(n => n.startsWith('BLOODS-'));
      assert.ok(bloods, 'BLOODS-*.md should be written');
      assert.equal(bloods, 'BLOODS-2026-04-21.md');
    } finally {
      fs.rmSync(reportsDir, { recursive: true, force: true });
    }
  });

  test('copyReportFixtures rewrites placeholders inside file bodies', () => {
    const reportsDir = tmpDir();
    try {
      const today = new Date(2026, 4, 21);
      copyReportFixtures({ reportsDir, today });
      const bloods = fs.readFileSync(path.join(reportsDir, 'BLOODS-2026-04-21.md'), 'utf8');
      assert.ok(bloods.includes('Collected:'), 'should mention "Collected:"');
      assert.ok(!/__OFFSET_DAYS/.test(bloods), 'no placeholders should remain');
      assert.ok(bloods.includes('2026-04-21'), 'collected date should be resolved');
    } finally {
      fs.rmSync(reportsDir, { recursive: true, force: true });
    }
  });

  test('wipeReportsDir removes existing markdown but leaves other files alone', () => {
    const reportsDir = tmpDir();
    try {
      fs.writeFileSync(path.join(reportsDir, 'stale.md'), '# stale');
      fs.writeFileSync(path.join(reportsDir, 'keep.txt'), 'leave me');
      const removed = wipeReportsDir(reportsDir);
      assert.ok(removed.includes('stale.md'), 'stale.md should be removed');
      assert.ok(fs.existsSync(path.join(reportsDir, 'keep.txt')), 'keep.txt should survive');
      assert.ok(!fs.existsSync(path.join(reportsDir, 'stale.md')), 'stale.md should be gone');
    } finally {
      fs.rmSync(reportsDir, { recursive: true, force: true });
    }
  });

  test('resetDemo seeds reports/ alongside data/', () => {
    const dir = tmpDir();
    const reportsDir = tmpDir();
    fs.writeFileSync(path.join(reportsDir, 'old-debrief.md'), '# old');
    const orig = process.env.KLEBB_DEMO;
    process.env.KLEBB_DEMO = '1';
    try {
      const today = new Date(2026, 4, 21);
      const result = resetDemo({ dataDir: dir, reportsDir, today });
      assert.equal(result.reportsDir, reportsDir);
      assert.ok(result.reportsRemoved.includes('old-debrief.md'), 'pre-existing markdown should be wiped');
      assert.ok(result.reportsWritten.length >= 4, 'should seed at least 4 reports');
      // Genome overview has no placeholder, so the filename is verbatim.
      assert.ok(result.reportsWritten.includes('GENOME-overview.md'));
      // Each written report exists on disk.
      for (const name of result.reportsWritten) {
        const full = path.join(reportsDir, name);
        assert.ok(fs.existsSync(full), `${name} should exist after reset`);
        const body = fs.readFileSync(full, 'utf8');
        assert.ok(/^#\s+/m.test(body), `${name}: needs an H1`);
      }
    } finally {
      if (orig === undefined) delete process.env.KLEBB_DEMO;
      else process.env.KLEBB_DEMO = orig;
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(reportsDir, { recursive: true, force: true });
    }
  });
});
