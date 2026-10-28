// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const product = path.resolve(__dirname, '../..');
const { createSandbox, cleanupSandbox, spawnServer, req, fakeAuthState } =
  require(path.join(product, 'tests/helpers/sandbox'));
const ORIGIN = 'https://owner-a.klebb.app';
const BASE = '/api/connectors/health-connect';
const GRANTS = `${BASE}/pairing-grants`;
const EXCHANGE = `${BASE}/v1/pairing/exchange`;
const ENV = {
  HEALTH_ORIGIN: ORIGIN, HEALTH_RP_ID: 'owner-a.klebb.app',
  AGENT_API_TOKEN: '', KLEBB_ADMIN_TOKEN: '', KLEBB_CLOUD: '', KLEBB_DEMO: '',
  HEALTH_DATA_DIR: '', HEALTH_REPORTS_DIR: '', HEALTH_AUTO_EXPORT_DIR: '',
  HEALTH_SESSIONS_DIR: '', HEALTH_CREDENTIALS_DIR: '', HEALTH_ARCHIVE_DIR: '',
  HEALTH_CONFIG_PATH: '', HEALTH_DB_DIR: '', HEALTH_DB_FILE: '', HEALTH_CHAT_DIR: '',
  HEALTH_USER_FILE: '', HEALTH_NOTIFICATIONS_STATE_FILE: '', HEALTH_INBOX_DIR: '',
  HEALTH_KEYS_DIR: '', HEALTH_VAPID_FILE: '', HEALTH_PUSH_SUBSCRIPTIONS_FILE: '',
  HEALTH_AUTO_EXPORT_TOKEN: '', NODE_OPTIONS: '',
};
const authorityPath = home => path.join(home, 'credentials', 'health-connect.json');
const bytes = home => fs.readFileSync(authorityPath(home));
const state = home => JSON.parse(bytes(home));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function fixture() {
  const owner = fakeAuthState('owner-a');
  return { owner, home: createSandbox({ credentials: owner.credentials, sessions: owner.sessions }) };
}
async function grant(server, owner) {
  const response = await req(server.baseUrl, GRANTS, {
    method: 'POST', cookie: owner.cookie, headers: { Origin: ORIGIN },
    body: { categories: ['StepsRecord'], name: 'Independent synthetic phone' },
  });
  assert.equal(response.status, 201, 'valid synthetic seed grant');
  return response.json;
}
const frame = approved => ({
  version: 1, kind: 'pairing-exchange',
  tenantId: approved.tenantId, instanceId: approved.instanceId, grant: approved.grant,
  installationId: 'independent-synthetic-installation', sourceStoreId: approved.sourceStoreId,
  categories: ['StepsRecord'],
});
function faultEnv(home, fault) {
  const preload = path.join(__dirname, '../helpers/health-connect-authority-fault-preload.cjs')
    .replaceAll('\\', '/');
  return { ...ENV, NODE_OPTIONS: `--require "${preload}"`,
    INDEPENDENT_AUTHORITY_FILE: authorityPath(home),
    INDEPENDENT_FAULT_MARKER: path.join(home, 'fault-fired.txt'),
    INDEPENDENT_FAULT: fault,
    INDEPENDENT_FREEZE_MODULE: path.join(product, 'lib/import/freeze.js'),
  };
}
function observed(response, home, before) {
  return {
    status: response.status, code: response.json?.code || null,
    kind: response.json?.kind || null,
    issuedSecret: Boolean(response.json?.credential || response.json?.grant),
    unchangedBytes: hash(bytes(home)) === hash(before),
    grants: state(home).grants.length, connectors: state(home).connectors.length,
    faultFired: fs.existsSync(path.join(home, 'fault-fired.txt')),
  };
}
function deny(response, status, code) {
  assert.equal(response.status, status);
  assert.equal(response.json?.code, code);
  assert.equal(Boolean(response.json?.credential || response.json?.grant), false);
}
test('malformed persisted verifier array fences every authority request without rewriting bytes', async () => {
  const data = fixture();
  let server;
  try {
    server = await spawnServer(data.home, ENV);
    await grant(server, data.owner);
    await server.kill(); server = null;
    const malformed = state(data.home);
    malformed.grants[0].verifier = [malformed.grants[0].verifier];
    fs.writeFileSync(authorityPath(data.home), JSON.stringify(malformed));
    const before = bytes(data.home);
    server = await spawnServer(data.home, ENV);
    const listed = await req(server.baseUrl, BASE, { cookie: data.owner.cookie });
    const issued = await req(server.baseUrl, GRANTS, {
      method: 'POST', cookie: data.owner.cookie, headers: { Origin: ORIGIN },
      body: { categories: ['StepsRecord'], name: 'Must not issue' },
    });
    console.log(JSON.stringify({ case: 'malformed-verifier-array',
      list: observed(listed, data.home, before), grant: observed(issued, data.home, before) }));
    deny(listed, 503, 'storage-unavailable');
    deny(issued, 503, 'storage-unavailable');
    assert.deepEqual(bytes(data.home), before);
  } finally {
    if (server) await server.kill();
    cleanupSandbox(data.home);
  }
});
test('freeze engaged after entry prevents resumed body from issuing a pairing grant', async () => {
  const data = fixture();
  let server;
  try {
    server = await spawnServer(data.home, ENV);
    await grant(server, data.owner);
    await server.kill(); server = null;
    const before = bytes(data.home);
    server = await spawnServer(data.home, faultEnv(data.home, 'freeze-after-entry'));
    const response = await req(server.baseUrl, GRANTS, {
      method: 'POST', cookie: data.owner.cookie, headers: { Origin: ORIGIN },
      body: { categories: ['StepsRecord'], name: 'Frozen must not issue' },
    });
    console.log(JSON.stringify({ case: 'freeze-after-entry', ...observed(response, data.home, before) }));
    assert.equal(fs.readFileSync(path.join(data.home, 'fault-fired.txt'), 'utf8'), 'freeze-after-entry');
    deny(response, 503, 'IMPORT_FROZEN');
    assert.deepEqual(bytes(data.home), before);
  } finally {
    if (server) await server.kill();
    cleanupSandbox(data.home);
  }
});
for (const fault of ['write-enospc', 'rename-eio']) {
  test(`${fault} refuses exchange before issuing credential or consuming grant`, async () => {
    const data = fixture();
    let server;
    try {
      server = await spawnServer(data.home, ENV);
      const approved = await grant(server, data.owner);
      await server.kill(); server = null;
      const before = bytes(data.home);
      server = await spawnServer(data.home, faultEnv(data.home, fault));
      const response = await req(server.baseUrl, EXCHANGE, {
        method: 'POST', body: frame(approved),
      });
      console.log(JSON.stringify({ case: fault, ...observed(response, data.home, before) }));
      assert.equal(fs.readFileSync(path.join(data.home, 'fault-fired.txt'), 'utf8'), fault);
      deny(response, 503, 'storage-unavailable');
      assert.deepEqual(bytes(data.home), before, 'failure did not consume grant or add connector');
      assert.equal(fs.readdirSync(path.dirname(authorityPath(data.home)))
        .filter(name => name.startsWith('health-connect.json.') && name.endsWith('.tmp')).length, 0);
      await server.kill(); server = null;
      server = await spawnServer(data.home, ENV);
      const retried = await req(server.baseUrl, EXCHANGE, {
        method: 'POST', body: frame(approved),
      });
      assert.equal(retried.status, 200, 'same unconsumed grant is usable after fault removal');
      assert.equal(retried.json.kind, 'paired');
      assert.equal(state(data.home).connectors.length, 1);
      assert.ok(state(data.home).grants[0].consumedAt);
    } finally {
      if (server) await server.kill();
      cleanupSandbox(data.home);
    }
  });
}
