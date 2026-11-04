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
const authorityPath = home => path.join(home, 'credentials', 'health-connect-policy.json');
const legacyPath = home => path.join(home, 'credentials', 'health-connect.json');
const bytes = home => fs.readFileSync(authorityPath(home));
const legacyBytes = home => fs.readFileSync(legacyPath(home));
const catalogue = home => JSON.parse(bytes(home));
const state = home => {
  const entries = catalogue(home).namespaces;
  return { grants: entries.flatMap(entry => entry.state.grants),
    connectors: entries.flatMap(entry => entry.state.connectors) };
};
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function selectGrant(home, approved, saved = catalogue(home)) {
  assert.equal(saved.version, 2);
  const matches = saved.namespaces.filter(entry =>
    entry.state.tenantId === approved.tenantId &&
    entry.state.instanceId === approved.instanceId &&
    entry.state.restoreEpoch === approved.restoreEpoch);
  assert.equal(matches.length, 1, 'exact namespace from healthy seed response');
  const [entry] = matches;
  const grants = entry.state.grants.filter(item =>
    item.sourceStoreId === approved.sourceStoreId &&
    item.verifier === `sha256:${hash(approved.grant)}`);
  assert.equal(grants.length, 1, 'actual saved grant from healthy seed response');
  const [savedGrant] = grants;
  return { state: entry.state, grant: savedGrant };
}
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
    INDEPENDENT_FREEZE_FILE: legacyPath(home),
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
    const approved = await grant(server, data.owner);
    await server.kill(); server = null;
    const legacyBefore = legacyBytes(data.home);
    const malformed = catalogue(data.home);
    const selected = selectGrant(data.home, approved, malformed);
    assert.equal(selected.state.grants.length, 1);
    assert.equal(selected.state.connectors.length, 0);
    assert.equal(selected.grant.consumedAt, null);
    selected.grant.verifier = [selected.grant.verifier];
    fs.writeFileSync(authorityPath(data.home), JSON.stringify(malformed));
    const before = bytes(data.home);
    server = await spawnServer(data.home, ENV);
    const listed = await req(server.baseUrl, BASE, { cookie: data.owner.cookie });
    const issued = await req(server.baseUrl, GRANTS, {
      method: 'POST', cookie: data.owner.cookie, headers: { Origin: ORIGIN },
      body: { categories: ['StepsRecord'], name: 'Must not issue' },
    });
    const exchanged = await req(server.baseUrl, EXCHANGE, {
      method: 'POST', body: frame(approved),
    });
    console.log(JSON.stringify({ case: 'malformed-verifier-array',
      list: observed(listed, data.home, before), grant: observed(issued, data.home, before),
      exchange: observed(exchanged, data.home, before) }));
    deny(listed, 503, 'storage-unavailable');
    deny(issued, 503, 'storage-unavailable');
    deny(exchanged, 503, 'storage-unavailable');
    assert.deepEqual(bytes(data.home), before);
    assert.deepEqual(legacyBytes(data.home), legacyBefore, 'neutral V1 authority is unchanged');
  } finally {
    if (server) await server.kill();
    cleanupSandbox(data.home);
  }
});
test('malformed retained V1 verifier still fences authority without rewriting bytes', async () => {
  const seed = fixture(), retained = fixture();
  let server;
  try {
    server = await spawnServer(seed.home, ENV);
    const approved = await grant(server, seed.owner);
    const selected = selectGrant(seed.home, approved);
    assert.equal(selected.state.grants.length, 1);
    assert.equal(selected.state.connectors.length, 0);
    assert.equal(selected.grant.consumedAt, null);
    await server.kill(); server = null;
    fs.writeFileSync(legacyPath(retained.home), JSON.stringify(selected.state));
    server = await spawnServer(retained.home, ENV);
    const healthy = await req(server.baseUrl, BASE, { cookie: retained.owner.cookie });
    assert.equal(healthy.status, 200, 'valid retained V1 fixture before corruption');
    await server.kill(); server = null;
    const malformed = JSON.parse(legacyBytes(retained.home));
    const matches = malformed.grants.filter(item =>
      item.sourceStoreId === approved.sourceStoreId &&
      item.verifier === `sha256:${hash(approved.grant)}`);
    assert.equal(matches.length, 1);
    const [savedGrant] = matches;
    savedGrant.verifier = [savedGrant.verifier];
    fs.writeFileSync(legacyPath(retained.home), JSON.stringify(malformed));
    const before = legacyBytes(retained.home);
    server = await spawnServer(retained.home, ENV);
    const listed = await req(server.baseUrl, BASE, { cookie: retained.owner.cookie });
    const issued = await req(server.baseUrl, GRANTS, {
      method: 'POST', cookie: retained.owner.cookie, headers: { Origin: ORIGIN },
      body: { categories: ['StepsRecord'], name: 'Must not issue' },
    });
    const exchanged = await req(server.baseUrl, EXCHANGE, {
      method: 'POST', body: frame(approved),
    });
    deny(listed, 503, 'storage-unavailable');
    deny(issued, 503, 'storage-unavailable');
    deny(exchanged, 503, 'storage-unavailable');
    assert.deepEqual(legacyBytes(retained.home), before);
    assert.equal(fs.existsSync(authorityPath(retained.home)), false);
  } finally {
    if (server) await server.kill();
    cleanupSandbox(seed.home);
    cleanupSandbox(retained.home);
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
      const legacyBefore = legacyBytes(data.home);
      const selected = selectGrant(data.home, approved);
      assert.equal(selected.state.grants.length, 1);
      assert.equal(selected.state.connectors.length, 0);
      assert.equal(selected.grant.consumedAt, null);
      server = await spawnServer(data.home, faultEnv(data.home, fault));
      const response = await req(server.baseUrl, EXCHANGE, {
        method: 'POST', body: frame(approved),
      });
      console.log(JSON.stringify({ case: fault, ...observed(response, data.home, before) }));
      assert.equal(fs.readFileSync(path.join(data.home, 'fault-fired.txt'), 'utf8'), fault);
      deny(response, 503, 'storage-unavailable');
      assert.deepEqual(bytes(data.home), before, 'failure did not consume grant or add connector');
      assert.deepEqual(legacyBytes(data.home), legacyBefore, 'neutral V1 authority is unchanged');
      const refused = selectGrant(data.home, approved);
      assert.equal(refused.state.grants.length, 1);
      assert.equal(refused.state.connectors.length, 0);
      assert.equal(refused.grant.consumedAt, null);
      assert.equal(fs.readdirSync(path.dirname(authorityPath(data.home)))
        .filter(name => name.startsWith('health-connect-policy.json.') && name.endsWith('.tmp')).length, 0);
      await server.kill(); server = null;
      server = await spawnServer(data.home, ENV);
      const retried = await req(server.baseUrl, EXCHANGE, {
        method: 'POST', body: frame(approved),
      });
      assert.equal(retried.status, 200, 'same unconsumed grant is usable after fault removal');
      assert.equal(retried.json.kind, 'paired');
      const paired = selectGrant(data.home, approved);
      assert.equal(paired.state.connectors.length, 1);
      assert.equal(paired.state.grants.length, 1);
      assert.ok(paired.grant.consumedAt);
      assert.deepEqual(legacyBytes(data.home), legacyBefore, 'managed pairing preserves V1 bytes');
    } finally {
      if (server) await server.kill();
      cleanupSandbox(data.home);
    }
  });
}
