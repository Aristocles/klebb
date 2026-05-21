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
  copyFixtures,
  FIXTURES_DIR,
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
    try {
      const orig = process.env.KLEBB_DEMO;
      delete process.env.KLEBB_DEMO;
      try {
        assert.throws(() => resetDemo({ dataDir: dir }), /KLEBB_DEMO=1/);
      } finally {
        if (orig !== undefined) process.env.KLEBB_DEMO = orig;
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('refuses to run when KLEBB_DEMO is set to something other than "1"', () => {
    const dir = tmpDir();
    try {
      const orig = process.env.KLEBB_DEMO;
      process.env.KLEBB_DEMO = 'true';
      try {
        assert.throws(() => resetDemo({ dataDir: dir }), /KLEBB_DEMO=1/);
      } finally {
        if (orig === undefined) delete process.env.KLEBB_DEMO;
        else process.env.KLEBB_DEMO = orig;
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('with KLEBB_DEMO=1: wipes existing JSON, copies all fixtures', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'stale.json'), '{"$schema":"x"}');
    fs.writeFileSync(path.join(dir, 'keep.txt'), 'not a manifest');
    const orig = process.env.KLEBB_DEMO;
    process.env.KLEBB_DEMO = '1';
    try {
      const today = new Date(2026, 4, 21);
      const result = resetDemo({ dataDir: dir, today });
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
    const orig = process.env.KLEBB_DEMO;
    process.env.KLEBB_DEMO = '1';
    try {
      const result = resetDemo({ dataDir: dir });
      const fixtures = listFixtures(FIXTURES_DIR)
        .map(f => path.basename(f));
      assert.deepEqual(result.written.sort(), fixtures.sort());
    } finally {
      if (orig === undefined) delete process.env.KLEBB_DEMO;
      else process.env.KLEBB_DEMO = orig;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
