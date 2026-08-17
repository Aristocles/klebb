// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/registry-watch-quiesce.test.js
// stopWatch/resumeWatch: quiescing the fs.watch pipeline before a bulk
// mutation (wipe-then-reimport). The failure this pins: closing the watcher
// alone leaves a debounced reload already queued by an event from just
// before the stop, and that timer fires a reload mid-wipe. stopWatch must
// cancel it; resumeWatch must re-register exactly as init() does.
//
// Fresh-require registry tests only — never mix spawnServer sandbox tests
// into this file (require-cache purge makes the runner hang).

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createSandbox, cleanupSandbox } = require('./helpers/sandbox');

const REPO_ROOT = path.resolve(__dirname, '..');
const MANIFESTS_DIR = path.resolve(REPO_ROOT, 'manifests') + path.sep;
const CONFIG_DIR = path.resolve(REPO_ROOT, 'config') + path.sep;

function freshRegistry(sandboxRoot) {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(MANIFESTS_DIR) || key.startsWith(CONFIG_DIR)) {
      delete require.cache[key];
    }
  }
  process.env.HEALTH_HOME = sandboxRoot;
  return require(path.join(REPO_ROOT, 'manifests', 'registry.js'));
}

function card(id) {
  return {
    $schema: 'klebb.datafile.v1',
    meta: { id, label: id, view: { enabled: true, component: 'generic-card' } },
  };
}

function writeCard(sandbox, name, content) {
  fs.writeFileSync(path.join(sandbox, 'data', name), JSON.stringify(content, null, 2));
}

function has(registry, id) {
  return registry.list().some(c => c.id === id);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitFor(fn, ms = 8000, step = 25) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await sleep(step);
  }
  return fn();
}

describe('registry watch quiesce', () => {
  test('stopWatch cancels the queued debounced reload; resumeWatch re-arms', async () => {
    const sandbox = createSandbox({ seed: { 'a.json': card('a') } });
    const registry = freshRegistry(sandbox);
    try {
      registry.init();
      assert.ok(has(registry, 'a'));

      // Control leg: prove touch -> fs event -> debounce -> reload works in
      // this sandbox, so the quiesce leg below cannot pass vacuously.
      writeCard(sandbox, 'b.json', card('b'));
      assert.ok(await waitFor(() => has(registry, 'b')),
        'fs.watch chain never delivered a reload; the quiesce assertions would be vacuous');

      // Quiesce leg: arm a debounced reload (event delivered, 250ms timer
      // pending), then stopWatch before it fires. stopWatch returns true only
      // when it cancelled a pending reload, so a retry loop guarantees the
      // timer really was in flight.
      let cancelled = false;
      for (let attempt = 0; attempt < 20 && !cancelled; attempt++) {
        writeCard(sandbox, 'c.json', card('c'));
        await sleep(100); // long enough for event delivery, well inside the 250ms debounce
        cancelled = registry.stopWatch();
        if (!cancelled) registry.resumeWatch();
      }
      assert.ok(cancelled, 'never caught a pending debounced reload to cancel');

      await sleep(600); // well past the debounce window
      assert.ok(!has(registry, 'c'),
        'the queued reload fired after stopWatch: the debounce timer was not cleared');

      // resumeWatch re-registers the watcher: the next touch reloads, and the
      // rescan picks up c as well.
      registry.resumeWatch();
      writeCard(sandbox, 'd.json', card('d'));
      assert.ok(await waitFor(() => has(registry, 'd')),
        'no reload after resumeWatch: the watcher was not re-registered');
      assert.ok(has(registry, 'c'));
    } finally {
      registry.stopWatch();
      registry.closeStore();
      cleanupSandbox(sandbox);
    }
  });

  test('stopWatch with nothing pending is a quiet no-op, twice over', () => {
    const sandbox = createSandbox({ seed: { 'a.json': card('a') } });
    const registry = freshRegistry(sandbox);
    try {
      registry.init();
      assert.strictEqual(registry.stopWatch(), false);
      assert.strictEqual(registry.stopWatch(), false);
      assert.strictEqual(registry.reload().count, 1, 'manual reload stays callable while quiesced');
    } finally {
      registry.closeStore();
      cleanupSandbox(sandbox);
    }
  });
});
