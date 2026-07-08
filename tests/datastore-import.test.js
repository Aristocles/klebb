// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/datastore-import.test.js
// Unit tests for the import inbox: backup -> DB transaction -> file strip
// ordering, idempotent re-import after a simulated crash, backup naming the
// loader ignores, data:null vs absent-key distinction, and convergence
// (N files with data produce exactly N imports, then quiesce).

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { open } = require('../lib/datastore');
const { createImporter } = require('../lib/datastore/import');

let sqliteAvailable = true;
try { require('node:sqlite'); } catch { sqliteAvailable = false; }
const skip = sqliteAvailable ? false : 'node:sqlite unavailable on this Node';

// Mirrors manifests/registry.js BACKUP_NAME_RE ("two .json segments").
const BACKUP_NAME_RE = /\.json\.[^/\\]+\.json$/i;

let dir;
let store;
let importer;

function manifest(id, data) {
  const m = {
    $schema: 'klebb.datafile.v1',
    meta: { id, label: id, view: { component: 'generic-card' } },
    description: 'A test card.',
  };
  if (data !== undefined) m.data = data;
  return m;
}

function writeCard(name, content) {
  const file = path.join(dir, 'data', name);
  fs.writeFileSync(file, JSON.stringify(content, null, 2));
  return file;
}

function readCard(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function importFile(file) {
  return importer.importParsedFile(file, readCard(file));
}

beforeEach(() => {
  if (!sqliteAvailable) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eh-imp-'));
  fs.mkdirSync(path.join(dir, 'data'));
  store = open(path.join(dir, 'db', 'klebb.db'));
  store.load();
  importer = createImporter(store);
});

afterEach(() => {
  if (!sqliteAvailable) return;
  try { store.close(); } catch {}
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('import inbox: fresh import', { skip }, () => {
  test('imports the data block, strips the key, leaves a backup', () => {
    const rows = [{ date: '2026-05-01', mood: 3 }, { date: '2026-05-02', mood: 4 }];
    const file = writeCard('mood.json', manifest('mood', rows));

    const res = importFile(file);
    assert.strictEqual(res.imported, true);
    assert.strictEqual(res.id, 'mood');

    assert.deepStrictEqual(store.getData('mood'), rows);
    assert.strictEqual(store.hasData('mood'), true);

    const after = readCard(file);
    assert.ok(!('data' in after), 'data key stripped from file');
    assert.deepStrictEqual(after.meta, manifest('mood').meta, 'meta untouched');

    assert.ok(fs.existsSync(res.backup), 'backup exists');
    assert.deepStrictEqual(readCard(res.backup).data, rows, 'backup holds the original block');
  });

  test('file strip changes only the data key: order and formatting preserved', () => {
    const file = writeCard('mood.json', manifest('mood', [{ date: '2026-05-01', mood: 3 }]));
    const before = fs.readFileSync(file, 'utf8');
    importFile(file);
    const after = fs.readFileSync(file, 'utf8');
    const beforeParsed = JSON.parse(before);
    delete beforeParsed.data;
    assert.strictEqual(after, JSON.stringify(beforeParsed, null, 2), 'byte-identical minus data key');
    assert.deepStrictEqual(Object.keys(JSON.parse(after)), ['$schema', 'meta', 'description'], 'key order preserved');
  });

  test('backup filename matches the registry BACKUP_NAME_RE', () => {
    const file = writeCard('mood.json', manifest('mood', []));
    const { backup } = importFile(file);
    assert.match(path.basename(backup), BACKUP_NAME_RE, 'loader must keep ignoring it');
    assert.match(path.basename(backup), /^mood\.json\.pre-import-/);
  });

  test('a file with no data key is not an import candidate', () => {
    const file = writeCard('combo.json', manifest('combo'));
    const res = importFile(file);
    assert.strictEqual(res.imported, false);
    assert.strictEqual(store.dataUpdatedAt('combo'), null, 'no bookkeeping row created');
    assert.strictEqual(fs.readdirSync(path.join(dir, 'data')).length, 1, 'no backup written');
  });

  test('data: null imports as no-data: key stripped, null-ness recorded', () => {
    const file = writeCard('combo.json', manifest('combo', null));
    const res = importFile(file);
    assert.strictEqual(res.imported, true);
    assert.ok(!('data' in readCard(file)));
    assert.strictEqual(store.getData('combo'), null);
    assert.strictEqual(store.hasData('combo'), false);
    assert.ok(store.dataUpdatedAt('combo'), 'bookkeeping row records the null');
  });

  test('roster and doc shapes import intact', () => {
    const roster = { items: [{ name: 'BPC-157', doses: [{ scheduledDate: '2026-04-29', takenAt: null }] }], groups: [] };
    const fileA = writeCard('peptides.json', manifest('peptides', roster));
    importFile(fileA);
    assert.deepStrictEqual(store.getData('peptides'), roster);

    const doc = { markdown: '# Notes' };
    const fileB = writeCard('doc.json', manifest('doc', doc));
    importFile(fileB);
    assert.deepStrictEqual(store.getData('doc'), doc);
  });
});

describe('import inbox: crash-safe ordering', { skip }, () => {
  test('re-import after simulated crash (DB has rows, file still has data) is idempotent', () => {
    const rows = [{ date: '2026-05-01', mood: 3 }];
    const file = writeCard('mood.json', manifest('mood', rows));
    const original = fs.readFileSync(file, 'utf8');

    // Simulate: first import committed to DB but crashed before the file
    // rewrite landed. The file still carries its data key.
    importFile(file);
    fs.writeFileSync(file, original);

    const res = importFile(file);
    assert.strictEqual(res.imported, true, 'file with a data key is always an import candidate');
    assert.deepStrictEqual(store.getData('mood'), rows, 'full replace of the same value');
    assert.ok(!('data' in readCard(file)), 'strip completes this time');
  });

  test('a datastore throw leaves the file un-stripped (DB before file rewrite)', () => {
    // BigInt in a row: JSON.stringify throws inside setData, after the
    // backup copy but before the file rewrite.
    const file = writeCard('bad.json', manifest('bad', []));
    const withPoison = readCard(file);
    withPoison.data = [{ v: 1n }];

    assert.throws(() => importer.importParsedFile(file, withPoison), TypeError);
    assert.ok('data' in readCard(file), 'file untouched: still an import candidate next boot');
    assert.strictEqual(store.dataUpdatedAt('bad'), null, 'DB rolled back');
  });

  test('backup is written before the DB transaction', () => {
    const file = writeCard('bad.json', manifest('bad', []));
    const withPoison = readCard(file);
    withPoison.data = [{ v: 1n }];
    try { importer.importParsedFile(file, withPoison); } catch {}
    const backups = fs.readdirSync(path.join(dir, 'data')).filter(n => BACKUP_NAME_RE.test(n));
    assert.strictEqual(backups.length, 1, 'backup exists even though the import failed');
  });
});

describe('import inbox: convergence', { skip }, () => {
  test('N files with data produce exactly N imports, then quiesce', () => {
    const files = [];
    for (let i = 0; i < 5; i++) {
      files.push(writeCard(`card-${i}.json`, manifest(`card-${i}`, [{ date: '2026-01-01', v: i }])));
    }
    files.push(writeCard('meta-only.json', manifest('meta-only')));

    let imports = 0;
    for (const f of files) if (importFile(f).imported) imports++;
    assert.strictEqual(imports, 5, 'exactly N imports on first pass');

    // The follow-up reload (triggered by the rewrites themselves) finds no
    // data keys: zero imports, no new backups.
    const backupsBefore = fs.readdirSync(path.join(dir, 'data')).filter(n => BACKUP_NAME_RE.test(n)).length;
    let second = 0;
    for (const f of files) if (importFile(f).imported) second++;
    assert.strictEqual(second, 0, 'quiesced: stripped files are never candidates again');
    const backupsAfter = fs.readdirSync(path.join(dir, 'data')).filter(n => BACKUP_NAME_RE.test(n)).length;
    assert.strictEqual(backupsAfter, backupsBefore, 'no new backups on the quiescent pass');
  });

  test('double import of one card in a boot logs loudly', () => {
    const file = writeCard('mood.json', manifest('mood', [{ date: '2026-05-01', mood: 3 }]));
    const original = fs.readFileSync(file, 'utf8');
    const warnings = [];
    const realWarn = console.warn;
    console.warn = (...args) => { warnings.push(args.join(' ')); };
    try {
      importFile(file);
      fs.writeFileSync(file, original);
      importFile(file);
    } finally {
      console.warn = realWarn;
    }
    assert.ok(
      warnings.some(w => w.includes('importing twice in one boot')),
      `expected the double-import warning, got: ${JSON.stringify(warnings)}`,
    );
  });

  test('importer rejects a parsed value without meta.id', () => {
    assert.throws(() => importer.importParsedFile('x.json', { data: [] }), /meta\.id required/);
    assert.throws(() => importer.importParsedFile('x.json', null), /parsed manifest object required/);
  });
});
