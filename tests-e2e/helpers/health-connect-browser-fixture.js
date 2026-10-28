// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// Isolated browser/session fixture. HTTPS browser URLs are routed to the real
// loopback server; this bridge is not evidence of actual network TLS.
'use strict';

const {
  createSandbox, cleanupSandbox, spawnServer, fakeAuthState,
} = require('../../tests/helpers/sandbox');

const CANONICAL = 'https://owner-a.klebb.app';
const ROWS = [{ date: '2026-01-02', count: 1234 }];
const ENV = {
  HEALTH_RP_ID: 'owner-a.klebb.app',
  KLEBB_CLOUD: '',
  KLEBB_DEMO: '',
  AGENT_API_TOKEN: '',
  KLEBB_ADMIN_TOKEN: '',
  HEALTH_DATA_DIR: '',
  HEALTH_REPORTS_DIR: '',
  HEALTH_AUTO_EXPORT_DIR: '',
  HEALTH_SESSIONS_DIR: '',
  HEALTH_CREDENTIALS_DIR: '',
  HEALTH_ARCHIVE_DIR: '',
  HEALTH_CONFIG_PATH: '',
  HEALTH_DB_DIR: '',
  HEALTH_DB_FILE: '',
  HEALTH_CHAT_DIR: '',
  HEALTH_USER_FILE: '',
  HEALTH_NOTIFICATIONS_STATE_FILE: '',
  HEALTH_INBOX_DIR: '',
  HEALTH_KEYS_DIR: '',
  HEALTH_VAPID_FILE: '',
  HEALTH_PUSH_SUBSCRIPTIONS_FILE: '',
  HEALTH_AUTO_EXPORT_TOKEN: '',
  NODE_OPTIONS: '',
};

async function authorityPage(browser, {
  canonical = CANONICAL, visibleOrigin = canonical, uncancellableGrantResponses = false,
} = {}) {
  const owner = fakeAuthState('owner-a');
  const other = fakeAuthState('owner-b');
  const home = createSandbox({
    credentials: { users: { ...owner.credentials.users, ...other.credentials.users } },
    sessions: { ...owner.sessions, ...other.sessions },
    seed: {
      'authority-sentinel.json': {
        $schema: 'klebb.datafile.v1',
        meta: { id: 'authority-sentinel', label: 'Authority sentinel' },
        data: ROWS,
      },
    },
  });
  let server, context;
  try {
    server = await spawnServer(home, { ...ENV, HEALTH_ORIGIN: canonical });
    context = await browser.newContext({ serviceWorkers: 'block' });
    await context.addCookies([{
      name: 'klebb_session', value: owner.token, url: visibleOrigin,
      httpOnly: true, secure: visibleOrigin.startsWith('https:'), sameSite: 'Lax',
    }]);
    await context.addInitScript(uncancellable => {
      window.__healthClipboardWrites = [];
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async text => window.__healthClipboardWrites.push(String(text)) },
      });
      const original = document.execCommand.bind(document);
      document.execCommand = (command, ...args) => {
        if (command === 'copy') window.__healthClipboardWrites.push('execCommand-copy');
        return original(command, ...args);
      };
      if (uncancellable) {
        const originalFetch = window.fetch.bind(window);
        window.fetch = (input, options = {}) => {
          const url = new URL(typeof input === 'string' ? input : input.url, location.href);
          if (options.method === 'POST'
              && url.pathname === '/api/connectors/health-connect/pairing-grants') {
            const { signal, ...uninterrupted } = options;
            return originalFetch(input, uninterrupted);
          }
          return originalFetch(input, options);
        };
      }
    }, uncancellableGrantResponses);
    const requestPaths = [];
    const consoleMessages = [];
    const bridgeFailures = [];
    const heldResponses = new Set();
    let nextGrantResponse = null;
    function holdNextGrantResponse() {
      if (nextGrantResponse) throw new Error('a grant response is already reserved');
      let ready, release;
      const gate = {
        ready: new Promise(resolve => { ready = resolve; }),
        released: new Promise(resolve => { release = resolve; }),
        markReady: () => ready(),
        release: () => release(),
      };
      nextGrantResponse = gate;
      heldResponses.add(gate);
      return gate;
    }
    await context.route(`${visibleOrigin}/**`, async route => {
      try {
        const request = route.request();
        const original = new URL(request.url());
        requestPaths.push({ method: request.method(), url: request.url() });
        const target = new URL(original.pathname + original.search, server.baseUrl);
        const headers = await request.allHeaders();
        // Carry the actual browser Cookie and Origin to the actual handler.
        // Do not invent an Origin or replace an authority response.
        const forwarded = await context.request.fetch(target.href, {
          method: request.method(),
          headers,
          data: request.postDataBuffer() || undefined,
          maxRedirects: 0,
          timeout: 10000,
        });
        const responseHeaders = { ...forwarded.headers() };
        delete responseHeaders['content-encoding'];
        delete responseHeaders['content-length'];
        const body = await forwarded.body();
        if (request.method() === 'POST'
            && original.pathname === '/api/connectors/health-connect/pairing-grants'
            && nextGrantResponse) {
          const gate = nextGrantResponse;
          nextGrantResponse = null;
          gate.markReady();
          await gate.released;
          heldResponses.delete(gate);
        }
        await route.fulfill({
          status: forwarded.status(), headers: responseHeaders,
          body,
        });
      } catch (error) {
        bridgeFailures.push(error.message);
        await route.abort('failed');
      }
    });
    const page = await context.newPage();
    page.on('console', message => consoleMessages.push(message.text()));
    return {
      page, context, server, home, owner, other, canonical, visibleOrigin,
      requestPaths, consoleMessages, bridgeFailures,
      holdNextGrantResponse,
      close: async () => {
        for (const gate of heldResponses) gate.release();
        try { await context.close(); }
        finally {
          try { await server.kill(); }
          finally { cleanupSandbox(home); }
        }
      },
    };
  } catch (error) {
    if (context) await context.close();
    if (server) await server.kill();
    cleanupSandbox(home);
    throw error;
  }
}

module.exports = { authorityPage, CANONICAL, ROWS };
