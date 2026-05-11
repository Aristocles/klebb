// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests-e2e/helpers/auth-fixture.js
// Playwright fixtures that inject the sandbox session cookie on every
// new page, so specs can go straight to authenticated routes.

const fs = require('fs');
const path = require('path');
const { test: base, expect } = require('@playwright/test');

const STATE_FILE = path.join(__dirname, '..', '.state', 'state.json');

function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    throw new Error(
      `[e2e] sandbox state not found at ${STATE_FILE}. Did globalSetup run?`,
    );
  }
  return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
}

const test = base.extend({
  sandboxState: async ({}, use) => {
    await use(loadState());
  },
  baseURL: async ({ sandboxState }, use) => {
    await use(sandboxState.baseUrl);
  },
  context: async ({ context, sandboxState }, use) => {
    const url = new URL(sandboxState.baseUrl);
    await context.addCookies([
      {
        name: 'klebb_session',
        value: sandboxState.sessionToken,
        domain: url.hostname,
        path: '/',
        httpOnly: true,
        secure: false,
        sameSite: 'Lax',
      },
    ]);
    await use(context);
  },
  page: async ({ page }, use, testInfo) => {
    const headed = !testInfo.project.use.headless;
    if (headed) {
      await installTestBanner(page, testInfo.title);
    }
    await use(page);
    if (process.env.KLEBB_E2E_PAUSE === '1') {
      await page.pause();
    }
  },
});

async function installTestBanner(page, title) {
  const script = `(() => {
    const css = \`
      #klebb-e2e-banner {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        z-index: 2147483647;
        padding: 6px 14px;
        background: rgba(20, 20, 30, 0.88);
        color: #fff;
        font: 500 13px/1.3 system-ui, sans-serif;
        text-align: center;
        pointer-events: none;
        letter-spacing: 0.02em;
      }
      #klebb-e2e-banner b { color: #aeeaff; font-weight: 600; }
    \`;
    function mount() {
      if (document.getElementById('klebb-e2e-banner')) return;
      if (!document.body) { requestAnimationFrame(mount); return; }
      const style = document.createElement('style');
      style.textContent = css;
      (document.head || document.documentElement).appendChild(style);
      const el = document.createElement('div');
      el.id = 'klebb-e2e-banner';
      el.innerHTML = 'e2e: <b>' + ${JSON.stringify(title)} + '</b>';
      document.body.appendChild(el);
    }
    mount();
  })();`;
  await page.addInitScript(script);
  // Eager inject too, in case the spec never navigates (e.g. API-only
  // tests). Fire-and-forget; navigations will rerun the init script.
  page.evaluate(script).catch(() => {});
}

module.exports = { test, expect };
