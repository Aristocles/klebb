// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/registry-close-store.test.js
//
// registry.closeStore() in isolation. Lives in its own file because it purges
// the require cache to get a fresh registry against a fresh HEALTH_HOME, and
// mixing that with spawnServer tests hangs the runner (see CLAUDE.md).

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

describe('registry.closeStore', () => {
  test('closeStore is idempotent and safe before the store is opened', () => {
    // _shutdown may run more than once (SIGTERM then SIGINT), and a process that
    // dies before init must not throw on the way out.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'klebb-closestore-'));
    fs.mkdirSync(path.join(home, 'data'), { recursive: true });
    const previous = process.env.HEALTH_HOME;
    process.env.HEALTH_HOME = home;
    process.env.HEALTH_HOME_WARNED = '1';
    const purge = () => {
      for (const key of Object.keys(require.cache)) {
        if (/[\\/](config[\\/]paths|manifests[\\/]registry|lib[\\/]datastore)/.test(key)) {
          delete require.cache[key];
        }
      }
    };
    purge();
    try {
      const registry = require('../manifests/registry');
      // Never opened: a no-op, not a throw.
      assert.equal(registry.closeStore(), false);
      registry.init();
      assert.equal(registry.closeStore(), true);
      // Second call must not throw or claim to have closed anything.
      assert.equal(registry.closeStore(), false);
    } finally {
      if (previous === undefined) delete process.env.HEALTH_HOME;
      else process.env.HEALTH_HOME = previous;
      purge();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

});
