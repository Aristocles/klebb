// SPDX-License-Identifier: AGPL-3.0-only
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ROOT = path.join(REPO_ROOT, 'tmp', 'health-connect-v1-producer');
const REVISION = '8ba9a9adb302ec0fe3e742af8c267b0f83227940';
const TREE = '09989ff894ab11e0c41d1d1fd42f8fce734bee66';
const originalSpawn = childProcess.spawn;
const attempts = new Map();

function git(args, cwd = ROOT) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^GIT_/i.test(key)) delete env[key];
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'eh-test-git-config-'));
  const config = path.join(directory, 'config');
  let directoryAdmitted = false;
  let descriptor;
  let identity;
  let failure;
  const checkEmptyConfig = () => {
    directDirectory(directory);
    const current = fs.lstatSync(config);
    const opened = fs.fstatSync(descriptor);
    assert.equal(current.isFile(), true); assert.equal(current.isSymbolicLink(), false);
    assert.equal(opened.isFile(), true);
    assert.deepEqual([current.dev, current.ino, current.size], [identity.dev, identity.ino, 0]);
    assert.deepEqual([opened.dev, opened.ino, opened.size], [identity.dev, identity.ino, 0]);
  };
  try {
    directDirectory(directory);
    directoryAdmitted = true;
    descriptor = fs.openSync(config, 'wx', 0o600);
    identity = fs.fstatSync(descriptor);
    checkEmptyConfig();
    // An owned empty regular file works as a config filename on every supported platform.
    env.GIT_CONFIG_GLOBAL = config;
    env.GIT_CONFIG_SYSTEM = config;
    env.GIT_CONFIG_NOSYSTEM = '1';
    return childProcess.execFileSync('git', ['--no-replace-objects',
      '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
      '-c', 'core.autocrlf=false', '-c', 'core.eol=lf', ...args], {
      cwd, env, encoding: 'utf8', timeout: 30000, windowsHide: true,
      maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      try { if (descriptor !== undefined) checkEmptyConfig(); }
      finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
      // No recursive removal: unexpected entries or failed custody retain the directory.
      if (descriptor !== undefined) fs.unlinkSync(config);
      if (directoryAdmitted) fs.rmdirSync(directory);
    } catch (cleanupError) {
      if (failure) throw new AggregateError([failure, cleanupError], 'Scoped Git config cleanup failed');
      throw cleanupError;
    }
  }
}

function directDirectory(directory) {
  const entry = fs.lstatSync(directory);
  assert.equal(entry.isDirectory(), true);
  assert.equal(entry.isSymbolicLink(), false);
  const real = fs.realpathSync(directory);
  assert.equal(process.platform === 'win32' ? real.toLowerCase() : real,
    process.platform === 'win32' ? directory.toLowerCase() : directory);
}

function verifyTrackedTree(directory, tree) {
  directDirectory(directory);
  const rows = git(['ls-tree', '-r', '-z', '--full-tree', tree], directory)
    .split('\0').filter(Boolean);
  const names = new Set();
  for (const row of rows) {
    const match = /^(100644|100755) blob ([0-9a-f]{40})\t(.+)$/.exec(row);
    assert.ok(match, 'Pinned producer requires direct regular tracked source');
    const [, , expected, relative] = match;
    assert.equal(names.has(relative), false); names.add(relative);
    assert.equal(relative.split('/').some(part => !part || part === '.' || part === '..'), false);
    const target = path.resolve(directory, ...relative.split('/'));
    assert.equal(path.relative(directory, target).startsWith('..'), false);
    assert.equal(fs.realpathSync(target), target);
    const before = fs.lstatSync(target);
    assert.equal(before.isFile(), true); assert.equal(before.isSymbolicLink(), false);
    const bytes = fs.readFileSync(target);
    const after = fs.lstatSync(target);
    assert.deepEqual([after.dev, after.ino, after.size, after.mtimeMs],
      [before.dev, before.ino, before.size, before.mtimeMs]);
    const actual = crypto.createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`))
      .update(bytes).digest('hex');
    assert.equal(actual, expected, 'Pinned producer source bytes differ');
  }
  return rows.length;
}

function verifyProducer(checkDependencies = true) {
  directDirectory(ROOT);
  assert.equal(git(['rev-parse', 'HEAD']), REVISION);
  assert.equal(git(['rev-parse', 'HEAD^{tree}']), TREE);
  assert.equal(verifyTrackedTree(ROOT, TREE), 899);
  git(['diff', '--quiet', '--no-ext-diff', '--no-textconv', 'HEAD', '--']);
  assert.equal(git(['status', '--porcelain', '--untracked-files=all']), '');
  for (const name of ['.env', 'data', 'credentials', 'sessions']) {
    assert.equal(fs.existsSync(path.join(ROOT, name)), false);
  }
  if (checkDependencies) {
    assert.equal(fs.existsSync(path.join(ROOT, 'node_modules', '.package-lock.json')), true);
  }
}

function observeOwnedProcess(proc, home, phase = 'controlled') {
  const row = { proc, phase, exitObserved: false, closeObserved: false, error: null };
  if (!attempts.has(home)) attempts.set(home, []);
  attempts.get(home).push(row);
  proc.on('error', error => { row.error = error; });
  proc.on('exit', () => { row.exitObserved = true; });
  proc.on('close', () => { row.closeObserved = true; });
  return row;
}

function captureSpawn(executable, argv, options) {
  assert.equal(executable, process.execPath);
  assert.ok(options.cwd === ROOT || options.cwd === REPO_ROOT);
  assert.deepEqual(argv, [path.join(options.cwd, 'server.js')]);
  assert.equal(options.env.HOST, '127.0.0.1');
  const phase = options.cwd === ROOT ? 'warm-original' : 'cold-candidate';
  const rows = attempts.get(options.env.HEALTH_HOME) || [];
  if (phase === 'cold-candidate' && !rows.some(row => row.phase === phase)) {
    const warm = rows.filter(row => row.phase === 'warm-original');
    assert.ok(warm.length && warm.every(row => row.exitObserved && row.closeObserved),
      'Actual warm EXIT and CLOSE required before the first cold launch');
  }
  const proc = originalSpawn.call(childProcess, executable, argv, options);
  observeOwnedProcess(proc, options.env.HEALTH_HOME, phase);
  return proc;
}

function loadSandbox(directory) {
  const filename = path.join(directory, 'tests', 'helpers', 'sandbox.js');
  assert.equal(require.cache[require.resolve(filename)], undefined,
    'Server helper must capture the owned spawn observer on its first import');
  const previous = childProcess.spawn;
  childProcess.spawn = captureSpawn;
  try { return require(filename); }
  finally { childProcess.spawn = previous; }
}

// Both factories capture the actual spawn before a child can start or retry.
const sandbox = loadSandbox(REPO_ROOT);
let producerSandbox = null;
const allClosed = home => (attempts.get(home) || [])
  .every(row => row.exitObserved && row.closeObserved);
async function waitForClosure(home) {
  await sandbox.waitFor(() => allClosed(home), {
    timeoutMs: 10000, what: 'every owned server EXIT and stdout/stderr CLOSE',
  });
}

async function stopOwnedProcesses(home) {
  const timers = [];
  try {
    for (const row of attempts.get(home) || []) {
      if (row.exitObserved || !Number.isInteger(row.proc.pid)) continue;
      try { row.proc.kill('SIGTERM'); } catch {}
      timers.push(setTimeout(() => {
        if (!row.exitObserved) { try { row.proc.kill('SIGKILL'); } catch {} }
      }, 2000));
    }
    await waitForClosure(home);
  } finally { for (const timer of timers) clearTimeout(timer); }
}

function admitProducer() {
  // The original complete physical source is admitted before any fixture files.
  verifyProducer();
  if (!producerSandbox) producerSandbox = loadSandbox(ROOT);
}

function createSandbox(options) {
  admitProducer();
  return sandbox.createSandbox(options);
}

function cleanupSandbox(home) {
  assert.equal(allClosed(home), true, 'Owned child closure unproved; fixture home retained');
  sandbox.cleanupSandbox(home);
  assert.equal(fs.existsSync(home), false, 'Owned fixture cleanup did not complete');
  attempts.delete(home);
}

async function spawnOwnedServer(factory, home, env, original) {
  try {
    const server = await factory.spawnServer(home, env);
    const originalKill = server.kill.bind(server);
    return { ...server, kill: async () => {
      await originalKill();
      await waitForClosure(home);
      if (original) verifyProducer();
    } };
  } catch (error) {
    try { await stopOwnedProcesses(home); }
    catch (closureError) {
      throw new AggregateError([error, closureError], 'Server startup failed; owned fixture retained');
    }
    throw error;
  }
}

async function spawnProducerServer(home, env) {
  verifyProducer();
  assert.ok(producerSandbox, 'Original producer must be admitted before fixture creation');
  return spawnOwnedServer(producerSandbox, home, env, true);
}
const spawnCandidateServer = (home, env) => spawnOwnedServer(sandbox, home, env, false);

module.exports = { ROOT, REVISION, TREE, git, verifyProducer, verifyTrackedTree,
  admitProducer, createSandbox, cleanupSandbox, spawnProducerServer, spawnCandidateServer,
  observeOwnedProcess, allClosed, waitForClosure, stopOwnedProcesses };
