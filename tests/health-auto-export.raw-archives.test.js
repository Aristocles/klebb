// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/health-auto-export.raw-archives.test.js
//
// The shared exclusion list behind the export's skips and the import
// wipe's spares (#656). Directories only (#672): the export's skip set is
// consulted for directories alone, so sparing a same-named FILE would make
// the two consumers disagree.

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { rawArchiveDirs } = require('../health-auto-export/raw-archives');

let dir;

describe('rawArchiveDirs', () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eh-raw-arch-'));
  });
  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  test('raw is returned whether or not it exists; migrated dirs by scan', () => {
    assert.deepStrictEqual(rawArchiveDirs(dir), [path.join(dir, 'raw')]);

    fs.mkdirSync(path.join(dir, 'raw.migrated-20260810T000000000Z'));
    fs.mkdirSync(path.join(dir, 'raw.migrated-20260901T000000000Z'));
    fs.mkdirSync(path.join(dir, 'unrelated'));
    const dirs = rawArchiveDirs(dir).sort();
    assert.deepStrictEqual(dirs, [
      path.join(dir, 'raw'),
      path.join(dir, 'raw.migrated-20260810T000000000Z'),
      path.join(dir, 'raw.migrated-20260901T000000000Z'),
    ].sort());
  });

  test('a FILE named raw.migrated-* is not an archive dir (#672)', () => {
    fs.writeFileSync(path.join(dir, 'raw.migrated-imposter'), '{}');
    assert.deepStrictEqual(rawArchiveDirs(dir), [path.join(dir, 'raw')]);
  });

  test('a missing auto-export dir yields just the fixed entry', () => {
    assert.deepStrictEqual(rawArchiveDirs(path.join(dir, 'absent')), [path.join(dir, 'absent', 'raw')]);
  });
});
