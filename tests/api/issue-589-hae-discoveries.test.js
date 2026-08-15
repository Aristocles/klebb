// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/api/issue-589-hae-discoveries.test.js
// #589: the Hidden Apple Health Metrics surface. Covers the discoveries
// endpoints (GET list, dismiss, unhide), which shipped with no coverage,
// plus the regression the fix closes: a manifest subscribing an
// uncatalogued HAE metric used to validate fine, store nothing forever,
// AND graduate the metric off the discovery surface. It must now be
// refused with 422 'invalid ingest: ...', leaving the metric discoverable.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const {
  createSandbox,
  cleanupSandbox,
  spawnServer,
  req,
  fakeAuthState,
} = require('../helpers/sandbox');

const DISCOVERIES_PATH = '/api/health-auto-export/discoveries';
const INGEST_PATH = '/api/health-auto-export';
const MANIFESTS_PATH = '/api/manifests';
const HAE_TOKEN = 'test-hae-token-589';

function stepsManifest(id = 'steps') {
  return {
    $schema: 'klebb.datafile.v1',
    meta: {
      id,
      label: 'Steps',
      ingest: { source: 'hae', metric: 'step_count' },
      view: {
        enabled: true,
        component: 'generic-card',
        display: { template: '{count} steps' },
      },
      writeable: { fromWebapp: false },
    },
    description: 'Daily step count ingested from HAE.',
    data: [],
  };
}

// vo2_max is a real HAE metric name that is deliberately NOT in
// health-auto-export/catalogue.js, so it lands on the discovery surface
// as an unsupported entry.
function pushPayload({ withStepCount = true } = {}) {
  const metrics = [
    {
      name: 'vo2_max',
      units: 'mL/min·kg',
      data: [
        { date: '2026-05-01 00:00:00 +1000', qty: 41.2 },
      ],
    },
  ];
  if (withStepCount) {
    metrics.push({
      name: 'step_count',
      units: 'count',
      data: [
        { date: '2026-05-01 00:00:00 +1000', qty: 4200 },
        { date: '2026-05-02 00:00:00 +1000', qty: 6800 },
      ],
    });
  }
  return { data: { metrics } };
}

function push(server, payload) {
  return req(server.baseUrl, INGEST_PATH, {
    method: 'POST',
    headers: { Authorization: `Bearer ${HAE_TOKEN}` },
    body: payload,
  });
}

describe('#589 HAE discoveries surface', () => {
  let sandbox, server, auth;
  let firstSeenAt;

  before(async () => {
    auth = fakeAuthState('e2e-user');
    sandbox = createSandbox({
      seed: { 'steps.json': stepsManifest() },
      credentials: auth.credentials,
      sessions: auth.sessions,
    });
    server = await spawnServer(sandbox, { HEALTH_AUTO_EXPORT_TOKEN: HAE_TOKEN });
  });

  after(async () => {
    if (server) await server.kill();
    if (sandbox) cleanupSandbox(sandbox);
  });

  test('GET discoveries without a session returns 401', async () => {
    const r = await req(server.baseUrl, DISCOVERIES_PATH);
    assert.equal(r.status, 401);
    assert.equal(r.json.error, 'Unauthorized');
  });

  test('GET discoveries with a session returns the empty partitioned shape', async () => {
    const r = await req(server.baseUrl, DISCOVERIES_PATH, { cookie: auth.cookie });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, {
      undismissed: { supported: {}, unsupported: [] },
      dismissed: [],
    });
  });

  test('push: uncatalogued vo2_max is discovered; subscribed step_count is not', async () => {
    const pushed = await push(server, pushPayload());
    assert.equal(pushed.status, 200, `push failed: ${pushed.body}`);
    assert.deepEqual(pushed.json.availableUnsubscribed, ['vo2_max']);
    assert.deepEqual(pushed.json.ingested, { steps: 2 });

    const r = await req(server.baseUrl, DISCOVERIES_PATH, { cookie: auth.cookie });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.undismissed.supported, {});
    assert.equal(r.json.undismissed.unsupported.length, 1);
    assert.equal(r.json.undismissed.unsupported[0].metric, 'vo2_max');
    assert.equal(typeof r.json.undismissed.unsupported[0].firstSeenAt, 'string');
    assert.deepEqual(r.json.dismissed, []);

    firstSeenAt = r.json.undismissed.unsupported[0].firstSeenAt;
  });

  test('dismiss moves vo2_max to the dismissed list', async () => {
    const d = await req(server.baseUrl, `${DISCOVERIES_PATH}/vo2_max/dismiss`, {
      method: 'POST', cookie: auth.cookie,
    });
    assert.equal(d.status, 200);
    assert.deepEqual(d.json, { ok: true });

    const r = await req(server.baseUrl, DISCOVERIES_PATH, { cookie: auth.cookie });
    assert.deepEqual(r.json.undismissed, { supported: {}, unsupported: [] });
    assert.equal(r.json.dismissed.length, 1);
    assert.equal(r.json.dismissed[0].metric, 'vo2_max');
    assert.equal(r.json.dismissed[0].firstSeenAt, firstSeenAt);
    assert.equal(typeof r.json.dismissed[0].dismissedAt, 'string');
  });

  test('unhide brings vo2_max back to the undismissed list', async () => {
    const u = await req(server.baseUrl, `${DISCOVERIES_PATH}/vo2_max/unhide`, {
      method: 'POST', cookie: auth.cookie,
    });
    assert.equal(u.status, 200);
    assert.deepEqual(u.json, { ok: true });

    const r = await req(server.baseUrl, DISCOVERIES_PATH, { cookie: auth.cookie });
    assert.deepEqual(r.json, {
      undismissed: {
        supported: {},
        unsupported: [{ metric: 'vo2_max', firstSeenAt }],
      },
      dismissed: [],
    });
  });
});

describe('#589 regression: refused subscription cannot graduate a discovery', () => {
  let sandbox, server, auth;

  before(async () => {
    auth = fakeAuthState('e2e-user');
    sandbox = createSandbox({
      credentials: auth.credentials,
      sessions: auth.sessions,
    });
    server = await spawnServer(sandbox, { HEALTH_AUTO_EXPORT_TOKEN: HAE_TOKEN });
  });

  after(async () => {
    if (server) await server.kill();
    if (sandbox) cleanupSandbox(sandbox);
  });

  test('POST /api/manifests subscribing an uncatalogued metric returns 422', async () => {
    const pushed = await push(server, pushPayload({ withStepCount: false }));
    assert.equal(pushed.status, 200, `push failed: ${pushed.body}`);
    assert.deepEqual(pushed.json.availableUnsubscribed, ['vo2_max']);

    const r = await req(server.baseUrl, MANIFESTS_PATH, {
      method: 'POST',
      cookie: auth.cookie,
      body: {
        $schema: 'klebb.datafile.v1',
        meta: {
          id: 'vo2-max',
          label: 'VO2 Max',
          ingest: { source: 'hae', metric: 'vo2_max' },
        },
      },
    });
    assert.equal(r.status, 422, `expected 422, got ${r.status}: ${r.body}`);
    assert.match(r.json.error, /^invalid ingest:/);

    const gone = await req(server.baseUrl, `${MANIFESTS_PATH}/vo2-max`, { cookie: auth.cookie });
    assert.equal(gone.status, 404);
  });

  test('a subsequent push still lists vo2_max as discoverable', async () => {
    // Before #589 the bad manifest would have been accepted, counted as a
    // subscriber, and this push would have graduated vo2_max off the
    // surface while storing nothing.
    const pushed = await push(server, pushPayload({ withStepCount: false }));
    assert.equal(pushed.status, 200, `push failed: ${pushed.body}`);
    assert.deepEqual(pushed.json.availableUnsubscribed, ['vo2_max']);

    const r = await req(server.baseUrl, DISCOVERIES_PATH, { cookie: auth.cookie });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.undismissed.unsupported.map(e => e.metric), ['vo2_max']);
    assert.deepEqual(r.json.dismissed, []);
  });

  test('POST /api/manifests subscribing a catalogued metric succeeds 201', async () => {
    const r = await req(server.baseUrl, MANIFESTS_PATH, {
      method: 'POST',
      cookie: auth.cookie,
      body: stepsManifest('steps-created'),
    });
    assert.equal(r.status, 201, `expected 201, got ${r.status}: ${r.body}`);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.id, 'steps-created');
  });
});
