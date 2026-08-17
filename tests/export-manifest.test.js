// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/export-manifest.test.js
// The provenance manifest scripts/export-embed.js writes last (#592):
// klebb-export.json must reconcile exactly against the emitted tree (every
// file listed once, hashes of the bytes as written), record the four card
// data states with rows from the datastore decomposition, carry the samples
// push count only when a samples file was exported, contain no secret
// material or absolute paths, and never exist in a torn export. The
// reserved file name is skipped when found inside the source data/ tree.
//
// Contract: docs/EXPORT-FORMAT.md.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const {
  createSandbox, cleanupSandbox, spawnServer, req, fakeAuthState,
} = require('./helpers/sandbox');
const { decompose } = require('../lib/datastore/shape');

const REPO_ROOT = path.resolve(__dirname, '..');
const EXPORT = path.join(REPO_ROOT, 'scripts', 'export-embed.js');
const MANIFEST_NAME = 'klebb-export.json';

let sqliteAvailable = true;
try { require('node:sqlite'); } catch { sqliteAvailable = false; }
const skip = sqliteAvailable ? false : 'node:sqlite unavailable on this Node';

function card(id, extra = {}) {
  return {
    $schema: 'klebb.datafile.v1',
    meta: { id, label: id, view: { enabled: true, component: 'generic-card' } },
    ...extra,
  };
}

const SEED = {
  'weight.json': card('weight', { data: [{ date: '2026-04-20', kg: 85 }, { date: '2026-04-21', kg: 84.6 }] }),
  'peptides.json': card('peptides', {
    data: { items: [{ name: 'BPC-157', doses: [{ scheduledDate: '2026-04-29' }] }], groups: [] },
  }),
  'notes.json': card('notes', { data: { markdown: '# Notes\n\nfree document' } }),
  'motto.json': card('motto', { data: 'a bare document value' }),
  'greetings.json': card('greetings', { data: ['g’day', 'howdy'] }),
  'null-data.json': card('null-data', { data: null }),
  'no-data.json': card('no-data'),
};

const INLINE_DATA = [{ date: '2026-05-01', note: 'pre-migration' }, { date: '2026-05-02', note: 'still on file' }];

function runExport(healthHome, target, extraArgs = []) {
  const r = spawnSync(process.execPath, [EXPORT, target, ...extraArgs], {
    encoding: 'utf8',
    env: { ...process.env, HEALTH_HOME: healthHome, HEALTH_HOME_WARNED: '1' },
  });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function seedHaePushes(healthHome) {
  const samplesModule = path.join(REPO_ROOT, 'health-auto-export', 'samples.js');
  const script = `
    const samples = require(${JSON.stringify(samplesModule)});
    samples.recordPush({ data: { metrics: [{ name: 'step_count', data: [{ date: '2026-05-01', qty: 4100 }] }] } },
      { receivedAt: '2026-05-01T00:00:00.000Z' });
    samples.recordPush({ data: { metrics: [{ name: 'step_count', data: [{ date: '2026-05-02', qty: 5200 }] }] } },
      { receivedAt: '2026-05-02T00:00:00.000Z' });
    samples.close();
  `;
  execFileSync(process.execPath, ['-e', script], {
    env: { ...process.env, HEALTH_HOME: healthHome, HEALTH_HOME_WARNED: '1' },
  });
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// The test's own row count from an API-dumped value, so a writer that
// miscounts is caught against data the server actually serves.
function rowsOf(value) {
  const { shape, containers } = decompose(value);
  if (shape.kind !== 'array' && shape.kind !== 'object') return 0;
  return Object.values(containers).reduce((n, arr) => n + arr.length, 0);
}

function walkFiles(dir, base = dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walkFiles(abs, base));
    else if (ent.isFile()) out.push(path.relative(base, abs).split(path.sep).join('/'));
  }
  return out;
}

function listedFiles(manifest) {
  const inv = manifest.inventory;
  return [
    ...inv.cards.map(c => c.file),
    ...(inv.samples ? [inv.samples.file] : []),
    ...inv.reports.map(r => r.file),
    ...inv.other.map(o => o.file),
  ];
}

async function apiDump(server, cookie) {
  const listRes = await req(server.baseUrl, '/api/settings/cards', { cookie });
  assert.equal(listRes.status, 200);
  const dump = new Map();
  for (const c of listRes.json.cards) {
    const res = await req(server.baseUrl, `/api/manifests/${c.id}/data`, { cookie });
    assert.equal(res.status, 200, `${c.id}: ${res.status}`);
    dump.set(c.id, res.json.data);
  }
  return dump;
}

describe('export manifest', { skip }, () => {
  let sandbox; let target; let manifest; let exportRun; let dump;
  const auth = fakeAuthState();

  before(async () => {
    sandbox = createSandbox({ seed: SEED, credentials: auth.credentials, sessions: auth.sessions });
    fs.writeFileSync(path.join(sandbox, 'config.json'), JSON.stringify({
      hae: { token: 'seekrit-hae-token' },
      auth: { invites: [{ code: 'INVITE1', used: false }], requireInviteForRegistration: true },
      display: { theme: 'dark' },
    }, null, 2));
    fs.mkdirSync(path.join(sandbox, 'reports'), { recursive: true });
    fs.writeFileSync(path.join(sandbox, 'reports', 'bloods-2026-05.md'), '# Bloods May');

    // Boot once so the import inbox moves every seeded data block into the
    // datastore, dump what the API serves, then stop the server: the export
    // subprocess must not contend with a live writer for the same db.
    const server = await spawnServer(sandbox);
    dump = await apiDump(server, auth.cookie);
    await server.kill();

    seedHaePushes(sandbox);

    // A pre-migration card added after the boot import, so its data block is
    // still on file at export time.
    fs.writeFileSync(path.join(sandbox, 'data', 'inline.json'),
      JSON.stringify(card('inline', { data: INLINE_DATA }), null, 2));

    // Reserved-name plants: one at data/ top level, one nested, as a
    // restored-then-re-exported tree would carry them.
    fs.writeFileSync(path.join(sandbox, 'data', MANIFEST_NAME),
      JSON.stringify({ format: 'klebb.export.v1', formatVersion: 1, stale: true }));
    fs.mkdirSync(path.join(sandbox, 'data', 'info'), { recursive: true });
    fs.writeFileSync(path.join(sandbox, 'data', 'info', MANIFEST_NAME),
      JSON.stringify({ format: 'klebb.export.v1', formatVersion: 1, stale: true }));

    target = fs.mkdtempSync(path.join(os.tmpdir(), 'eh-export-'));
    fs.rmdirSync(target);
    exportRun = runExport(sandbox, target);
    assert.equal(exportRun.code, 0, exportRun.stdout + exportRun.stderr);
    manifest = JSON.parse(fs.readFileSync(path.join(target, MANIFEST_NAME), 'utf8'));
  });

  after(() => {
    cleanupSandbox(sandbox);
    try { fs.rmSync(target, { recursive: true, force: true }); } catch {}
  });

  test('manifest parses with the pinned envelope fields', () => {
    assert.equal(manifest.format, 'klebb.export.v1');
    assert.equal(manifest.formatVersion, 1);
    assert.equal(manifest.appVersion, require('../package.json').version);
    assert.match(manifest.exportedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.ok(!Number.isNaN(Date.parse(manifest.exportedAt)));
  });

  test('inventory reconciles exactly against the emitted tree', () => {
    const listed = listedFiles(manifest);
    assert.equal(new Set(listed).size, listed.length, 'a file is listed twice');
    const onDisk = walkFiles(target).filter(f => f !== MANIFEST_NAME);
    assert.deepStrictEqual([...listed].sort(), onDisk.sort());
    assert.ok(!listed.includes(MANIFEST_NAME), 'the manifest listed itself');
  });

  test('every recorded hash matches the file bytes as written', () => {
    const inv = manifest.inventory;
    const entries = [...inv.cards, inv.samples, ...inv.reports, ...inv.other];
    for (const entry of entries) {
      assert.equal(entry.sha256, sha256(path.join(target, entry.file)),
        `hash mismatch for ${entry.file}`);
    }
  });

  test('card data states cover embedded, inline, null, and none', () => {
    const byId = new Map(manifest.inventory.cards.map(c => [c.id, c]));
    assert.equal(byId.get('weight').data, 'embedded');
    assert.equal(byId.get('inline').data, 'inline');
    assert.equal(byId.get('null-data').data, 'null');
    assert.equal(byId.get('no-data').data, 'none');
    assert.equal(byId.get('weight').file, 'data/weight.json');
  });

  test('rows come from the datastore decomposition of the API-served value', () => {
    const byId = new Map(manifest.inventory.cards.map(c => [c.id, c]));
    for (const [id, data] of dump) {
      assert.equal(byId.get(id).rows, rowsOf(data), `rows diverged for ${id}`);
    }
    assert.equal(byId.get('weight').rows, 2);
    assert.equal(byId.get('peptides').rows, 1);
    assert.equal(byId.get('greetings').rows, 2);
    assert.equal(byId.get('notes').rows, 0, 'a rest-only object has no rows');
    assert.equal(byId.get('motto').rows, 0, 'a doc value has no rows');
    assert.equal(byId.get('null-data').rows, 0);
    assert.equal(byId.get('no-data').rows, 0);
    assert.equal(byId.get('inline').rows, INLINE_DATA.length);
  });

  test('samples entry carries the push count', () => {
    assert.equal(manifest.inventory.samples.file, 'data/auto-export/samples.json');
    assert.equal(manifest.inventory.samples.pushes, 2);
    assert.ok(fs.existsSync(path.join(target, 'data', 'auto-export', 'samples.json')));
  });

  test('reports entries carry byte sizes', () => {
    const report = manifest.inventory.reports.find(r => r.file === 'reports/bloods-2026-05.md');
    assert.ok(report, 'the report file is not in the inventory');
    assert.equal(report.bytes, Buffer.byteLength('# Bloods May'));
  });

  test('no secret material, no absolute paths, no parent escapes', () => {
    const raw = fs.readFileSync(path.join(target, MANIFEST_NAME), 'utf8');
    assert.ok(!raw.includes('seekrit-hae-token'), 'the HAE token leaked into the manifest');
    assert.ok(!raw.includes('INVITE1'), 'an invite code leaked into the manifest');
    for (const file of listedFiles(manifest)) {
      assert.ok(!path.isAbsolute(file), `absolute path in manifest: ${file}`);
      assert.ok(!file.includes('\\') && !file.includes('..') && !file.includes(':'),
        `suspicious path in manifest: ${file}`);
      assert.match(file, /^(data\/|reports\/|config\.json$)/, `path outside the tree contract: ${file}`);
    }
  });

  test('reserved file names inside data/ are skipped with a warning', () => {
    assert.ok(!fs.existsSync(path.join(target, 'data', MANIFEST_NAME)));
    assert.ok(!fs.existsSync(path.join(target, 'data', 'info', MANIFEST_NAME)));
    assert.ok(!listedFiles(manifest).some(f => f.split('/').pop() === MANIFEST_NAME));
    assert.equal((exportRun.stderr.match(/reserved name/g) || []).length, 2,
      `expected two reserved-name warnings, got: ${exportRun.stderr}`);
  });
});

describe('export manifest guards', { skip }, () => {
  test('samples key is absent when no samples file was exported', () => {
    // No server boot and no db/: the card exports inline and there is no
    // push history to write.
    const sandbox = createSandbox({ seed: { 'weight.json': card('weight', { data: [{ date: '2026-04-20', kg: 85 }] }) } });
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'eh-export-'));
    fs.rmdirSync(target);
    try {
      const res = runExport(sandbox, target);
      assert.equal(res.code, 0, res.stdout + res.stderr);
      const manifest = JSON.parse(fs.readFileSync(path.join(target, MANIFEST_NAME), 'utf8'));
      assert.ok(!('samples' in manifest.inventory), 'samples key present with no samples file');
      assert.equal(manifest.inventory.cards[0].data, 'inline');
      assert.equal(manifest.inventory.cards[0].rows, 1);
    } finally {
      cleanupSandbox(sandbox);
      try { fs.rmSync(target, { recursive: true, force: true }); } catch {}
    }
  });

  test('a torn export leaves no manifest in the target', () => {
    const sandbox = createSandbox({ seed: { 'weight.json': card('weight', { data: [{ date: '2026-04-20', kg: 85 }] }) } });
    // A regular file where the reports directory belongs makes the reports
    // copy throw after the data walk has already written card files.
    fs.rmSync(path.join(sandbox, 'reports'), { recursive: true, force: true });
    fs.writeFileSync(path.join(sandbox, 'reports'), 'not a directory');
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'eh-export-'));
    fs.rmdirSync(target);
    try {
      const res = runExport(sandbox, target);
      assert.notEqual(res.code, 0, 'the export was expected to fail');
      assert.ok(fs.existsSync(path.join(target, 'data', 'weight.json')),
        'the export never started, so this proves nothing about tearing');
      assert.ok(!fs.existsSync(path.join(target, MANIFEST_NAME)),
        'a torn export left a manifest behind');
    } finally {
      cleanupSandbox(sandbox);
      try { fs.rmSync(target, { recursive: true, force: true }); } catch {}
    }
  });
});
