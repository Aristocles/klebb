// SPDX-License-Identifier: AGPL-3.0-only
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { git, verifyTrackedTree, observeOwnedProcess, allClosed,
  waitForClosure, stopOwnedProcesses, cleanupSandbox } = require('./helpers/legacy-health-producer');

function home() { return fs.mkdtempSync(path.join(os.tmpdir(), 'eh-test-')); }

test('a startup child cannot lose its fixture before actual exit and stream close', async () => {
  const directory = home();
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  observeOwnedProcess(child, directory);
  try {
    assert.equal(allClosed(directory), false);
    assert.throws(() => cleanupSandbox(directory), /closure unproved/);
    assert.equal(fs.existsSync(directory), true);
    await stopOwnedProcesses(directory);
    assert.equal(allClosed(directory), true);
    cleanupSandbox(directory);
    assert.equal(fs.existsSync(directory), false);
  } finally {
    await stopOwnedProcesses(directory);
    if (fs.existsSync(directory)) cleanupSandbox(directory);
  }
});

test('fixture deletion requires actual close notification separately from parent exit', async () => {
  const directory = home();
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  const originalEmit = child.emit;
  let closeArguments;
  let resolveClose;
  let rejectClose;
  let forwarded = false;
  const actualClose = new Promise((resolve, reject) => {
    resolveClose = resolve; rejectClose = reject;
  });
  const deadline = setTimeout(() => rejectClose(new Error('Actual child close was not received')), 10000);
  // Hold only delivery of the real native close event. No event is fabricated,
  // and no platform assumption about a grandchild inheriting pipes is needed.
  child.emit = function(event, ...args) {
    if (event === 'close') { closeArguments = args; resolveClose(); return true; }
    return originalEmit.call(this, event, ...args);
  };
  const releaseClose = () => {
    if (closeArguments && !forwarded) {
      forwarded = true;
      child.emit = originalEmit;
      originalEmit.call(child, 'close', ...closeArguments);
    }
  };
  observeOwnedProcess(child, directory);
  try {
    await once(child, 'exit', { signal: AbortSignal.timeout(10000) });
    await actualClose;
    clearTimeout(deadline);
    assert.deepEqual(closeArguments, [0, null]);
    assert.equal(allClosed(directory), false);
    assert.throws(() => cleanupSandbox(directory), /closure unproved/);
    assert.equal(fs.existsSync(directory), true);
    releaseClose();
    await waitForClosure(directory);
    assert.equal(allClosed(directory), true);
    cleanupSandbox(directory);
    assert.equal(fs.existsSync(directory), false);
  } finally {
    clearTimeout(deadline);
    child.emit = originalEmit;
    releaseClose();
    await stopOwnedProcesses(directory);
    if (fs.existsSync(directory)) cleanupSandbox(directory);
  }
});

test('pinned physical source refuses an edit hidden from normal Git status', () => {
  const directory = home();
  const envKeys = ['Git_Dir', 'Git_Work_Tree'];
  const saved = envKeys.map(key => [key, process.env[key]]);
  try {
    git(['init', '--quiet'], directory);
    fs.writeFileSync(path.join(directory, 'server.js'), 'fixture source\n');
    git(['add', 'server.js'], directory);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
      '-c', 'commit.gpgsign=false',
      'commit', '--quiet', '-m', 'Controlled source fixture'], directory);
    const tree = git(['rev-parse', 'HEAD^{tree}'], directory);
    assert.equal(verifyTrackedTree(directory, tree), 1);
    // These keys must not redirect provenance to an unrelated directory on Windows.
    process.env.Git_Dir = path.join(directory, 'absent-git');
    process.env.Git_Work_Tree = path.join(directory, 'absent-tree');
    assert.equal(verifyTrackedTree(directory, tree), 1);
    git(['update-index', '--assume-unchanged', 'server.js'], directory);
    fs.writeFileSync(path.join(directory, 'server.js'), 'different fixture source\n');
    assert.equal(git(['status', '--porcelain'], directory), '');
    assert.throws(() => verifyTrackedTree(directory, tree), /source bytes differ/);
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('scoped Git ignores inherited default config and never invokes its fsmonitor', () => {
  const directory = home();
  const repo = path.join(directory, 'repo');
  const profileHome = path.join(directory, 'profile-home');
  const profileXdg = path.join(directory, 'profile-xdg');
  const marker = path.join(directory, 'fsmonitor-invoked');
  const hook = path.join(directory, 'fsmonitor-marker.cjs');
  const explicitConfig = path.join(directory, 'inherited-config');
  const keys = ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME',
    'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM'];
  const controlled = key => keys.some(name => name.toLowerCase() === key.toLowerCase());
  const saved = Object.entries(process.env).filter(([key]) => controlled(key));
  try {
    fs.mkdirSync(repo);
    git(['init', '--quiet'], repo);
    fs.writeFileSync(path.join(repo, 'server.js'), 'controlled source\n');
    git(['add', 'server.js'], repo);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
      '-c', 'commit.gpgsign=false',
      'commit', '--quiet', '-m', 'Controlled config fixture'], repo);
    const tree = git(['rev-parse', 'HEAD^{tree}'], repo);
    fs.mkdirSync(profileHome);
    fs.mkdirSync(path.join(profileXdg, 'git'), { recursive: true });
    fs.writeFileSync(hook, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'invoked');\n`
      + `process.stdout.write('fixture-token\\0');\n`);
    const command = [process.execPath, hook]
      .map(value => '"' + value.replace(/\\/g, '/').replace(/"/g, '\\"') + '"').join(' ');
    const config = '[core]\n\tfsmonitor = ' + JSON.stringify(command)
      + '\n[fixture]\n\tinheritedProfileSentinel = parent-only\n';
    fs.writeFileSync(path.join(profileHome, '.gitconfig'), config);
    fs.writeFileSync(path.join(profileXdg, 'git', 'config'), config);
    fs.writeFileSync(explicitConfig, config);
    process.env.HOME = profileHome;
    process.env.USERPROFILE = profileHome;
    process.env.XDG_CONFIG_HOME = profileXdg;
    process.env.GIT_CONFIG_GLOBAL = explicitConfig;
    process.env.GIT_CONFIG_SYSTEM = explicitConfig;
    process.env.GIT_CONFIG_NOSYSTEM = '0';
    // Marker absence alone could be masked by the per-command fsmonitor override.
    // This separate sentinel assertion proves the default config is unavailable.
    assert.throws(() => git(['config', '--get', 'fixture.inheritedProfileSentinel'], repo),
      error => error.status === 1);
    // A local/worktree setting must also lose to the scoped fsmonitor override.
    git(['config', '--local', 'core.fsmonitor', command], repo);
    git(['diff', '--quiet', '--no-ext-diff', '--no-textconv', 'HEAD', '--'], repo);
    assert.equal(git(['status', '--porcelain', '--untracked-files=all'], repo), '');
    assert.equal(fs.existsSync(marker), false, 'Unpinned fsmonitor must never execute');
    assert.equal(verifyTrackedTree(repo, tree), 1);
  } finally {
    for (const key of Object.keys(process.env)) if (controlled(key)) delete process.env[key];
    for (const [key, value] of saved) process.env[key] = value;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
