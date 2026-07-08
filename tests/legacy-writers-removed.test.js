// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/legacy-writers-removed.test.js
// Regression for #496: the legacy mood/notes/injection-log endpoints were
// the only server writers that bypassed the manifest registry, reconciling
// only via the debounced fs.watch reload — a clobber window against a
// registry write to the same card. They were also dead: the v2 UI never
// called them, and on the live v2 array cards the mood/notes handlers were
// silent no-ops (they applied date-keyed-object semantics to an array, so
// JSON.stringify dropped the write). The injection-log handler additionally
// mutated peptides.json on disk, leaving the registry cache stale.
//
// This suite pins two things: the bypass routes are gone (404), and the
// surviving write seam (POST /api/manifests/:id/data) is immediately
// consistent for a peptides dose check-off — which is how the live
// schedule-card actually logs doses.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const {
  createSandbox,
  cleanupSandbox,
  spawnServer,
  req,
  fakeAuthState,
} = require('./helpers/sandbox');

function moodManifest() {
  return {
    $schema: 'klebb.datafile.v1',
    meta: {
      id: 'mood',
      label: 'Mood',
      view: { enabled: true, component: 'generic-card' },
      writeable: {
        fromWebapp: true, todayAllowed: true, pastAllowed: true, maxReadingsPerDay: 1,
        inputs: [{ key: 'mood', type: 'rating', min: 1, max: 5 }],
      },
    },
    description: 'Daily mood.',
    data: [{ date: '2026-05-01', mood: 3 }],
  };
}

function peptidesManifest() {
  return {
    $schema: 'klebb.datafile.v1',
    meta: {
      id: 'peptides',
      label: 'Schedule',
      view: { enabled: true, component: 'schedule-card' },
      writeable: { fromWebapp: true, todayAllowed: true },
    },
    description: 'Peptide schedule.',
    data: { items: [{ id: 'bpc', name: 'BPC-157', doses: [] }], groups: [] },
  };
}

describe('#496: registry-bypassing legacy writers are removed', () => {
  let sandbox, server, auth;

  before(async () => {
    auth = fakeAuthState('u');
    sandbox = createSandbox({
      seed: { 'mood.json': moodManifest(), 'peptides.json': peptidesManifest() },
      credentials: auth.credentials,
      sessions: auth.sessions,
    });
    server = await spawnServer(sandbox);
  });

  after(async () => {
    if (server) await server.kill();
    cleanupSandbox(sandbox);
  });

  for (const [name, method, path, body] of [
    ['mood POST', 'POST', '/api/mood/2026-05-02', { mood: 5, notes: 'x' }],
    ['mood DELETE', 'DELETE', '/api/mood/2026-05-01', null],
    ['notes POST', 'POST', '/api/notes/2026-05-02', { text: 'a note' }],
    ['injection-log POST', 'POST', '/api/injection-log/2026-05-02', { peptide: 'BPC-157', taken: true }],
    ['injection-log GET all', 'GET', '/api/injection-log', null],
    ['injection-log GET date', 'GET', '/api/injection-log/2026-05-02', null],
    ['mood GET', 'GET', '/api/mood/2026-05-01', null],
    ['notes GET', 'GET', '/api/notes/2026-05-01', null],
  ]) {
    test(`${name} is gone (404)`, async () => {
      const r = await req(server.baseUrl, path, { method, cookie: auth.cookie, body });
      assert.equal(r.status, 404, `${method} ${path} should 404, got ${r.status}: ${r.body}`);
    });
  }

  test('the removed injection-log write-through did not leave a side path: dose check-off goes through the registry and is immediately visible', async () => {
    // The live schedule-card logs a dose by POSTing the full data block to
    // the registry write seam. Prove it round-trips without waiting on the
    // fs.watch reload — which the old direct-file write-through could not.
    const before = await req(server.baseUrl, '/api/manifests/peptides/data', { cookie: auth.cookie });
    const data = before.json.data;
    data.items[0].doses.push({ scheduledDate: '2026-05-02', takenAt: '2026-05-02T09:00:00.000Z' });

    const write = await req(server.baseUrl, '/api/manifests/peptides/data', {
      method: 'POST', cookie: auth.cookie, body: { data },
    });
    assert.equal(write.status, 200, `write failed: ${write.body}`);

    const after = await req(server.baseUrl, '/api/manifests/peptides/data', { cookie: auth.cookie });
    assert.equal(after.status, 200);
    const doses = after.json.data.items[0].doses;
    assert.equal(doses.length, 1, 'dose persisted through the registry');
    assert.equal(doses[0].scheduledDate, '2026-05-02');
    assert.equal(doses[0].takenAt, '2026-05-02T09:00:00.000Z');
  });
});
