// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { waitFor } = require('../helpers/sandbox');
const F = require('../helpers/health-connect-sticky-admission-fixture.cjs');
const { readSamples } = require('../helpers/hae-samples-readback');
const E = require('../fixtures/health-connect/native-display-normal.expected.json');
const TYPES = ['WeightRecord', 'StepsRecord'];
const PRODUCER = 'org.example.synthetic.producer';
const TOKEN = 'synthetic-normal-display-hae-token';
const FP = 'sha256:db4912372cd0190c42ec800c11d08841050322e2529813b8d6edaddac9a7b911';
const digest = text => 'sha256:' + crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const owner = (data, route, options = {}) => F.request(data, route, { ...options, browser: true });
const dataRoute = id => `/api/manifests/${id}/data`;
const fullRoute = id => `/api/manifests/${id}`;

async function sourceReadout(data, source, expected) {
  if (expected.length) {
    const settled = await waitFor(async () => {
      const status = await owner(data, `${F.BASE}/projections/status`);
      assert.equal(status.status, 200);
      assert.equal(status.json.target, 'source-index-v1');
      const current = status.json.sources.find(item => item.sourceStoreId === source.binding.sourceStoreId);
      return current?.state === 'current' ? current : null;
    }, { what: 'normal saved source-index publication' });
    assert.equal(settled.saved.complete, true);
    const expectedFrontier = { binding: F.binding(source, expected[0].recordType),
      recordType: expected[0].recordType, acknowledgedSequence: '1' };
    assert.deepEqual(settled.saved.frontiers, [expectedFrontier]);
    assert.deepEqual(settled.published.frontiers, [expectedFrontier]);
    assert.equal(settled.published.restoreEpoch, source.binding.restoreEpoch);
  }
  const before = F.coldRead(data.home);
  const response = await owner(data, `${F.BASE}/dashboard-sources`);
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, { sources: expected });
  F.noAuthority(response.body, data);
  const refused = await F.request(data, `${F.BASE}/dashboard-sources`, {
    headers: { Authorization: `Bearer ${source.paired.credential}` },
  });
  assert.equal(refused.status, 401);
  assert.equal(Object.hasOwn(refused.json, 'sources'), false);
  assert.deepEqual(F.coldRead(data.home), before, 'source discovery cannot mutate saved history');
}

async function newSource(data) {
  const auth = await owner(data, '/auth/status');
  assert.equal(auth.status, 200); assert.equal(auth.json.authenticated, true);
  const grant = await owner(data, `${F.BASE}/pairing-grants`, {
    method: 'POST', body: { name: 'Synthetic normal display source', categories: TYPES },
  });
  assert.equal(grant.status, 201);
  const response = await F.request(data, `${F.BASE}/v1/pairing/exchange`, {
    method: 'POST', body: { version: 1, kind: 'pairing-exchange',
      tenantId: grant.json.tenantId, instanceId: grant.json.instanceId,
      sourceStoreId: grant.json.sourceStoreId, installationId: 'synthetic-normal-display-installation',
      categories: TYPES, grant: grant.json.grant },
  });
  assert.equal(response.status, 200);
  const paired = response.json;
  data.markers.push(grant.json.grant, paired.credential);
  return { paired, binding: { tenantId: paired.tenantId, instanceId: paired.instanceId,
    sourceStoreId: paired.sourceStoreId, installationId: paired.installationId,
    generation: paired.streams.WeightRecord.generation, restoreEpoch: paired.restoreEpoch } };
}

async function activate(data, source, type) {
  const send = body => F.request(data, `${F.BASE}/v2/streams/${type}/readiness`, {
    method: 'POST', body, headers: { Authorization: `Bearer ${source.paired.credential}`,
      'Klebb-Health-Protocol': '2' },
  });
  const current = F.binding(source, type);
  const status = await send({ version: 2, kind: 'readiness-status', recordType: type, binding: current });
  assert.equal(status.status, 200);
  const queryJson = JSON.stringify({ recordType: type,
    window: { start: '2040-02-03T00:00:00.000Z', end: '2040-02-04T00:00:00.000Z' }, pageSize: 2 });
  const filterDigest = digest(queryJson);
  const begun = await send({ version: 2, kind: 'readiness-begin', recordType: type,
    binding: current, policyRevision: status.json.policyRevision, queryJson, filterDigest });
  assert.equal(begun.status, 200);
  const challenge = begun.json;
  assert.deepEqual(challenge.binding, { ...current, generation: String(BigInt(current.generation) + 1n) });
  // Synthetic report exercises the real server admission path, not SDK readiness.
  const completed = await send({ version: 2, kind: 'readiness-complete', recordType: type,
    readinessId: challenge.readinessId, binding: challenge.binding,
    policyRevision: challenge.policyRevision, filterDigest,
    firstPage: { localReadRevision: '1', recordCount: '1', terminalPage: false,
      permissionFingerprintStart: FP, permissionFingerprintEnd: FP, tokenValid: true,
      historyWindowLimited: true, interveningChangeCount: '1', changesHaveMore: true } });
  assert.equal(completed.status, 200); assert.equal(completed.json.sharing, 'enabled');
  assert.equal(completed.json.verification, 'authenticated-companion-report');
  const caps = await F.request(data, `${F.BASE}/v1/capabilities`, {
    headers: F.headers(source, type),
  });
  assert.equal(caps.status, 200);
  source.paired = { ...source.paired, streams: structuredClone(caps.json.streams) };
}

async function cards(data, spec) {
  const unit = spec.metric === 'body_mass' ? 'kg' : 'steps';
  const field = spec.metric === 'body_mass' ? 'kg' : 'count';
  for (const manifest of [
    { $schema: 'klebb.datafile.v1', meta: { id: spec.cardId, label: 'Synthetic normal metric',
      ingest: { source: 'hae', metric: spec.metric },
      view: { enabled: true, component: 'generic-card', display: { template: `{${field}}`, unit } },
      writeable: { fromWebapp: false } }, data: [] },
    { $schema: 'klebb.datafile.v1', meta: { id: 'unrelated-resting', label: 'Synthetic unrelated metric',
      ingest: { source: 'hae', metric: 'resting_heart_rate' },
      view: { enabled: true, component: 'generic-card', display: { template: '{bpm}', unit: 'bpm' } },
      writeable: { fromWebapp: false } }, data: [] },
  ]) {
    const response = await owner(data, '/api/manifests', { method: 'POST', body: manifest });
    assert.equal(response.status, 201);
  }
  const push = async metrics => {
    const response = await F.request(data, '/api/health-auto-export', { method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` }, body: { data: { metrics } } });
    assert.equal(response.status, 200); assert.equal(response.json.ok, true);
  };
  if (spec.metric === 'step_count') {
    await push([{ name: 'step_count', data: [{ date: '2040-02-02', qty: 5000 }] }]);
    await push([{ name: 'step_count', data: [
      { date: '2040-02-02 08:00:00 +0000', qty: 1200 },
      { date: '2040-02-02 12:00:00 +0000', qty: 3200 },
      { date: '2040-02-03', qty: 9000 }, { date: '2040-02-04', qty: 8000 },
    ] }, { name: 'resting_heart_rate', data: [{ date: E.unrelated.date, qty: E.unrelated.bpm }] }]);
  } else {
    await push([{ name: 'body_mass', units: 'kg', data: [
      { date: '2040-02-02', qty: 80 }, { date: '2040-02-03', qty: 81 },
    ] }, { name: 'resting_heart_rate', data: [{ date: E.unrelated.date, qty: E.unrelated.bpm }] }]);
  }
  const baseline = await owner(data, dataRoute(spec.cardId));
  assert.equal(baseline.status, 200); assert.deepEqual(baseline.json.data, spec.HAEBeforeRows);
  return { rows: F.rows(F.coldRead(data.home), 'rows').filter(row => row.card_id === spec.cardId),
    rawHaeSamples: readSamples(data.home) };
}

async function saved(data, source, spec, sequence, batchId, record, deletion = false) {
  const nativeRecordId = spec.nativeInitial.record.metadata.id;
  const identity = { tenantId: source.binding.tenantId, sourceStoreId: source.binding.sourceStoreId,
    recordType: spec.sourceType, nativeRecordId };
  const change = deletion ? { operation: 'delete', identity } : { operation: 'upsert', identity,
    dataFamily: 'ordinary', projection: 'raw-only', serializerId: 'health-connect-record',
    serializerVersion: 1, record };
  const vector = F.batch(source, sequence, [change], { type: spec.sourceType, id: batchId });
  const receipt = { version: 1, kind: 'durable-receipt', binding: F.binding(source, spec.sourceType),
    recordType: spec.sourceType, sequence, batchId, payloadDigest: digest(vector.wire.payloadJson) };
  assert.equal(vector.wire.payloadDigest, receipt.payloadDigest);
  const response = await F.post(data, source, F.BATCH, vector.wire, F.headers(source, spec.sourceType));
  assert.equal(response.status, 200); assert.deepEqual(response.json, receipt);
  const snapshot = F.coldRead(data.home);
  const raw = F.identityRows(snapshot, 'health_records', identity);
  assert.equal(raw.length, deletion ? 0 : 1);
  if (!deletion) assert.equal(raw[0].record_json, JSON.stringify(record));
  else assert.equal(F.identityRows(snapshot, 'health_tombstones', identity).length, 1);
  const receipts = F.rows(snapshot, 'health_batch_receipts').filter(row => row.batch_id === batchId);
  assert.equal(receipts.length, 1); assert.equal(receipts[0].receipt_json, JSON.stringify(receipt));
  const stream = F.rows(snapshot, 'health_streams').find(row => row.stream_key === receipts[0].stream_key);
  assert.equal(stream.acknowledged_sequence, sequence);
  return receipt;
}

async function selection(data, source, spec) {
  const config = { tenantId: source.binding.tenantId, sourceStoreId: source.binding.sourceStoreId,
    recordType: spec.sourceType, switchDate: spec.switchDate, dataOrigin: PRODUCER,
    timeZone: 'UTC', mappingVersion: 1 };
  const patched = await owner(data, fullRoute(spec.cardId), {
    method: 'PATCH', body: { meta: { healthConnectDisplay: config } },
  });
  assert.equal(patched.status, 200);
  const stored = await owner(data, fullRoute(spec.cardId));
  assert.equal(stored.status, 200); assert.deepEqual(stored.json.meta.healthConnectDisplay, config);
  return config;
}

async function view(data, spec, rows, sources) {
  const response = await owner(data, dataRoute(spec.cardId));
  assert.equal(response.status, 200);
  // Ordinary OLD reaches this fixed row assertion after real auth, receipt and HAE controls.
  assert.deepEqual(response.json.data, rows);
  assert.equal(Object.hasOwn(response.json, 'id'), false);
  assert.equal(response.json.projection.state, 'saved');
  assert.match(response.json.projection.revision, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(response.json.projection.selectedSources, sources);
  const full = await owner(data, fullRoute(spec.cardId));
  assert.equal(full.status, 200); assert.deepEqual(full.json.data, rows);
  assert.deepEqual(full.json.projection, response.json.projection);
  const cards = await owner(data, '/api/views/view');
  assert.equal(cards.status, 200);
  const card = cards.json.cards.find(item => item.id === spec.cardId);
  assert.ok(card); assert.equal(card.viewConfig.component, 'generic-card');
  return response.json.projection.revision;
}

async function unchangedCached(data, spec, cached) {
  const rows = F.rows(F.coldRead(data.home), 'rows').filter(row => row.card_id === spec.cardId);
  assert.deepEqual(rows, cached.rows, 'Native view must not overwrite legacy HAE cached data');
  assert.deepEqual(readSamples(data.home), cached.rawHaeSamples, 'Native view keeps every durable HAE sample unchanged');
  const unrelated = await owner(data, dataRoute('unrelated-resting'));
  assert.equal(unrelated.status, 200); assert.deepEqual(unrelated.json.data, [E.unrelated]);
}

async function stale(data, spec, revision, expectedRows) {
  const response = await owner(data, dataRoute(spec.cardId), {
    headers: { 'X-Projection-Revision': revision },
  });
  assert.equal(response.status, 409); assert.equal(response.json.code, 'stale-projection');
  const latest = await owner(data, dataRoute(spec.cardId));
  assert.equal(latest.status, 200); assert.deepEqual(latest.json.data, expectedRows);
}

test('authenticated saved Weight reaches the existing kg card and refuses an older correction publication', async () => {
  const data = await F.fixture({ readinessVersion: 2, extraEnv: { HEALTH_AUTO_EXPORT_TOKEN: TOKEN } });
  const spec = E.weight;
  try {
    const source = await newSource(data); await activate(data, source, spec.sourceType);
    await sourceReadout(data, source, []);
    const cached = await cards(data, spec);
    const firstReceipt = await saved(data, source, spec, '1', spec.initialBatch.batchId, spec.nativeInitial.record);
    await sourceReadout(data, source, [{ tenantId: source.binding.tenantId,
      sourceStoreId: source.binding.sourceStoreId, recordType: spec.sourceType, dataOrigin: PRODUCER }]);
    await selection(data, source, spec);
    const initial = await view(data, spec, spec.initialExpectedRows, spec.initialSelectedSources);
    await saved(data, source, spec, '2', spec.correctionBatch.batchId, spec.nativeCorrection.record);
    const corrected = await view(data, spec, spec.correctedExpectedRows, spec.initialSelectedSources);
    assert.notEqual(corrected, initial, 'Raw correction invalidates revision even without policy revision change');
    await stale(data, spec, initial, spec.correctedExpectedRows);
    assert.equal(F.rows(F.coldRead(data.home), 'health_batch_receipts')
      .find(row => row.batch_id === spec.initialBatch.batchId).receipt_json, JSON.stringify(firstReceipt));
    await unchangedCached(data, spec, cached);
  } finally { await F.close(data); }
});

test('authenticated saved Steps uses persisted cutover and deletion cannot restore overlapping HAE or stale native rows', async () => {
  const data = await F.fixture({ readinessVersion: 2, extraEnv: { HEALTH_AUTO_EXPORT_TOKEN: TOKEN } });
  const spec = E.steps;
  try {
    const source = await newSource(data); await activate(data, source, spec.sourceType);
    await sourceReadout(data, source, []);
    const cached = await cards(data, spec);
    const firstReceipt = await saved(data, source, spec, '1', spec.initialBatch.batchId, spec.nativeInitial.record);
    await sourceReadout(data, source, [{ tenantId: source.binding.tenantId,
      sourceStoreId: source.binding.sourceStoreId, recordType: spec.sourceType, dataOrigin: PRODUCER }]);
    await selection(data, source, spec);
    const initial = await view(data, spec, spec.initialExpectedRows, spec.initialSelectedSources);
    await saved(data, source, spec, '2', spec.basicDeletion.batchId, null, true);
    const deleted = await view(data, spec, spec.deletedExpectedRows,
      [{ date: '2040-02-02', source: 'hae' }]);
    assert.notEqual(deleted, initial, 'Raw deletion/frontier change invalidates the initial revision');
    await stale(data, spec, initial, spec.deletedExpectedRows);
    assert.equal(F.rows(F.coldRead(data.home), 'health_batch_receipts')
      .find(row => row.batch_id === spec.initialBatch.batchId).receipt_json, JSON.stringify(firstReceipt));
    await unchangedCached(data, spec, cached);
  } finally { await F.close(data); }
});
