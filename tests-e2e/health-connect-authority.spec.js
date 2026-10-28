// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// #772 browser authority proof. Real server responses, isolated sessions and
// synthetic native exchange; no phone, health ingestion or real-TLS claim.
'use strict';

const { test, expect } = require('./helpers/auth-fixture');
const { authorityPage, CANONICAL, ROWS } = require('./helpers/health-connect-browser-fixture');
const { req } = require('../tests/helpers/sandbox');

const BASE = '/api/connectors/health-connect';
const GRANTS = `${BASE}/pairing-grants`;
const EXCHANGE = `${BASE}/v1/pairing/exchange`;
const CAPABILITIES = `${BASE}/v1/capabilities`;
const COMPONENT = 'eh-settings-health-connect';
const STEPS = ['StepsRecord'];

async function openSecurity(fixture) {
  await fixture.page.goto(`${fixture.visibleOrigin}/settings`);
  await expect(fixture.page.locator('eh-settings-view')).toBeVisible();
  await fixture.page.locator('eh-settings-view [data-tab="security"]').click();
  const pane = fixture.page.locator(COMPONENT);
  await expect(pane).toBeVisible();
  return pane;
}

function grantPostCount(fixture) {
  return fixture.requestPaths.filter(request =>
    request.method === 'POST' && new URL(request.url).pathname === GRANTS).length;
}

async function createThroughBrowser(fixture, pane) {
  await expect(pane.locator('.hc-destination')).toHaveText(CANONICAL);
  await pane.getByLabel('Phone name', { exact: true }).fill('Test phone');
  await pane.getByLabel('Confirm destination', { exact: true }).check();
  const responsePromise = fixture.page.waitForResponse(response =>
    new URL(response.url()).pathname === GRANTS &&
    response.request().method() === 'POST');
  await pane.getByRole('button', { name: 'Create pairing grant', exact: true }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(201);
  expect(response.request().postDataJSON()).toEqual({
    categories: STEPS, name: 'Test phone',
  });
  const grant = await response.json();
  expect(grant.version).toBe(1);
  expect(grant.kind).toBe('pairing-grant');
  expect(grant.destination).toBe(CANONICAL);
  expect(grant.categories).toEqual(STEPS);
  expect(grant.grant).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const payload = pane.getByLabel('Health Connect pairing payload', { exact: true });
  await expect(payload).toBeVisible();
  await expect(payload).toHaveAttribute('readonly', '');
  expect(JSON.parse(await payload.inputValue())).toEqual(grant);
  await expect(pane).toContainText(/works once|one.use|single.use/i);
  await expect(pane).toContainText(/expir/i);
  return grant;
}

function exchangeFrame(grant, installationId = 'synthetic-browser-installation') {
  return {
    version: 1, kind: 'pairing-exchange',
    tenantId: grant.tenantId, instanceId: grant.instanceId,
    grant: grant.grant, sourceStoreId: grant.sourceStoreId,
    installationId, categories: STEPS,
  };
}

async function noAutomaticClipboard(fixture) {
  expect(await fixture.page.evaluate(() => window.__healthClipboardWrites)).toEqual([]);
}

test.describe('#772 authenticated Health Connect browser authority', () => {
  test('explicit destination confirmation precedes the only grant POST; Cancel clears the payload', async ({ browser }) => {
    const fixture = await authorityPage(browser);
    try {
      const pane = await openSecurity(fixture);
      await expect(pane).toContainText('Pairing proof: Steps');
      await expect(pane.locator('.hc-destination')).toHaveText(CANONICAL);
      const button = pane.getByRole('button', { name: 'Create pairing grant', exact: true });
      await expect(button).toBeDisabled();
      expect(grantPostCount(fixture)).toBe(0);
      await pane.getByLabel('Phone name', { exact: true }).fill('Test phone');
      await pane.getByLabel('Confirm destination', { exact: true }).check();
      await expect(button).toBeEnabled();
      await pane.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(button).toBeDisabled();
      expect(grantPostCount(fixture)).toBe(0);
      await noAutomaticClipboard(fixture);

      const grant = await createThroughBrowser(fixture, pane);
      expect(grantPostCount(fixture)).toBe(1);
      await noAutomaticClipboard(fixture);
      expect(new URL(fixture.page.url()).search).toBe('');
      expect(new URL(fixture.page.url()).hash).toBe('');
      expect(fixture.requestPaths.some(request => request.url.includes(grant.grant))).toBe(false);
      expect(fixture.consoleMessages.some(message => message.includes(grant.grant))).toBe(false);
      await pane.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(pane.getByLabel('Health Connect pairing payload', { exact: true })).toHaveCount(0);
      expect(grantPostCount(fixture)).toBe(1);
      expect(fixture.bridgeFailures).toEqual([]);
    } finally { await fixture.close(); }
  });

  test('leaving Security and reloading clear the ephemeral grant without minting another', async ({ browser }) => {
    const fixture = await authorityPage(browser);
    try {
      let pane = await openSecurity(fixture);
      await createThroughBrowser(fixture, pane);
      await fixture.page.locator('eh-settings-view [data-tab="general"]').click();
      await expect(fixture.page.locator(COMPONENT)).toHaveCount(0);
      await fixture.page.locator('eh-settings-view [data-tab="security"]').click();
      pane = fixture.page.locator(COMPONENT);
      await expect(pane).toBeVisible();
      await expect(pane.getByLabel('Health Connect pairing payload', { exact: true })).toHaveCount(0);
      await expect(pane.getByRole('button', {
        name: 'Create pairing grant', exact: true,
      })).toBeDisabled();
      expect(grantPostCount(fixture)).toBe(1);
      await fixture.page.reload();
      await expect(fixture.page.locator('eh-settings-view')).toBeVisible();
      await fixture.page.locator('eh-settings-view [data-tab="security"]').click();
      await expect(fixture.page.locator(COMPONENT)
        .getByLabel('Health Connect pairing payload', { exact: true })).toHaveCount(0);
      expect(grantPostCount(fixture)).toBe(1);
      await noAutomaticClipboard(fixture);
      expect(fixture.bridgeFailures).toEqual([]);
    } finally { await fixture.close(); }
  });

  test('real scoped connector appears and browser revocation visibly fences it while retaining history', async ({ browser }) => {
    const fixture = await authorityPage(browser);
    try {
      const pane = await openSecurity(fixture);
      const grant = await createThroughBrowser(fixture, pane);
      const exchange = await req(fixture.server.baseUrl, EXCHANGE, {
        method: 'POST', body: exchangeFrame(grant),
      });
      expect(exchange.status).toBe(200);
      const paired = exchange.json;
      expect(paired.categories).toEqual(STEPS);
      const otherGrant = await req(fixture.server.baseUrl, GRANTS, {
        method: 'POST', cookie: fixture.other.cookie, headers: { Origin: CANONICAL },
        body: { categories: STEPS, name: 'Other phone' },
      });
      expect(otherGrant.status).toBe(201);
      expect((await req(fixture.server.baseUrl, EXCHANGE, {
        method: 'POST', body: exchangeFrame(otherGrant.json, 'synthetic-other-installation'),
      })).status).toBe(200);
      await pane.getByRole('button', { name: 'Refresh connected devices', exact: true }).click();
      const row = pane.locator('.hc-connector-row').filter({ hasText: 'Test phone' });
      await expect(row).toHaveCount(1);
      await expect(row).toContainText('StepsRecord');
      await expect(pane.locator('.hc-connector-row').filter({ hasText: 'Other phone' })).toHaveCount(0);
      const beforeHistory = await req(fixture.server.baseUrl, '/api/manifests/authority-sentinel/data', {
        cookie: fixture.owner.cookie,
      });
      expect(beforeHistory.json.data).toEqual(ROWS);
      const revokeResponse = fixture.page.waitForResponse(response =>
        new URL(response.url()).pathname === `${BASE}/${paired.connectorId}` &&
        response.request().method() === 'DELETE');
      await row.getByRole('button', { name: 'Revoke access', exact: true }).click();
      const revoked = await revokeResponse;
      expect(revoked.status()).toBe(200);
      expect(await revoked.json()).toEqual({ revoked: true });
      await expect(pane.getByRole('status')).toContainText(/revoked/i);
      await expect(row).toContainText(/revoked/i);
      expect((await req(fixture.server.baseUrl, CAPABILITIES, {
        headers: {
          Authorization: `Bearer ${paired.credential}`, 'Klebb-Health-Protocol': '1',
        },
      })).status).toBe(401);
      const afterHistory = await req(fixture.server.baseUrl, '/api/manifests/authority-sentinel/data', {
        cookie: fixture.owner.cookie,
      });
      expect(afterHistory.json).toEqual(beforeHistory.json);
      expect(fixture.requestPaths.some(request =>
        request.url.includes(grant.grant) || request.url.includes(paired.credential))).toBe(false);
      expect(fixture.consoleMessages.some(message =>
        message.includes(grant.grant) || message.includes(paired.credential))).toBe(false);
      await noAutomaticClipboard(fixture);
      expect(fixture.bridgeFailures).toEqual([]);
    } finally { await fixture.close(); }
  });

  test('a lost session produces a visible refusal and no handoff payload', async ({ browser }) => {
    const fixture = await authorityPage(browser);
    try {
      const pane = await openSecurity(fixture);
      await expect(pane.locator('.hc-destination')).toHaveText(CANONICAL);
      expect((await req(fixture.server.baseUrl, '/auth/logout', {
        method: 'POST', cookie: fixture.owner.cookie,
      })).status).toBe(200);
      await pane.getByLabel('Phone name', { exact: true }).fill('Test phone');
      await pane.getByLabel('Confirm destination', { exact: true }).check();
      const refusedResponse = fixture.page.waitForResponse(response =>
        new URL(response.url()).pathname === GRANTS &&
        response.request().method() === 'POST');
      await pane.getByRole('button', { name: 'Create pairing grant', exact: true }).click();
      expect((await refusedResponse).status()).toBe(401);
      await expect(pane.getByRole('alert')).toContainText(/unauthori[sz]ed|sign in|session/i);
      await expect(pane.getByLabel('Health Connect pairing payload', { exact: true })).toHaveCount(0);
      await noAutomaticClipboard(fixture);
      expect(fixture.bridgeFailures).toEqual([]);
    } finally { await fixture.close(); }
  });

  test('a configured HTTP destination disables native pairing', async ({ browser }) => {
    const fixture = await authorityPage(browser, { canonical: 'http://owner-a.klebb.app' });
    try {
      const pane = await openSecurity(fixture);
      await expect(pane).toContainText(/HTTPS/i);
      await expect(pane.getByRole('button', {
        name: 'Create pairing grant', exact: true,
      })).toBeDisabled();
      expect(grantPostCount(fixture)).toBe(0);
      await noAutomaticClipboard(fixture);
      expect(fixture.bridgeFailures).toEqual([]);
    } finally { await fixture.close(); }
  });

  test('displayed destination comes from the server rather than the visible page origin', async ({ browser }) => {
    const fixture = await authorityPage(browser, {
      visibleOrigin: 'https://visible-shell.example.test',
    });
    try {
      const pane = await openSecurity(fixture);
      expect(new URL(fixture.page.url()).origin).toBe('https://visible-shell.example.test');
      await expect(pane.locator('.hc-destination')).toHaveText(CANONICAL);
      expect(grantPostCount(fixture)).toBe(0);
      await noAutomaticClipboard(fixture);
      expect(fixture.bridgeFailures).toEqual([]);
    } finally { await fixture.close(); }
  });

  for (const action of ['Cancel', 'leave Security']) {
    test(`a delayed real response cannot restore the payload after ${action}`, async ({ browser }) => {
      const fixture = await authorityPage(browser, { uncancellableGrantResponses: true });
      try {
        const pane = await openSecurity(fixture);
        await expect(pane.locator('.hc-destination')).toHaveText(CANONICAL);
        await pane.getByLabel('Phone name', { exact: true }).fill('Test phone');
        await pane.getByLabel('Confirm destination', { exact: true }).check();
        const held = fixture.holdNextGrantResponse();
        await pane.getByRole('button', { name: 'Create pairing grant', exact: true }).click();
        await held.ready;
        const retired = await pane.elementHandle();
        if (action === 'Cancel') {
          await pane.getByRole('button', { name: 'Cancel', exact: true }).click();
        } else {
          await fixture.page.locator('eh-settings-view [data-tab="general"]').click();
        }
        const delivered = fixture.page.waitForResponse(response =>
          new URL(response.url()).pathname === GRANTS &&
          response.request().method() === 'POST');
        held.release();
        expect((await delivered).status()).toBe(201);
        await fixture.page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
        expect(await retired.evaluate(element =>
          element.shadowRoot.querySelector('textarea')?.value || '')).toBe('');
        if (action !== 'Cancel') {
          await fixture.page.locator('eh-settings-view [data-tab="security"]').click();
        }
        const current = fixture.page.locator(COMPONENT);
        await expect(current.getByLabel('Health Connect pairing payload', { exact: true })).toHaveCount(0);
        await expect(current.getByRole('button', {
          name: 'Create pairing grant', exact: true,
        })).toBeDisabled();
        expect(grantPostCount(fixture)).toBe(1);
        expect(fixture.bridgeFailures).toEqual([]);
      } finally { await fixture.close(); }
    });
  }

  test('advancing the browser clock clears an expired real grant without another POST', async ({ browser }) => {
    const fixture = await authorityPage(browser);
    try {
      const pane = await openSecurity(fixture);
      await fixture.page.clock.install({ time: new Date() });
      await createThroughBrowser(fixture, pane);
      await fixture.page.clock.fastForward(300001);
      await expect(pane.getByLabel('Health Connect pairing payload', { exact: true })).toHaveCount(0);
      await expect(pane.getByRole('status')).toContainText(/expired/i);
      await expect(pane.getByRole('button', {
        name: 'Create pairing grant', exact: true,
      })).toBeDisabled();
      expect(grantPostCount(fixture)).toBe(1);
      await noAutomaticClipboard(fixture);
      expect(fixture.bridgeFailures).toEqual([]);
    } finally { await fixture.close(); }
  });
});
