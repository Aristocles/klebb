// SPDX-License-Identifier: AGPL-3.0-only
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('the actual Docker source allowlist can load the connector authority', () => {
  const root = path.resolve(__dirname, '..');
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'health-runtime-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'health-runtime-home-'));
  try {
    // Resolve literal application COPY sources from the actual runtime stage.
    // Dependencies use the installed modules, matching the separate deps COPY.
    const docker = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8').replace(/\\\r?\n\s*/g, ' ');
    for (const line of docker.split(/\r?\n/)) {
      if (!line.startsWith('COPY --chown=klebb:klebb ') || line.includes('/usr/')) continue;
      const sources = line.trim().split(/\s+/).slice(2, -1);
      for (const source of sources) {
        const target = path.join(runtime, source);
        fs.cpSync(path.join(root, source), target, { recursive: true });
      }
    }
    const result = spawnSync(process.execPath, ['-e',
      "require('./lib/health-connect/authority'); process.stdout.write('authority-loaded')"], {
      cwd: runtime, encoding: 'utf8', timeout: 15000,
      env: { ...process.env, HEALTH_HOME: home, KLEBB_SKIP_HOME_ENV: '1',
        NODE_PATH: path.join(root, 'node_modules'), HEALTH_HOME_WARNED: '1',
        HEALTH_ORIGIN: 'https://runtime.example.test', HEALTH_RP_ID: 'runtime.example.test' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes('authority-loaded'));
  } finally {
    for (const directory of [runtime, home]) {
      assert.ok(fs.realpathSync(directory).startsWith(fs.realpathSync(os.tmpdir()) + path.sep));
      assert.match(path.basename(directory), /^health-runtime-(home-)?/);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
});
