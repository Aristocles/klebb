// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/import-validate.test.js
// Unit tests for lib/import/validate.js: one test per finding code pinning
// the exact message, the target-freshness legs (factory-fresh passes,
// orphaned datastore rows and HAE pushes refuse), and the happy-tree plan.

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { validateTree } = require('../lib/import/validate');

let sqliteAvailable = true;
try { require('node:sqlite'); } catch { sqliteAvailable = false; }
const skipDb = sqliteAvailable ? false : 'node:sqlite unavailable on this Node';

const MANIFEST_NAME = 'klebb-export.json';

const cleanup = [];
afterEach(() => {
  while (cleanup.length) {
    try { fs.rmSync(cleanup.pop(), { recursive: true, force: true }); } catch {}
  }
});

function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanup.push(dir);
  return dir;
}

function sha256Hex(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function cardBody(id, extra = {}) {
  return { $schema: 'klebb.datafile.v1', meta: { id, label: id }, ...extra };
}

function rowsOf(value) {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') {
    let n = 0;
    for (const v of Object.values(value)) if (Array.isArray(v)) n += v.length;
    return n;
  }
  return 0;
}

// Build an export tree the way scripts/export-embed.js would: card files
// under data/, samples under data/auto-export/, reports/, config.json, and a
// klebb-export.json inventory over everything, written last. Card bodies
// given as raw strings are written verbatim and never inventoried (they
// stand in for hand-added junk).
function makeTree(spec = {}) {
  const root = tmpDir('eh-val-');
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  const inv = { cards: [], reports: [], other: [] };
  let samplesEntry = null;

  for (const [name, body] of Object.entries(spec.cards || {})) {
    const bytes = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
    fs.writeFileSync(path.join(root, 'data', name), bytes);
    if (typeof body === 'string') continue;
    const dataState = !Object.prototype.hasOwnProperty.call(body, 'data') ? 'none'
      : body.data === null ? 'null' : 'embedded';
    inv.cards.push({
      id: body.meta && body.meta.id,
      file: `data/${name}`,
      data: dataState,
      rows: rowsOf(body.data),
      sha256: sha256Hex(bytes),
    });
  }

  if (spec.samples !== undefined) {
    const file = path.join(root, 'data', 'auto-export', 'samples.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const bytes = typeof spec.samples === 'string'
      ? spec.samples : JSON.stringify(spec.samples, null, 2);
    fs.writeFileSync(file, bytes);
    const pushes = (spec.samples && Array.isArray(spec.samples.pushes))
      ? spec.samples.pushes.length : 0;
    samplesEntry = { file: 'data/auto-export/samples.json', pushes, sha256: sha256Hex(bytes) };
  }

  for (const [name, content] of Object.entries(spec.reports || {})) {
    const file = path.join(root, 'reports', name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    inv.reports.push({
      file: `reports/${name}`, bytes: Buffer.byteLength(content), sha256: sha256Hex(content),
    });
  }

  if (spec.config !== undefined) {
    const bytes = typeof spec.config === 'string'
      ? spec.config : JSON.stringify(spec.config, null, 2);
    fs.writeFileSync(path.join(root, 'config.json'), bytes);
    inv.other.push({ file: 'config.json', sha256: sha256Hex(bytes) });
  }

  for (const [rel, content] of Object.entries(spec.extra || {})) {
    const file = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }

  if (spec.manifest !== false) {
    let m = {
      format: 'klebb.export.v1',
      formatVersion: 1,
      appVersion: '0.0.0',
      exportedAt: '2026-08-17T00:00:00.000Z',
      inventory: {
        cards: inv.cards,
        ...(samplesEntry ? { samples: samplesEntry } : {}),
        reports: inv.reports,
        other: inv.other,
      },
    };
    if (spec.mutateManifest) m = spec.mutateManifest(m) || m;
    fs.writeFileSync(path.join(root, MANIFEST_NAME),
      typeof m === 'string' ? m : JSON.stringify(m, null, 2));
  }
  return root;
}

function happyTree() {
  return makeTree({
    cards: {
      'a.json': cardBody('a', { data: [{ date: '2026-01-01', kg: 80 }] }),
      'b.json': cardBody('b'),
      'c.json': cardBody('c', { data: null }),
    },
    samples: {
      version: 1,
      pushes: [
        { receivedAt: '2026-01-01T00:00:00.000Z', payload: { data: {} } },
        { receivedAt: '2026-01-02T00:00:00.000Z', payload: { data: {} } },
      ],
    },
    reports: { 'bloods.md': '# Bloods\n' },
    config: { instance: { name: 'Klebb' } },
  });
}

function byCode(res, code) {
  return res.findings.filter(f => f.code === code);
}

function one(res, code) {
  const found = byCode(res, code);
  assert.strictEqual(found.length, 1,
    `expected exactly one ${code}, got ${found.length}: ${JSON.stringify(res.findings)}`);
  return found[0];
}

function sumTreeBytes(root, rel = '') {
  const abs = rel ? path.join(root, rel) : root;
  let total = 0;
  for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
    const childRel = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) total += sumTreeBytes(root, childRel);
    else if (ent.isFile()) total += fs.statSync(path.join(root, childRel)).size;
  }
  return total;
}

describe('validateTree: tree gates', () => {
  test('VAL_NO_DATA_DIR: refuses a tree without data/', () => {
    const root = tmpDir('eh-val-');
    const res = validateTree(root);
    const f = one(res, 'VAL_NO_DATA_DIR');
    assert.strictEqual(f.message, 'archive has no data/ directory; not a Klebb export tree');
    assert.strictEqual(f.severity, 'refusal');
    assert.strictEqual(f.scope, 'tree');
    assert.strictEqual(f.phase, 'validate');
    assert.strictEqual(res.ok, false);
  });

  test('VAL_NO_MANIFEST: absent, unparseable, and wrong-format manifests all refuse', () => {
    const message = 'no klebb-export.json manifest: not a Klebb export tree, or an incomplete one; re-export from the source instance';

    const absent = makeTree({ cards: { 'a.json': cardBody('a') }, manifest: false });
    let f = one(validateTree(absent), 'VAL_NO_MANIFEST');
    assert.strictEqual(f.message, message);
    assert.strictEqual(f.severity, 'refusal');
    assert.strictEqual(f.scope, 'tree');

    const unparseable = makeTree({ cards: { 'a.json': cardBody('a') }, manifest: false });
    fs.writeFileSync(path.join(unparseable, MANIFEST_NAME), '{ not json');
    f = one(validateTree(unparseable), 'VAL_NO_MANIFEST');
    assert.strictEqual(f.message, message);

    const wrongFormat = makeTree({
      cards: { 'a.json': cardBody('a') },
      mutateManifest: m => ({ ...m, format: 'klebb.zip.v9' }),
    });
    f = one(validateTree(wrongFormat), 'VAL_NO_MANIFEST');
    assert.strictEqual(f.message, message);
  });

  test('VAL_FORMAT_NEWER: names both versions', () => {
    const root = makeTree({
      cards: { 'a.json': cardBody('a') },
      mutateManifest: m => ({ ...m, formatVersion: 2 }),
    });
    const res = validateTree(root);
    const f = one(res, 'VAL_FORMAT_NEWER');
    assert.strictEqual(f.message,
      'archive format v2 is newer than this instance supports (v1); update the instance or re-export from a matching version');
    assert.strictEqual(f.severity, 'refusal');
    assert.strictEqual(res.ok, false);
    // A newer inventory may mean something else: no reconciliation against it.
    assert.strictEqual(byCode(res, 'VAL_INVENTORY_EXTRA').length, 0);
  });
});

describe('validateTree: card checks', () => {
  test('VAL_BAD_JSON: unparseable card file refuses', () => {
    const root = makeTree({ cards: { 'a.json': cardBody('a'), 'bad.json': '{ nope' } });
    const res = validateTree(root);
    const f = one(res, 'VAL_BAD_JSON');
    assert.strictEqual(f.message, 'card file is not valid JSON');
    assert.strictEqual(f.severity, 'refusal');
    assert.strictEqual(f.scope, 'card');
    assert.strictEqual(f.ref, 'data/bad.json');
  });

  test('VAL_BAD_CARD: manifest-shape failure refuses with the registry message', () => {
    const root = makeTree({
      cards: { 'x.json': { $schema: 'klebb.datafile.v1', meta: { id: 'x' } } },
    });
    const f = one(validateTree(root), 'VAL_BAD_CARD');
    assert.strictEqual(f.message, 'not a valid card manifest: missing meta.label');
    assert.strictEqual(f.severity, 'refusal');
    assert.strictEqual(f.ref, 'data/x.json');
  });

  test('VAL_SCHEMA_UNSUPPORTED: unknown $schema refuses', () => {
    const root = makeTree({
      cards: { 'x.json': { $schema: 'klebb.datafile.v2', meta: { id: 'x', label: 'x' } } },
    });
    const f = one(validateTree(root), 'VAL_SCHEMA_UNSUPPORTED');
    assert.strictEqual(f.message,
      'unsupported $schema "klebb.datafile.v2"; this instance supports klebb.datafile.v1');
    assert.strictEqual(f.severity, 'refusal');
  });

  test('VAL_DUP_ID: names both files; only the first reaches the plan', () => {
    const root = makeTree({
      cards: { 'a.json': cardBody('same'), 'b.json': cardBody('same') },
    });
    const res = validateTree(root);
    const f = one(res, 'VAL_DUP_ID');
    assert.strictEqual(f.message,
      'duplicate meta.id "same": data/a.json and data/b.json both declare it; the second would never load or import');
    assert.strictEqual(f.severity, 'refusal');
    assert.strictEqual(f.ref, 'data/b.json');
    assert.deepStrictEqual(res.plan.cards,
      [{ id: 'same', file: 'data/a.json', data: 'none', label: 'same', rows: 0, hae: false }]);
  });

  test('legacy files without a $schema are inert data, not cards', () => {
    const root = makeTree({
      cards: { 'a.json': cardBody('a') },
      extra: { 'data/legacy.json': JSON.stringify({ rows: [1, 2] }) },
    });
    const res = validateTree(root);
    assert.strictEqual(byCode(res, 'VAL_BAD_CARD').length, 0);
    assert.deepStrictEqual(res.plan.cards,
      [{ id: 'a', file: 'data/a.json', data: 'none', label: 'a', rows: 0, hae: false }]);
  });
});

describe('validateTree: hostile content', () => {
  test('VAL_FORBIDDEN_FILE: legacy WebAuthn names refuse at any depth under data/', () => {
    const root = makeTree({
      cards: { 'a.json': cardBody('a') },
      extra: {
        'data/webauthn-credentials.json': '[]',
        'data/nested/webauthn-sessions.json': '{}',
      },
    });
    const res = validateTree(root);
    const found = byCode(res, 'VAL_FORBIDDEN_FILE');
    assert.strictEqual(found.length, 2);
    const creds = found.find(f => f.ref === 'data/webauthn-credentials.json');
    assert.strictEqual(creds.message,
      "webauthn-credentials.json would override this instance's credentials (the loader prefers the legacy location when present) and is never part of an export");
    const sess = found.find(f => f.ref === 'data/nested/webauthn-sessions.json');
    assert.strictEqual(sess.message,
      "webauthn-sessions.json would override this instance's credentials (the loader prefers the legacy location when present) and is never part of an export");
    assert.strictEqual(res.ok, false);
  });

  test('VAL_SYMLINK: any symlink in the tree refuses', () => {
    const root = makeTree({ cards: { 'a.json': cardBody('a') } });
    fs.mkdirSync(path.join(root, 'linktarget'));
    // A junction on Windows, a directory symlink elsewhere; both read back
    // as symlinks through withFileTypes.
    fs.symlinkSync(path.join(root, 'linktarget'), path.join(root, 'data', 'link'), 'junction');
    const res = validateTree(root);
    const f = one(res, 'VAL_SYMLINK');
    assert.strictEqual(f.message, 'symlink in the archive; an export tree never contains symlinks');
    assert.strictEqual(f.severity, 'refusal');
    assert.strictEqual(f.scope, 'file');
    assert.strictEqual(f.ref, 'data/link');
  });
});

describe('validateTree: caps', () => {
  test('VAL_CAP: file count', () => {
    const root = makeTree({ cards: { 'a.json': cardBody('a') } });
    const res = validateTree(root, { caps: { maxFiles: 1 } });
    const f = one(res, 'VAL_CAP');
    assert.strictEqual(f.message, 'tree has 2 files; the cap is 1 (KLEBB_IMPORT_MAX_FILES)');
    assert.strictEqual(f.severity, 'refusal');
    assert.strictEqual(f.scope, 'tree');
  });

  test('VAL_CAP: tree size', () => {
    const root = makeTree({
      cards: { 'a.json': cardBody('a') },
      extra: { 'data/blob.bin': 'x'.repeat(1048577) },
    });
    const total = sumTreeBytes(root);
    const res = validateTree(root, { caps: { maxTreeMB: 1, maxFileMB: 64 } });
    const found = byCode(res, 'VAL_CAP');
    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0].message,
      `tree is ${total} bytes; the cap is 1 MB (KLEBB_IMPORT_MAX_TREE_MB)`);
  });

  test('VAL_CAP: per-file size', () => {
    const root = makeTree({
      cards: { 'a.json': cardBody('a') },
      extra: { 'data/blob.bin': 'x'.repeat(1048577) },
    });
    const res = validateTree(root, { caps: { maxFileMB: 1 } });
    const f = one(res, 'VAL_CAP');
    assert.strictEqual(f.message,
      'file is 1048577 bytes; the per-file cap is 1 MB (KLEBB_IMPORT_MAX_FILE_MB)');
    assert.strictEqual(f.ref, 'data/blob.bin');
  });

  test('VAL_CAP: rows per card', () => {
    const root = makeTree({
      cards: { 'a.json': cardBody('a', { data: [{ n: 1 }, { n: 2 }, { n: 3 }] }) },
    });
    const res = validateTree(root, { caps: { maxRowsPerCard: 2 } });
    const f = one(res, 'VAL_CAP');
    assert.strictEqual(f.message,
      'card has 3 data rows; the cap is 2 (KLEBB_IMPORT_MAX_ROWS_PER_CARD)');
    assert.strictEqual(f.scope, 'card');
  });

  test('VAL_CAP: samples pushes', () => {
    const root = makeTree({
      cards: { 'a.json': cardBody('a') },
      samples: {
        version: 1,
        pushes: [{ payload: { data: {} } }, { payload: { data: {} } }],
      },
    });
    const res = validateTree(root, { caps: { maxPushes: 1 } });
    const f = one(res, 'VAL_CAP');
    assert.strictEqual(f.message,
      'samples.json has 2 pushes; the cap is 1 (KLEBB_IMPORT_MAX_PUSHES)');
    assert.strictEqual(f.scope, 'samples');
  });
});

describe('validateTree: round trip', () => {
  test('VAL_ROUNDTRIP: refuses card data the datastore kernel would corrupt', () => {
    // The kernel is lossless for every JSON value, so the guard is
    // exercised by sabotaging reconstruct for a fresh copy of the module.
    const shapePath = require.resolve('../lib/datastore/shape.js');
    const validatePath = require.resolve('../lib/import/validate.js');
    const realExports = require.cache[shapePath].exports;
    delete require.cache[validatePath];
    require.cache[shapePath].exports = { ...realExports, reconstruct: () => ({ sabotaged: true }) };
    try {
      const { validateTree: patched } = require(validatePath);
      const root = makeTree({
        cards: { 'a.json': cardBody('a', { data: [{ date: '2026-01-01', kg: 80 }] }) },
      });
      const res = patched(root);
      const f = one(res, 'VAL_ROUNDTRIP');
      assert.strictEqual(f.message,
        'card data does not survive the datastore decompose/reconstruct round trip; the store would corrupt it');
      assert.strictEqual(f.severity, 'refusal');
      assert.strictEqual(res.ok, false);
      assert.deepStrictEqual(res.plan.cards, []);
    } finally {
      require.cache[shapePath].exports = realExports;
      delete require.cache[validatePath];
    }
  });

  test('numeric edge cases do not false-refuse: -0 survives JSON normalisation', () => {
    const root = makeTree({
      cards: { 'a.json': cardBody('a', { data: [{ date: '2026-01-01', delta: -0 }] }) },
    });
    const res = validateTree(root);
    assert.strictEqual(byCode(res, 'VAL_ROUNDTRIP').length, 0);
    assert.strictEqual(res.ok, true);
  });
});

describe('validateTree: samples', () => {
  test('VAL_SAMPLES_SHAPE: pushes not an array, or version not 1, refuses', () => {
    const message = 'samples.json is not a valid HAE history file; expected an object with a pushes array';

    const noPushes = makeTree({ cards: { 'a.json': cardBody('a') }, samples: { version: 1 } });
    let f = one(validateTree(noPushes), 'VAL_SAMPLES_SHAPE');
    assert.strictEqual(f.message, message);
    assert.strictEqual(f.severity, 'refusal');
    assert.strictEqual(f.scope, 'samples');
    assert.strictEqual(f.ref, 'data/auto-export/samples.json');

    const badVersion = makeTree({
      cards: { 'a.json': cardBody('a') },
      samples: { version: 2, pushes: [] },
    });
    f = one(validateTree(badVersion), 'VAL_SAMPLES_SHAPE');
    assert.strictEqual(f.message, message);
  });

  test('VAL_SAMPLES_EMPTY_PUSH: warns with the count; plan skips them', () => {
    const root = makeTree({
      cards: { 'a.json': cardBody('a') },
      samples: {
        version: 1,
        pushes: [
          { receivedAt: '2026-01-01T00:00:00.000Z', payload: { data: {} } },
          { receivedAt: '2026-01-02T00:00:00.000Z' },
          null,
        ],
      },
    });
    const res = validateTree(root);
    const f = one(res, 'VAL_SAMPLES_EMPTY_PUSH');
    assert.strictEqual(f.message, '2 push(es) have no payload and will be skipped at import');
    assert.strictEqual(f.severity, 'warning');
    assert.strictEqual(res.plan.samplesPushes, 1);
    assert.strictEqual(res.ok, true);
  });
});

describe('validateTree: inventory reconciliation', () => {
  test('VAL_INVENTORY_MISSING: inventoried file absent from the tree refuses', () => {
    const root = makeTree({
      cards: { 'a.json': cardBody('a') },
      mutateManifest: (m) => {
        m.inventory.other.push({ file: 'data/ghost.json', sha256: 'ab'.repeat(32) });
        return m;
      },
    });
    const res = validateTree(root);
    const f = one(res, 'VAL_INVENTORY_MISSING');
    assert.strictEqual(f.message,
      'listed in klebb-export.json but missing from the tree; the archive is incomplete');
    assert.strictEqual(f.severity, 'refusal');
    assert.strictEqual(f.ref, 'data/ghost.json');
  });

  test('VAL_INVENTORY_EXTRA: uninventoried tree file warns only', () => {
    const root = makeTree({
      cards: { 'a.json': cardBody('a') },
      extra: { 'data/notes.txt': 'hand-added\n' },
    });
    const res = validateTree(root);
    const f = one(res, 'VAL_INVENTORY_EXTRA');
    assert.strictEqual(f.message, 'not listed in klebb-export.json; it will be imported as found');
    assert.strictEqual(f.severity, 'warning');
    assert.strictEqual(f.ref, 'data/notes.txt');
    assert.strictEqual(res.ok, true);
  });

  test('VAL_CHECKSUM: hand-edited file warns only', () => {
    const root = makeTree({ cards: { 'a.json': cardBody('a') } });
    fs.writeFileSync(path.join(root, 'data', 'a.json'),
      JSON.stringify(cardBody('a', { description: 'edited by hand' }), null, 2));
    const res = validateTree(root);
    const f = one(res, 'VAL_CHECKSUM');
    assert.strictEqual(f.message,
      'checksum does not match klebb-export.json; the file was changed after export (hand edits are supported)');
    assert.strictEqual(f.severity, 'warning');
    assert.strictEqual(f.ref, 'data/a.json');
    assert.strictEqual(res.ok, true);
  });

  test('VAL_STRAY_BACKUP: backup and tmp strays warn and stay out of everything else', () => {
    const root = makeTree({
      cards: { 'a.json': cardBody('a') },
      extra: {
        'data/welcome.json.pre-import-20260817T000000000Z.json': '{}',
        'data/a.json.tmp': '{',
      },
    });
    const res = validateTree(root);
    const found = byCode(res, 'VAL_STRAY_BACKUP');
    assert.strictEqual(found.length, 2);
    for (const f of found) {
      assert.strictEqual(f.message, 'backup or tmp file; it will be skipped at import');
      assert.strictEqual(f.severity, 'warning');
    }
    assert.strictEqual(byCode(res, 'VAL_INVENTORY_EXTRA').length, 0);
    assert.strictEqual(byCode(res, 'VAL_BAD_JSON').length, 0);
    assert.strictEqual(res.ok, true);
  });
});

describe('validateTree: config', () => {
  test('VAL_CONFIG_SECRETS: hae.token or auth.invites warns', () => {
    const withToken = makeTree({
      cards: { 'a.json': cardBody('a') },
      config: { hae: { token: 'shh' } },
    });
    let f = one(validateTree(withToken), 'VAL_CONFIG_SECRETS');
    assert.strictEqual(f.message,
      'config.json carries secrets (hae.token or auth.invites); they will be imported verbatim');
    assert.strictEqual(f.severity, 'warning');
    assert.strictEqual(f.scope, 'config');

    const withInvites = makeTree({
      cards: { 'a.json': cardBody('a') },
      config: { auth: { invites: [{ code: 'shh' }] } },
    });
    f = one(validateTree(withInvites), 'VAL_CONFIG_SECRETS');
    assert.strictEqual(f.severity, 'warning');
  });

  test('VAL_CONFIG_INVALID: unparseable config warns and plans none', () => {
    const root = makeTree({ cards: { 'a.json': cardBody('a') }, config: '{ nope' });
    const res = validateTree(root);
    const f = one(res, 'VAL_CONFIG_INVALID');
    assert.strictEqual(f.message, 'config.json is not valid JSON and will not be imported');
    assert.strictEqual(f.severity, 'warning');
    assert.strictEqual(res.plan.config, 'none');
    assert.strictEqual(res.ok, true);
  });
});

describe('validateTree: target freshness', { skip: skipDb }, () => {
  function makeTarget() {
    const home = tmpDir('eh-tgt-');
    fs.mkdirSync(path.join(home, 'data'), { recursive: true });
    return home;
  }

  function seedWelcome(home) {
    const welcome = JSON.stringify(cardBody('welcome'), null, 2);
    fs.writeFileSync(path.join(home, 'data', 'welcome.klebb.json'), welcome);
    fs.writeFileSync(
      path.join(home, 'data', 'welcome.klebb.json.pre-import-20260817T000000000Z.json'),
      welcome);
  }

  test('factory-fresh target (welcome card + its import backup) is fresh', () => {
    const home = makeTarget();
    seedWelcome(home);
    fs.writeFileSync(path.join(home, 'config.json'), '{}');
    const res = validateTree(happyTree(), { targetHome: home });
    assert.strictEqual(byCode(res, 'VAL_TARGET_NOT_FRESH').length, 0);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.plan.config, 'keep-existing');
  });

  test('non-welcome card file in data/ is not fresh', () => {
    const home = makeTarget();
    seedWelcome(home);
    fs.writeFileSync(path.join(home, 'data', 'mood.json'),
      JSON.stringify(cardBody('mood'), null, 2));
    const res = validateTree(happyTree(), { targetHome: home });
    const f = one(res, 'VAL_TARGET_NOT_FRESH');
    assert.strictEqual(f.message,
      'target instance is not fresh: 1 non-welcome card file(s) in data/; import only writes into a fresh instance');
    assert.strictEqual(f.severity, 'refusal');
    assert.strictEqual(f.scope, 'target');
    assert.strictEqual(res.ok, false);
  });

  test('orphaned datastore rows (row without a file) are not fresh; welcome row is fine', () => {
    const home = makeTarget();
    seedWelcome(home);
    const { open } = require('../lib/datastore');
    const store = open(path.join(home, 'db', 'klebb.db'));
    store.load();
    store.setData('welcome', [{ note: 'hi' }]);
    store.setData('mood', [{ date: '2026-01-01', mood: 3 }]);
    store.close();
    const f = one(validateTree(happyTree(), { targetHome: home }), 'VAL_TARGET_NOT_FRESH');
    assert.strictEqual(f.message,
      'target instance is not fresh: 1 non-welcome card(s) in the datastore; import only writes into a fresh instance');
  });

  test('HAE pushes alone are not fresh', () => {
    const home = makeTarget();
    seedWelcome(home);
    const { DatabaseSync } = require('node:sqlite');
    fs.mkdirSync(path.join(home, 'db'), { recursive: true });
    const db = new DatabaseSync(path.join(home, 'db', 'klebb.db'));
    db.exec(`CREATE TABLE hae_pushes (
      push_seq INTEGER PRIMARY KEY AUTOINCREMENT,
      received_at TEXT NOT NULL,
      source_file TEXT UNIQUE
    );`);
    db.prepare('INSERT INTO hae_pushes (received_at, source_file) VALUES (?, ?)')
      .run('2026-01-01T00:00:00.000Z', null);
    db.close();
    const f = one(validateTree(happyTree(), { targetHome: home }), 'VAL_TARGET_NOT_FRESH');
    assert.strictEqual(f.message,
      'target instance is not fresh: 1 HAE push(es) recorded; import only writes into a fresh instance');
  });

  test('empty target home passes trivially', () => {
    const home = tmpDir('eh-tgt-');
    const res = validateTree(happyTree(), { targetHome: home });
    assert.strictEqual(byCode(res, 'VAL_TARGET_NOT_FRESH').length, 0);
    assert.strictEqual(res.ok, true);
  });
});

describe('validateTree: happy tree', () => {
  test('ok:true with zero findings and a correct plan', () => {
    const res = validateTree(happyTree());
    assert.deepStrictEqual(res.findings, []);
    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(res.plan, {
      cards: [
        { id: 'a', file: 'data/a.json', data: 'embedded', label: 'a', rows: 1, hae: false },
        { id: 'b', file: 'data/b.json', data: 'none', label: 'b', rows: 0, hae: false },
        { id: 'c', file: 'data/c.json', data: 'null', label: 'c', rows: 0, hae: false },
      ],
      samplesPushes: 2,
      reports: ['reports/bloods.md'],
      config: 'write',
    });
  });
});
