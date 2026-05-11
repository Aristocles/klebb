// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/api/mood-edit-single-date.test.js
// Regression test for the M1 bug tracked in #181 (see QA-BUGS.md B11):
// editing a single past-date mood row must not overwrite other rows.
//
// The server accepts a full `data[]` replacement on POST /api/manifests/
// :id/data. This test exercises a correct client payload (all rows
// present, only target row changed) and asserts only that row's mood
// value is different post-write. A broken client that sends the same
// mood for every row would make this test pass — but the fix for #181
// lives client-side (form submission path), and the E2E equivalent
// in tests-e2e/ will cover that layer once it lands.
//
// In the meantime this test documents the server-side contract: the
// write endpoint must round-trip a targeted edit faithfully. Regression
// here means a server change that mangles data.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const {
  createSandbox,
  cleanupSandbox,
  spawnServer,
  req,
  fakeAuthState,
} = require('../helpers/sandbox');

function moodManifest(data) {
  return {
    $schema: 'klebb.datafile.v1',
    meta: {
      id: 'mood',
      label: 'Mood',
      view: {
        enabled: true,
        component: 'generic-card',
        dateContext: 'latest',
        display: {
          template: '{mood}',
          emojiMap: { 1: '😩', 2: '😔', 3: '😐', 4: '🙂', 5: '😄' },
        },
      },
      writeable: {
        fromWebapp: true,
        todayAllowed: true,
        pastAllowed: true,
        futureAllowed: false,
        maxReadingsPerDay: 1,
        inputs: [
          { key: 'mood', type: 'rating', min: 1, max: 5, required: true },
          { key: 'note', type: 'textarea', required: false },
        ],
      },
    },
    description: 'Daily mood rating.',
    data,
  };
}

describe('M1/#181: mood edit must affect only the targeted date', () => {
  let sandbox, server, auth;

  const seedData = [
    { date: '2026-05-05', mood: 5 },
    { date: '2026-05-06', mood: 3 },
    { date: '2026-05-07', mood: 4 },
    { date: '2026-05-08', mood: 2 },
    { date: '2026-05-09', mood: 5 },
  ];

  before(async () => {
    auth = fakeAuthState('e2e-user');
    sandbox = createSandbox({
      seed: { 'mood.json': moodManifest(seedData) },
      credentials: auth.credentials,
      sessions: auth.sessions,
    });
    server = await spawnServer(sandbox);
  });

  after(async () => {
    if (server) await server.kill();
    cleanupSandbox(sandbox);
  });

  test('editing 2026-05-06 leaves other dates intact', async () => {
    const target = '2026-05-06';
    const newMoodValue = 1;
    const nextRows = seedData.map(r =>
      r.date === target ? { ...r, mood: newMoodValue } : r,
    );

    const writeRes = await req(server.baseUrl, '/api/manifests/mood/data', {
      method: 'POST',
      cookie: auth.cookie,
      body: { data: nextRows },
    });
    assert.equal(writeRes.status, 200, `write failed: ${writeRes.body}`);

    const readRes = await req(server.baseUrl, '/api/manifests/mood/data', {
      cookie: auth.cookie,
    });
    assert.equal(readRes.status, 200);
    const rows = readRes.json.data;

    const byDate = Object.fromEntries(rows.map(r => [r.date, r.mood]));
    assert.equal(byDate[target], newMoodValue, 'target row updated');
    assert.equal(byDate['2026-05-05'], 5, 'prior day untouched');
    assert.equal(byDate['2026-05-07'], 4, 'next day untouched');
    assert.equal(byDate['2026-05-08'], 2, 'untouched');
    assert.equal(byDate['2026-05-09'], 5, 'latest untouched');
  });
});
