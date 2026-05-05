// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/health-auto-export.ingest.test.js
// End-to-end ingest test: POST canned HAE payload, assert manifests upserted.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createSandbox, cleanupSandbox, spawnServer, req } = require('./helpers/sandbox');

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

describe('POST /api/health-auto-export', () => {
  describe('with token unset', () => {
    let sandbox, server;
    before(async () => {
      sandbox = createSandbox();
      // Spawn WITHOUT the token env var
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

  describe('with token set', () => {
    let sandbox, server;
    const TOKEN = 'test-hae-token-hex-123456789abcdef';

    before(async () => {
      sandbox = createSandbox();
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

    test('200 with correct bearer + upserts four manifests', async () => {
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

      // Raw payload was archived
      const rawDir = path.join(sandbox, 'data', 'auto-export', 'raw');
      const files = fs.readdirSync(rawDir).filter(f => f.endsWith('.json'));
      assert.ok(files.length >= 1, 'raw file was archived');

      // Each atomic manifest exists on disk and carries the expected row
      const sleepMan = JSON.parse(fs.readFileSync(
        path.join(sandbox, 'data', 'sleep-hours.json'), 'utf8'));
      assert.equal(sleepMan.data[0].date, '2026-05-04');
      assert.equal(sleepMan.data[0].hours, 7.8);

      const stepsMan = JSON.parse(fs.readFileSync(
        path.join(sandbox, 'data', 'steps.json'), 'utf8'));
      assert.equal(stepsMan.data[0].date, '2026-05-04');
      assert.equal(stepsMan.data[0].count, 7700);

      const activeMan = JSON.parse(fs.readFileSync(
        path.join(sandbox, 'data', 'active-minutes.json'), 'utf8'));
      assert.equal(activeMan.data[0].date, '2026-05-04');
      assert.equal(activeMan.data[0].minutes, 3);

      const workoutsMan = JSON.parse(fs.readFileSync(
        path.join(sandbox, 'data', 'workouts.json'), 'utf8'));
      assert.equal(workoutsMan.data[0].date, '2026-05-04');
      assert.equal(workoutsMan.data[0].trained, true);
    });

    test('re-POSTing same date overwrites only that date', async () => {
      // First push: 2026-05-04 with 7700 steps (from the previous test).
      // Second push: 2026-05-05, new date.
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

      // Give the fs.watch reload a tick
      await new Promise(r => setTimeout(r, 200));

      const stepsMan = JSON.parse(fs.readFileSync(
        path.join(sandbox, 'data', 'steps.json'), 'utf8'));
      // Should still have both dates
      const byDate = Object.fromEntries(stepsMan.data.map(r => [r.date, r.count]));
      assert.equal(byDate['2026-05-04'], 7700, 'prior date row preserved');
      assert.equal(byDate['2026-05-05'], 9001, 'new date row appended');
    });

    test('malformed JSON body: 200 + warning, raw archived', async () => {
      const rawDir = path.join(sandbox, 'data', 'auto-export', 'raw');
      const before = fs.readdirSync(rawDir).length;

      const res = await req(server.baseUrl, '/api/health-auto-export', {
        method: 'POST',
        body: 'not json at all',
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.ok, true);
      assert.ok(res.json.warning, 'warning present on parse failure');

      const after = fs.readdirSync(rawDir).length;
      assert.ok(after > before, 'raw file archived on parse failure');
    });
  });
});
