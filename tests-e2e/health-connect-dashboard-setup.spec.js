// SPDX-License-Identifier: AGPL-3.0-only
'use strict';

const crypto = require('node:crypto');
const { test, expect } = require('./helpers/auth-fixture');
const { authorityPage, CANONICAL } = require('./helpers/health-connect-browser-fixture');
const { req } = require('../tests/helpers/sandbox');
const F = require('../tests/helpers/health-connect-sticky-admission-fixture.cjs');
const E = require('../tests/fixtures/health-connect/native-display-normal.expected.json');

const BASE = '/api/connectors/health-connect';
const TYPES = ['WeightRecord', 'StepsRecord'];
const PRODUCER = 'org.example.synthetic.producer';
const FP = 'sha256:db4912372cd0190c42ec800c11d08841050322e2529813b8d6edaddac9a7b911';
const digest = text => 'sha256:' + crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const owner = (fixture, route, options = {}) => req(fixture.server.baseUrl, route, {
  ...options, cookie: fixture.owner.cookie,
  headers: { ...options.headers, Origin: fixture.canonical },
});
const responseIs = (response, method, pathname) => response.request().method() === method
  && new URL(response.url()).pathname === pathname;

// The existing browser bridge forwards real sessions and real server responses.
async function newSource(fixture) {
  const auth = await owner(fixture, '/auth/status');
  expect(auth.status).toBe(200);
  expect(auth.json.authenticated).toBe(true);
  const grant = await owner(fixture, `${BASE}/pairing-grants`, {
    method: 'POST', body: { name: 'Synthetic dashboard source', categories: TYPES },
  });
  expect(grant.status).toBe(201);
  const exchanged = await req(fixture.server.baseUrl, `${BASE}/v1/pairing/exchange`, {
    method: 'POST', body: {
      version: 1, kind: 'pairing-exchange',
      tenantId: grant.json.tenantId, instanceId: grant.json.instanceId,
      sourceStoreId: grant.json.sourceStoreId,
      installationId: 'synthetic-dashboard-installation',
      categories: TYPES, grant: grant.json.grant,
    },
  });
  expect(exchanged.status).toBe(200);
  const paired = exchanged.json;
  return { paired, binding: {
    tenantId: paired.tenantId, instanceId: paired.instanceId,
    sourceStoreId: paired.sourceStoreId, installationId: paired.installationId,
    generation: paired.streams.WeightRecord.generation, restoreEpoch: paired.restoreEpoch,
  } };
}

// Same ordinary readiness inputs as the existing normal display API controls.
// This synthetic companion report is not SDK/provider verification.
async function activate(fixture, source, type) {
  const send = body => req(fixture.server.baseUrl, `${BASE}/v2/streams/${type}/readiness`, {
    method: 'POST', body, headers: {
      Authorization: `Bearer ${source.paired.credential}`, 'Klebb-Health-Protocol': '2',
    },
  });
  const current = F.binding(source, type);
  const status = await send({
    version: 2, kind: 'readiness-status', recordType: type, binding: current,
  });
  expect(status.status).toBe(200);
  const queryJson = JSON.stringify({
    recordType: type,
    window: { start: '2040-02-03T00:00:00.000Z', end: '2040-02-04T00:00:00.000Z' },
    pageSize: 2,
  });
  const filterDigest = digest(queryJson);
  const begun = await send({
    version: 2, kind: 'readiness-begin', recordType: type, binding: current,
    policyRevision: status.json.policyRevision, queryJson, filterDigest,
  });
  expect(begun.status).toBe(200);
  const challenge = begun.json;
  expect(challenge.binding).toEqual({
    ...current, generation: String(BigInt(current.generation) + 1n),
  });
  const completed = await send({
    version: 2, kind: 'readiness-complete', recordType: type,
    readinessId: challenge.readinessId, binding: challenge.binding,
    policyRevision: challenge.policyRevision, filterDigest,
    firstPage: {
      localReadRevision: '1', recordCount: '1', terminalPage: false,
      permissionFingerprintStart: FP, permissionFingerprintEnd: FP,
      tokenValid: true, historyWindowLimited: true,
      interveningChangeCount: '1', changesHaveMore: true,
    },
  });
  expect(completed.status).toBe(200);
  expect(completed.json.sharing).toBe('enabled');
  expect(completed.json.verification).toBe('authenticated-companion-report');
  const caps = await req(fixture.server.baseUrl, `${BASE}/v1/capabilities`, {
    headers: F.headers(source, type),
  });
  expect(caps.status).toBe(200);
  source.paired = { ...source.paired, streams: structuredClone(caps.json.streams) };
}

async function saved(fixture, source, spec) {
  const record = spec.nativeInitial.record;
  const identity = {
    tenantId: source.binding.tenantId, sourceStoreId: source.binding.sourceStoreId,
    recordType: spec.sourceType, nativeRecordId: record.metadata.id,
  };
  const vector = F.batch(source, '1', [{
    operation: 'upsert', identity, dataFamily: 'ordinary', projection: 'raw-only',
    serializerId: 'health-connect-record', serializerVersion: 1, record,
  }], { type: spec.sourceType, id: spec.initialBatch.batchId });
  const receipt = {
    version: 1, kind: 'durable-receipt', binding: F.binding(source, spec.sourceType),
    recordType: spec.sourceType, sequence: '1', batchId: spec.initialBatch.batchId,
    payloadDigest: digest(vector.wire.payloadJson),
  };
  expect(vector.wire.payloadDigest).toBe(receipt.payloadDigest);
  const response = await F.post(fixture, source, F.BATCH, vector.wire, F.headers(source, spec.sourceType));
  expect(response.status).toBe(200);
  expect(response.json).toEqual(receipt);
  const snapshot = F.coldRead(fixture.home);
  const raw = F.identityRows(snapshot, 'health_records', identity);
  expect(raw).toHaveLength(1);
  expect(raw[0].record_json).toBe(JSON.stringify(record));
  const receipts = F.rows(snapshot, 'health_batch_receipts')
    .filter(row => row.batch_id === spec.initialBatch.batchId);
  expect(receipts).toHaveLength(1);
  expect(receipts[0].receipt_json).toBe(JSON.stringify(receipt));
  const stream = F.rows(snapshot, 'health_streams')
    .find(row => row.stream_key === receipts[0].stream_key);
  expect(stream.acknowledged_sequence).toBe('1');
}

function selection(source, spec) {
  return {
    tenantId: source.binding.tenantId, sourceStoreId: source.binding.sourceStoreId,
    recordType: spec.sourceType, dataOrigin: PRODUCER, switchDate: spec.switchDate,
    timeZone: 'UTC', mappingVersion: 1,
  };
}

async function healthySourcesAndTemplate(fixture, source, spec, templateId) {
  const observed = await owner(fixture, `${BASE}/dashboard-sources`);
  expect(observed.status).toBe(200);
  expect(observed.json).toEqual({ sources: [{
    tenantId: source.binding.tenantId, sourceStoreId: source.binding.sourceStoreId,
    recordType: spec.sourceType, dataOrigin: PRODUCER,
  }] });
  const templates = await owner(fixture, '/api/templates');
  expect(templates.status).toBe(200);
  const template = templates.json.templates.find(value => value.id === templateId);
  expect(template).toBeTruthy();
  expect(template.manifest.meta.ingest).toEqual({ source: 'hae', metric: spec.metric });
  expect(template.manifest.data).toEqual([]);
}

async function chooser(fixture) {
  await fixture.page.goto(`${fixture.visibleOrigin}/settings`);
  await expect(fixture.page.locator('eh-settings-view')).toBeVisible();
  await fixture.page.locator('eh-settings-view [data-tab="security"]').click();
  const pane = fixture.page.locator('eh-settings-health-connect');
  await expect(pane).toBeVisible();
  await expect(pane.locator('.hc-destination')).toHaveText(CANONICAL);
  // Healthy authenticated/native/template controls precede this ordinary OLD assertion.
  // There is no missing-control click, timeout or new helper import before it.
  expect(await pane.getByLabel('Display metric', { exact: true }).count()).toBe(1);
  return pane.getByRole('region', { name: 'Health Connect dashboard setup', exact: true });
}

async function fillChoice(region, spec, cardId) {
  await region.getByLabel('Display metric', { exact: true }).selectOption(spec.sourceType);
  await region.getByLabel('Dashboard card', { exact: true }).selectOption(cardId);
  const sources = region.getByLabel('Captured source and app', { exact: true });
  await expect(sources).toBeEnabled();
  await expect(sources.locator('option')).toHaveCount(2);
  await expect(sources.locator('option').nth(1)).toHaveText(`${PRODUCER} · Source 1`);
  await sources.selectOption({ index: 1 });
  await region.getByLabel('Phone display date', { exact: true }).fill(spec.switchDate);
  await region.getByLabel('Display timezone', { exact: true }).fill('UTC');
}

async function readback(fixture, cardId, expected, rows, selectedSources, expectedLabel) {
  const full = await owner(fixture, `/api/manifests/${encodeURIComponent(cardId)}`);
  expect(full.status).toBe(200);
  expect(full.json.meta.id).toBe(cardId);
  expect(full.json.meta.label).toBe(expectedLabel);
  expect(Object.hasOwn(full.json, 'id')).toBe(false);
  expect(full.json.meta.healthConnectDisplay).toEqual(expected);
  expect(full.json.data).toEqual(rows);
  const data = await owner(fixture, `/api/manifests/${encodeURIComponent(cardId)}/data`);
  expect(data.status).toBe(200);
  expect(data.json.data).toEqual(rows);
  expect(data.json.projection.state).toBe('saved');
  expect(data.json.projection.selectedSources).toEqual(selectedSources);
  expect(data.json.projection.revision).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(full.json.projection).toEqual(data.json.projection);
}

async function reloadedChoice(fixture, spec, cardId) {
  await fixture.page.reload();
  await expect(fixture.page.locator('eh-settings-view')).toBeVisible();
  await fixture.page.locator('eh-settings-view [data-tab="security"]').click();
  const region = fixture.page.getByRole('region', {
    name: 'Health Connect dashboard setup', exact: true,
  });
  await region.getByLabel('Display metric', { exact: true }).selectOption(spec.sourceType);
  await expect(region.getByLabel('Dashboard card', { exact: true })).toHaveValue(cardId);
  await expect(region.getByLabel('Phone display date', { exact: true })).toHaveValue(spec.switchDate);
  await expect(region.getByLabel('Display timezone', { exact: true })).toHaveValue('UTC');
}

test.describe.configure({ mode: 'serial' });

test('fresh owner setup creates a Weight card and persists the real saved source choice', async ({ browser }) => {
  const fixture = await authorityPage(browser);
  const spec = E.weight;
  try {
    const source = await newSource(fixture);
    await activate(fixture, source, spec.sourceType);
    await saved(fixture, source, spec);
    await healthySourcesAndTemplate(fixture, source, spec, 'body-mass-hae');
    const before = await owner(fixture, '/api/manifests');
    expect(before.status).toBe(200);
    expect(before.json.entries.filter(entry =>
      entry.meta?.ingest?.source === 'hae' && entry.meta.ingest.metric === 'body_mass')).toHaveLength(0);
    const region = await chooser(fixture);
    await fillChoice(region, spec, '');
    const createdPromise = fixture.page.waitForResponse(response =>
      responseIs(response, 'POST', '/api/settings/cards/from-template'));
    const patchedPromise = fixture.page.waitForResponse(response =>
      response.request().method() === 'PATCH'
      && new URL(response.url()).pathname.startsWith('/api/manifests/'));
    await region.getByRole('button', { name: 'Save Weight display', exact: true }).click();
    const created = await createdPromise;
    expect(created.status()).toBe(201);
    expect(created.request().postDataJSON()).toEqual({ templateId: 'body-mass-hae', label: 'Weight' });
    const result = await created.json();
    expect(result.ok).toBe(true);
    expect(typeof result.id).toBe('string');
    expect(result.id.length).toBeGreaterThan(0);
    const patched = await patchedPromise;
    expect(patched.status()).toBe(200);
    expect(new URL(patched.url()).pathname).toBe(`/api/manifests/${encodeURIComponent(result.id)}`);
    expect(patched.request().postDataJSON()).toEqual({
      meta: { healthConnectDisplay: selection(source, spec) },
    });
    await expect(region.getByRole('status')).toContainText('Weight display choice saved.');
    await expect(region.getByRole('status')).toContainText('Saved data is shown');
    await readback(fixture, result.id, selection(source, spec),
      [{ date: '2040-02-03', kg: 45.359237 }],
      [{ date: '2040-02-03', source: 'health-connect' }], 'Weight');
    const after = await owner(fixture, '/api/manifests');
    expect(after.status).toBe(200);
    expect(after.json.entries.length).toBe(before.json.entries.length + 1);
    await reloadedChoice(fixture, spec, result.id);
    expect(fixture.bridgeFailures).toEqual([]);
  } finally { await fixture.close(); }
});

test('existing Steps owner setup keeps pre-cutover history and excludes overlapping HAE rows', async ({ browser }) => {
  const fixture = await authorityPage(browser);
  const spec = E.steps;
  try {
    const source = await newSource(fixture);
    await activate(fixture, source, spec.sourceType);
    const created = await owner(fixture, '/api/manifests', {
      method: 'POST', body: {
        $schema: 'klebb.datafile.v1', meta: {
          id: spec.cardId, label: 'Existing Steps',
          ingest: { source: 'hae', metric: 'step_count' },
          view: { enabled: true, component: 'generic-card',
            display: { template: '{count}', unit: 'steps' } },
          writeable: { fromWebapp: false },
        }, data: spec.HAEBeforeRows,
      },
    });
    expect(created.status).toBe(201);
    const before = await owner(fixture, `/api/manifests/${spec.cardId}/data`);
    expect(before.status).toBe(200);
    expect(before.json.data).toEqual(spec.HAEBeforeRows);
    const cached = F.rows(F.coldRead(fixture.home), 'rows')
      .filter(row => row.card_id === spec.cardId);
    await saved(fixture, source, spec);
    await healthySourcesAndTemplate(fixture, source, spec, 'steps');
    const region = await chooser(fixture);
    await fillChoice(region, spec, spec.cardId);
    const patchedPromise = fixture.page.waitForResponse(response =>
      responseIs(response, 'PATCH', `/api/manifests/${spec.cardId}`));
    await region.getByRole('button', { name: 'Save Steps display', exact: true }).click();
    const patched = await patchedPromise;
    expect(patched.status()).toBe(200);
    expect(patched.request().postDataJSON()).toEqual({
      meta: { healthConnectDisplay: selection(source, spec) },
    });
    await expect(region.getByRole('status')).toContainText('Steps display choice saved.');
    await readback(fixture, spec.cardId, selection(source, spec),
      spec.initialExpectedRows, spec.initialSelectedSources, 'Existing Steps');
    expect(F.rows(F.coldRead(fixture.home), 'rows')
      .filter(row => row.card_id === spec.cardId)).toEqual(cached);
    expect(fixture.requestPaths.filter(request => request.method === 'POST'
      && new URL(request.url).pathname === '/api/settings/cards/from-template')).toHaveLength(0);
    await reloadedChoice(fixture, spec, spec.cardId);
    expect(fixture.bridgeFailures).toEqual([]);
  } finally { await fixture.close(); }
});
