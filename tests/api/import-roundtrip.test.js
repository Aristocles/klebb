// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/api/import-roundtrip.test.js
// The HTTP-level proof that export-then-import round-trips: seed a real
// server through its API (cards, an HAE push, an uploaded report), export,
// import into a fresh home, boot a second server, and compare everything the
// API serves. Plus the hostile trees a CLI user can actually hand it, and
// the crash-between-copy-and-import state converging at boot.
//
// spawnServer only in this file; the exporter and importer run strictly as
// subprocesses, never fresh-required in-process (mixing the two harnesses in
// one file leaves the runner hanging even when every test passes).

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');
const {
  createSandbox, cleanupSandbox, spawnServer, req, fakeAuthState, waitFor, REPO_ROOT,
} = require('../helpers/sandbox');

process.env.HEALTH_HOME_WARNED = '1';

let sqliteAvailable = true;
try { require('node:sqlite'); } catch { sqliteAvailable = false; }
const skip = sqliteAvailable ? false : 'node:sqlite unavailable on this Node';

const CLI = path.join(REPO_ROOT, 'scripts', 'import-tree.js');
const EXPORT = path.join(REPO_ROOT, 'scripts', 'export-embed.js');
const MANIFEST_NAME = 'klebb-export.json';

const WEIGHT_ROWS = [
  { date: '2026-06-01', kg: 81.2 },
  { date: '2026-06-02', kg: 80.9 },
  { date: '2026-06-03', kg: 80.4 },
];
const STEP_PUSHES = [
  { date: '2026-06-01', qty: 8123 },
  { date: '2026-06-02', qty: 9541 },
];
const REPORT_FILE = 'bloods.txt';
const REPORT_BODY = 'haemoglobin 147 g/L\ncholesterol 4.9 mmol/L\n';

function cardBody(id, label, metaExtra = {}) {
  return { $schema: 'klebb.datafile.v1', meta: { id, label, ...metaExtra } };
}

function haePayload({ date, qty }) {
  return {
    data: {
      metrics: [
        { name: 'step_count', units: 'count', data: [{ date: `${date} 00:00:00 +1000`, qty }] },
      ],
    },
  };
}

function runNode(args, env = {}) {
  const r = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    cwd: REPO_ROOT,
    env: { ...process.env, HEALTH_HOME_WARNED: '1', ...env },
  });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '', out: (r.stdout || '') + (r.stderr || '') };
}

function runImport(args) {
  return runNode([CLI, ...args]);
}

// Raw-body upload, same contract the browser client uses.
function upload(baseUrl, filename, body, cookie) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(body);
    const r = http.request(new URL('/api/reports/upload', baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': payload.length,
        'X-Klebb-Filename': encodeURIComponent(filename),
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

// Everything the API says about the cards: the listing (meta, hasData,
// enabled) plus each card's served data.
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

async function captureReports(baseUrl, cookie) {
  const env = await req(baseUrl, '/api/reports', { cookie });
  assert.strictEqual(env.status, 200, env.body);
  const texts = {};
  const sources = {};
  for (const rep of env.json.reports) {
    const t = await req(baseUrl, `/api/reports/${rep.name}/text`, { cookie });
    assert.strictEqual(t.status, 200, t.body);
    texts[rep.name] = t.body;
    if (rep.hasSource) {
      const s = await req(baseUrl, `/api/reports/${rep.name}/source`, { cookie });
      assert.strictEqual(s.status, 200, s.body);
      sources[rep.name] = s.body;
    }
  }
  return { envelope: env.json, texts, sources };
}

// Only read once every server on the home has exited: a second handle on a
// live WAL home is the two-writers flake.
function countSql(home, sql) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(home, 'db', 'klebb.db'));
  try {
    return Number(db.prepare(sql).get().n);
  } finally {
    db.close();
  }
}

describe('import round trip over HTTP', { skip }, () => {
  let auth;
  let homeA;
  let tree;
  let treeManifest;
  let ground;
  const scratch = [];

  function scratchDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eh-rt-'));
    scratch.push(dir);
    return dir;
  }

  function copyOfTree() {
    const dst = path.join(scratchDir(), 'tree');
    fs.cpSync(tree, dst, { recursive: true });
    return dst;
  }

  before(async () => {
    auth = fakeAuthState();
    homeA = createSandbox({ credentials: auth.credentials, sessions: auth.sessions });
    const serverA = await spawnServer(homeA);
    const { baseUrl } = serverA;
    const cookie = auth.cookie;

    const cards = [
      cardBody('weight', 'Weight', {
        view: { enabled: true, component: 'generic-card', display: { template: '{kg} kg' } },
        writeable: { fromWebapp: true, pastAllowed: true },
      }),
      cardBody('journal', 'Journal', { writeable: { fromWebapp: true } }),
      cardBody('placeholder', 'Placeholder'),
      cardBody('steps', 'Steps', {
        ingest: { source: 'hae', metric: 'step_count' },
        writeable: { fromWebapp: false },
      }),
    ];
    for (const body of cards) {
      const r = await req(baseUrl, '/api/manifests', { method: 'POST', body, cookie });
      assert.strictEqual(r.status, 201, r.body);
    }

    const w = await req(baseUrl, '/api/manifests/weight/data', {
      method: 'POST', body: { data: WEIGHT_ROWS }, cookie,
    });
    assert.strictEqual(w.status, 200, w.body);

    // A real recorded null, distinct from never having held data.
    const n = await req(baseUrl, '/api/manifests/journal/data', {
      method: 'POST', body: { data: null }, cookie,
    });
    assert.strictEqual(n.status, 200, n.body);

    const mint = await req(baseUrl, '/api/health-auto-export/token', { method: 'POST', cookie });
    assert.strictEqual(mint.status, 200, mint.body);
    for (const push of STEP_PUSHES) {
      const r = await req(baseUrl, '/api/health-auto-export', {
        method: 'POST',
        headers: { Authorization: `Bearer ${mint.json.token}` },
        body: haePayload(push),
      });
      assert.strictEqual(r.status, 200, r.body);
    }

    const up = await upload(baseUrl, REPORT_FILE, REPORT_BODY, cookie);
    assert.strictEqual(up.status, 202, up.body);
    await waitFor(async () => {
      const r = await req(baseUrl, '/api/reports', { cookie });
      return r.json && r.json.reports.length === 1 && r.json.processing.length === 0;
    }, { what: 'uploaded report to land' });

    const del = await req(baseUrl, '/api/manifests/welcome', { method: 'DELETE', cookie });
    assert.strictEqual(del.status, 200, del.body);

    ground = {
      cards: await captureCards(baseUrl, cookie),
      reports: await captureReports(baseUrl, cookie),
    };

    await serverA.kill();

    tree = path.join(scratchDir(), 'tree');
    const exp = runNode([EXPORT, tree], { HEALTH_HOME: homeA });
    assert.strictEqual(exp.code, 0, exp.out);
    assert.match(exp.stdout, /Exported 4 card\(s\)/);
    treeManifest = JSON.parse(fs.readFileSync(path.join(tree, MANIFEST_NAME), 'utf8'));
  });

  after(() => {
    cleanupSandbox(homeA);
    while (scratch.length) {
      try { fs.rmSync(scratch.pop(), { recursive: true, force: true }); } catch {}
    }
  });

  test('the export inventory matches what was seeded over the API', () => {
    const byId = Object.fromEntries(treeManifest.inventory.cards.map(c => [c.id, c]));
    assert.deepStrictEqual(Object.keys(byId).sort(), ['journal', 'placeholder', 'steps', 'weight']);
    assert.strictEqual(byId.weight.data, 'embedded');
    assert.strictEqual(byId.weight.rows, WEIGHT_ROWS.length);
    assert.strictEqual(byId.steps.data, 'embedded');
    assert.strictEqual(byId.steps.rows, STEP_PUSHES.length);
    assert.strictEqual(byId.journal.data, 'null');
    assert.strictEqual(byId.placeholder.data, 'none');
    assert.strictEqual(treeManifest.inventory.samples.pushes, STEP_PUSHES.length);
    const reportFiles = treeManifest.inventory.reports.map(r => r.file).sort();
    assert.strictEqual(reportFiles.length, 2, `expected the report and its archived original, got ${reportFiles}`);
    assert.ok(reportFiles.some(f => f.endsWith('bloods.md')), `no report in ${reportFiles}`);
    assert.ok(reportFiles.some(f => f.startsWith('reports/_archive/')), `no archived original in ${reportFiles}`);
  });

  describe('full round trip into a fresh home', () => {
    let homeB;
    let serverB;
    let stateB;
    let hadWelcomeBeforeImport;
    let dry;
    let applied;

    before(async () => {
      homeB = createSandbox({ credentials: auth.credentials, sessions: auth.sessions });
      // One boot makes it factory-fresh the way a real new instance is:
      // seeded welcome card, welcome data recorded.
      const b0 = await spawnServer(homeB);
      const list0 = await req(b0.baseUrl, '/api/manifests', { cookie: auth.cookie });
      hadWelcomeBeforeImport = list0.json.entries.some(e => e.id === 'welcome');
      await b0.kill();

      dry = runImport([tree, '--target', homeB]);
      applied = runImport([tree, '--apply', '--target', homeB]);

      serverB = await spawnServer(homeB);
      stateB = {
        cards: await captureCards(serverB.baseUrl, auth.cookie),
        reports: await captureReports(serverB.baseUrl, auth.cookie),
      };
    });

    after(async () => {
      if (serverB) await serverB.kill();
      cleanupSandbox(homeB);
    });

    test('dry run validates the factory-fresh home clean; apply reports ok', () => {
      assert.strictEqual(dry.code, 0, dry.out);
      assert.match(dry.stdout, /Dry run/);
      assert.match(dry.stdout, /Tree validates/);
      assert.strictEqual(applied.code, 0, applied.out);
      assert.match(applied.stdout, /status: ok/);
    });

    test('every card the API served on A is served identically on B', () => {
      assert.ok(ground.cards.entries.length > 0, 'ground truth has no cards: empty-vs-empty would pass vacuously');
      assert.strictEqual(ground.cards.entries.length, 4);
      // Ground truth itself must be the seeded data, or the comparison
      // below proves nothing.
      assert.deepStrictEqual(ground.cards.dumps.weight, WEIGHT_ROWS);
      assert.deepStrictEqual(stateB.cards.entries, ground.cards.entries);
      assert.deepStrictEqual(stateB.cards.dumps, ground.cards.dumps);
    });

    test('the null-data card serves null, the never-held card grew nothing', () => {
      // hasData deliberately reports a stored null as false, so over HTTP the
      // two cards look alike; the recorded-vs-never distinction is pinned at
      // the tree level (inventory 'null' vs 'none') and in the datastore by
      // the refusal-legs and crash-convergence tests below.
      for (const state of [ground, stateB]) {
        const byId = Object.fromEntries(state.cards.entries.map(e => [e.id, e]));
        assert.strictEqual(byId.journal.hasData, false);
        assert.strictEqual(byId.placeholder.hasData, false, 'a never-held-data card grew data');
        assert.strictEqual(state.cards.dumps.journal, null);
        assert.strictEqual(state.cards.dumps.placeholder, null);
      }
    });

    test('the HAE-built card serves identical rows', () => {
      assert.ok(Array.isArray(ground.cards.dumps.steps), 'HAE ingest built no rows on A');
      assert.strictEqual(ground.cards.dumps.steps.length, STEP_PUSHES.length);
      assert.deepStrictEqual(
        ground.cards.dumps.steps.map(r => r.date).sort(),
        STEP_PUSHES.map(p => p.date),
      );
      assert.deepStrictEqual(stateB.cards.dumps.steps, ground.cards.dumps.steps);
    });

    test('the uploaded report is listed and served identically', () => {
      assert.strictEqual(ground.reports.envelope.reports.length, 1, 'no report landed on A');
      const name = ground.reports.envelope.reports[0].name;
      assert.match(ground.reports.texts[name], /haemoglobin 147 g\/L/);
      assert.strictEqual(ground.reports.sources[name], REPORT_BODY);
      assert.deepStrictEqual(stateB.reports.envelope, ground.reports.envelope);
      assert.deepStrictEqual(stateB.reports.texts, ground.reports.texts);
      assert.deepStrictEqual(stateB.reports.sources, ground.reports.sources);
    });

    test('the welcome card is absent after import', async () => {
      assert.strictEqual(hadWelcomeBeforeImport, true,
        'the pre-import boot never seeded a welcome card, so its absence proves nothing');
      assert.ok(!stateB.cards.entries.some(e => e.id === 'welcome'));
      const r = await req(serverB.baseUrl, '/api/manifests/welcome', { cookie: auth.cookie });
      assert.strictEqual(r.status, 404, r.body);
    });

    test('a second run against the now-populated home refuses, naming the legs', async () => {
      await serverB.kill();
      const r = runImport([tree, '--target', homeB]);
      assert.strictEqual(r.code, 1, r.out);
      assert.match(r.out, /VAL_TARGET_NOT_FRESH/);
      assert.match(r.out, /4 non-welcome card file\(s\) in data\//);
      // 3, not 4: the recorded-null card holds a datastore record, the
      // never-held-data card does not. This count IS the distinction.
      assert.match(r.out, /3 non-welcome card\(s\) in the datastore/);
      assert.match(r.out, /2 HAE push\(es\) recorded/);
      assert.match(r.out, /Refused/);
    });
  });

  describe('hostile trees at the CLI', () => {
    test('a planted webauthn file refuses and the target is untouched', () => {
      const bad = copyOfTree();
      fs.writeFileSync(path.join(bad, 'data', 'webauthn-credentials.json'), '{"users":{}}');
      const target = scratchDir();
      const r = runImport([bad, '--target', target]);
      assert.strictEqual(r.code, 1, r.out);
      assert.match(r.out, /VAL_FORBIDDEN_FILE/);
      assert.match(r.out, /Refused/);
      assert.deepStrictEqual(fs.readdirSync(target), [], 'a refused dry run wrote into the target');
    });

    test('a duplicated card id refuses', () => {
      const bad = copyOfTree();
      fs.copyFileSync(path.join(bad, 'data', 'weight.json'), path.join(bad, 'data', 'weight-again.json'));
      const r = runImport([bad, '--target', scratchDir()]);
      assert.strictEqual(r.code, 1, r.out);
      assert.match(r.out, /VAL_DUP_ID/);
    });

    test('a tree without klebb-export.json refuses', () => {
      const bad = copyOfTree();
      fs.rmSync(path.join(bad, MANIFEST_NAME));
      const r = runImport([bad, '--target', scratchDir()]);
      assert.strictEqual(r.code, 1, r.out);
      assert.match(r.out, /VAL_NO_MANIFEST/);
    });
  });

  describe('crash between copy and import', () => {
    test('a torn apply converges on the next boot and holds on the one after', async () => {
      // Exactly the state a crash between copy and import leaves: card files
      // still carrying their data keys, samples.json still in the inbox.
      const homeC = createSandbox({ credentials: auth.credentials, sessions: auth.sessions });
      try {
        fs.cpSync(path.join(tree, 'data'), path.join(homeC, 'data'), { recursive: true });

        let server = await spawnServer(homeC);
        const first = await captureCards(server.baseUrl, auth.cookie);
        await server.kill();
        assert.ok(first.entries.length > 0, 'boot import produced no cards: empty-vs-empty would pass vacuously');
        assert.strictEqual(first.entries.length, 4);
        assert.deepStrictEqual(first.dumps, ground.cards.dumps);

        server = await spawnServer(homeC);
        const second = await captureCards(server.baseUrl, auth.cookie);
        await server.kill();
        assert.deepStrictEqual(second.entries, first.entries);
        assert.deepStrictEqual(second.dumps, first.dumps);

        // Both servers have exited: safe to read the datastore directly.
        assert.strictEqual(countSql(homeC, 'SELECT COUNT(*) AS n FROM hae_pushes'),
          STEP_PUSHES.length, 'HAE pushes doubled or never arrived');
        assert.strictEqual(countSql(homeC, "SELECT COUNT(*) AS n FROM rows WHERE card_id = 'weight'"),
          WEIGHT_ROWS.length, 'card rows doubled across restarts');
        assert.strictEqual(countSql(homeC, "SELECT COUNT(*) AS n FROM cards WHERE card_id = 'journal'"),
          1, 'the recorded null was not recorded');
        assert.strictEqual(countSql(homeC, "SELECT COUNT(*) AS n FROM cards WHERE card_id = 'placeholder'"),
          0, 'a never-held-data card grew a record');

        const autoExport = fs.readdirSync(path.join(homeC, 'data', 'auto-export'));
        assert.ok(!autoExport.includes('samples.json'), 'samples.json was not drained at boot');
        assert.strictEqual(autoExport.filter(n => n.startsWith('samples.json.imported-')).length, 1);
      } finally {
        cleanupSandbox(homeC);
      }
    });
  });
});
