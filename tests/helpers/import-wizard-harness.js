// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/helpers/import-wizard-harness.js
// Shared scaffolding for the import wizard + boot recovery suites: scratch
// homes seeded through the real datastore handles, source trees produced by
// the real export (subprocess, so the parent's require cache stays clean),
// and a fresh-require module generation bound to a target home.
//
// The generation trick: config/paths resolves HEALTH_HOME at require time,
// so every module that touches the home (registry, samples, inbox, wizard)
// is purged and re-required per target. Callers must tear a generation down
// (close handles) before removing its home, or Windows file locks keep the
// tmp dir alive.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const EXPORT_CLI = path.join(REPO_ROOT, 'scripts', 'export-embed.js');
const WELCOME_FIXTURE = path.join(REPO_ROOT, 'server', 'first-boot', 'welcome.klebb.json');

function card(id, extra = {}) {
  return { $schema: 'klebb.datafile.v1', meta: { id, label: id, ...(extra.meta || {}) }, ...omit(extra, 'meta') };
}

function omit(obj, key) {
  const out = { ...obj };
  delete out[key];
  return out;
}

function norm(value) {
  return JSON.parse(JSON.stringify(value === undefined ? null : value));
}

function stepPush(date, qty) {
  return {
    receivedAt: `${date}T00:00:00.000Z`,
    payload: { data: { metrics: [{ name: 'step_count', units: 'count', data: [{ date, qty }] }] } },
  };
}

function purgeRepoModules() {
  const testsDir = path.join(REPO_ROOT, 'tests') + path.sep;
  const nodeModules = path.sep + 'node_modules' + path.sep;
  for (const key of Object.keys(require.cache)) {
    if (!key.startsWith(REPO_ROOT + path.sep)) continue;
    if (key.includes(nodeModules)) continue;
    if (key.startsWith(testsDir)) continue;
    delete require.cache[key];
  }
}

// Seed a home through the real write paths, with explicit file paths so the
// parent process needs no HEALTH_HOME of its own.
function seedHome(home, { cards = {}, rows = {}, pushes = [], welcome = false, config = null, reports = {} } = {}) {
  const dataDir = path.join(home, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  if (welcome) {
    fs.copyFileSync(WELCOME_FIXTURE, path.join(dataDir, 'welcome.klebb.json'));
  }
  for (const [name, content] of Object.entries(cards)) {
    fs.writeFileSync(path.join(dataDir, name), JSON.stringify(content, null, 2));
  }
  if (Object.keys(rows).length) {
    const { open } = require(path.join(REPO_ROOT, 'lib', 'datastore'));
    const store = open(path.join(home, 'db', 'klebb.db'));
    store.load();
    for (const [id, value] of Object.entries(rows)) store.setData(id, value);
    store.close();
  }
  if (pushes.length) {
    const samples = require(path.join(REPO_ROOT, 'health-auto-export', 'samples'));
    const dbFile = path.join(home, 'db', 'klebb.db');
    for (const p of pushes) samples.recordPush(p.payload, { receivedAt: p.receivedAt, dbFile });
    samples.close();
  }
  if (config) {
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(config, null, 2));
  }
  for (const [name, body] of Object.entries(reports)) {
    fs.mkdirSync(path.join(home, 'reports'), { recursive: true });
    fs.writeFileSync(path.join(home, 'reports', name), body);
  }
  return home;
}

// Build an export tree by seeding a scratch source home and running the real
// export CLI against it in a subprocess. Returns { tree, src }.
function buildSourceTree(spec, tmpDirs) {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'eh-wiz-src-'));
  tmpDirs.push(src);
  seedHome(src, spec);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'eh-wiz-tree-'));
  tmpDirs.push(base);
  const tree = path.join(base, 'tree');
  const r = spawnSync(process.execPath, [EXPORT_CLI, tree], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
    env: { ...process.env, HEALTH_HOME: src, HEALTH_HOME_WARNED: '1' },
  });
  if (r.status !== 0) {
    throw new Error(`export failed: ${r.stdout}\n${r.stderr}`);
  }
  return { tree, src };
}

// Fresh module generation bound to `home`, with the registry inited the way
// a live server would have it. deps.store IS the registry's handle.
function targetGen(home) {
  process.env.HEALTH_HOME = home;
  process.env.HEALTH_HOME_WARNED = '1';
  purgeRepoModules();
  const registry = require(path.join(REPO_ROOT, 'manifests', 'registry'));
  const samples = require(path.join(REPO_ROOT, 'health-auto-export', 'samples'));
  const samplesInbox = require(path.join(REPO_ROOT, 'health-auto-export', 'samples-inbox'));
  const { exportTo } = require(path.join(REPO_ROOT, 'scripts', 'export-embed'));
  const { createImporter } = require(path.join(REPO_ROOT, 'lib', 'datastore', 'import'));
  const wizardMod = require(path.join(REPO_ROOT, 'lib', 'import', 'wizard'));
  const recoverMod = require(path.join(REPO_ROOT, 'lib', 'import', 'recover'));
  const freeze = require(path.join(REPO_ROOT, 'lib', 'import', 'freeze'));
  registry.init();
  const store = registry.store();
  const deps = { home, registry, store, samples, samplesInbox, exportTo, importerFactory: createImporter };
  return { home, registry, store, samples, samplesInbox, freeze, deps, wizardMod, recoverMod };
}

function teardownGen(gen) {
  if (!gen) return;
  try { gen.registry.stopWatch(); } catch {}
  try { gen.registry.closeStore(); } catch {}
  try { gen.samples.close(); } catch {}
  try { gen.freeze.release(); } catch {}
}

// Durable-state readers with their own short-lived handles: usable from a
// parent process that never owned the home.
function withStore(home, fn) {
  const { open } = require(path.join(REPO_ROOT, 'lib', 'datastore'));
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

function preImportBackups(home) {
  try {
    return fs.readdirSync(path.join(home, 'data')).filter(n => n.includes('.pre-import-'));
  } catch {
    return [];
  }
}

function readJobFile(home) {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, 'import', 'job.json'), 'utf8'));
  } catch {
    return null;
  }
}

module.exports = {
  REPO_ROOT,
  WELCOME_FIXTURE,
  card,
  norm,
  stepPush,
  purgeRepoModules,
  seedHome,
  buildSourceTree,
  targetGen,
  teardownGen,
  withStore,
  countSql,
  pushCountOf,
  preImportBackups,
  readJobFile,
};
