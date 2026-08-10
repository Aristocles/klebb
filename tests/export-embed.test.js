// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/export-embed.test.js
// Round-trip proof for scripts/export-embed.js (#497): export instance A,
// boot instance B on the exported tree, and every card's API-visible data
// deep-equals A's — including hasData parity for null-data and no-data
// cards. Also pins the config.json secret strip and the exclusion of
// credentials/sessions/db/backups from the exported tree.
//
// The export runs while A's server is still up (WAL allows the second
// read handle), matching how the Cloud export invokes it inside a running
// container.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const {
  createSandbox, cleanupSandbox, spawnServer, req, fakeAuthState,
} = require('./helpers/sandbox');

const REPO_ROOT = path.resolve(__dirname, '..');
const EXPORT = path.join(REPO_ROOT, 'scripts', 'export-embed.js');

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
  'greetings.json': card('greetings', { data: ['g’day', 'howdy'] }),
  'null-data.json': card('null-data', { data: null }),
  'no-data.json': card('no-data'),
};

function runExport(healthHome, target, extraArgs = []) {
  try {
    const stdout = execSync(`node ${EXPORT} ${target} ${extraArgs.join(' ')}`, {
      encoding: 'utf8',
      env: { ...process.env, HEALTH_HOME: healthHome, HEALTH_HOME_WARNED: '1' },
    });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status || 1, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

async function apiDump(server, cookie) {
  const listRes = await req(server.baseUrl, '/api/settings/cards', { cookie });
  assert.equal(listRes.status, 200);
  const dump = new Map();
  for (const c of listRes.json.cards) {
    const res = await req(server.baseUrl, `/api/manifests/${c.id}/data`, { cookie });
    assert.equal(res.status, 200, `${c.id}: ${res.status}`);
    dump.set(c.id, { data: res.json.data, hasData: c.hasData });
  }
  return dump;
}

describe('export-embed round trip', { skip }, () => {
  let sandboxA; let sandboxB; let target;
  let serverA; let serverB;
  let dumpA; let dumpB;
  const auth = fakeAuthState();

  before(async () => {
    sandboxA = createSandbox({ seed: SEED, credentials: auth.credentials, sessions: auth.sessions });
    fs.writeFileSync(path.join(sandboxA, 'config.json'), JSON.stringify({
      hae: { token: 'seekrit-hae-token', lastRegeneratedAt: '2026-07-01T00:00:00Z' },
      auth: { invites: [{ code: 'INVITE1', used: false }], requireInviteForRegistration: true },
      display: { theme: 'dark' },
    }, null, 2));
    fs.mkdirSync(path.join(sandboxA, 'reports'), { recursive: true });
    fs.writeFileSync(path.join(sandboxA, 'reports', 'bloods-2026-05.md'), '# Bloods May');
    // A pre-#546 tree can still hold the superseded file archive, and the
    // migration leaves a moved-aside copy. Neither may be staged: they are
    // hundreds of MB of duplicates, and the export goes to a customer.
    fs.mkdirSync(path.join(sandboxA, 'data', 'auto-export', 'raw'), { recursive: true });
    fs.writeFileSync(path.join(sandboxA, 'data', 'auto-export', 'raw', 'push-1.json'), '{"data":{"metrics":[]}}');
    fs.mkdirSync(path.join(sandboxA, 'data', 'auto-export', 'raw.migrated-20260810T000000000Z'), { recursive: true });
    fs.writeFileSync(path.join(sandboxA, 'data', 'auto-export', 'raw.migrated-20260810T000000000Z', 'old.json'), '{}');
    fs.writeFileSync(path.join(sandboxA, 'data', 'auto-export', 'last-push.json'), '{"receivedAt":"2026-07-08"}');

    // Boot A: the import inbox strips every seeded data block into the store.
    serverA = await spawnServer(sandboxA);
    dumpA = await apiDump(serverA, auth.cookie);

    // Export while A is still running (second WAL read handle).
    target = fs.mkdtempSync(path.join(os.tmpdir(), 'eh-export-'));
    fs.rmdirSync(target);
    const res = runExport(sandboxA, target);
    assert.equal(res.code, 0, res.stdout + (res.stderr || ''));

    // Boot B on the exported tree.
    sandboxB = createSandbox({ credentials: auth.credentials, sessions: auth.sessions });
    fs.cpSync(path.join(target, 'data'), path.join(sandboxB, 'data'), { recursive: true });
    fs.cpSync(path.join(target, 'reports'), path.join(sandboxB, 'reports'), { recursive: true });
    fs.copyFileSync(path.join(target, 'config.json'), path.join(sandboxB, 'config.json'));
    serverB = await spawnServer(sandboxB);
    dumpB = await apiDump(serverB, auth.cookie);
  });

  after(async () => {
    if (serverA) await serverA.kill();
    if (serverB) await serverB.kill();
    cleanupSandbox(sandboxA);
    cleanupSandbox(sandboxB);
    try { fs.rmSync(target, { recursive: true, force: true }); } catch {}
  });

  test('every card API value deep-equals across the round trip', () => {
    assert.deepStrictEqual([...dumpB.keys()].sort(), [...dumpA.keys()].sort());
    for (const [id, a] of dumpA) {
      assert.deepStrictEqual(dumpB.get(id).data, a.data, `card ${id} diverged`);
    }
  });

  test('hasData parity holds, including null-data and no-data cards', () => {
    for (const [id, a] of dumpA) {
      assert.equal(dumpB.get(id).hasData, a.hasData, `hasData parity broke for ${id}`);
    }
    assert.equal(dumpA.get('null-data').hasData, false);
    assert.equal(dumpA.get('no-data').hasData, false);
    assert.equal(dumpA.get('weight').hasData, true);
  });

  test('exported card files carry re-embedded data; no-data key stays absent', () => {
    const weight = JSON.parse(fs.readFileSync(path.join(target, 'data', 'weight.json'), 'utf8'));
    assert.deepStrictEqual(weight.data, SEED['weight.json'].data);
    const nullData = JSON.parse(fs.readFileSync(path.join(target, 'data', 'null-data.json'), 'utf8'));
    assert.equal(nullData.data, null);
    assert.ok(Object.prototype.hasOwnProperty.call(nullData, 'data'));
    const noData = JSON.parse(fs.readFileSync(path.join(target, 'data', 'no-data.json'), 'utf8'));
    assert.ok(!Object.prototype.hasOwnProperty.call(noData, 'data'));
  });

  test('secrets are stripped from the exported config.json by default', () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(target, 'config.json'), 'utf8'));
    assert.equal(cfg.hae, undefined);
    assert.equal(cfg.auth && cfg.auth.invites, undefined);
    assert.equal(cfg.auth.requireInviteForRegistration, true);
    assert.deepStrictEqual(cfg.display, { theme: 'dark' });
  });

  test('credentials, sessions, db, and import backups never reach the export', () => {
    assert.ok(!fs.existsSync(path.join(target, 'credentials')));
    assert.ok(!fs.existsSync(path.join(target, 'sessions')));
    assert.ok(!fs.existsSync(path.join(target, 'db')));
    const strays = fs.readdirSync(path.join(target, 'data'))
      .filter(f => /\.json\.[^/\\]+\.json$/i.test(f) || f.endsWith('.tmp'));
    assert.deepStrictEqual(strays, []);
  });

  test('superseded raw archives are never staged, other files copied', () => {
    assert.ok(!fs.existsSync(path.join(target, 'data', 'auto-export', 'raw')));
    assert.ok(!fs.existsSync(path.join(target, 'data', 'auto-export',
      'raw.migrated-20260810T000000000Z')),
      'a moved-aside archive from the migration was staged into the export');
    assert.ok(fs.existsSync(path.join(target, 'data', 'auto-export', 'last-push.json')));
    assert.ok(fs.existsSync(path.join(target, 'reports', 'bloods-2026-05.md')));
  });
});

describe('export-embed flags and guards', { skip }, () => {
  test('--include-secrets keeps the config verbatim; --include-raw is inert', () => {
    const auth = fakeAuthState();
    const sandbox = createSandbox({
      seed: { 'weight.json': card('weight', { data: [{ date: '2026-04-20', kg: 85 }] }) },
      credentials: auth.credentials,
      sessions: auth.sessions,
    });
    fs.writeFileSync(path.join(sandbox, 'config.json'), JSON.stringify({
      hae: { token: 'seekrit' }, auth: { invites: [{ code: 'X' }] },
    }));
    fs.mkdirSync(path.join(sandbox, 'data', 'auto-export', 'raw'), { recursive: true });
    fs.writeFileSync(path.join(sandbox, 'data', 'auto-export', 'raw', 'push-1.json'), '{}');
    // No server here on purpose. This test only asserts on files the export
    // writes, and a running server holds a write handle on the same
    // db/klebb.db the export subprocess opens: two writers, one database.
    // Under load the server could hold the lock at that moment and the export
    // died with "database is locked". See #583.
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'eh-export-'));
    fs.rmdirSync(target);
    try {
      // --include-raw referred to the removed file archive. It is still
      // accepted, so an existing invocation does not start failing, but it
      // must no longer stage the directory.
      const res = runExport(sandbox, target, ['--include-secrets', '--include-raw']);
      assert.equal(res.code, 0, res.stdout + (res.stderr || ''));
      const cfg = JSON.parse(fs.readFileSync(path.join(target, 'config.json'), 'utf8'));
      assert.equal(cfg.hae.token, 'seekrit');
      assert.equal(cfg.auth.invites.length, 1);
      assert.ok(!fs.existsSync(path.join(target, 'data', 'auto-export', 'raw')),
        '--include-raw still copies the superseded archive');
    } finally {
      cleanupSandbox(sandbox);
      try { fs.rmSync(target, { recursive: true, force: true }); } catch {}
    }
  });

  test('refuses a non-empty target and a target inside the data dir', () => {
    const sandbox = createSandbox({ seed: { 'weight.json': card('weight', { data: [] }) } });
    const occupied = fs.mkdtempSync(path.join(os.tmpdir(), 'eh-export-'));
    fs.writeFileSync(path.join(occupied, 'existing.txt'), 'x');
    try {
      const nonEmpty = runExport(sandbox, occupied);
      assert.notEqual(nonEmpty.code, 0);
      assert.match(nonEmpty.stderr || nonEmpty.stdout, /not empty/);
      const inside = runExport(sandbox, path.join(sandbox, 'data', 'export'));
      assert.notEqual(inside.code, 0);
      assert.match(inside.stderr || inside.stdout, /inside the data dir/);
    } finally {
      cleanupSandbox(sandbox);
      try { fs.rmSync(occupied, { recursive: true, force: true }); } catch {}
    }
  });

  test('a pre-migration tree (no db/) exports inline data untouched', () => {
    const sandbox = createSandbox({ seed: { 'weight.json': card('weight', { data: [{ date: '2026-04-20', kg: 85 }] }) } });
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'eh-export-'));
    fs.rmdirSync(target);
    try {
      assert.ok(!fs.existsSync(path.join(sandbox, 'db')));
      const res = runExport(sandbox, target);
      assert.equal(res.code, 0, res.stdout + (res.stderr || ''));
      const weight = JSON.parse(fs.readFileSync(path.join(target, 'data', 'weight.json'), 'utf8'));
      assert.deepStrictEqual(weight.data, [{ date: '2026-04-20', kg: 85 }]);
      assert.ok(!fs.existsSync(path.join(sandbox, 'db')), 'export must not create db/ as a side effect');
    } finally {
      cleanupSandbox(sandbox);
      try { fs.rmSync(target, { recursive: true, force: true }); } catch {}
    }
  });
});
