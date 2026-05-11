// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/api/loader-ignores-backup-files.test.js
// Regression test for #197 (QA-BUGS.md B10): the manifest loader must
// not treat timestamped backup files (e.g. foo.json.pre-reingest-*.json)
// as canonical manifests. Today, the loader globs `*.json` in the
// manifests dir, which includes such backups and produces duplicate-id
// errors that drop the canonical card.
//
// Currently `describe.skip` pending the #197 fix. Un-skip on that
// PR to prove the fix; the test then locks in the behaviour.

const fs = require('fs');
const path = require('path');
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const {
  createSandbox,
  cleanupSandbox,
  spawnServer,
  req,
  fakeAuthState,
} = require('../helpers/sandbox');

function moodManifest() {
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
    data: [{ date: '2026-05-09', mood: 4 }],
  };
}

describe.skip('M3/#197: loader ignores timestamped backup files (SKIP until fix)', () => {
  let sandbox, server, auth;

  before(async () => {
    auth = fakeAuthState('e2e-user');
    sandbox = createSandbox({
      seed: {
        'mood.json': moodManifest(),
        // Drop a backup file next to the canonical one. Same $schema,
        // same meta.id — would currently trigger duplicate-id error
        // and drop the canonical card too.
        'mood.json.pre-reingest-2026-05-10T000000000Z.json': moodManifest(),
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

  test('canonical mood card loads; backup file ignored', async () => {
    const res = await req(server.baseUrl, '/api/manifests', { cookie: auth.cookie });
    assert.equal(res.status, 200);
    const ids = res.json.entries.map(e => e.id);
    assert.ok(ids.includes('mood'), 'mood card was loaded');
    assert.equal(
      res.json.entries.filter(e => e.id === 'mood').length,
      1,
      'mood loaded exactly once',
    );
  });
});
