// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/api/issue-632-streaming-drain.test.js
//
// Live-server behaviour the #632 streaming drain enables. The boot drain
// used to park the event loop for the whole file, so a container draining
// a big samples.json answered nothing (healthchecks included) until it
// finished. Now: /healthz answers MID-drain, every other route parks
// behind the boot gate and answers only after boot settles, and the drain
// still imports every push exactly once.

'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const {
  createSandbox, cleanupSandbox, spawnServer, req, fakeAuthState, waitFor,
} = require('../helpers/sandbox');

process.env.HEALTH_HOME_WARNED = '1';

let sqliteAvailable = true;
try { require('node:sqlite'); } catch { sqliteAvailable = false; }
const skip = sqliteAvailable ? false : 'node:sqlite unavailable on this Node';

const PUSHES = 6000;

function samplesFixture(n) {
  const parts = ['{"version":1,"pushes":['];
  for (let i = 0; i < n; i++) {
    const date = `2026-0${(i % 9) + 1}-${String((i % 27) + 1).padStart(2, '0')}`;
    parts.push((i ? ',' : '') + JSON.stringify({
      receivedAt: `${date}T00:00:00.000Z`,
      payload: { data: { metrics: [{ name: 'step_count', units: 'count', data: [{ date, qty: i }] }] } },
    }));
  }
  parts.push(']}');
  return parts.join('');
}

function pushCountOf(home) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(home, 'db', 'klebb.db'));
  try {
    return Number(db.prepare('SELECT COUNT(*) AS n FROM hae_pushes').get().n);
  } finally {
    db.close();
  }
}

describe('issue #632: the boot drain keeps the server breathing', { skip }, () => {
  let auth;
  let home;
  let server;
  const samplesFile = () => path.join(home, 'data', 'auto-export', 'samples.json');

  before(() => {
    auth = fakeAuthState();
    home = createSandbox({
      credentials: auth.credentials,
      sessions: auth.sessions,
      seed: { 'auto-export/samples.json': samplesFixture(PUSHES) },
    });
  });

  after(async () => {
    if (server) await server.kill();
    cleanupSandbox(home);
  });

  test('/healthz answers mid-drain; gated routes park until boot settles; every push lands once', async () => {
    server = await spawnServer(home);

    // A gated request fired while the drain runs: the boot gate must hold it
    // until boot completes, never serve it against a half-initialised
    // registry. Checked below by when its answer arrived.
    let manifestsDoneBeforeDrainDone = false;
    const gated = req(server.baseUrl, '/api/manifests', { cookie: auth.cookie })
      .then((r) => {
        manifestsDoneBeforeDrainDone = fs.existsSync(samplesFile());
        return r;
      });

    // /healthz during the drain window. Non-vacuous: each response is only
    // counted when samples.json still existed at the moment it arrived, so
    // a drain that finished first scores zero.
    let liveMidDrain = 0;
    while (fs.existsSync(samplesFile())) {
      const r = await req(server.baseUrl, '/healthz');
      if (r.status === 200 && fs.existsSync(samplesFile())) liveMidDrain += 1;
    }
    assert.ok(liveMidDrain >= 3,
      `only ${liveMidDrain} /healthz answer(s) landed mid-drain; the drain is parking the event loop again`);

    const manifests = await gated;
    assert.strictEqual(manifests.status, 200, manifests.body);
    assert.strictEqual(manifestsDoneBeforeDrainDone, false,
      'a gated route answered while the boot drain still ran: the boot gate is gone');

    await waitFor(() => {
      const names = fs.readdirSync(path.join(home, 'data', 'auto-export'));
      return names.some(n => n.startsWith('samples.json.imported-'));
    }, { what: 'the drain audit rename' });

    await server.kill();
    server = null;
    assert.strictEqual(pushCountOf(home), PUSHES, 'the drain lost or doubled pushes');
  });
});
