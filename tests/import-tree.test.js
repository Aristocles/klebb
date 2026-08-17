// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/import-tree.test.js
// The import CLI (scripts/import-tree.js) + apply engine (lib/import/apply.js):
// dry-run prints the plan and writes nothing, a non-fresh target refuses
// naming all three legs, a real exported tree round-trips whole (cards
// deep-equal through the datastore, HAE pushes imported once, reports
// byte-identical, seeded welcome card gone), the samples inbox cannot
// double-import on the next boot, config keep-existing is honoured, a crash
// between copy and import converges on the next boot with no double rows,
// a verify mismatch reports partial and keeps the backups, and a held
// datastore refuses with APPLY_DB_BUSY before any write.
//
// No spawnServer here on purpose: applyTree fresh-requires the samples
// chain in-process, and boot-style imports run as subprocesses instead.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createSandbox, cleanupSandbox, REPO_ROOT } = require('./helpers/sandbox');

process.env.HEALTH_HOME_WARNED = '1';

const CLI = path.join(REPO_ROOT, 'scripts', 'import-tree.js');
const EXPORT = path.join(REPO_ROOT, 'scripts', 'export-embed.js');
const WELCOME_FIXTURE = path.join(REPO_ROOT, 'server', 'first-boot', 'welcome.klebb.json');

let sqliteAvailable = true;
try { require('node:sqlite'); } catch { sqliteAvailable = false; }
const skip = sqliteAvailable ? false : 'node:sqlite unavailable on this Node';

const EMBEDDED_ROWS = [{ date: '2026-01-01', kg: 80 }, { date: '2026-01-02', kg: 79.5 }];
const INLINE_ROWS = [{ date: '2026-05-01', note: 'pre-migration' }];
const REPORT_BODY = '# Bloods\n\nAll fine.\n';
const CONFIG_BODY = { display: { theme: 'dark' } };

function card(id, extra = {}) {
  return { $schema: 'klebb.datafile.v1', meta: { id, label: id }, ...extra };
}

function runNode(args, env = {}) {
  const r = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    cwd: REPO_ROOT,
    env: { ...process.env, HEALTH_HOME_WARNED: '1', ...env },
  });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '', out: (r.stdout || '') + (r.stderr || '') };
}

function runImport(args, env = {}) {
  return runNode([CLI, ...args], env);
}

function seedHaePushes(home) {
  const script = `
    const samples = require(${JSON.stringify(path.join(REPO_ROOT, 'health-auto-export', 'samples.js'))});
    samples.recordPush({ data: { metrics: [{ name: 'step_count', units: 'count', data: [{ date: '2026-05-01', qty: 4100 }] }] } },
      { receivedAt: '2026-05-01T00:00:00.000Z' });
    samples.recordPush({ data: { metrics: [{ name: 'step_count', units: 'count', data: [{ date: '2026-05-02', qty: 5200 }] }] } },
      { receivedAt: '2026-05-02T00:00:00.000Z' });
    samples.close();
  `;
  const r = runNode(['-e', script], { HEALTH_HOME: home });
  assert.strictEqual(r.code, 0, r.out);
}

const tmp = [];
function freshHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eh-import-tgt-'));
  tmp.push(home);
  fs.mkdirSync(path.join(home, 'data'), { recursive: true });
  return home;
}

// A factory-fresh instance after one boot: the welcome file on disk and its
// (empty-object) data recorded in the datastore.
function seedWelcome(home) {
  fs.copyFileSync(WELCOME_FIXTURE, path.join(home, 'data', 'welcome.klebb.json'));
  const { open } = require('../lib/datastore');
  const store = open(path.join(home, 'db', 'klebb.db'));
  store.load();
  store.setData('welcome', {});
  store.close();
}

function withStore(home, fn) {
  const { open } = require('../lib/datastore');
  const store = open(path.join(home, 'db', 'klebb.db'));
  store.load();
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

function countSql(home, sql) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(home, 'db', 'klebb.db'));
  try {
    return Number(db.prepare(sql).get().n);
  } catch {
    return 0;
  } finally {
    db.close();
  }
}

function pushCountOf(home) {
  return countSql(home, 'SELECT COUNT(*) AS n FROM hae_pushes');
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function norm(value) {
  return JSON.parse(JSON.stringify(value));
}

function preImportBackups(home) {
  return fs.readdirSync(path.join(home, 'data')).filter(n => n.includes('.pre-import-'));
}

describe('import-tree', { skip }, () => {
  let src;
  let tree;

  before(() => {
    src = createSandbox({
      seed: {
        'embedded.json': card('embedded'),
        'nulldata.json': card('nulldata'),
        'nodata.json': card('nodata'),
        'inline.json': card('inline', { data: INLINE_ROWS }),
      },
    });
    fs.writeFileSync(path.join(src, 'config.json'), JSON.stringify(CONFIG_BODY, null, 2));
    fs.writeFileSync(path.join(src, 'reports', 'bloods.md'), REPORT_BODY);
    withStore(src, (store) => {
      store.setData('embedded', EMBEDDED_ROWS);
      store.setData('nulldata', null);
    });
    seedHaePushes(src);

    tree = fs.mkdtempSync(path.join(os.tmpdir(), 'eh-import-tree-'));
    fs.rmdirSync(tree);
    const r = runNode([EXPORT, tree], { HEALTH_HOME: src });
    assert.strictEqual(r.code, 0, r.out);
  });

  after(() => {
    cleanupSandbox(src);
    try { fs.rmSync(tree, { recursive: true, force: true }); } catch {}
    while (tmp.length) {
      try { fs.rmSync(tmp.pop(), { recursive: true, force: true }); } catch {}
    }
  });

  describe('dry run', () => {
    test('good tree exits 0, prints the plan, writes nothing', () => {
      const home = freshHome();
      const r = runImport([tree, '--target', home]);
      assert.strictEqual(r.code, 0, r.out);
      assert.match(r.stdout, /Dry run/);
      assert.match(r.stdout, /embedded {2}data\/embedded\.json {2}data: embedded/);
      assert.match(r.stdout, /inline {2}data\/inline\.json {2}data: inline/);
      assert.match(r.stdout, /nodata {2}data\/nodata\.json {2}data: none/);
      assert.match(r.stdout, /nulldata {2}data\/nulldata\.json {2}data: null/);
      assert.match(r.stdout, /HAE pushes to import: 2/);
      assert.match(r.stdout, /reports to copy: 1/);
      assert.match(r.stdout, /config: write/);
      assert.ok(!fs.existsSync(path.join(home, 'klebb-export.json')), 'dry run wrote the manifest');
      assert.deepStrictEqual(fs.readdirSync(path.join(home, 'data')), [], 'dry run wrote into data/');
      assert.ok(!fs.existsSync(path.join(home, 'db')), 'dry run created db/');
    });

    test('non-fresh target exits 1 naming all three legs', () => {
      const home = freshHome();
      fs.writeFileSync(path.join(home, 'data', 'mood.json'),
        JSON.stringify(card('mood'), null, 2));
      withStore(home, store => store.setData('mood', [{ date: '2026-01-01', mood: 3 }]));
      seedHaePushes(home);
      const r = runImport([tree, '--target', home]);
      assert.strictEqual(r.code, 1, r.out);
      assert.match(r.out, /VAL_TARGET_NOT_FRESH/);
      assert.match(r.out, /1 non-welcome card file\(s\) in data\//);
      assert.match(r.out, /1 non-welcome card\(s\) in the datastore/);
      assert.match(r.out, /2 HAE push\(es\) recorded/);
      assert.match(r.out, /Refused/);
    });

    test('usage errors exit 2', () => {
      assert.strictEqual(runImport([]).code, 2);
      assert.strictEqual(runImport(['--bogus', tree]).code, 2);
    });
  });

  describe('full apply round trip', () => {
    let home;
    let applied;
    const DECOY = 'decoy.json.pre-import-20260101T000000000Z.json';

    before(() => {
      home = freshHome();
      seedWelcome(home);
      fs.writeFileSync(path.join(home, 'data', DECOY), '{}');
      applied = runImport([tree, '--apply', '--target', home]);
    });

    test('exits 0 with status ok and the verified counts', () => {
      assert.strictEqual(applied.code, 0, applied.out);
      assert.match(applied.stdout, /status: ok/);
      assert.match(applied.stdout, /verified: 4 card\(s\), 2 HAE push\(es\), 1 report\(s\)/);
    });

    test('every card deep-equals through the datastore; files are stripped', () => {
      withStore(home, (store) => {
        assert.deepStrictEqual(norm(store.getData('embedded')), norm(EMBEDDED_ROWS));
        assert.deepStrictEqual(norm(store.getData('inline')), norm(INLINE_ROWS));
        assert.notStrictEqual(store.dataUpdatedAt('nulldata'), null, 'null data was not recorded');
        assert.strictEqual(store.getData('nulldata'), null);
        assert.strictEqual(store.dataUpdatedAt('nodata'), null, 'a no-data card grew a record');
      });
      assert.ok(fs.existsSync(path.join(home, 'data', 'nodata.json')));
      for (const name of ['embedded.json', 'inline.json', 'nulldata.json']) {
        const parsed = JSON.parse(fs.readFileSync(path.join(home, 'data', name), 'utf8'));
        assert.ok(!Object.prototype.hasOwnProperty.call(parsed, 'data'),
          `${name} still carries its data key after import`);
      }
    });

    test('the seeded welcome card is fully gone (file and rows)', () => {
      assert.ok(!fs.existsSync(path.join(home, 'data', 'welcome.klebb.json')));
      withStore(home, (store) => {
        assert.strictEqual(store.dataUpdatedAt('welcome'), null);
      });
      assert.strictEqual(countSql(home,
        "SELECT COUNT(*) AS n FROM cards WHERE card_id = 'welcome'"), 0);
    });

    test('samples imported once and renamed aside', () => {
      assert.strictEqual(pushCountOf(home), 2);
      const autoExport = path.join(home, 'data', 'auto-export');
      assert.ok(!fs.existsSync(path.join(autoExport, 'samples.json')),
        'samples.json was not renamed aside');
      const imported = fs.readdirSync(autoExport).filter(n => n.startsWith('samples.json.imported-'));
      assert.strictEqual(imported.length, 1, `expected one imported marker, got ${imported}`);
    });

    test('reports byte-identical; provenance manifest at the home root', () => {
      assert.strictEqual(sha256(path.join(home, 'reports', 'bloods.md')),
        sha256(path.join(tree, 'reports', 'bloods.md')));
      assert.strictEqual(sha256(path.join(home, 'klebb-export.json')),
        sha256(path.join(tree, 'klebb-export.json')));
      assert.strictEqual(sha256(path.join(home, 'config.json')),
        sha256(path.join(tree, 'config.json')));
    });

    test('backups swept exactly: only this run\'s, the planted one survives', () => {
      assert.deepStrictEqual(preImportBackups(home), [DECOY]);
    });

    test('a simulated next boot drains nothing and push count holds', () => {
      const script = `
        const inbox = require(${JSON.stringify(path.join(REPO_ROOT, 'health-auto-export', 'samples-inbox.js'))});
        (async () => {
          console.log('drained:' + JSON.stringify(await inbox.drain()));
        })();
      `;
      const r = runNode(['-e', script], { HEALTH_HOME: home });
      assert.strictEqual(r.code, 0, r.out);
      assert.match(r.stdout, /drained:null/);
      assert.strictEqual(pushCountOf(home), 2);
    });
  });

  describe('applyTree in-process', () => {
    const { applyTree } = require('../lib/import/apply');

    test('config keep-existing leaves the target config and says so', async () => {
      const home = freshHome();
      const mine = JSON.stringify({ display: { theme: 'light' }, mine: true }, null, 2);
      fs.writeFileSync(path.join(home, 'config.json'), mine);
      const res = await applyTree(tree, home);
      assert.strictEqual(res.status, 'ok',
        JSON.stringify(res.findings, null, 2));
      const kept = res.findings.find(f => f.code === 'APPLY_CONFIG_KEPT');
      assert.ok(kept, 'no APPLY_CONFIG_KEPT finding');
      assert.strictEqual(kept.severity, 'info');
      assert.strictEqual(fs.readFileSync(path.join(home, 'config.json'), 'utf8'), mine);
      assert.deepStrictEqual(res.verified, { cards: 4, pushes: 2, reports: 1 });
    });

    test('APPLY_DB_BUSY: a held datastore refuses before any write', async () => {
      const home = freshHome();
      withStore(home, () => {});
      const { DatabaseSync } = require('node:sqlite');
      const holder = new DatabaseSync(path.join(home, 'db', 'klebb.db'));
      holder.exec('BEGIN IMMEDIATE');
      try {
        const res = await applyTree(tree, home);
        assert.strictEqual(res.status, 'refused');
        const busy = res.findings.find(f => f.code === 'APPLY_DB_BUSY');
        assert.ok(busy, JSON.stringify(res.findings, null, 2));
        assert.strictEqual(busy.severity, 'refusal');
        assert.match(busy.message, /stop the server first/);
        assert.strictEqual(res.verified, null);
        assert.ok(!fs.existsSync(path.join(home, 'klebb-export.json')), 'refusal still wrote the manifest');
        assert.deepStrictEqual(fs.readdirSync(path.join(home, 'data')), [], 'refusal still wrote into data/');
      } finally {
        holder.exec('ROLLBACK');
        holder.close();
      }
    });

    test('verify mismatch: status partial, backups retained, no auto-repair', async () => {
      const importPath = require.resolve('../lib/datastore/import.js');
      const applyPath = require.resolve('../lib/import/apply.js');
      const realExports = require.cache[importPath].exports;
      delete require.cache[applyPath];
      // Corrupt the stored value between import and verify, for one card
      // only, through the same store handle the importer used.
      require.cache[importPath].exports = {
        createImporter(store) {
          const real = realExports.createImporter(store);
          return {
            importParsedFile(file, parsed) {
              const r = real.importParsedFile(file, parsed);
              if (r.imported && r.id === 'embedded') {
                store.setData('embedded', [{ corrupted: true }]);
              }
              return r;
            },
          };
        },
      };
      try {
        const { applyTree: patched } = require(applyPath);
        const home = freshHome();
        const res = await patched(tree, home);
        assert.strictEqual(res.status, 'partial');
        const mismatch = res.findings.filter(f => f.code === 'VERIFY_CARD_MISMATCH');
        assert.strictEqual(mismatch.length, 1, JSON.stringify(res.findings, null, 2));
        assert.strictEqual(mismatch[0].ref, 'data/embedded.json');
        const kept = res.findings.find(f => f.code === 'APPLY_BACKUPS_KEPT');
        assert.ok(kept, 'no APPLY_BACKUPS_KEPT finding');
        assert.match(kept.message, /next boot re-imports any card file still carrying its data key/);
        assert.strictEqual(preImportBackups(home).length, 3,
          'the .pre-import backups were not retained');
        assert.strictEqual(res.verified.cards, 3);
        withStore(home, (store) => {
          assert.deepStrictEqual(norm(store.getData('embedded')), [{ corrupted: true }],
            'verify must report, never auto-repair');
        });
      } finally {
        require.cache[importPath].exports = realExports;
        delete require.cache[applyPath];
      }
    });
  });

  describe('crash-mid-apply convergence', () => {
    test('files copied but never imported converge on the next boot, no double rows', () => {
      const home = freshHome();
      // The state a crash between copy and import leaves behind: card files
      // still carrying their data keys, samples.json still in the inbox.
      fs.cpSync(path.join(tree, 'data'), path.join(home, 'data'), { recursive: true });

      const bootScript = `
        (async () => {
          await require(${JSON.stringify(path.join(REPO_ROOT, 'health-auto-export', 'samples-inbox.js'))}).drain();
          const stats = require(${JSON.stringify(path.join(REPO_ROOT, 'manifests', 'registry.js'))}).init();
          console.log('loaded:' + stats.count + ' errors:' + stats.errors);
          process.exit(0);
        })();
      `;
      const boot = runNode(['-e', bootScript], { HEALTH_HOME: home });
      assert.strictEqual(boot.code, 0, boot.out);
      assert.match(boot.stdout, /errors:0/);

      withStore(home, (store) => {
        assert.deepStrictEqual(norm(store.getData('embedded')), norm(EMBEDDED_ROWS));
        assert.deepStrictEqual(norm(store.getData('inline')), norm(INLINE_ROWS));
        assert.strictEqual(store.getData('nulldata'), null);
        assert.notStrictEqual(store.dataUpdatedAt('nulldata'), null);
      });
      assert.strictEqual(countSql(home,
        "SELECT COUNT(*) AS n FROM rows WHERE card_id = 'embedded'"), EMBEDDED_ROWS.length);
      assert.strictEqual(pushCountOf(home), 2);

      // And the boot after that changes nothing: the strip + rename stuck.
      const again = runNode(['-e', bootScript], { HEALTH_HOME: home });
      assert.strictEqual(again.code, 0, again.out);
      assert.strictEqual(countSql(home,
        "SELECT COUNT(*) AS n FROM rows WHERE card_id = 'embedded'"), EMBEDDED_ROWS.length);
      assert.strictEqual(pushCountOf(home), 2);
    });
  });
});
