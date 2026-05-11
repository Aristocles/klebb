// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/api/loader-ignores-backup-files.test.js
// Regression tests for #197: the manifest loader must skip timestamped
// backup files (e.g. foo.json.pre-reingest-*.json) outright rather
// than parsing them and hitting duplicate-id errors. The previous
// behaviour produced noisy startup logs and was fragile — if the
// canonical file ever failed to load first, the backup would "win"
// and the user would silently be served stale data.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const {
  createSandbox,
  cleanupSandbox,
  spawnServer,
  req,
  fakeAuthState,
} = require('../helpers/sandbox');

function moodManifest(mood) {
  return {
    $schema: 'klebb.datafile.v1',
    meta: {
      id: 'mood',
      label: 'Mood',
      view: {
        enabled: true,
        component: 'generic-card',
        display: { template: '{mood}' },
      },
      writeable: {
        fromWebapp: true,
        inputs: [{ key: 'mood', type: 'rating', min: 1, max: 5 }],
      },
    },
    description: 'Daily mood rating.',
    data: [{ date: '2026-05-09', mood }],
  };
}

describe('M3/#197: loader skips timestamped backup files', () => {
  describe('canonical present + backup present', () => {
    let sandbox, server, auth;

    before(async () => {
      auth = fakeAuthState('e2e-user');
      sandbox = createSandbox({
        seed: {
          'mood.json': moodManifest(4),
          // Distinct data value so we can prove which file was loaded.
          'mood.json.pre-reingest-2026-05-10T000000000Z.json': moodManifest(1),
        },
        credentials: auth.credentials,
        sessions: auth.sessions,
      });
      server = await spawnServer(sandbox);
    });

    after(async () => {
      if (server) await server.kill();
      cleanupSandbox(sandbox);
    });

    test('mood loads exactly once with canonical data', async () => {
      const res = await req(server.baseUrl, '/api/manifests', { cookie: auth.cookie });
      assert.equal(res.status, 200);
      const ids = res.json.entries.map(e => e.id);
      const moodEntries = res.json.entries.filter(e => e.id === 'mood');
      assert.equal(moodEntries.length, 1, 'mood loaded exactly once');
      assert.ok(ids.includes('mood'));

      // Authoritatively read the canonical data via the API.
      const dataRes = await req(server.baseUrl, '/api/manifests/mood/data', {
        cookie: auth.cookie,
      });
      assert.equal(dataRes.status, 200);
      // Canonical has mood=4; backup has mood=1. If the backup won,
      // this assertion flips.
      assert.equal(dataRes.json.data[0].mood, 4, 'canonical file won, not backup');
    });
  });

  describe('backup only (canonical missing)', () => {
    let sandbox, server, auth;

    before(async () => {
      auth = fakeAuthState('e2e-user');
      sandbox = createSandbox({
        // No canonical mood.json; only the backup. The loader should
        // NOT resurrect the card from the backup — backups are not
        // manifests and must be ignored regardless of what sits beside
        // them.
        seed: {
          'mood.json.pre-reingest-2026-05-10T000000000Z.json': moodManifest(1),
        },
        credentials: auth.credentials,
        sessions: auth.sessions,
      });
      server = await spawnServer(sandbox);
    });

    after(async () => {
      if (server) await server.kill();
      cleanupSandbox(sandbox);
    });

    test('mood is absent — backup files never populate the registry', async () => {
      const res = await req(server.baseUrl, '/api/manifests', { cookie: auth.cookie });
      assert.equal(res.status, 200);
      const ids = res.json.entries.map(e => e.id);
      assert.ok(!ids.includes('mood'), 'backup file must not create a card');
    });
  });
});
