// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests-e2e/seeded-data-imported-and-stripped.spec.js
// The seed manifests ship full inline `data` blocks. On boot the registry's
// import inbox moves each block into the datastore and strips the `data` key
// from the file. This proves the end-to-end mechanism against the real
// spawned server: the on-disk file is meta-only, a backup sits beside it, and
// the data still serves over the unchanged HTTP contract.

const fs = require('fs');
const path = require('path');
const { test, expect } = require('./helpers/auth-fixture');

test.describe('seeded inline data is imported and stripped on boot', () => {
  // /api/manifests/:id/data is auth-gated and Playwright's standalone request
  // fixture does not carry the browser context's session cookie, so send it.
  const authGet = (page, sandboxState, id) =>
    page.request.get(`${sandboxState.baseUrl}/api/manifests/${id}/data`, {
      headers: { Cookie: sandboxState.sessionCookie },
    });

  test('weight.json is meta-only on disk but its data serves via the API', async ({ page, sandboxState }) => {
    const dataDir = path.join(sandboxState.sandbox, 'data');
    const file = path.join(dataDir, 'weight.json');

    // File on disk carries no data key (it was imported + stripped on boot).
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(onDisk.$schema).toBe('klebb.datafile.v1');
    expect(onDisk.meta.id).toBe('weight');
    expect('data' in onDisk).toBe(false);

    // A pre-import backup sits beside it (loader ignores this name).
    const backups = fs.readdirSync(dataDir)
      .filter(f => f.startsWith('weight.json.pre-import-') && f.endsWith('.json'));
    expect(backups.length).toBeGreaterThanOrEqual(1);

    // The seeded rows still serve over the (unchanged) HTTP contract.
    const res = await authGet(page, sandboxState, 'weight');
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBe(4);
    expect(body.data.every(r => typeof r.kg === 'number')).toBe(true);
  });

  test('peptides.json (object-shaped data) round-trips through the store', async ({ page, sandboxState }) => {
    const file = path.join(sandboxState.sandbox, 'data', 'peptides.json');
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect('data' in onDisk).toBe(false);

    const res = await authGet(page, sandboxState, 'peptides');
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(Array.isArray(body.data.items)).toBe(true);
    expect(body.data.items[0].id).toBe('semax');
  });
});
