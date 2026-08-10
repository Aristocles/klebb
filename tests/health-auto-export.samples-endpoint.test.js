// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/health-auto-export.samples-endpoint.test.js
//
// The ingest endpoint's side of #546, through a real server: samples land in
// the database, no file archive is written, an unparseable payload is
// quarantined rather than lost, and the quarantine stays bounded.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const {
  createSandbox, cleanupSandbox, spawnServer, req,
} = require('./helpers/sandbox');
const { readSamples, readPushCount } = require('./helpers/hae-samples-readback');

const TOKEN = 'samples-endpoint-token-0123456789';

function push(server, payload) {
  return req(server.baseUrl, '/api/health-auto-export', {
    method: 'POST', body: payload,
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
}

// A body that is NOT valid JSON. `req` writes a string body verbatim, so this
// reaches the endpoint exactly as typed.
function pushRaw(server, text) {
  return req(server.baseUrl, '/api/health-auto-export', {
    method: 'POST', body: text,
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
}

describe('HAE ingest stores samples instead of archiving files', () => {
  let sandbox, server;
  before(async () => {
    sandbox = createSandbox();
    server = await spawnServer(sandbox, { HEALTH_AUTO_EXPORT_TOKEN: TOKEN });
  });
  after(async () => { if (server) await server.kill(); cleanupSandbox(sandbox); });

  test('a push stores its samples and writes no raw file', async () => {
    const r = await push(server, { data: { metrics: [
      { name: 'step_count', data: [{ date: '2026-05-06 08:00:00 +1000', qty: 4200 }] },
      { name: 'vo2_max', units: 'mL/min/kg', data: [{ date: '2026-05-06', qty: 47.3 }] },
    ]}});
    assert.equal(r.status, 200);

    const stored = readSamples(sandbox);
    assert.equal(stored.length, 2);
    // The uncatalogued metric is stored too: this endpoint is the only place it
    // is ever seen, so dropping it here loses it permanently.
    assert.ok(stored.some(s => s.metric === 'vo2_max'),
      'an uncatalogued metric was dropped at ingest');
    assert.equal(fs.existsSync(path.join(sandbox, 'data', 'auto-export', 'raw')), false,
      'the raw file archive is being written again');
  });

  test('a re-sent push stores no new samples but records the push', async () => {
    const payload = { data: { metrics: [
      { name: 'step_count', data: [{ date: '2026-05-07', qty: 5000 }] },
    ]}};
    await push(server, payload);
    const afterFirst = readSamples(sandbox).length;
    const pushesAfterFirst = readPushCount(sandbox);

    await push(server, payload);
    assert.equal(readSamples(sandbox).length, afterFirst,
      'an identical re-send stored a duplicate');
    assert.equal(readPushCount(sandbox), pushesAfterFirst + 1,
      'the re-send was not recorded as a push, which replay grouping needs');
  });

  test('an unparseable payload is quarantined and reported, not silently dropped', async () => {
    const res = await pushRaw(server, '{ this is not json');
    assert.equal(res.status, 200, 'the 200-on-parse-failure contract changed');
    assert.match(res.body, /quarantined/);

    const dir = path.join(sandbox, 'data', 'auto-export', 'unparsed');
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    assert.equal(files.length, 1);
    assert.equal(fs.readFileSync(path.join(dir, files[0]), 'utf8'), '{ this is not json',
      'the quarantined bytes are not what the client sent');

    // The status diagnostic says what happened, which is the only way an
    // operator learns a push is failing when the endpoint answers 200.
    const status = await req(server.baseUrl, '/api/health-auto-export/status');
    assert.ok(status.json.lastPush.warnings.some(w => /quarantined/.test(w)),
      `no warning recorded: ${JSON.stringify(status.json.lastPush)}`);
  });

  test('the quarantine keeps only the most recent few', async () => {
    const dir = path.join(sandbox, 'data', 'auto-export', 'unparsed');
    for (let i = 0; i < 8; i++) {
      await pushRaw(server, `{ bad payload ${i}`);
    }
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    const { KEEP } = require('../health-auto-export/quarantine');
    assert.ok(files.length <= KEEP,
      `quarantine is unbounded: ${files.length} files for a cap of ${KEEP}`);
    // And the ones kept are the newest, otherwise the cap is useless.
    const newest = files.sort().at(-1);
    assert.match(fs.readFileSync(path.join(dir, newest), 'utf8'), /bad payload 7/);
  });

  test('samples survive a restart and a later card replays from them', async () => {
    // The point of the whole store: history recorded with nothing subscribed is
    // still there for a card created afterwards, across a process boundary.
    await push(server, { data: { metrics: [
      { name: 'sleep_analysis', data: [
        { date: '2026-05-10', totalSleep: 7.4, source: 'Apple Watch' },
      ]},
    ]}});
    await server.kill();
    server = await spawnServer(sandbox, { HEALTH_AUTO_EXPORT_TOKEN: TOKEN });

    const create = await req(server.baseUrl, '/api/manifests', {
      method: 'POST',
      body: {
        $schema: 'klebb.datafile.v1',
        meta: {
          id: 'sleep-after-restart', label: 'Sleep',
          ingest: { source: 'hae', metric: 'sleep_analysis' },
          view: { enabled: true, component: 'generic-card',
                  display: { template: '{hours:round(1)}', unit: 'hrs' } },
          writeable: { fromWebapp: false },
        },
        data: [],
      },
    });
    assert.ok(create.status === 200 || create.status === 201,
      `create failed (${create.status}): ${create.body}`);

    const data = await req(server.baseUrl, '/api/manifests/sleep-after-restart/data');
    assert.equal(data.status, 200);
    assert.equal(data.json.data.length, 1);
    assert.equal(data.json.data[0].hours, 7.4);
  });
});
