// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Actual held HTTP uploads cross the authority and import lifecycle boundaries.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const product = path.resolve(__dirname, '../..');
const { createSandbox, cleanupSandbox, spawnServer, req, fakeAuthState } =
  require(path.join(product, 'tests/helpers/sandbox'));
const { coldReadNative } =
  require(path.join(product, 'tests/helpers/health-connect-cold-readback.cjs'));
const bank = require('../fixtures/health-connect/durable-history-independent-vectors.json');
const ORIGIN = 'https://midbody.example.test';
const BASE = '/api/connectors/health-connect';
const TYPE = 'BodyWaterMassRecord';
const ENV = {
  HEALTH_ORIGIN: ORIGIN, HEALTH_RP_ID: 'midbody.example.test',
  AGENT_API_TOKEN: '', KLEBB_ADMIN_TOKEN: '', KLEBB_CLOUD: '', KLEBB_DEMO: '',
  HEALTH_DATA_DIR: '', HEALTH_REPORTS_DIR: '', HEALTH_AUTO_EXPORT_DIR: '',
  HEALTH_SESSIONS_DIR: '', HEALTH_CREDENTIALS_DIR: '', HEALTH_ARCHIVE_DIR: '',
  HEALTH_CONFIG_PATH: '', HEALTH_DB_DIR: '', HEALTH_DB_FILE: '', HEALTH_CHAT_DIR: '',
  HEALTH_USER_FILE: '', HEALTH_NOTIFICATIONS_STATE_FILE: '', HEALTH_INBOX_DIR: '',
  HEALTH_KEYS_DIR: '', HEALTH_VAPID_FILE: '', HEALTH_PUSH_SUBSCRIPTIONS_FILE: '',
  HEALTH_AUTO_EXPORT_TOKEN: '', NODE_OPTIONS: '',
};
const sha = text => 'sha256:' + crypto.createHash('sha256').update(text, 'utf8').digest('hex');
async function fixture(mode) {
  const owner = fakeAuthState('midbody-owner');
  const home = createSandbox({ credentials: owner.credentials, sessions: owner.sessions });
  let server;
  try {
    server = await spawnServer(home, ENV);
    const grant = await req(server.baseUrl, `${BASE}/pairing-grants`, {
      method: 'POST', cookie: owner.cookie, headers: { Origin: ORIGIN },
      body: { name: 'Synthetic held upload', categories: [TYPE] },
    });
    assert.equal(grant.status, 201);
    const response = await req(server.baseUrl, `${BASE}/v1/pairing/exchange`, {
      method: 'POST', body: { version: 1, kind: 'pairing-exchange',
        tenantId: grant.json.tenantId, instanceId: grant.json.instanceId,
        sourceStoreId: grant.json.sourceStoreId, installationId: 'synthetic-midbody-installation',
        categories: [TYPE], grant: grant.json.grant },
    });
    assert.equal(response.status, 200);
    const paired = response.json;
    const binding = { tenantId: paired.tenantId, instanceId: paired.instanceId,
      sourceStoreId: paired.sourceStoreId, installationId: paired.installationId,
      generation: paired.streams[TYPE].generation, restoreEpoch: paired.restoreEpoch };
    const headers = { Authorization: `Bearer ${paired.credential}`, 'Klebb-Health-Protocol': '1',
      'Klebb-Health-Generation': binding.generation,
      'Klebb-Health-Restore-Epoch': binding.restoreEpoch };
    assert.equal((await req(server.baseUrl, `${BASE}/v1/capabilities`, { headers })).status, 200);
    await server.kill(); server = null;
    const before = coldReadNative(home);
    const latch = path.join(home, 'midbody-latch.json');
    const preload = path.join(__dirname, '../helpers/health-connect-midbody-preload.cjs').replaceAll('\\', '/');
    server = await spawnServer(home, { ...ENV,
      NODE_OPTIONS: `--require "${preload}"`, INDEPENDENT_PRODUCT_ROOT: product,
      INDEPENDENT_MID_BODY_LATCH: latch, INDEPENDENT_MID_BODY_ACTION: mode });
    const payload = JSON.parse(bank.vectors.find(item => item.id === 'initial-raw-only').payloadJson);
    payload.binding = binding;
    for (const change of payload.changes) {
      change.identity.tenantId = binding.tenantId;
      change.identity.sourceStoreId = binding.sourceStoreId;
    }
    const payloadJson = JSON.stringify(payload);
    const wire = Buffer.from(JSON.stringify({ version: 1, kind: 'batch', payloadJson,
      payloadDigest: sha(payloadJson) }), 'utf8');
    return { owner, home, server, before, paired, headers, latch, wire };
  } catch (error) {
    if (server) await server.kill();
    cleanupSandbox(home);
    throw error;
  }
}
function heldUpload(data) {
  let request;
  const response = new Promise((resolve, reject) => {
    request = http.request(`${data.server.baseUrl}${BASE}/v1/batches`, {
      method: 'POST', headers: { 'Content-Type': 'application/json',
        'Content-Length': data.wire.length, ...data.headers },
    }, result => {
      let body = '';
      result.on('data', bytes => { body += bytes.toString('utf8'); });
      result.on('end', () => resolve({ status: result.statusCode, body, json: JSON.parse(body) }));
      result.on('error', reject);
    });
    request.on('error', reject);
    request.setTimeout(15000, () => request.destroy(new Error('bounded held upload timeout')));
    request.write(data.wire.subarray(0, Math.floor(data.wire.length / 2)));
  });
  void response.catch(() => {});
  return { response, finish: () => request.end(data.wire.subarray(Math.floor(data.wire.length / 2))),
    destroy: () => request.destroy() };
}
async function consumed(data) {
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(data.latch) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(fs.existsSync(data.latch), 'the actual upload iterator consumed bytes before action');
  const event = JSON.parse(fs.readFileSync(data.latch, 'utf8'));
  assert.equal(event.phase, 'batch-iterator-consumed-first-chunk-before-request-end');
  assert.ok(event.bytes > 0 && event.bytes < data.wire.length);
}
for (const mode of ['observe', 'freeze']) {
  test(`held valid batch refuses ${mode === 'freeze' ? 'new import freeze' : 'new browser revocation'} before save`,
    async () => {
      const data = await fixture(mode);
      const pending = heldUpload(data);
      try {
        await consumed(data);
        if (mode === 'observe') {
          const revoked = await req(data.server.baseUrl, `${BASE}/${data.paired.connectorId}`, {
            method: 'DELETE', cookie: data.owner.cookie, headers: { Origin: ORIGIN },
          });
          assert.equal(revoked.status, 200);
        }
        pending.finish();
        const response = await pending.response;
        if (mode === 'observe') {
          assert.equal(response.status, 401);
          assert.equal(response.json.code, 'revoked');
          assert.equal(response.json.kind, 'error');
        } else {
          assert.equal(response.status, 503);
          assert.equal(response.json.code, 'IMPORT_FROZEN');
        }
        assert.notEqual(response.json.kind, 'durable-receipt');
        assert.equal(response.body.includes(data.paired.credential), false);
        await data.server.kill(); data.server = null;
        assert.deepEqual(coldReadNative(data.home), data.before,
          'no raw records, tombstones, receipt, frontier, job or legacy effect');
      } finally {
        pending.destroy();
        if (data.server) await data.server.kill();
        cleanupSandbox(data.home);
      }
    });
}
