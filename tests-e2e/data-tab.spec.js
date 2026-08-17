// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests-e2e/data-tab.spec.js
// Settings > Data in a real browser: the export download, the import wizard
// happy path on a fresh instance, and the typed-REPLACE confirm gate on a
// populated one.
//
// Every test spawns its OWN server (the webauthn-ceremony pattern): an
// import apply wipes the whole instance, which would destroy the shared
// sandbox for every spec after this one. Uses raw @playwright/test because
// the auth fixture pins its cookie to the shared sandbox; each test injects
// a session cookie for its own server instead.
//
// The import fixture is a REAL export: a seeded source server's
// /api/export download, saved once in beforeAll. Export on A, import on
// B, exactly the moving-an-instance recipe. The archive then gets a bulk
// HAE history planted into it: apply detaches into a polled job (#633),
// and the pushes stretch the pipeline's drain so the progress view
// reliably renders at least one stage label before the result card.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { test, expect } = require('@playwright/test');
const {
  createSandbox, cleanupSandbox, spawnServer, fakeAuthState,
} = require('../tests/helpers/sandbox');
const { injectPushes, treeZipEntries } = require('../tests/helpers/hae-push-fixture');
const { openZip } = require('../lib/zip/read');
const { writeZip } = require('../lib/zip/write');
const { seedManifests, todayISO } = require('./helpers/seed-manifests');

const FIXTURE_PUSHES = 240;

test.setTimeout(90_000);

// Same TZ pinning as the shared sandbox (helpers/global-setup.js): the
// browser and the server must agree on what "today" is.
const HOST_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

function binGet(baseUrl, pathname, cookie) {
  return new Promise((resolve, reject) => {
    const r = http.request(new URL(pathname, baseUrl), { headers: { Cookie: cookie } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, buf: Buffer.concat(chunks) }));
    });
    r.on('error', reject);
    r.setTimeout(30_000, () => r.destroy(new Error('request timeout')));
    r.end();
  });
}

// The source archive: Weight + Mood from the shared seed shapes (full view
// config, so they render as cards after the import). 2 cards, both with
// data, no HAE pushes, no reports.
function sourceSeed() {
  const all = seedManifests();
  return { 'weight.json': all['weight.json'], 'mood.json': all['mood.json'] };
}

// A card the archive does NOT carry, for the populated target: its survival
// proves a refused confirm destroyed nothing, its absence after apply
// proves the wipe.
function oldCard() {
  const today = todayISO();
  return {
    $schema: 'klebb.datafile.v1',
    meta: {
      id: 'old-card',
      label: 'Old Card',
      emoji: '🗃️',
      order: 100,
      category: 'lifestyle',
      view: {
        enabled: true,
        component: 'generic-card',
        fallbackToLatest: true,
        display: { template: '{n}' },
      },
      writeable: { fromWebapp: false },
    },
    description: 'Pre-import card for the confirm-gate spec.',
    data: [{ date: today, n: 7 }],
  };
}

async function injectSession(context, baseUrl, token) {
  const url = new URL(baseUrl);
  await context.addCookies([{
    name: 'klebb_session',
    value: token,
    domain: url.hostname,
    path: '/',
    httpOnly: true,
    secure: false,
    sameSite: 'Lax',
  }]);
}

async function openDataTab(page, baseUrl) {
  await page.goto(`${baseUrl}/settings`);
  await expect(page.locator('eh-settings-view')).toBeVisible();
  await page.locator('eh-settings-view [data-tab="data"]').click();
  const pane = page.locator('eh-settings-data');
  await expect(pane).toBeVisible();
  return pane;
}

let fixtureDir;
let fixtureZip;

test.beforeAll(async () => {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eh-e2e-data-tab-'));
  const auth = fakeAuthState();
  const srcHome = createSandbox({
    credentials: auth.credentials,
    sessions: auth.sessions,
    seed: sourceSeed(),
  });
  const src = await spawnServer(srcHome, { TZ: HOST_TZ });
  try {
    const r = await binGet(src.baseUrl, '/api/export', auth.cookie);
    if (r.status !== 200) throw new Error(`fixture export failed: ${r.status}`);
    fixtureZip = path.join(fixtureDir, 'source-export.zip');
    fs.writeFileSync(fixtureZip, r.buf);
  } finally {
    await src.kill();
    cleanupSandbox(srcHome);
  }

  // Plant the bulk HAE history (inventory-listed) and re-zip in place.
  const tree = path.join(fixtureDir, 'source-tree');
  const zip = await openZip(fixtureZip);
  await zip.extractTo(tree);
  await zip.close();
  injectPushes(tree, FIXTURE_PUSHES);
  await writeZip(fixtureZip, treeZipEntries(tree));
});

test.afterAll(() => {
  try { fs.rmSync(fixtureDir, { recursive: true, force: true }); } catch {}
});

test.describe('#618: Settings > Data', () => {
  let home, server;

  test.afterEach(async () => {
    if (server) { await server.kill(); server = null; }
    if (home) { cleanupSandbox(home); home = null; }
  });

  test('export: the download fires with the pinned filename shape and real bytes', async ({ page, context }) => {
    const auth = fakeAuthState();
    home = createSandbox({
      credentials: auth.credentials,
      sessions: auth.sessions,
      seed: sourceSeed(),
    });
    server = await spawnServer(home, { TZ: HOST_TZ });
    await injectSession(context, server.baseUrl, auth.token);

    const pane = await openDataTab(page, server.baseUrl);
    const downloadPromise = page.waitForEvent('download');
    await pane.locator('.export-btn').click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toMatch(/^klebb-export-\d{8}-\d{6}\.zip$/);
    const saved = path.join(fixtureDir, 'download-check.zip');
    await download.saveAs(saved);
    // Non-trivial: a manifest plus two data-carrying cards can never
    // deflate to a handful of bytes.
    expect(fs.statSync(saved).size).toBeGreaterThan(600);
  });

  test('import: fresh instance walks the wizard with no confirm and serves the cards', async ({ page, context }) => {
    const auth = fakeAuthState();
    home = createSandbox({ credentials: auth.credentials, sessions: auth.sessions });
    server = await spawnServer(home, { TZ: HOST_TZ });
    await injectSession(context, server.baseUrl, auth.token);

    const pane = await openDataTab(page, server.baseUrl);
    await pane.locator('.file-input').setInputFiles(fixtureZip);

    // Fresh target: preview with plan counts and the exclusions line, a
    // plain Apply, and NO typed-confirmation ceremony.
    const preview = pane.locator('.preview-panel');
    await expect(preview).toBeVisible({ timeout: 20_000 });
    await expect(preview.locator('.plan-counts'))
      .toContainText(`2 cards (2 with data), ${FIXTURE_PUSHES} HAE pushes, 0 reports`);
    await expect(preview.locator('.exclusions'))
      .toContainText('Passkeys, connected devices and chat history stay with the instance');
    await expect(preview.locator('.confirm-input')).toHaveCount(0);
    await expect(preview.locator('.danger-panel')).toHaveCount(0);

    // Apply detaches into a polled job: the progress view renders a live
    // stage label before the result card appears.
    await preview.locator('.apply-btn').click();
    const applying = pane.locator('.applying-panel');
    await expect(applying).toBeVisible({ timeout: 20_000 });
    await expect(applying.locator('.stage-label')).toContainText(
      /Saving a rollback snapshot|Clearing this instance|Copying the archive in|Importing history|Importing cards|Reloading|Verifying|Tidying up/);
    await expect(applying).toContainText('keep this page open');

    const result = pane.locator('.result-panel');
    await expect(result).toBeVisible({ timeout: 60_000 });
    await expect(result.locator('.result-counts'))
      .toContainText(`Import complete: verified 2 cards, ${FIXTURE_PUSHES} HAE pushes, 0 reports.`);

    // Reload the app, then the imported cards render on Today.
    await result.locator('.reload-btn').click();
    await page.goto(`${server.baseUrl}/`);
    await expect(page.locator('eh-date-view')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('eh-generic-card', { hasText: 'Weight' })).toBeVisible();
    await expect(page.locator('eh-generic-card', { hasText: 'Mood' })).toBeVisible();
  });

  test('import: populated instance holds behind REPLACE, then the held nonce carries the apply', async ({ page, context }) => {
    const auth = fakeAuthState();
    home = createSandbox({
      credentials: auth.credentials,
      sessions: auth.sessions,
      seed: { 'old-card.json': oldCard() },
    });
    server = await spawnServer(home, { TZ: HOST_TZ });
    await injectSession(context, server.baseUrl, auth.token);

    const pane = await openDataTab(page, server.baseUrl);
    await pane.locator('.file-input').setInputFiles(fixtureZip);

    const preview = pane.locator('.preview-panel');
    await expect(preview).toBeVisible({ timeout: 20_000 });
    const danger = preview.locator('.danger-panel');
    await expect(danger).toBeVisible();
    await expect(danger).toContainText('This will replace everything on this instance.');

    // The nonce was delivered exactly once, on the start response the
    // component holds. A status re-fetch cannot obtain it again; the apply
    // below succeeding proves the component carried its held copy.
    const st = await page.request.get(`${server.baseUrl}/api/import/status`);
    expect(st.status()).toBe(200);
    const stBody = await st.json();
    expect(stBody.state).toBe('awaiting-confirm');
    expect('confirmNonce' in stBody).toBe(false);

    // Injection: the wrong word keeps Apply disabled...
    const applyBtn = danger.locator('.apply-btn');
    await expect(applyBtn).toBeDisabled();
    await danger.locator('.confirm-input').fill('replace');
    await expect(applyBtn).toBeDisabled();
    await danger.locator('.confirm-input').fill('DELETE');
    await expect(applyBtn).toBeDisabled();

    // ...and nothing was destroyed: the old card still renders (a second
    // tab, so the wizard page keeps its held nonce) and its data is intact.
    const page2 = await context.newPage();
    await page2.goto(`${server.baseUrl}/`);
    await expect(page2.locator('eh-generic-card', { hasText: 'Old Card' })).toBeVisible({ timeout: 10_000 });
    await page2.close();
    const oldData = await page.request.get(`${server.baseUrl}/api/manifests/old-card/data`);
    expect(oldData.status()).toBe(200);
    expect((await oldData.json()).data).toEqual(oldCard().data);

    // The exact word arms Apply; the flow completes end to end through the
    // polled progress view.
    await danger.locator('.confirm-input').fill('REPLACE');
    await expect(applyBtn).toBeEnabled();
    await applyBtn.click();

    const applying = pane.locator('.applying-panel');
    await expect(applying).toBeVisible({ timeout: 20_000 });
    await expect(applying.locator('.stage-label')).toContainText(
      /Saving a rollback snapshot|Clearing this instance|Copying the archive in|Importing history|Importing cards|Reloading|Verifying|Tidying up/);

    const result = pane.locator('.result-panel');
    await expect(result).toBeVisible({ timeout: 60_000 });
    await expect(result.locator('.result-counts'))
      .toContainText(`Import complete: verified 2 cards, ${FIXTURE_PUSHES} HAE pushes, 0 reports.`);

    // The wipe was total and the archive now defines the instance.
    const gone = await page.request.get(`${server.baseUrl}/api/manifests/old-card`);
    expect(gone.status()).toBe(404);
    const weight = await page.request.get(`${server.baseUrl}/api/manifests/weight/data`);
    expect(weight.status()).toBe(200);
  });
});
