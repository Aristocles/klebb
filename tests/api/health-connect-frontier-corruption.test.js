// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const product = process.env.INDEPENDENT_PRODUCT_ROOT || path.resolve(__dirname, '../..');
const { createSandbox, cleanupSandbox, spawnServer, req, fakeAuthState } =
  require(path.join(product, 'tests/helpers/sandbox'));
const vectors = require(process.env.INDEPENDENT_PRODUCT_ROOT ?
  path.join(__dirname, '../../durable-history-independent-vectors.json') :
  path.join(product, 'tests/fixtures/health-connect/durable-history-independent-vectors.json'));
const BASE = '/api/connectors/health-connect';
const TYPE = 'BodyWaterMassRecord';
const ORIGIN = 'https://corruption.example.test';
const ENV = {
  HEALTH_ORIGIN: ORIGIN, HEALTH_RP_ID: 'corruption.example.test',
  AGENT_API_TOKEN: '', KLEBB_ADMIN_TOKEN: '', KLEBB_CLOUD: '', KLEBB_DEMO: '',
  HEALTH_DATA_DIR: '', HEALTH_REPORTS_DIR: '', HEALTH_AUTO_EXPORT_DIR: '',
  HEALTH_SESSIONS_DIR: '', HEALTH_CREDENTIALS_DIR: '', HEALTH_ARCHIVE_DIR: '',
  HEALTH_CONFIG_PATH: '', HEALTH_DB_DIR: '', HEALTH_DB_FILE: '', HEALTH_CHAT_DIR: '',
  HEALTH_USER_FILE: '', HEALTH_NOTIFICATIONS_STATE_FILE: '', HEALTH_INBOX_DIR: '',
  HEALTH_KEYS_DIR: '', HEALTH_VAPID_FILE: '', HEALTH_PUSH_SUBSCRIPTIONS_FILE: '',
  HEALTH_AUTO_EXPORT_TOKEN: '', NODE_OPTIONS: '',
};
const sha = text => 'sha256:' + crypto.createHash('sha256').update(text, 'utf8').digest('hex');
function frame(id, binding) {
  const template = vectors.vectors.find(item => item.id === id);
  const payload = JSON.parse(template.payloadJson);
  payload.binding = binding;
  for (const change of payload.changes) {
    change.identity.tenantId = binding.tenantId;
    change.identity.sourceStoreId = binding.sourceStoreId;
  }
  const payloadJson = JSON.stringify(payload);
  const payloadDigest = sha(payloadJson);
  return { wire: { version: 1, kind: 'batch', payloadJson, payloadDigest },
    receipt: { version: 1, kind: 'durable-receipt', binding, recordType: TYPE,
      sequence: payload.sequence, batchId: payload.batchId, payloadDigest } };
}
function logical(db) {
  return {
    records: db.prepare('SELECT * FROM health_records ORDER BY native_record_id').all(),
    tombstones: db.prepare('SELECT * FROM health_tombstones ORDER BY native_record_id').all(),
    receipts: db.prepare('SELECT * FROM health_batch_receipts ORDER BY sequence').all(),
    streams: db.prepare('SELECT * FROM health_streams ORDER BY stream_key').all(),
    jobs: db.prepare('SELECT * FROM health_projection_outbox ORDER BY sequence').all(),
  };
}
for (const defect of ['unreceipted-frontier', 'missing-stream', 'zero-with-receipt',
  'lagging-nonzero-frontier']) {
  test(`canonical frontier corruption fails status/capabilities closed: ${defect}`, async () => {
    const owner = fakeAuthState('synthetic-corruption-owner');
    const home = createSandbox({ credentials: owner.credentials, sessions: owner.sessions });
    let server;
    let writer;
    try {
      server = await spawnServer(home, ENV);
      const granted = await req(server.baseUrl, `${BASE}/pairing-grants`, {
        method: 'POST', cookie: owner.cookie, headers: { Origin: ORIGIN },
        body: { categories: [TYPE], name: 'Synthetic corruption phone' },
      });
      assert.equal(granted.status, 201);
      const paired = await req(server.baseUrl, `${BASE}/v1/pairing/exchange`, {
        method: 'POST', body: { version: 1, kind: 'pairing-exchange',
          tenantId: granted.json.tenantId, instanceId: granted.json.instanceId,
          sourceStoreId: granted.json.sourceStoreId, installationId: 'synthetic-corruption-installation',
          categories: [TYPE], grant: granted.json.grant },
      });
      assert.equal(paired.status, 200);
      const binding = {
        tenantId: paired.json.tenantId, instanceId: paired.json.instanceId,
        sourceStoreId: paired.json.sourceStoreId, installationId: paired.json.installationId,
        generation: paired.json.streams[TYPE].generation, restoreEpoch: paired.json.restoreEpoch,
      };
      const headers = { Authorization: `Bearer ${paired.json.credential}`, 'Klebb-Health-Protocol': '1',
        'Klebb-Health-Generation': binding.generation, 'Klebb-Health-Restore-Epoch': binding.restoreEpoch };
      const first = frame('initial-raw-only', binding);
      const committed = await req(server.baseUrl, `${BASE}/v1/batches`, {
        method: 'POST', headers, body: first.wire,
      });
      assert.equal(committed.status, 200);
      assert.deepEqual(committed.json, first.receipt);
      if (defect === 'lagging-nonzero-frontier') {
        const second = frame('second-delete-and-correction', binding);
        const response = await req(server.baseUrl, `${BASE}/v1/batches`, {
          method: 'POST', headers, body: second.wire,
        });
        assert.equal(response.status, 200);
        assert.deepEqual(response.json, second.receipt);
      }
      const expectedFrontier = defect === 'lagging-nonzero-frontier' ? '2' : '1';
      const healthy = await req(server.baseUrl, `${BASE}/v1/streams/${TYPE}/status`, { headers });
      assert.equal(healthy.status, 200);
      assert.equal(healthy.json.acknowledgedSequence, expectedFrontier);
      await server.kill(); server = null;
      writer = new DatabaseSync(path.join(home, 'db', 'klebb.db'));
      assert.equal(writer.prepare('SELECT acknowledged_sequence FROM health_streams').get()
        .acknowledged_sequence, expectedFrontier);
      if (defect === 'missing-stream') {
        assert.equal(writer.prepare('DELETE FROM health_streams').run().changes, 1);
      } else {
        const corrupt = defect === 'unreceipted-frontier' ? '2' :
          defect === 'zero-with-receipt' ? '0' : '1';
        assert.equal(writer.prepare('UPDATE health_streams SET acknowledged_sequence = ?')
          .run(corrupt).changes, 1);
      }
      const before = logical(writer);
      writer.close(); writer = null;
      server = await spawnServer(home, ENV);
      const status = await req(server.baseUrl, `${BASE}/v1/streams/${TYPE}/status`, { headers });
      const caps = await req(server.baseUrl, `${BASE}/v1/capabilities`, { headers });
      console.log(JSON.stringify({ defect, expectedStatus: 503,
        observedStatus: status.status, observedStatusCode: status.json?.code || null,
        advertisedFrontier: status.json?.acknowledgedSequence || null,
        observedCapabilitiesStatus: caps.status }));
      for (const result of [status, caps]) {
        assert.equal(result.status, 503);
        assert.equal(result.json?.kind, 'error');
        assert.equal(result.json?.code, 'storage-unavailable');
        assert.equal(result.json?.acknowledgedSequence, undefined);
        for (const marker of [paired.json.credential, granted.json.grant, owner.token]) {
          assert.equal(typeof marker, 'string');
          assert.ok(marker.length > 20);
          assert.equal(result.body.includes(marker), false);
        }
      }
      assert.equal((await req(server.baseUrl, '/healthz')).status, 200);
      await server.kill(); server = null;
      writer = new DatabaseSync(path.join(home, 'db', 'klebb.db'), { readOnly: true });
      assert.deepEqual(logical(writer), before, 'refusal did not repair or overwrite corrupted saved history');
    } finally {
      if (writer) writer.close();
      if (server) await server.kill();
      cleanupSandbox(home);
    }
  });
}
