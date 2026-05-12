// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests-e2e/helpers/global-setup.js
// Boots an ephemeral klebb server + sandbox for the entire E2E run.
// Writes connection info to tests-e2e/.state/state.json so specs can
// read it. The returned function is called by Playwright as teardown,
// which kills the server and removes the sandbox.

const fs = require('fs');
const path = require('path');
const {
  createSandbox,
  cleanupSandbox,
  spawnServer,
  fakeAuthState,
} = require('../../tests/helpers/sandbox');
const { seedManifests } = require('./seed-manifests');

const STATE_DIR = path.join(__dirname, '..', '.state');
const STATE_FILE = path.join(STATE_DIR, 'state.json');

module.exports = async () => {
  fs.mkdirSync(STATE_DIR, { recursive: true });

  const auth = fakeAuthState('e2e-user');
  const seed = seedManifests();

  const sandbox = createSandbox({
    seed,
    credentials: auth.credentials,
    sessions: auth.sessions,
  });

  // Pin the sandbox server's TZ to match the host. Node's default
  // when TZ is unset is UTC for Intl/Date.toLocaleDateString, which
  // drifts from the browser's local TZ and trips writeable-card
  // date-allowance checks when the UTC date is a day behind local.
  // Intl.DateTimeFormat().resolvedOptions() gives us the host zone
  // in a portable way (Windows doesn't expose IANA names via TZ).
  const hostTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const server = await spawnServer(sandbox, { TZ: hostTz });

  const state = {
    sandbox,
    baseUrl: server.baseUrl,
    port: server.port,
    sessionToken: auth.token,
    sessionCookie: auth.cookie,
    startedAt: new Date().toISOString(),
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

  process.env.KLEBB_E2E_BASE_URL = server.baseUrl;

  console.log(`[e2e] sandbox ready: ${server.baseUrl}`);

  return async () => {
    try { await server.kill(); } catch {}
    cleanupSandbox(sandbox);
    try { fs.unlinkSync(STATE_FILE); } catch {}
    console.log('[e2e] sandbox torn down');
  };
};
