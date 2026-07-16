// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests-e2e/webauthn-ceremony.spec.js
// #479: drive the REAL passkey register + login ceremonies via Chromium's
// CDP virtual authenticator. Every other spec injects a pre-minted session
// cookie; these are the only specs that exercise the ceremony code
// (public/js/lib/webauthn-ceremony.js + auth/webauthn.js options/verify).
//
// Each test spawns its OWN server: bootstrap registration needs a fresh
// instance with zero credentials, which the shared sandbox can never be.
// The CDP session is opened and the authenticator added BEFORE navigation,
// and each ceremony stays within a single page (CDP sessions are
// per-target). HEALTH_RP_ID=localhost (not the sandbox default 127.0.0.1):
// an RP ID must be a domain, so Chromium rejects IP-address RP IDs, and
// localhost is a secure context without TLS.
//
// Uses raw @playwright/test on purpose: the auth fixture's cookie
// injection would defeat the point of driving login for real.

const { test, expect } = require('@playwright/test');
const {
  createSandbox, cleanupSandbox, spawnServer, req, fakeAuthState,
} = require('../tests/helpers/sandbox');

const ADMIN_TOKEN = 'e2e-admin-token-479';

// Generous ceremony timeouts: the virtual authenticator is fast, but CI
// runners stall; a flaky ceremony spec is worse than a slow one.
test.setTimeout(90_000);

// Like spawnServer, but reachable at http://localhost:<port> with
// HEALTH_RP_ID=localhost. The helper's 127.0.0.1 default is fine for API
// tests but not for ceremonies: an RP ID must be a domain (Chromium
// rejects IP addresses), and localhost is a secure context without TLS.
async function spawnLocalhostServer(sandbox, extraEnv = {}) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const srv = await spawnServer(sandbox, {
    PORT: String(port),
    HEALTH_ORIGIN: `http://localhost:${port}`,
    HEALTH_RP_ID: 'localhost',
    ...extraEnv,
  });
  return { ...srv, baseUrl: `http://localhost:${port}`, port };
}

async function addVirtualAuthenticator(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return { cdp, authenticatorId };
}

async function credentialCount(cdp, authenticatorId) {
  const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
  return credentials.length;
}

test.describe('#479: real WebAuthn ceremonies via CDP virtual authenticator', () => {
  let sandbox, srv;

  test.afterEach(async () => {
    if (srv) { await srv.kill(); srv = null; }
    if (sandbox) { cleanupSandbox(sandbox); sandbox = null; }
  });

  test('bootstrap register: fresh instance, /register, ceremony, lands authenticated', async ({ page }) => {
    sandbox = createSandbox();
    srv = await spawnLocalhostServer(sandbox);

    const { cdp, authenticatorId } = await addVirtualAuthenticator(page);
    await page.goto(`${srv.baseUrl}/register`);
    await expect(page.locator('#register-btn')).toBeEnabled();

    await page.click('#register-btn');
    await expect(page.locator('#success')).toBeVisible({ timeout: 30_000 });
    expect(await credentialCount(cdp, authenticatorId)).toBe(1);

    // The redirect lands on the dashboard as an authenticated session:
    // the ceremony minted a real session cookie, no fixture injection.
    await page.waitForURL(`${srv.baseUrl}/`, { timeout: 15_000 });
    await expect(page.locator('eh-date-view')).toBeVisible();
  });

  test('invite register: minted code is consumed by the ceremony', async ({ page }) => {
    // Instance already has an owner (fake seed), so /register without a
    // code is closed; a minted invite opens it for a second device/user.
    const auth = fakeAuthState('owner');
    sandbox = createSandbox({ credentials: auth.credentials, sessions: auth.sessions });
    srv = await spawnLocalhostServer(sandbox, { KLEBB_ADMIN_TOKEN: ADMIN_TOKEN });

    const mint = await req(srv.baseUrl, '/api/admin/invites', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}` },
      body: { label: 'seconddevice' },
    });
    expect(mint.status).toBe(201);

    const { cdp, authenticatorId } = await addVirtualAuthenticator(page);

    // Closed without a code.
    await page.goto(`${srv.baseUrl}/register`);
    await expect(page.locator('#register-btn')).toBeDisabled();

    // Open with the minted code (registerUrl is what the portal emails).
    await page.goto(mint.json.registerUrl);
    await expect(page.locator('#register-btn')).toBeEnabled();
    await expect(page.locator('.subtitle')).toContainText('seconddevice');

    await page.click('#register-btn');
    await expect(page.locator('#success')).toBeVisible({ timeout: 30_000 });
    expect(await credentialCount(cdp, authenticatorId)).toBe(1);

    // Single-use: revisiting the same link is now closed.
    await page.goto(mint.json.registerUrl);
    await expect(page.locator('#register-btn')).toBeDisabled();
  });

  test('login: a registered credential signs back in via the ceremony', async ({ page }) => {
    sandbox = createSandbox();
    srv = await spawnLocalhostServer(sandbox);

    const { cdp, authenticatorId } = await addVirtualAuthenticator(page);

    // Register first (bootstrap), then drop the session and sign back in
    // with the same virtual credential.
    await page.goto(`${srv.baseUrl}/register`);
    await expect(page.locator('#register-btn')).toBeEnabled();
    await page.click('#register-btn');
    await expect(page.locator('#success')).toBeVisible({ timeout: 30_000 });
    await page.waitForURL(`${srv.baseUrl}/`, { timeout: 15_000 });

    await page.context().clearCookies();
    await page.goto(`${srv.baseUrl}/login.html`);
    await page.click('#login-btn');
    await page.waitForURL(`${srv.baseUrl}/`, { timeout: 30_000 });
    await expect(page.locator('eh-date-view')).toBeVisible();
    expect(await credentialCount(cdp, authenticatorId)).toBe(1);
  });

  test('Settings > Security: authenticated session adds a second passkey through the pane', async ({ page }) => {
    // Exercises registerCredential() from the shared ceremony module via
    // the pane's "register a passkey on this device" path (the default add
    // path is the QR/link invite, #482, which needs a second device).
    //
    // The first credential comes from a REAL bootstrap ceremony, not a
    // seeded fake: the pane's add path sends excludeCredentials, so the
    // stored id must be genuine base64url (a fake id breaks the browser
    // library's decode) — and the ceremony must run on a DIFFERENT
    // authenticator, because excludeCredentials makes the one already
    // holding the credential refuse re-enrolment. Swapping virtual
    // authenticators models exactly that second device.
    sandbox = createSandbox();
    srv = await spawnLocalhostServer(sandbox);

    const { cdp, authenticatorId: authA } = await addVirtualAuthenticator(page);
    await page.goto(`${srv.baseUrl}/register`);
    await expect(page.locator('#register-btn')).toBeEnabled();
    await page.click('#register-btn');
    await expect(page.locator('#success')).toBeVisible({ timeout: 30_000 });
    await page.waitForURL(`${srv.baseUrl}/`, { timeout: 15_000 });

    // "New device": retire authenticator A, attach a fresh one.
    await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: authA });
    const { authenticatorId: authB } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: {
        protocol: 'ctap2',
        transport: 'internal',
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });

    await page.goto(`${srv.baseUrl}/settings`);
    await expect(page.locator('eh-settings-view')).toBeVisible();
    await page.locator('eh-settings-view [data-tab="security"]').click();
    const security = page.locator('eh-settings-security');
    await expect(security).toBeVisible();

    await security.locator('.on-this-device').click();
    await security.locator('.nick-input').fill('e2e-virtual');
    await security.locator('.passkey-add .primary').click();

    // The pane reloads its list after the ceremony; poll the API through
    // the page's own (ceremony-minted) session.
    await expect
      .poll(async () => {
        const r = await page.request.get(`${srv.baseUrl}/api/credentials`);
        if (!r.ok()) return 0;
        const j = await r.json();
        return Array.isArray(j.credentials) ? j.credentials.length : 0;
      }, { timeout: 30_000 })
      .toBe(2);
    const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId: authB });
    expect(credentials.length).toBe(1);
  });
});
