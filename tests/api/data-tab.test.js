// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/api/data-tab.test.js
// The export download and import HTTP surface (routes/data.js), driven
// entirely over HTTP against spawned servers: the wizard runs inside the
// server process, and this file never calls the engine in-process (a second
// handle on a live WAL home is the two-writers flake). The zip modules ARE
// used in the test process, but only on files the server is not holding:
// parsing a completed download, building an upload fixture.

'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const {
  createSandbox, cleanupSandbox, spawnServer, req, fakeAuthState, waitFor, REPO_ROOT,
} = require('../helpers/sandbox');
const { openZip } = require('../../lib/zip/read');
const { writeZip } = require('../../lib/zip/write');
const { injectPushes } = require('../helpers/hae-push-fixture');

process.env.HEALTH_HOME_WARNED = '1';

let sqliteAvailable = true;
try { require('node:sqlite'); } catch { sqliteAvailable = false; }
const skip = sqliteAvailable ? false : 'node:sqlite unavailable on this Node';

const EXPORT_CLI = path.join(REPO_ROOT, 'scripts', 'export-embed.js');
const IMPORT_CLI = path.join(REPO_ROOT, 'scripts', 'import-tree.js');

const WEIGHT_ROWS = [
  { date: '2026-06-01', kg: 81.2 },
  { date: '2026-06-02', kg: 80.9 },
];
const NOTES_ROWS = [
  { date: '2026-06-01', note: 'slept well' },
];
const OLD_ROWS = [
  { date: '2025-12-01', mood: 3 },
  { date: '2025-12-02', mood: 4 },
];

const scratchDirs = [];
function scratchDir(prefix = 'eh-data-tab-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

function card(id, rows) {
  const body = { $schema: 'klebb.datafile.v1', meta: { id, label: id } };
  if (rows !== undefined) body.data = rows;
  return body;
}

function runNode(args, env = {}) {
  const r = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    cwd: REPO_ROOT,
    env: { ...process.env, HEALTH_HOME_WARNED: '1', ...env },
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

function listZipEntries(root, rel = '') {
  const out = [];
  const dir = rel ? path.join(root, rel) : root;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const r = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) out.push(...listZipEntries(root, r));
    else if (ent.isFile()) out.push({ name: r, sourcePath: path.join(root, r) });
  }
  return out;
}

// Build a real exported tree (source home of plain card files with inline
// data, run through the export CLI in a subprocess) and zip it with the
// paired writer. opts.pushes plants that many HAE pushes into the tree
// (inventory-listed), which is what stretches the pipeline's drain stage
// into an observable applying window. opts.reports maps a filename under
// reports/ to its body. Returns { tree, zipBuf }.
async function buildTreeZip(cards, opts = {}) {
  const src = scratchDir('eh-data-src-');
  fs.mkdirSync(path.join(src, 'data'), { recursive: true });
  for (const c of cards) {
    fs.writeFileSync(path.join(src, 'data', `${c.meta.id}.json`), JSON.stringify(c, null, 2));
  }
  if (opts.reports) {
    fs.mkdirSync(path.join(src, 'reports'), { recursive: true });
    for (const [name, body] of Object.entries(opts.reports)) {
      fs.writeFileSync(path.join(src, 'reports', name), body);
    }
  }
  const tree = path.join(scratchDir('eh-data-tree-'), 'tree');
  const r = runNode([EXPORT_CLI, tree], { HEALTH_HOME: src });
  assert.strictEqual(r.code, 0, r.out);
  if (opts.pushes) injectPushes(tree, opts.pushes);
  const zipFile = path.join(scratchDir('eh-data-zip-'), 'tree.zip');
  await writeZip(zipFile, listZipEntries(tree));
  return { tree, zipBuf: fs.readFileSync(zipFile) };
}

// Apply and rollback answer 202 and the pipeline settles behind
// GET /api/import/status polling (#633).
function pollUntilSettled(baseUrl, cookie) {
  return waitFor(async () => {
    const r = await req(baseUrl, '/api/import/status', { cookie });
    assert.strictEqual(r.status, 200, r.body);
    return (r.json.state === 'done' || r.json.state === 'failed') ? r.json : null;
  }, { timeoutMs: 60000, what: 'the import job to settle' });
}

// One entry named ../escape.txt, hand-assembled because the paired writer
// (correctly) refuses to produce it.
function buildHostileZip() {
  const name = Buffer.from('../escape.txt');
  const data = Buffer.from('hostile');
  const body = zlib.deflateRawSync(data);
  const crc = zlib.crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42);
  const cdOffset = 30 + name.length + body.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(46 + name.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([local, name, body, central, name, eocd]);
}

// Raw-body POST (the upload contract); returns { status, json, body }.
function binPost(baseUrl, pathname, payload, cookie) {
  return new Promise((resolve, reject) => {
    const r = http.request(new URL(pathname, baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/zip',
        'Content-Length': payload.length,
        Cookie: cookie,
      },
    }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch {}
        resolve({ status: res.statusCode, body: buf, json });
      });
    });
    r.on('error', reject);
    r.setTimeout(15000, () => r.destroy(new Error('request timeout')));
    r.write(payload);
    r.end();
  });
}

// Full binary GET, buffered.
function binGet(baseUrl, pathname, cookie) {
  return new Promise((resolve, reject) => {
    const r = http.request(new URL(pathname, baseUrl), { headers: { Cookie: cookie } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks) }));
    });
    r.on('error', reject);
    r.setTimeout(30000, () => r.destroy(new Error('request timeout')));
    r.end();
  });
}

// Open a download and PAUSE it after the headers, so the server's response
// cannot finish and its in-flight flag stays held for the concurrency test.
function openPausedDownload(baseUrl, pathname, cookie) {
  return new Promise((resolve, reject) => {
    const r = http.request(new URL(pathname, baseUrl), { headers: { Cookie: cookie } }, res => {
      res.pause();
      resolve(res);
    });
    r.on('error', reject);
    r.end();
  });
}

function drain(res) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    res.on('data', c => chunks.push(c));
    res.on('end', () => resolve(Buffer.concat(chunks)));
    res.on('error', reject);
    res.resume();
  });
}

async function captureCards(baseUrl, cookie) {
  const list = await req(baseUrl, '/api/manifests', { cookie });
  assert.strictEqual(list.status, 200, list.body);
  const dumps = {};
  for (const e of list.json.entries) {
    const d = await req(baseUrl, `/api/manifests/${e.id}/data`, { cookie });
    assert.strictEqual(d.status, 200, d.body);
    dumps[e.id] = d.json.data;
  }
  return { entries: list.json.entries, dumps };
}

function noStagingLeft(home) {
  return fs.readdirSync(home).filter(n => n.startsWith('export-staging.')).length === 0;
}

function partFilesIn(importDir) {
  try {
    return fs.readdirSync(importDir).filter(n => n.endsWith('.part'));
  } catch {
    return [];
  }
}

after(() => {
  while (scratchDirs.length) {
    try { fs.rmSync(scratchDirs.pop(), { recursive: true, force: true }); } catch {}
  }
});

describe('GET /api/export', { skip }, () => {
  let auth;
  let home;
  let server;

  before(async () => {
    auth = fakeAuthState();
    // A bulk card too: random hex defeats deflate, so the zip is megabytes
    // and the paused-download concurrency test below holds a real window.
    const bulkRows = [];
    for (let i = 0; i < 100; i++) {
      bulkRows.push({ date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`, v: crypto.randomBytes(32 * 1024).toString('hex') });
    }
    home = createSandbox({
      credentials: auth.credentials,
      sessions: auth.sessions,
      seed: {
        'weight.json': card('weight', WEIGHT_ROWS),
        'bulk.json': card('bulk', bulkRows),
      },
    });
    server = await spawnServer(home);
  });

  after(async () => {
    if (server) await server.kill();
    cleanupSandbox(home);
  });

  test('downloads a valid zip the CLI importer accepts, disposition pinned', async () => {
    const r = await binGet(server.baseUrl, '/api/export', auth.cookie);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers['content-type'], 'application/zip');
    assert.strictEqual(Number(r.headers['content-length']), r.buf.length);
    assert.match(r.headers['content-disposition'],
      /^attachment; filename="klebb-export-\d{8}-\d{6}\.zip"$/);

    const zipFile = path.join(scratchDir(), 'download.zip');
    fs.writeFileSync(zipFile, r.buf);
    const zip = await openZip(zipFile);
    const names = zip.entries().map(e => e.name);
    assert.ok(names.includes('klebb-export.json'), `no manifest in ${names}`);
    assert.ok(names.includes('data/weight.json'), `no weight card in ${names}`);
    const extracted = path.join(scratchDir(), 'tree');
    await zip.extractTo(extracted);
    await zip.close();

    const dry = runNode([IMPORT_CLI, extracted, '--target', scratchDir()]);
    assert.strictEqual(dry.code, 0, dry.out);
    assert.match(dry.out, /Tree validates/);
  });

  test('staging dir and zip are cleaned once the response ends', async () => {
    await waitFor(() => noStagingLeft(home), { what: 'export staging cleanup' });
  });

  test('a concurrent export answers 409 while one is streaming', async () => {
    const first = await openPausedDownload(server.baseUrl, '/api/export', auth.cookie);
    assert.strictEqual(first.statusCode, 200);
    try {
      const second = await req(server.baseUrl, '/api/export', { cookie: auth.cookie });
      assert.strictEqual(second.status, 409, second.body);
      assert.match(second.json.error, /already in progress/);
    } finally {
      const body = await drain(first);
      assert.strictEqual(body.length, Number(first.headers['content-length']));
    }
    await waitFor(() => noStagingLeft(home), { what: 'export staging cleanup after drain' });
    // The in-flight flag released with the stream: a fresh export succeeds.
    const third = await binGet(server.baseUrl, '/api/export', auth.cookie);
    assert.strictEqual(third.status, 200);
    await waitFor(() => noStagingLeft(home), { what: 'export staging cleanup after third' });
  });
});

describe('demo mode 403s the whole surface', { skip }, () => {
  let auth;
  let home;
  let server;

  before(async () => {
    auth = fakeAuthState();
    home = createSandbox({ credentials: auth.credentials, sessions: auth.sessions });
    server = await spawnServer(home, { KLEBB_DEMO: '1' });
  });

  after(async () => {
    if (server) await server.kill();
    cleanupSandbox(home);
  });

  test('export 403 before any work', async () => {
    const r = await req(server.baseUrl, '/api/export', { cookie: auth.cookie });
    assert.strictEqual(r.status, 403, r.body);
    assert.ok(noStagingLeft(home), 'demo export staged files before refusing');
  });

  test('the import family 403s', async () => {
    for (const [method, p] of [
      ['GET', '/api/import/status'],
      ['POST', '/api/import/upload'],
      ['POST', '/api/import/start'],
      ['POST', '/api/import/apply'],
    ]) {
      const r = await req(server.baseUrl, p, { method, cookie: auth.cookie, body: method === 'POST' ? {} : null });
      assert.strictEqual(r.status, 403, `${method} ${p}: ${r.body}`);
    }
  });
});

describe('import over HTTP: fresh target', { skip }, () => {
  let auth;
  let home;
  let server;
  let fixture;

  before(async () => {
    fixture = await buildTreeZip([card('weight', WEIGHT_ROWS), card('notes', NOTES_ROWS)]);
    auth = fakeAuthState();
    home = createSandbox({ credentials: auth.credentials, sessions: auth.sessions });
    server = await spawnServer(home);
  });

  after(async () => {
    if (server) await server.kill();
    cleanupSandbox(home);
  });

  test('start without an upload answers 404', async () => {
    const r = await req(server.baseUrl, '/api/import/start', { method: 'POST', cookie: auth.cookie, body: {} });
    assert.strictEqual(r.status, 404, r.body);
  });

  test('scan-tree without a tree answers 404', async () => {
    const r = await req(server.baseUrl, '/api/import/scan-tree', { method: 'POST', cookie: auth.cookie, body: {} });
    assert.strictEqual(r.status, 404, r.body);
  });

  test('upload stages the archive', async () => {
    const r = await binPost(server.baseUrl, '/api/import/upload', fixture.zipBuf, auth.cookie);
    assert.strictEqual(r.status, 200, r.body);
    assert.strictEqual(r.json.ok, true);
    assert.strictEqual(r.json.bytes, fixture.zipBuf.length);
    assert.ok(fs.existsSync(path.join(home, 'import', 'upload.zip')));
  });

  test('start extracts, consumes the zip, and needs no confirm on a fresh target', async () => {
    // Non-vacuous freshness: the target seeded its welcome card, which the
    // fresh gate must ignore.
    const pre = await req(server.baseUrl, '/api/manifests', { cookie: auth.cookie });
    assert.ok(pre.json.entries.some(e => e.id === 'welcome'), 'no welcome card; freshness would be vacuous');

    const r = await req(server.baseUrl, '/api/import/start', { method: 'POST', cookie: auth.cookie, body: {} });
    assert.strictEqual(r.status, 200, r.body);
    assert.strictEqual(r.json.state, 'awaiting-confirm');
    assert.strictEqual(r.json.requiresConfirm, false);
    assert.ok(!('confirmNonce' in r.json), 'a fresh target must not mint a nonce');
    assert.ok(!fs.existsSync(path.join(home, 'import', 'upload.zip')), 'upload.zip survived extraction');
    assert.ok(fs.readdirSync(path.join(home, 'import')).some(n => n.startsWith('staging-')), 'no staged tree');
  });

  test('apply answers 202 applying; polling reaches done; cards served deep-equal', async () => {
    const r = await req(server.baseUrl, '/api/import/apply', { method: 'POST', cookie: auth.cookie, body: {} });
    assert.strictEqual(r.status, 202, r.body);
    assert.strictEqual(r.json.state, 'applying');

    const st = await pollUntilSettled(server.baseUrl, auth.cookie);
    assert.strictEqual(st.state, 'done', JSON.stringify(st.findings));

    const { entries, dumps } = await captureCards(server.baseUrl, auth.cookie);
    assert.deepStrictEqual(entries.map(e => e.id).sort(), ['notes', 'weight']);
    assert.deepStrictEqual(dumps.weight, WEIGHT_ROWS);
    assert.deepStrictEqual(dumps.notes, NOTES_ROWS);
    assert.ok(!entries.some(e => e.id === 'welcome'), 'the welcome card survived the import');
  });

  test('abort clears the finished job', async () => {
    const r = await req(server.baseUrl, '/api/import/abort', { method: 'POST', cookie: auth.cookie, body: {} });
    assert.strictEqual(r.status, 200, r.body);
    assert.strictEqual(r.json.ok, true);
    const st = await req(server.baseUrl, '/api/import/status', { cookie: auth.cookie });
    assert.strictEqual(st.json.state, 'idle');
    const again = await req(server.baseUrl, '/api/import/abort', { method: 'POST', cookie: auth.cookie, body: {} });
    assert.strictEqual(again.status, 409, again.body);
    assert.strictEqual(again.json.code, 'BAD_STATE');
  });
});

describe('import over HTTP: populated target, nonce, rollback', { skip }, () => {
  let auth;
  let home;
  let server;
  let fixture;
  let preImport;
  let nonce;

  before(async () => {
    fixture = await buildTreeZip([card('weight', WEIGHT_ROWS), card('notes', NOTES_ROWS)]);
    auth = fakeAuthState();
    home = createSandbox({
      credentials: auth.credentials,
      sessions: auth.sessions,
      seed: { 'old.json': card('old', OLD_ROWS) },
    });
    server = await spawnServer(home);
    preImport = await captureCards(server.baseUrl, auth.cookie);
    assert.deepStrictEqual(preImport.dumps.old, OLD_ROWS, 'the populated target never got its data');
  });

  after(async () => {
    if (server) await server.kill();
    cleanupSandbox(home);
  });

  test('start returns requiresConfirm true and the nonce exactly once', async () => {
    const up = await binPost(server.baseUrl, '/api/import/upload', fixture.zipBuf, auth.cookie);
    assert.strictEqual(up.status, 200, up.body);
    const r = await req(server.baseUrl, '/api/import/start', { method: 'POST', cookie: auth.cookie, body: {} });
    assert.strictEqual(r.status, 200, r.body);
    assert.strictEqual(r.json.state, 'awaiting-confirm');
    assert.strictEqual(r.json.requiresConfirm, true);
    assert.match(r.json.confirmNonce, /^[0-9a-f]{32}$/);
    assert.deepStrictEqual(r.json.plan,
      { cards: 2, cardsWithData: 2, samplesPushes: 0, reports: 0 });
    nonce = r.json.confirmNonce;

    const st = await req(server.baseUrl, '/api/import/status', { cookie: auth.cookie });
    assert.strictEqual(st.status, 200, st.body);
    assert.ok(!('confirmNonce' in st.json), 'the nonce was delivered twice');
    assert.strictEqual(st.json.requiresConfirm, true);
  });

  test('a second start answers 409 JOB_ACTIVE', async () => {
    const r = await req(server.baseUrl, '/api/import/start', { method: 'POST', cookie: auth.cookie, body: {} });
    assert.strictEqual(r.status, 409, r.body);
    assert.strictEqual(r.json.code, 'JOB_ACTIVE');
  });

  test('apply without the nonce answers 428; with a wrong nonce answers 428', async () => {
    const bare = await req(server.baseUrl, '/api/import/apply', { method: 'POST', cookie: auth.cookie, body: {} });
    assert.strictEqual(bare.status, 428, bare.body);
    assert.strictEqual(bare.json.code, 'CONFIRM_REQUIRED');
    const wrong = await req(server.baseUrl, '/api/import/apply', {
      method: 'POST', cookie: auth.cookie, body: { nonce: 'f'.repeat(32) },
    });
    assert.strictEqual(wrong.status, 428, wrong.body);
    assert.strictEqual(wrong.json.code, 'CONFIRM_REQUIRED');
    const st = await req(server.baseUrl, '/api/import/status', { cookie: auth.cookie });
    assert.strictEqual(st.json.state, 'awaiting-confirm');
  });

  test('apply with the right nonce answers 202 and settles done; the snapshot exists', async () => {
    const r = await req(server.baseUrl, '/api/import/apply', {
      method: 'POST', cookie: auth.cookie, body: { nonce },
    });
    assert.strictEqual(r.status, 202, r.body);
    assert.strictEqual(r.json.state, 'applying');

    const st = await pollUntilSettled(server.baseUrl, auth.cookie);
    assert.strictEqual(st.state, 'done', JSON.stringify(st.findings));
    assert.ok(st.snapshotPath, 'a populated target took no snapshot');
    assert.ok(fs.existsSync(st.snapshotPath), 'the snapshot is not on disk');

    const { entries, dumps } = await captureCards(server.baseUrl, auth.cookie);
    assert.deepStrictEqual(entries.map(e => e.id).sort(), ['notes', 'weight']);
    assert.deepStrictEqual(dumps.weight, WEIGHT_ROWS);
    const gone = await req(server.baseUrl, '/api/manifests/old', { cookie: auth.cookie });
    assert.strictEqual(gone.status, 404, 'the old card survived the wipe');
  });

  test('rollback answers 202 and polling restores the pre-import state deep-equal', async () => {
    const r = await req(server.baseUrl, '/api/import/rollback', { method: 'POST', cookie: auth.cookie, body: {} });
    assert.strictEqual(r.status, 202, r.body);
    assert.strictEqual(r.json.state, 'applying');
    assert.strictEqual(r.json.rolledBack, true);

    const st = await pollUntilSettled(server.baseUrl, auth.cookie);
    assert.strictEqual(st.state, 'done', JSON.stringify(st.findings));
    assert.strictEqual(st.rolledBack, true);

    const rolled = await captureCards(server.baseUrl, auth.cookie);
    assert.ok(preImport.entries.length > 0, 'empty pre-import state: the comparison would be vacuous');
    assert.deepStrictEqual(rolled.entries, preImport.entries);
    assert.deepStrictEqual(rolled.dumps, preImport.dumps);
  });

  test('rollback again after abort answers 409; a fresh job has no snapshot', async () => {
    const ab = await req(server.baseUrl, '/api/import/abort', { method: 'POST', cookie: auth.cookie, body: {} });
    assert.strictEqual(ab.status, 200, ab.body);
    const r = await req(server.baseUrl, '/api/import/rollback', { method: 'POST', cookie: auth.cookie, body: {} });
    assert.strictEqual(r.status, 409, r.body);
    assert.strictEqual(r.json.code, 'BAD_STATE');
  });
});

describe('import over HTTP: a selection narrows what comes back', { skip }, () => {
  let auth;
  let home;
  let server;
  let fixture;
  let held;
  let nonce;

  before(async () => {
    fixture = await buildTreeZip(
      [card('weight', WEIGHT_ROWS), card('notes', NOTES_ROWS)],
      { pushes: 2, reports: { 'bloods.md': '# Bloods\n\nAll fine.\n' } });
    auth = fakeAuthState();
    home = createSandbox({
      credentials: auth.credentials,
      sessions: auth.sessions,
      seed: { 'old.json': card('old', OLD_ROWS) },
    });
    server = await spawnServer(home);
    held = await captureCards(server.baseUrl, auth.cookie);
    assert.ok(held.entries.length > 0, 'an empty target makes the honest-wipe assertions vacuous');
  });

  after(async () => {
    if (server) await server.kill();
    cleanupSandbox(home);
  });

  test('start offers the archive artefact by artefact, beside what the target holds', async () => {
    const up = await binPost(server.baseUrl, '/api/import/upload', fixture.zipBuf, auth.cookie);
    assert.strictEqual(up.status, 200, up.body);
    const r = await req(server.baseUrl, '/api/import/start', { method: 'POST', cookie: auth.cookie, body: {} });
    assert.strictEqual(r.status, 200, r.body);
    assert.strictEqual(r.json.state, 'awaiting-confirm');
    nonce = r.json.confirmNonce;

    assert.deepStrictEqual(r.json.items.cards.map(c => c.id).sort(), ['notes', 'weight']);
    assert.deepStrictEqual(r.json.items.cards.map(c => c.hae), [false, false]);
    assert.deepStrictEqual(r.json.items.reports.map(x => x.key), ['reports/bloods.md']);
    assert.strictEqual(r.json.items.history.pushes, 2);
    assert.strictEqual(r.json.selection, null, 'nothing is chosen until the caller chooses');
    // The confirm panel has to say what is about to go, so the target's own
    // counts travel with the offer.
    assert.strictEqual(r.json.target.cards, held.entries.length);
  });

  test('a selection this archive cannot satisfy answers 400, with nothing destroyed', async () => {
    const cases = [
      { selection: { cards: ['not-in-here'] }, code: 'SELECTION_INVALID', ref: 'not-in-here' },
      { selection: { reports: ['../../etc/passwd'] }, code: 'SELECTION_INVALID', ref: '../../etc/passwd' },
      { selection: 'everything', code: 'SELECTION_INVALID' },
      { selection: { cards: 'weight' }, code: 'SELECTION_INVALID' },
      { selection: { cards: [], reports: [], history: false }, code: 'SELECTION_EMPTY' },
    ];
    for (const c of cases) {
      const r = await req(server.baseUrl, '/api/import/apply', {
        method: 'POST', cookie: auth.cookie, body: { nonce, selection: c.selection },
      });
      assert.strictEqual(r.status, 400, `${JSON.stringify(c.selection)} -> ${r.status} ${r.body}`);
      assert.strictEqual(r.json.code, c.code, r.body);
      assert.strictEqual(r.json.findings[0].phase, 'select', r.body);
      if (c.ref) assert.ok(r.json.findings.some(f => f.ref === c.ref), r.body);
    }
    const st = await req(server.baseUrl, '/api/import/status', { cookie: auth.cookie });
    assert.strictEqual(st.json.state, 'awaiting-confirm', 'a refused selection moved the job');
    assert.strictEqual(st.json.selection, null);
    assert.strictEqual(st.json.stage, null, 'a refused selection started a stage');
    const kept = await captureCards(server.baseUrl, auth.cookie);
    assert.deepStrictEqual(kept.dumps, held.dumps, 'a refused selection cost the target its data');
  });

  test('the nonce is unspent by the refusals, and the good selection restores just it', async () => {
    const selection = { cards: ['weight'], reports: [], history: false };
    const r = await req(server.baseUrl, '/api/import/apply', {
      method: 'POST', cookie: auth.cookie, body: { nonce, selection },
    });
    assert.strictEqual(r.status, 202, r.body);
    assert.strictEqual(r.json.state, 'applying');
    assert.deepStrictEqual(r.json.selection, selection);

    const st = await pollUntilSettled(server.baseUrl, auth.cookie);
    assert.strictEqual(st.state, 'done', JSON.stringify(st.findings));
    assert.deepStrictEqual(st.verified, { cards: 1, pushes: 0, reports: 0 });
    assert.deepStrictEqual(st.selection, selection);
    // The item list is the confirm panel's input, so the 1.5s apply polls do
    // not carry an entry per card for nothing.
    assert.ok(!('items' in st), 'the apply polls carry the item list');
    assert.ok(!('target' in st), 'the apply polls carry the target summary');

    const { entries, dumps } = await captureCards(server.baseUrl, auth.cookie);
    assert.deepStrictEqual(entries.map(e => e.id), ['weight']);
    assert.deepStrictEqual(dumps.weight, WEIGHT_ROWS);
    assert.ok(!fs.existsSync(path.join(home, 'reports', 'bloods.md')), 'an unticked report landed anyway');
    // Filtered replace, not merge: the card the target held goes with the
    // wipe, and no selection ever protected it.
    const gone = await req(server.baseUrl, '/api/manifests/old', { cookie: auth.cookie });
    assert.strictEqual(gone.status, 404, 'the wipe spared a card the selection never named');
  });
});

describe('detached apply: 202 mid-pipeline, widened freeze gate over HTTP', { skip }, () => {
  let auth;
  let home;
  let server;
  let fixture;

  before(async () => {
    // The pipeline only suspends inside the samples drain (#632), so the
    // observable applying window over HTTP is the drain's duration: 400
    // pushes measure ~2s on this class of machine, wide enough to land
    // every probe below mid-run with no test-only hold hook.
    fixture = await buildTreeZip([card('weight', WEIGHT_ROWS)], { pushes: 400 });
    auth = fakeAuthState();
    home = createSandbox({ credentials: auth.credentials, sessions: auth.sessions });
    server = await spawnServer(home);
    const up = await binPost(server.baseUrl, '/api/import/upload', fixture.zipBuf, auth.cookie);
    assert.strictEqual(up.status, 200, up.body);
    const st = await req(server.baseUrl, '/api/import/start', { method: 'POST', cookie: auth.cookie, body: {} });
    assert.strictEqual(st.status, 200, st.body);
    assert.strictEqual(st.json.requiresConfirm, false);
  });

  after(async () => {
    if (server) await server.kill();
    cleanupSandbox(home);
  });

  test('202 answers mid-pipeline; /api reads 503 IMPORT_FROZEN while applying; done reopens everything', async () => {
    const t0 = Date.now();
    const applied = await req(server.baseUrl, '/api/import/apply', {
      method: 'POST', cookie: auth.cookie, body: {},
    });
    const elapsed202 = Date.now() - t0;
    assert.strictEqual(applied.status, 202, applied.body);
    assert.strictEqual(applied.json.state, 'applying');

    // The job must still be running when the next request lands: a
    // blocking apply would have answered done, and every "mid-pipeline"
    // probe below would be theatre.
    const live = await req(server.baseUrl, '/api/import/status', { cookie: auth.cookie });
    assert.strictEqual(live.status, 200, live.body);
    assert.strictEqual(live.json.state, 'applying',
      'the pipeline finished before the 202 was even observed; the window is gone');

    // WHILE APPLYING: every /api read is refused, superseding the old
    // non-GET-only rule, because mid-pipeline the registry and datastore
    // are transiently wiped and a read would serve wreckage as truth.
    const reads = await req(server.baseUrl, '/api/manifests', { cookie: auth.cookie });
    assert.strictEqual(reads.status, 503,
      `expected the widened gate to refuse plain GETs mid-pipeline: ${reads.status} ${reads.body}`);
    assert.strictEqual(reads.json.code, 'IMPORT_FROZEN');

    const exp = await req(server.baseUrl, '/api/export', { cookie: auth.cookie });
    assert.strictEqual(exp.status, 503, exp.body);
    assert.strictEqual(exp.json.code, 'IMPORT_FROZEN');

    const hae = await req(server.baseUrl, '/api/health-auto-export', { method: 'POST', body: {} });
    assert.strictEqual(hae.status, 503, hae.body);
    assert.strictEqual(hae.json.code, 'IMPORT_FROZEN');

    // The import surface stays live mid-job, answering its own state
    // codes, never the freeze gate's 503.
    const second = await req(server.baseUrl, '/api/import/apply', { method: 'POST', cookie: auth.cookie, body: {} });
    assert.strictEqual(second.status, 409, second.body);
    assert.strictEqual(second.json.code, 'BAD_STATE');
    const abort = await req(server.baseUrl, '/api/import/abort', { method: 'POST', cookie: auth.cookie, body: {} });
    assert.strictEqual(abort.status, 409, abort.body);
    assert.strictEqual(abort.json.code, 'BAD_STATE');

    // Non-vacuous: the job is STILL applying after the probes, so every
    // one of them (the 503s included) was observed inside the window.
    const inWindow = await req(server.baseUrl, '/api/import/status', { cookie: auth.cookie });
    assert.strictEqual(inWindow.json.state, 'applying',
      'the pipeline settled before the probes finished; grow the fixture');

    const st = await pollUntilSettled(server.baseUrl, auth.cookie);
    const settledMs = Date.now() - t0;
    assert.strictEqual(st.state, 'done', JSON.stringify(st.findings));
    assert.deepStrictEqual(st.verified, { cards: 1, pushes: 400, reports: 0 });
    assert.ok(elapsed202 < settledMs / 2,
      `202 took ${elapsed202}ms of a ${settledMs}ms pipeline; the apply is not detached`);

    // The gate released with the pipeline: reads and writes land again.
    const reread = await req(server.baseUrl, '/api/manifests', { cookie: auth.cookie });
    assert.strictEqual(reread.status, 200, reread.body);
    const post = await req(server.baseUrl, '/api/manifests', {
      method: 'POST', cookie: auth.cookie, body: card('post-freeze'),
    });
    assert.strictEqual(post.status, 201, post.body);
  });
});

describe('upload guards and hostile archives', { skip }, () => {
  let auth;
  let home;
  let server;

  before(async () => {
    auth = fakeAuthState();
    home = createSandbox({ credentials: auth.credentials, sessions: auth.sessions });
    server = await spawnServer(home, { KLEBB_IMPORT_MAX_TREE_MB: '1' });
  });

  after(async () => {
    if (server) await server.kill();
    cleanupSandbox(home);
  });

  test('an over-cap upload answers 413 mid-stream and leaves no .part', async () => {
    const r = await binPost(server.baseUrl, '/api/import/upload',
      Buffer.alloc(2 * 1024 * 1024, 0x61), auth.cookie);
    assert.strictEqual(r.status, 413, r.body);
    await waitFor(() => partFilesIn(path.join(home, 'import')).length === 0,
      { what: 'over-cap .part cleanup' });
    assert.ok(!fs.existsSync(path.join(home, 'import', 'upload.zip')), 'the refused upload landed anyway');
  });

  test('an abandoned socket leaves no .part', async () => {
    const r = http.request(new URL('/api/import/upload', server.baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/zip',
        'Content-Length': 512 * 1024,
        Cookie: auth.cookie,
      },
    });
    r.on('error', () => {});
    r.write(Buffer.alloc(64 * 1024, 0x62));
    // Prove the abandon path has a .part to clean, or the wait at the end
    // passes vacuously; only then kill the socket.
    await waitFor(() => partFilesIn(path.join(home, 'import')).length === 1,
      { what: 'the .part to appear before the socket dies' });
    r.destroy();
    await waitFor(() => partFilesIn(path.join(home, 'import')).length === 0,
      { what: 'abandoned .part cleanup' });
  });

  test('a dot-dot zip uploads but start refuses 422 and stages nothing', async () => {
    const up = await binPost(server.baseUrl, '/api/import/upload', buildHostileZip(), auth.cookie);
    assert.strictEqual(up.status, 200, up.body);
    const r = await req(server.baseUrl, '/api/import/start', { method: 'POST', cookie: auth.cookie, body: {} });
    assert.strictEqual(r.status, 422, r.body);
    assert.strictEqual(r.json.code, 'ZIP_NAME');
    const staged = fs.readdirSync(path.join(home, 'import')).filter(n => n.startsWith('staging-'));
    assert.deepStrictEqual(staged, [], 'a refused archive left a staged tree');
    const st = await req(server.baseUrl, '/api/import/status', { cookie: auth.cookie });
    assert.strictEqual(st.json.state, 'idle');
    // A refused archive stays staged; re-upload must replace it in place
    // (rename over an existing file, the Windows-fragile path).
    assert.ok(fs.existsSync(path.join(home, 'import', 'upload.zip')));
    const again = await binPost(server.baseUrl, '/api/import/upload', buildHostileZip(), auth.cookie);
    assert.strictEqual(again.status, 200, again.body);
  });

  test('scan-tree is the operator door for an extracted tree', async () => {
    const fixture = await buildTreeZip([card('weight', WEIGHT_ROWS)]);
    fs.cpSync(fixture.tree, path.join(home, 'import', 'tree'), { recursive: true });
    const r = await req(server.baseUrl, '/api/import/scan-tree', { method: 'POST', cookie: auth.cookie, body: {} });
    assert.strictEqual(r.status, 200, r.body);
    assert.strictEqual(r.json.state, 'awaiting-confirm');
    const ab = await req(server.baseUrl, '/api/import/abort', { method: 'POST', cookie: auth.cookie, body: {} });
    assert.strictEqual(ab.status, 200, ab.body);
  });
});

describe('boot recovery over HTTP', { skip }, () => {
  function applyingJob(home, treePath) {
    return {
      jobId: 'boot-test-01',
      state: 'applying',
      treePath,
      snapshotPath: null,
      confirmNonce: null,
      requiresConfirm: false,
      fresh: true,
      configPlan: 'none',
      startedAt: new Date().toISOString(),
      stage: 'copy',
      wipedOnce: true,
      appliedOnce: true,
      findings: [],
      verified: null,
    };
  }

  test('a job killed mid-copy resumes at boot: tree served, no welcome card', async () => {
    const fixture = await buildTreeZip([card('weight', WEIGHT_ROWS), card('notes', NOTES_ROWS)]);
    const auth = fakeAuthState();
    const home = createSandbox({ credentials: auth.credentials, sessions: auth.sessions });
    // Killed right as the copy stage began: the wipe ran (data/ is empty, so
    // an unrecovered boot WOULD seed a welcome card over it), the staged
    // tree survives, job.json says applying.
    const staged = path.join(home, 'import', 'staging-1');
    fs.cpSync(fixture.tree, staged, { recursive: true });
    fs.writeFileSync(path.join(home, 'import', 'job.json'),
      JSON.stringify(applyingJob(home, staged), null, 2));

    const server = await spawnServer(home);
    try {
      // The resume runs detached behind the freeze gate (#633): boot
      // answers at once, and status is the window into the running job.
      const st = await pollUntilSettled(server.baseUrl, auth.cookie);
      assert.strictEqual(st.state, 'done', JSON.stringify(st.findings));
      assert.strictEqual(st.recovered, true);

      const { entries, dumps } = await captureCards(server.baseUrl, auth.cookie);
      assert.deepStrictEqual(entries.map(e => e.id).sort(), ['notes', 'weight']);
      assert.deepStrictEqual(dumps.weight, WEIGHT_ROWS);
      assert.ok(!entries.some(e => e.id === 'welcome'),
        'first-boot seeding ran before recovery: welcome card planted over the import');
    } finally {
      await server.kill();
      cleanupSandbox(home);
    }
  });

  test('tree and snapshot both gone: boot refuses to serve, /healthz stays live', async () => {
    const auth = fakeAuthState();
    const home = createSandbox({ credentials: auth.credentials, sessions: auth.sessions });
    fs.mkdirSync(path.join(home, 'import'), { recursive: true });
    fs.writeFileSync(path.join(home, 'import', 'job.json'),
      JSON.stringify(applyingJob(home, path.join(home, 'import', 'staging-gone')), null, 2));

    const server = await spawnServer(home);
    try {
      const m = await req(server.baseUrl, '/api/manifests', { cookie: auth.cookie });
      assert.strictEqual(m.status, 503, m.body);
      assert.strictEqual(m.json.code, 'IMPORT_RECOVERY_FAILED');
      assert.match(m.json.reason, /neither the staged tree nor the rollback snapshot/);

      const h = await req(server.baseUrl, '/healthz');
      assert.strictEqual(h.status, 200, h.body);

      const st = await req(server.baseUrl, '/api/import/status', { cookie: auth.cookie });
      assert.strictEqual(st.status, 200, st.body);
      assert.strictEqual(st.json.state, 'applying');

      // Rollback is reachable through the gate; with no snapshot it can only
      // report the truth.
      const rb = await req(server.baseUrl, '/api/import/rollback', { method: 'POST', cookie: auth.cookie, body: {} });
      assert.strictEqual(rb.status, 409, rb.body);
    } finally {
      await server.kill();
      cleanupSandbox(home);
    }
  });
});
