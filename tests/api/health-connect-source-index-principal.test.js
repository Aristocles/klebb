// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fakeAuthState } = require('../helpers/sandbox');
const { SESSION_SECRET } = require('../helpers/health-connect-ready-collection-fixture.cjs');
const {
  fixture, close, restart, first, postBatch, ownerStatus, waitForStatus,
  req, STATUS, REBUILD, ORIGIN, TARGET, coldReadSourceState, assertFirstNative,
} = require('../helpers/health-connect-source-index-test-fixture.cjs');

function cold(data) {
  return {
    saved: coldReadSourceState(data.home),
    policy: fs.readFileSync(path.join(data.home, 'credentials', 'health-connect-policy.json')),
    legacy: fs.readFileSync(path.join(data.home, 'credentials', 'health-connect.json')),
    members: fs.readFileSync(path.join(data.home, 'credentials', 'webauthn.json')),
  };
}

test('an authenticated account label matching a retained owner UUID cannot acquire projection authority',
  { timeout: 30000 }, async () => {
    const data = await fixture({ SESSION_SECRET });
    try {
      const vector = first(data);
      const committed = await postBatch(data, vector);
      assert.equal(committed.status, 200, 'genuine ready source commits the first ordinary vector');
      assert.deepEqual(committed.json, vector.receipt);
      const current = await waitForStatus(data, result => result.sources?.length === 1 &&
        result.sources[0].sourceStoreId === data.binding.sourceStoreId &&
        result.sources[0].state === 'current' &&
        result.sources[0].saved.frontiers[0]?.acknowledgedSequence === '1' &&
        result.sources[0].published?.frontiers[0]?.acknowledgedSequence === '1');
      assert.equal(current.status, 200, 'the genuinely bound owner reads its current source');
      assertFirstNative(coldReadSourceState(data.home).native, data);

      await data.server.kill();
      data.server = null;
      const credentialsFile = path.join(data.home, 'credentials', 'webauthn.json');
      const sessionsFile = path.join(data.home, 'sessions', 'webauthn.json');
      const policyFile = path.join(data.home, 'credentials', 'health-connect-policy.json');
      const policyBytes = fs.readFileSync(policyFile);
      const catalogue = JSON.parse(policyBytes.toString('utf8'));
      const owned = catalogue.namespaces.filter(namespace =>
        namespace.state.tenantId === data.binding.tenantId &&
        namespace.state.connectors.some(connector => connector.sourceStoreId === data.binding.sourceStoreId));
      assert.equal(owned.length, 1, 'the real managed source has exactly one registered namespace');
      const ownerId = owned[0].ownerId;
      assert.match(ownerId, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
      const principal = catalogue.principals.find(item => item.ownerId === ownerId);
      assert.ok(principal?.members.some(member =>
        member.userId === data.owner.sessions[data.owner.token].userId &&
        member.credentialId === data.owner.credentialId), 'the original owner retains its real member binding');

      // The collision changes only an invented account label, never its authority.
      const collision = fakeAuthState(ownerId);
      assert.notEqual(collision.credentialId, data.owner.credentialId);
      assert.equal(catalogue.principals.some(item => item.members.some(member =>
        member.userId === ownerId && member.credentialId === collision.credentialId)), false);
      const credentials = JSON.parse(fs.readFileSync(credentialsFile, 'utf8'));
      const sessions = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'));
      assert.equal(Object.hasOwn(credentials.users, ownerId), false);
      credentials.users[ownerId] = collision.credentials.users[ownerId];
      fs.writeFileSync(credentialsFile, JSON.stringify(credentials));
      fs.writeFileSync(sessionsFile, JSON.stringify({ ...sessions, ...collision.sessions }));
      data.markers.push(collision.token);
      const before = cold(data);
      assert.deepEqual(before.policy, policyBytes, 'adding a valid member does not bind a principal');
      await restart(data, { ...data.extraEnv, SESSION_SECRET });
      assert.deepEqual(cold(data), before, 'restart preserves committed source and catalogue bytes');

      const authenticated = await req(data.server.baseUrl, '/auth/status', { cookie: collision.cookie });
      assert.equal(authenticated.status, 200);
      assert.equal(authenticated.json.setup, true);
      assert.equal(authenticated.json.authenticated, true, 'the colliding member has a valid current session');
      const status = await req(data.server.baseUrl, STATUS, {
        cookie: collision.cookie, headers: { Origin: ORIGIN },
      });
      assert.equal(status.status, 403, 'an unbound label is not a retained owner UUID');
      assert.deepEqual(status.json, { target: TARGET, code: 'scope-mismatch', retryable: false });
      assert.deepEqual(cold(data), before, 'status refusal changes no saved or authority state');
      const rebuild = await req(data.server.baseUrl, REBUILD, {
        method: 'POST', cookie: collision.cookie, headers: { Origin: ORIGIN }, body: {},
      });
      assert.equal(rebuild.status, 403);
      assert.deepEqual(rebuild.json, { target: TARGET, code: 'scope-mismatch', retryable: false });
      assert.deepEqual(cold(data), before, 'rebuild refusal queues and writes nothing');

      const retained = await ownerStatus(data);
      assert.equal(retained.status, 200, 'the real bound owner still has projection authority');
      assert.equal(retained.json.sources.length, 1);
      assert.equal(retained.json.sources[0].sourceStoreId, data.binding.sourceStoreId);
      assert.equal(retained.json.sources[0].state, 'current');
      assert.deepEqual(cold(data), before);
    } finally { await close(data); }
  });
