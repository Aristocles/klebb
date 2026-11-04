// SPDX-License-Identifier: AGPL-3.0-only
'use strict';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let dashboardCards, dashboardSources, makeDisplaySelection, saveDashboardSelection;

before(async () => {
  ({ dashboardCards, dashboardSources, makeDisplaySelection, saveDashboardSelection } =
    await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'lib',
      'health-connect-dashboard-setup.js')).href));
});

const weightSource = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  sourceStoreId: '22222222-2222-4222-8222-222222222222',
  recordType: 'WeightRecord',
  dataOrigin: 'example.app',
};
const stepsSource = { ...weightSource, recordType: 'StepsRecord' };
const weightSelection = {
  ...weightSource, switchDate: '2026-11-02', timeZone: 'UTC', mappingVersion: 1,
};
const stepsSelection = {
  ...stepsSource, switchDate: '2026-11-02', timeZone: 'UTC', mappingVersion: 1,
};
const weightEntry = {
  id: 'weight-card',
  meta: {
    id: 'weight-card', label: 'Weight',
    ingest: { source: 'hae', metric: 'body_mass' },
    writeable: { fromWebapp: false },
    healthConnectDisplay: weightSelection,
  },
  data: [{ date: '2026-11-01', kg: 80 }],
  projection: { state: 'saved', revision: 'sha256:' + '1'.repeat(64) },
};
const stepsEntry = {
  id: 'steps-card',
  meta: {
    id: 'steps-card', label: 'Steps',
    ingest: { source: 'hae', metric: 'step_count' },
    writeable: { fromWebapp: false },
    healthConnectDisplay: stepsSelection,
  },
  data: [{ date: '2026-11-01', count: 1200 }],
  projection: { state: 'pending', revision: 'sha256:' + '2'.repeat(64) },
};
const weightReadback = {
  meta: weightEntry.meta, data: weightEntry.data, projection: weightEntry.projection,
};
const stepsReadback = {
  meta: stepsEntry.meta, data: stepsEntry.data, projection: stepsEntry.projection,
};

// This is a scripted transport contract, not authenticated browser evidence.
function transport(script, signal, events = []) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const call = {
      url, method: options.method || 'GET', credentials: options.credentials,
    };
    if (options.body !== undefined) {
      call.body = JSON.parse(options.body);
      assert.equal(options.headers?.['Content-Type'], 'application/json');
    }
    assert.equal(options.signal, signal);
    calls.push(call);
    events.push(`${call.method} ${url}`);
    const reply = script[calls.length - 1];
    assert.ok(reply, 'No unexpected request or duplicate card creation');
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      json: async () => structuredClone(reply.json),
    };
  };
  return { fetchImpl, calls, events };
}

test('fresh Weight setup creates once, retains the ID before PATCH and verifies the effective choice', async () => {
  const payload = { sources: [weightSource, stepsSource] };
  assert.deepEqual(dashboardSources(payload, 'WeightRecord'), [weightSource]);
  assert.deepEqual(dashboardSources(payload, 'StepsRecord'), [stepsSource]);
  assert.deepEqual(makeDisplaySelection(weightSource, '2026-11-02', 'UTC'), weightSelection);
  assert.deepEqual(dashboardCards([weightEntry, stepsEntry], 'WeightRecord'), [weightEntry]);
  assert.deepEqual(dashboardCards([weightEntry, stepsEntry], 'StepsRecord'), [stepsEntry]);

  const signal = new AbortController().signal;
  const events = [];
  const stub = transport([
    { status: 200, json: { ok: true, id: 'weight-card' } },
    { status: 200, json: { ok: true, id: 'weight-card' } },
    { status: 200, json: weightReadback },
  ], signal, events);
  let retainedId;
  const result = await saveDashboardSelection({
    fetchImpl: stub.fetchImpl, recordType: 'WeightRecord',
    selection: weightSelection, signal,
    onCreated(id) { retainedId = id; events.push(`created:${id}`); },
  });
  assert.equal(retainedId, 'weight-card');
  assert.deepEqual(events, [
    'POST /api/settings/cards/from-template', 'created:weight-card',
    'PATCH /api/manifests/weight-card', 'GET /api/manifests/weight-card',
  ]);
  assert.deepEqual(stub.calls, [
    { url: '/api/settings/cards/from-template', method: 'POST', credentials: 'same-origin',
      body: { templateId: 'body-mass-hae' } },
    { url: '/api/manifests/weight-card', method: 'PATCH', credentials: 'same-origin',
      body: { meta: { healthConnectDisplay: weightSelection } } },
    { url: '/api/manifests/weight-card', method: 'GET', credentials: 'same-origin' },
  ]);
  assert.deepEqual(result, weightEntry);
});

test('existing Steps cutover keeps its card, metadata and history without creating another card', async () => {
  const previous = structuredClone(stepsEntry);
  previous.meta.healthConnectDisplay.switchDate = '2026-10-01';
  const expected = {
    ...previous,
    meta: { ...previous.meta, healthConnectDisplay: stepsSelection },
  };
  const readback = {
    meta: expected.meta, data: expected.data, projection: expected.projection,
  };
  const signal = new AbortController().signal;
  const stub = transport([
    { status: 200, json: { ok: true, id: 'steps-card' } },
    { status: 200, json: readback },
  ], signal);
  let created = 0;
  const result = await saveDashboardSelection({
    fetchImpl: stub.fetchImpl, cardId: previous.id, recordType: 'StepsRecord',
    selection: stepsSelection, signal, onCreated() { created++; },
  });
  assert.equal(created, 0);
  assert.deepEqual(stub.calls, [
    { url: '/api/manifests/steps-card', method: 'PATCH', credentials: 'same-origin',
      body: { meta: { healthConnectDisplay: stepsSelection } } },
    { url: '/api/manifests/steps-card', method: 'GET', credentials: 'same-origin' },
  ]);
  assert.deepEqual(result, expected);
  assert.deepEqual(result.data, previous.data);
  assert.deepEqual(result.meta.ingest, previous.meta.ingest);
  assert.deepEqual(result.meta.writeable, previous.meta.writeable);
  assert.equal(result.meta.label, previous.meta.label);
});

test('a failed PATCH retains the new Steps ID and retry uses that card without another creation', async () => {
  const signal = new AbortController().signal;
  const events = [];
  const first = transport([
    { status: 200, json: { ok: true, id: 'steps-card' } },
    { status: 403, json: { error: 'denied' } },
  ], signal, events);
  let retainedId, succeeded = false;
  await assert.rejects(async () => {
    await saveDashboardSelection({
      fetchImpl: first.fetchImpl, recordType: 'StepsRecord', selection: stepsSelection, signal,
      onCreated(id) { retainedId = id; events.push(`created:${id}`); },
    });
    succeeded = true;
  }, Error);
  assert.equal(succeeded, false);
  assert.equal(retainedId, 'steps-card');
  assert.deepEqual(events, [
    'POST /api/settings/cards/from-template', 'created:steps-card',
    'PATCH /api/manifests/steps-card',
  ]);
  assert.deepEqual(first.calls, [
    { url: '/api/settings/cards/from-template', method: 'POST', credentials: 'same-origin',
      body: { templateId: 'steps' } },
    { url: '/api/manifests/steps-card', method: 'PATCH', credentials: 'same-origin',
      body: { meta: { healthConnectDisplay: stepsSelection } } },
  ]);

  const retry = transport([
    { status: 200, json: { ok: true, id: 'steps-card' } },
    { status: 200, json: stepsReadback },
  ], signal);
  let createdAgain = 0;
  const result = await saveDashboardSelection({
    fetchImpl: retry.fetchImpl, cardId: retainedId, recordType: 'StepsRecord',
    selection: stepsSelection, signal, onCreated() { createdAgain++; },
  });
  assert.equal(createdAgain, 0);
  assert.deepEqual(retry.calls, [
    { url: '/api/manifests/steps-card', method: 'PATCH', credentials: 'same-origin',
      body: { meta: { healthConnectDisplay: stepsSelection } } },
    { url: '/api/manifests/steps-card', method: 'GET', credentials: 'same-origin' },
  ]);
  assert.deepEqual(result, stepsEntry);
  assert.equal([...first.calls, ...retry.calls].filter(call => call.method === 'POST').length, 1);
});

test('successful PATCH with a different effective readback refuses success', async () => {
  const mismatched = structuredClone(weightReadback);
  mismatched.meta.healthConnectDisplay.switchDate = '2026-11-03';
  const signal = new AbortController().signal;
  const stub = transport([
    { status: 200, json: { ok: true, id: 'weight-card' } },
    { status: 200, json: mismatched },
  ], signal);
  let succeeded = false;
  await assert.rejects(async () => {
    await saveDashboardSelection({
      fetchImpl: stub.fetchImpl, cardId: 'weight-card', recordType: 'WeightRecord',
      selection: weightSelection, signal,
    });
    succeeded = true;
  }, Error);
  assert.equal(succeeded, false);
  assert.deepEqual(stub.calls, [
    { url: '/api/manifests/weight-card', method: 'PATCH', credentials: 'same-origin',
      body: { meta: { healthConnectDisplay: weightSelection } } },
    { url: '/api/manifests/weight-card', method: 'GET', credentials: 'same-origin' },
  ]);
});
