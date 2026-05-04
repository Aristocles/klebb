// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/health-auto-export.ingest.test.js
// End-to-end coverage of POST /api/health-auto-export/<type>.
//
// Spawns a real server against a sandbox HEALTH_HOME and exercises:
//   - 501 when the token env is unset (feature off by default),
//   - 401 on missing / wrong bearer,
//   - 404 on unsupported type,
//   - 400 on malformed body,
//   - 200 happy path: archive file written + atomic target manifests
//     created / upserted,
//   - idempotency: re-posting the same date overwrites only that date,
//   - partial writes (bedTime then wakeTime) merge on the same date,
//   - existing manifests receive new rows without losing prior rows.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {
  createSandbox, cleanupSandbox, spawnServer, req, fakeAuthState,
} = require('./helpers/sandbox');

const TOKEN = 'test-hae-token-1234567890';

describe('POST /api/health-auto-export/<type>', () => {

  describe('feature disabled (no token env)', () => {
    let sandbox, server;
    before(async () => {
      sandbox = createSandbox();
      server = await spawnServer(sandbox);  // no HEALTH_AUTO_EXPORT_TOKEN
    });
    after(async () => {
      if (server) await server.kill();
      cleanupSandbox(sandbox);
    });

    test('returns 501', async () => {
      const res = await req(server.baseUrl, '/api/health-auto-export/sleep', {
        method: 'POST',
        body: { date: '2026-05-01', metrics: { hours: 7 } },
      });
      assert.equal(res.status, 501);
    });
  });

  describe('feature enabled', () => {
    let sandbox, server, auth;
    const bearer = { 'Authorization': `Bearer ${TOKEN}` };

    before(async () => {
      auth = fakeAuthState('op');
      sandbox = createSandbox({
        credentials: auth.credentials,
        sessions: auth.sessions,
      });
      server = await spawnServer(sandbox, { HEALTH_AUTO_EXPORT_TOKEN: TOKEN });
    });
    after(async () => {
      if (server) await server.kill();
      cleanupSandbox(sandbox);
    });

    test('401 without bearer', async () => {
      const res = await req(server.baseUrl, '/api/health-auto-export/sleep', {
        method: 'POST',
        body: { date: '2026-05-01', metrics: { hours: 7 } },
      });
      assert.equal(res.status, 401);
    });

    test('401 with wrong bearer', async () => {
      const res = await req(server.baseUrl, '/api/health-auto-export/sleep', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer nope' },
        body: { date: '2026-05-01', metrics: { hours: 7 } },
      });
      assert.equal(res.status, 401);
    });

    test('404 on unsupported type', async () => {
      const res = await req(server.baseUrl, '/api/health-auto-export/bananas', {
        method: 'POST',
        headers: bearer,
        body: { date: '2026-05-01', metrics: {} },
      });
      assert.equal(res.status, 404);
    });

    test('400 on malformed JSON body', async () => {
      const res = await req(server.baseUrl, '/api/health-auto-export/sleep', {
        method: 'POST',
        headers: bearer,
        body: '{not json',
      });
      assert.equal(res.status, 400);
    });

    test('400 on invalid date', async () => {
      const res = await req(server.baseUrl, '/api/health-auto-export/sleep', {
        method: 'POST',
        headers: bearer,
        body: { date: '5/1/2026', metrics: { hours: 7 } },
      });
      assert.equal(res.status, 400);
    });

    test('happy path: creates missing manifests + archive file', async () => {
      const payload = {
        date: '2026-05-01',
        metrics: {
          hours: 7.5,
          stages: { core: 4.2, rem: 1.3, deep: 1.5, awake: 0.5 },
          bedTime: '23:12',
          wakeTime: '07:05',
        },
      };
      const res = await req(server.baseUrl, '/api/health-auto-export/sleep', {
        method: 'POST',
        headers: bearer,
        body: payload,
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.ok, true);
      assert.equal(res.json.date, '2026-05-01');
      assert.ok(res.json.targets.includes('sleep-hours'));
      assert.ok(res.json.targets.includes('sleep-stages'));
      assert.ok(res.json.targets.includes('sleep-bed-wake'));

      // Archive file on disk
      const archive = path.join(sandbox, 'data', 'auto-export', 'sleep', '2026-05-01.json');
      assert.ok(fs.existsSync(archive), 'archive file should exist');
      const archived = JSON.parse(fs.readFileSync(archive, 'utf8'));
      assert.equal(archived.date, '2026-05-01');
      assert.equal(archived.metrics.hours, 7.5);

      // Target manifests exist and carry the row for this date
      const sleepHours = await req(server.baseUrl, '/api/manifests/sleep-hours/data', { cookie: auth.cookie });
      assert.equal(sleepHours.status, 200);
      const row = sleepHours.json.data.find(r => r.date === '2026-05-01');
      assert.equal(row.hours, 7.5);

      const stages = await req(server.baseUrl, '/api/manifests/sleep-stages/data', { cookie: auth.cookie });
      const stageRow = stages.json.data.find(r => r.date === '2026-05-01');
      assert.equal(stageRow.core, 4.2);
      assert.equal(stageRow.rem, 1.3);
      assert.equal(stageRow.deep, 1.5);

      const bedWake = await req(server.baseUrl, '/api/manifests/sleep-bed-wake/data', { cookie: auth.cookie });
      const bwRow = bedWake.json.data.find(r => r.date === '2026-05-01');
      assert.equal(bwRow.bedTime, '23:12');
      assert.equal(bwRow.wakeTime, '07:05');

      // Manifest file itself is a valid klebb.datafile.v1
      const onDisk = JSON.parse(fs.readFileSync(path.join(sandbox, 'data', 'sleep-hours.json'), 'utf8'));
      assert.equal(onDisk.$schema, 'klebb.datafile.v1');
      assert.equal(onDisk.meta.id, 'sleep-hours');
    });

    test('second post for the same date overwrites only that date', async () => {
      // First: post another date so we have at least two entries to keep.
      await req(server.baseUrl, '/api/health-auto-export/sleep', {
        method: 'POST',
        headers: bearer,
        body: { date: '2026-04-30', metrics: { hours: 6.0 } },
      });
      // Then overwrite the 2026-05-01 row.
      const res = await req(server.baseUrl, '/api/health-auto-export/sleep', {
        method: 'POST',
        headers: bearer,
        body: { date: '2026-05-01', metrics: { hours: 9.0 } },
      });
      assert.equal(res.status, 200);
      const sleepHours = await req(server.baseUrl, '/api/manifests/sleep-hours/data', { cookie: auth.cookie });
      const rows = sleepHours.json.data;
      const may1 = rows.filter(r => r.date === '2026-05-01');
      assert.equal(may1.length, 1, 'exactly one row for the reposted date');
      assert.equal(may1[0].hours, 9.0);
      const apr30 = rows.find(r => r.date === '2026-04-30');
      assert.equal(apr30.hours, 6.0, 'earlier date untouched');
    });

    test('partial writes merge into one row per date', async () => {
      // Post only bedTime.
      await req(server.baseUrl, '/api/health-auto-export/sleep', {
        method: 'POST',
        headers: bearer,
        body: { date: '2026-06-01', metrics: { bedTime: '22:30' } },
      });
      // Then only wakeTime.
      await req(server.baseUrl, '/api/health-auto-export/sleep', {
        method: 'POST',
        headers: bearer,
        body: { date: '2026-06-01', metrics: { wakeTime: '06:40' } },
      });
      const bedWake = await req(server.baseUrl, '/api/manifests/sleep-bed-wake/data', { cookie: auth.cookie });
      const rows = bedWake.json.data.filter(r => r.date === '2026-06-01');
      assert.equal(rows.length, 1);
      assert.equal(rows[0].bedTime, '22:30');
      assert.equal(rows[0].wakeTime, '06:40');
    });

    test('activity payload fans out to four atomic cards', async () => {
      const res = await req(server.baseUrl, '/api/health-auto-export/activity', {
        method: 'POST',
        headers: bearer,
        body: {
          date: '2026-05-01',
          metrics: {
            steps: 8421,
            activeEnergy: 540,
            exerciseMinutes: 42,
            standHours: 11,
          },
        },
      });
      assert.equal(res.status, 200);
      assert.ok(res.json.targets.includes('steps'));
      assert.ok(res.json.targets.includes('active-energy'));
      assert.ok(res.json.targets.includes('exercise-minutes'));
      assert.ok(res.json.targets.includes('stand-hours'));

      const steps = await req(server.baseUrl, '/api/manifests/steps/data', { cookie: auth.cookie });
      assert.equal(steps.json.data.find(r => r.date === '2026-05-01').count, 8421);
      const energy = await req(server.baseUrl, '/api/manifests/active-energy/data', { cookie: auth.cookie });
      assert.equal(energy.json.data.find(r => r.date === '2026-05-01').kcal, 540);
    });

    test('sparse metrics produce only the relevant writes', async () => {
      const res = await req(server.baseUrl, '/api/health-auto-export/activity', {
        method: 'POST',
        headers: bearer,
        body: { date: '2026-05-02', metrics: { steps: 500 } },
      });
      assert.equal(res.status, 200);
      assert.deepEqual(res.json.targets, ['steps']);
    });

    test('unknown metric keys are silently ignored (no writes, still ok)', async () => {
      const res = await req(server.baseUrl, '/api/health-auto-export/sleep', {
        method: 'POST',
        headers: bearer,
        body: { date: '2026-07-01', metrics: { nonsense: 1, moreNonsense: 'x' } },
      });
      assert.equal(res.status, 200);
      assert.deepEqual(res.json.targets, []);
      // No archive for missing-metric day? Actually, we archive regardless,
      // so that raw captures still land. Check.
      const archive = path.join(sandbox, 'data', 'auto-export', 'sleep', '2026-07-01.json');
      assert.ok(fs.existsSync(archive), 'archive should capture even no-op payloads');
    });

    test('existing pre-seeded manifest is upserted, not recreated', async () => {
      // The "steps" manifest was already created by an earlier test (activity).
      // Re-post a new day and confirm BOTH rows end up in the same file.
      await req(server.baseUrl, '/api/health-auto-export/activity', {
        method: 'POST',
        headers: bearer,
        body: { date: '2026-05-03', metrics: { steps: 12345 } },
      });
      const steps = await req(server.baseUrl, '/api/manifests/steps/data', { cookie: auth.cookie });
      const dates = steps.json.data.map(r => r.date);
      assert.ok(dates.includes('2026-05-01'));
      assert.ok(dates.includes('2026-05-03'));
    });
  });
});
