// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/api/hae-ingest-fp-rounding.test.js
// Regression test for #184 (QA-BUGS.md B15): HAE ingest should not
// persist IEEE754 precision tails (e.g. 88.00000000000001 bpm) into
// manifest rows.
//
// Today this test is `test.skip`-d because the bug has not been fixed
// yet — `aggregate: 'last-per-date'` copies the source value verbatim
// in `health-auto-export/ingest.js`. When #184 lands, un-skip the
// test; it will pass against the fixed ingest and fail-fast if the
// behaviour regresses later.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const {
  createSandbox,
  cleanupSandbox,
  spawnServer,
  req,
  fakeAuthState,
} = require('../helpers/sandbox');

function walkingHrManifest() {
  return {
    $schema: 'klebb.datafile.v1',
    meta: {
      id: 'walking-heart-rate',
      label: 'Walking HR',
      ingest: { source: 'hae', metric: 'walking_heart_rate_average' },
      view: {
        enabled: true,
        component: 'generic-card',
        display: { template: '{bpm:round(0)} bpm' },
      },
      writeable: { fromWebapp: false },
    },
    description: 'Walking heart rate average ingested from HAE.',
    data: [],
  };
}

function restingHrManifest() {
  return {
    $schema: 'klebb.datafile.v1',
    meta: {
      id: 'resting-heart-rate',
      label: 'Resting HR',
      ingest: { source: 'hae', metric: 'resting_heart_rate' },
      view: {
        enabled: true,
        component: 'generic-card',
        display: { template: '{bpm} bpm' },
      },
      writeable: { fromWebapp: false },
    },
    description: 'Resting heart rate ingested from HAE.',
    data: [],
  };
}

// Build a minimal HAE payload shape with FP-tail values typical of
// Apple Health averages.
function haePayloadWithFpTails() {
  return {
    data: {
      metrics: [
        {
          name: 'walking_heart_rate_average',
          units: 'bpm',
          data: [
            { date: '2026-05-01 00:00:00 +1000', qty: 88.00000000000001 },
            { date: '2026-05-02 00:00:00 +1000', qty: 84.99999999999999 },
            { date: '2026-05-03 00:00:00 +1000', qty: 91.5 },
          ],
        },
        {
          name: 'resting_heart_rate',
          units: 'bpm',
          data: [
            { date: '2026-05-01 00:00:00 +1000', qty: 62.00000000000001 },
            { date: '2026-05-02 00:00:00 +1000', qty: 67 },
          ],
        },
      ],
    },
  };
}

describe('M1/#184: HAE ingest rounds numeric values', () => {
  let sandbox, server, auth;
  const token = 'test-hae-token';

  before(async () => {
    auth = fakeAuthState('e2e-user');
    sandbox = createSandbox({
      seed: {
        'walking-heart-rate.json': walkingHrManifest(),
        'resting-heart-rate.json': restingHrManifest(),
      },
      credentials: auth.credentials,
      sessions: auth.sessions,
    });
    server = await spawnServer(sandbox, {
      HEALTH_AUTO_EXPORT_TOKEN: token,
    });
  });

  after(async () => {
    if (server) await server.kill();
    cleanupSandbox(sandbox);
  });

  test('walking HR rows are rounded, no IEEE754 tails', async () => {
    const pushRes = await req(server.baseUrl, '/api/health-auto-export', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: haePayloadWithFpTails(),
    });
    assert.equal(pushRes.status, 200, `push failed: ${pushRes.body}`);

    const readRes = await req(server.baseUrl, '/api/manifests/walking-heart-rate/data', {
      cookie: auth.cookie,
    });
    const rows = readRes.json.data;
    for (const r of rows) {
      const s = String(r.bpm);
      assert.ok(
        !s.includes('0000000') && !s.includes('9999999'),
        `FP tail leaked into walking-heart-rate row: ${JSON.stringify(r)}`,
      );
    }
  });

  test('resting HR rows are rounded to integer', async () => {
    const readRes = await req(server.baseUrl, '/api/manifests/resting-heart-rate/data', {
      cookie: auth.cookie,
    });
    const rows = readRes.json.data;
    for (const r of rows) {
      assert.equal(
        r.bpm,
        Math.round(r.bpm),
        `resting-heart-rate row not rounded to integer: ${JSON.stringify(r)}`,
      );
    }
  });
});
