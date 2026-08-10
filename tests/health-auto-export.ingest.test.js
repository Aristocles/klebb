// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/health-auto-export.ingest.test.js
// End-to-end ingest test: POST canned HAE payload, assert subscriber
// manifests upsert correctly. No auto-seed: a fresh sandbox with no
// subscribers ingests nothing and creates no files.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createSandbox, cleanupSandbox, spawnServer, req } = require('./helpers/sandbox');
const { readSamples } = require('./helpers/hae-samples-readback');

const CANNED_PAYLOAD = {
  data: {
    metrics: [
      { name: 'sleep_analysis', data: [
        { date: '2026-05-04 00:00:00 +1000', totalSleep: 7.8, inBed: 8.5,
          asleep: 7.6, source: 'Apple Watch' },
      ]},
      { name: 'step_count', data: [
        { date: '2026-05-04 08:00:00 +1000', qty: 3500 },
        { date: '2026-05-04 15:00:00 +1000', qty: 4200 },
      ]},
      { name: 'apple_exercise_time', data: [
        { date: '2026-05-04 09:00:00 +1000', qty: 1 },
        { date: '2026-05-04 09:30:00 +1000', qty: 1 },
        { date: '2026-05-04 16:00:00 +1000', qty: 1 },
      ]},
    ],
    workouts: [
      { name: 'Functional Strength Training',
        start: '2026-05-04 11:00:00 +1000', duration: 1800 },
    ],
  },
};

// Minimal subscriber manifests — written into the sandbox so the
// dispatcher has targets to route into.
const SUBSCRIBERS = {
  'sleep-hours.json': {
    $schema: 'klebb.datafile.v1',
    meta: {
      id: 'sleep-hours', label: 'Sleep', emoji: '😴', order: 500,
      ingest: { source: 'hae', metric: 'sleep_analysis' },
      view: { enabled: true, component: 'generic-card',
              display: { template: '{hours:round(1)}', unit: 'hrs' } },
      writeable: { fromWebapp: false },
    },
    data: [],
  },
  'steps.json': {
    $schema: 'klebb.datafile.v1',
    meta: {
      id: 'steps', label: 'Steps', emoji: '👣', order: 520,
      ingest: { source: 'hae', metric: 'step_count' },
      view: { enabled: true, component: 'generic-card',
              display: { template: '{count}', unit: 'steps' } },
      writeable: { fromWebapp: false },
    },
    data: [],
  },
  'active-minutes.json': {
    $schema: 'klebb.datafile.v1',
    meta: {
      id: 'active-minutes', label: 'Active Minutes', emoji: '⏱️', order: 525,
      ingest: { source: 'hae', metric: 'apple_exercise_time' },
      view: { enabled: true, component: 'generic-card',
              display: { template: '{minutes}', unit: 'min' } },
      writeable: { fromWebapp: false },
    },
    data: [],
  },
  'workouts.json': {
    $schema: 'klebb.datafile.v1',
    meta: {
      id: 'workouts', label: 'Workout Today', emoji: '🏋️', order: 530,
      ingest: { source: 'hae', metric: 'workouts' },
      view: { enabled: true, component: 'generic-card',
              display: { template: '{trained?✅ Trained:❌ Rest}',
                         secondary: '{type|}' } },
      writeable: { fromWebapp: false },
    },
    data: [],
  },
};

describe('POST /api/health-auto-export', () => {
  describe('with token unset', () => {
    let sandbox, server;
    before(async () => {
      sandbox = createSandbox({ seed: SUBSCRIBERS });
      server = await spawnServer(sandbox, { HEALTH_AUTO_EXPORT_TOKEN: '' });
    });
    after(async () => { if (server) await server.kill(); if (sandbox) cleanupSandbox(sandbox); });

    test('returns 501 when token unset', async () => {
      const res = await req(server.baseUrl, '/api/health-auto-export', {
        method: 'POST',
        body: CANNED_PAYLOAD,
      });
      assert.equal(res.status, 501);
      assert.equal(res.json.error, 'ingest disabled');
    });
  });

  describe('with token set and subscribers present', () => {
    let sandbox, server;
    const TOKEN = 'test-hae-token-hex-123456789abcdef';

    before(async () => {
      sandbox = createSandbox({ seed: SUBSCRIBERS });
      server = await spawnServer(sandbox, { HEALTH_AUTO_EXPORT_TOKEN: TOKEN });
    });
    after(async () => { if (server) await server.kill(); if (sandbox) cleanupSandbox(sandbox); });

    test('401 with no Authorization header', async () => {
      const res = await req(server.baseUrl, '/api/health-auto-export', {
        method: 'POST',
        body: CANNED_PAYLOAD,
      });
      assert.equal(res.status, 401);
    });

    test('401 with wrong bearer', async () => {
      const res = await req(server.baseUrl, '/api/health-auto-export', {
        method: 'POST',
        body: CANNED_PAYLOAD,
        headers: { Authorization: 'Bearer not-the-right-token' },
      });
      assert.equal(res.status, 401);
    });

    test('200 with correct bearer + upserts subscribed manifests', async () => {
      const res = await req(server.baseUrl, '/api/health-auto-export', {
        method: 'POST',
        body: CANNED_PAYLOAD,
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.ok, true);
      assert.equal(res.json.ingested['sleep-hours'], 1);
      assert.equal(res.json.ingested.steps, 1);
      assert.equal(res.json.ingested['active-minutes'], 1);
      assert.equal(res.json.ingested.workouts, 1);

      // The push's samples are durable. Since #546 that means rows in the
      // samples table rather than a file under auto-export/raw/.
      assert.ok(readSamples(sandbox).length >= 1, 'the push stored no samples');

      // Ingest writes card data to the datastore now, not the manifest file;
      // read it back over the API.
      const dataFor = async (id) => (await req(server.baseUrl, `/api/manifests/${id}/data`)).json.data;

      const sleep = await dataFor('sleep-hours');
      assert.equal(sleep[0].date, '2026-05-04');
      assert.equal(sleep[0].hours, 7.8);

      const steps = await dataFor('steps');
      assert.equal(steps[0].date, '2026-05-04');
      assert.equal(steps[0].count, 7700);

      const active = await dataFor('active-minutes');
      assert.equal(active[0].date, '2026-05-04');
      assert.equal(active[0].minutes, 3);

      const workouts = await dataFor('workouts');
      assert.equal(workouts[0].date, '2026-05-04');
      assert.equal(workouts[0].trained, true);
    });

    test('a push writes only the datastore: manifest files untouched, no tmp strays', async () => {
      const dataDir = path.join(sandbox, 'data');
      const files = ['sleep-hours.json', 'steps.json', 'active-minutes.json', 'workouts.json'];
      const before = Object.fromEntries(
        files.map(f => [f, fs.statSync(path.join(dataDir, f)).mtimeMs]));

      const res = await req(server.baseUrl, '/api/health-auto-export', {
        method: 'POST',
        body: CANNED_PAYLOAD,
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      assert.equal(res.status, 200);
      await new Promise(r => setTimeout(r, 300));

      for (const f of files) {
        assert.equal(fs.statSync(path.join(dataDir, f)).mtimeMs, before[f],
          `${f} mtime changed: an HAE push must not rewrite manifest files`);
      }

      // Nothing under auto-export/ is written by a push any more, so a stray
      // temp file there would mean the removed archive path came back.
      const autoExport = path.join(dataDir, 'auto-export');
      const strays = fs.existsSync(autoExport)
        ? fs.readdirSync(autoExport).filter(f => f.endsWith('.tmp') || f === 'raw')
        : [];
      assert.deepEqual(strays, [], 'a push wrote into auto-export/');
    });

    test('re-POSTing same date overwrites only that date', async () => {
      const second = {
        data: {
          metrics: [
            { name: 'step_count', data: [
              { date: '2026-05-05 10:00:00 +1000', qty: 9001 },
            ]},
          ],
        },
      };
      const res = await req(server.baseUrl, '/api/health-auto-export', {
        method: 'POST',
        body: second,
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      assert.equal(res.status, 200);

      await new Promise(r => setTimeout(r, 200));

      const steps = (await req(server.baseUrl, '/api/manifests/steps/data')).json.data;
      const byDate = Object.fromEntries(steps.map(r => [r.date, r.count]));
      assert.equal(byDate['2026-05-04'], 7700, 'prior date row preserved');
      assert.equal(byDate['2026-05-05'], 9001, 'new date row appended');
    });

    test('malformed JSON body: 200 + warning, payload quarantined', async () => {
      // Still 200 (the phone must not retry-loop) and still recoverable, but
      // the bytes now go to a bounded quarantine rather than the unbounded
      // archive: a payload that will not parse has no samples to store, so it
      // is the one case where keeping the raw bytes still earns its keep.
      const dir = path.join(sandbox, 'data', 'auto-export', 'unparsed');
      const before = fs.existsSync(dir) ? fs.readdirSync(dir).length : 0;

      const res = await req(server.baseUrl, '/api/health-auto-export', {
        method: 'POST',
        body: 'not json at all',
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.ok, true);
      assert.ok(res.json.warning, 'warning present on parse failure');

      const files = fs.readdirSync(dir);
      assert.ok(files.length > before, 'the unparseable payload was not kept');
      assert.equal(
        fs.readFileSync(path.join(dir, files.sort().at(-1)), 'utf8'),
        'not json at all',
        'the quarantined bytes are not what the client sent');
    });
  });

  describe('with no subscribers', () => {
    let sandbox, server;
    const TOKEN = 'test-hae-token-hex-123456789abcdef';

    before(async () => {
      // Empty data dir — no subscribers at all.
      sandbox = createSandbox({ seed: {} });
      server = await spawnServer(sandbox, { HEALTH_AUTO_EXPORT_TOKEN: TOKEN });
    });
    after(async () => { if (server) await server.kill(); if (sandbox) cleanupSandbox(sandbox); });

    test('samples stored, nothing upserted, available metrics reported', async () => {
      const res = await req(server.baseUrl, '/api/health-auto-export', {
        method: 'POST',
        body: CANNED_PAYLOAD,
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.ok, true);
      assert.deepEqual(res.json.ingested, {});
      assert.ok(Array.isArray(res.json.availableUnsubscribed));
      assert.ok(res.json.availableUnsubscribed.includes('sleep_analysis'));
      assert.ok(res.json.availableUnsubscribed.includes('step_count'));
      assert.ok(res.json.availableUnsubscribed.includes('workouts'));

      // None of the four previously auto-seeded manifests were materialised.
      const dataDir = path.join(sandbox, 'data');
      for (const f of ['sleep-hours.json', 'steps.json',
                       'active-minutes.json', 'workouts.json']) {
        assert.ok(!fs.existsSync(path.join(dataDir, f)),
          `${f} should not be auto-created`);
      }

      // The samples are stored even with nothing subscribed: that is what lets
      // a card created later be backfilled, and for an uncatalogued metric it
      // is the only copy that will ever exist.
      const stored = readSamples(sandbox);
      assert.ok(stored.length >= 1, 'a push with no subscribers stored nothing');
      assert.ok(stored.some(s => s.metric === 'sleep_analysis'));
      assert.ok(stored.some(s => s.metric === 'workouts'));
    });
  });
});
