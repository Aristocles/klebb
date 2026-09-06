// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests-e2e/chat-reattach-lifecycle.spec.js
// Regression for #696. A turn runs to completion server-side and its reply
// is kept even if this client's connection dies (#602), so every way of
// losing the stream must end in a reattach: a 409 (another turn beat us to
// the conversation), a socket that dies mid-turn, and a stream that closes
// cleanly without ever sending a terminal reply/error/stopped event. Before
// this fix the 409 path called reattach while its own _loading flag was
// still set, which the reattach guard refused, so all three ended as a dead
// error bubble over a finished reply nobody collected. And an adopted turn
// left _loading false, so it rendered as idle while tokens arrived and its
// Stop button never appeared.

const { test, expect } = require('./helpers/auth-fixture');

const sse = (events) => events
  .map(([ev, data]) => `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`)
  .join('');

async function openChat(page) {
  await page.goto('/');
  await expect(page.locator('eh-date-view')).toBeVisible();
  const promptModal = page.locator('eh-prompt-modal dialog');
  await promptModal.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
  if (await promptModal.isVisible().catch(() => false)) {
    await promptModal.locator('button[aria-label="Dismiss"]').click();
    await expect(promptModal).not.toBeVisible();
  }
  await page.getByRole('button', { name: /open chat/i }).click();
  const widget = page.locator('health-chat');
  await expect(widget.locator('.chat-input')).toBeVisible();
  return widget;
}

async function newChat(widget) {
  await widget.locator('button[aria-label="New chat"]').click();
  await expect(widget.locator('.msg.user')).toHaveCount(0);
}

// Answer the reattach GET with a complete event stream. Kept separate from
// the POST route: `**/api/chat` matches only the exact path, so the turn
// endpoint needs its own handler.
async function routeReattach(page, events, { count } = {}) {
  const seen = { hits: 0 };
  await page.route('**/api/chat/turn/*', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    seen.hits += 1;
    if (count !== undefined && seen.hits > count) {
      return route.fulfill({ status: 204, body: '' });
    }
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body: sse(events) });
  });
  return seen;
}

test.describe('#696 a lost stream reattaches instead of stranding the turn', () => {
  test('a 409 attaches to the turn that beat us to it', async ({ page }) => {
    await page.route('**/api/chat', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'A reply is already being generated for this conversation.' }),
      });
    });
    const attach = await routeReattach(page, [
      ['token', { text: 'Answering the earlier one' }],
      ['reply', { reply: 'Answering the earlier one.' }],
      ['done', {}],
    ], { count: 1 });

    const widget = await openChat(page);
    await newChat(widget);
    await widget.locator('.chat-input').fill('impatient');
    await widget.locator('.chat-input').press('Enter');

    // The refusal is still reported: this message never reached the server,
    // so the user has to know to send it again.
    await expect(widget.locator('.msg.error')).toContainText(/still finishing/i);
    await expect(widget.locator('.msg.error')).toContainText(/didn't send/i);
    // ...and the turn that refused us is watched to completion.
    await expect(widget.locator('.msg.assistant').last())
      .toContainText('Answering the earlier one.');
    expect(attach.hits).toBeGreaterThan(0);
    await expect(widget.locator('.chat-input')).toBeEnabled();
  });

  test('a stream that closes with no terminal event is a drop, not a silent success', async ({ page }) => {
    await page.route('**/api/chat', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      // Tokens, then a clean close: a buffering proxy or a cut socket. No
      // reply, no error, no stopped, so nothing decided this turn.
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: sse([['status', { phase: 'thinking' }], ['token', { text: 'Half a th' }]]),
      });
    });
    const attach = await routeReattach(page, [
      ['reply', { reply: 'Half a thought, finished server-side.' }],
      ['done', {}],
    ], { count: 1 });

    const widget = await openChat(page);
    await newChat(widget);
    await widget.locator('.chat-input').fill('what happened to my reply');
    await widget.locator('.chat-input').press('Enter');

    await expect(widget.locator('.msg.assistant').last())
      .toContainText('Half a thought, finished server-side.');
    expect(attach.hits).toBeGreaterThan(0);
    // The turn was recovered, so there is nothing to apologise for.
    await expect(widget.locator('.msg.error')).toHaveCount(0);
  });

  test('a dead socket over a live turn recovers without blaming the network', async ({ page }) => {
    await page.route('**/api/chat', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      await route.abort('connectionreset');
    });
    await routeReattach(page, [
      ['reply', { reply: 'Survived the dropped socket.' }],
      ['done', {}],
    ], { count: 1 });

    const widget = await openChat(page);
    await newChat(widget);
    await widget.locator('.chat-input').fill('drop me');
    await widget.locator('.chat-input').press('Enter');

    await expect(widget.locator('.msg.assistant').last())
      .toContainText('Survived the dropped socket.');
    await expect(widget.locator('.msg.error')).toHaveCount(0);
  });

  test('a dead socket with nothing running still reports the failure', async ({ page }) => {
    await page.route('**/api/chat', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      await route.abort('connectionreset');
    });
    // 204: no turn is running and the conversation holds no newer reply, so
    // the drop is real and must be reported rather than swallowed.
    await page.route('**/api/chat/turn/*', async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      await route.fulfill({ status: 204, body: '' });
    });

    const widget = await openChat(page);
    await newChat(widget);
    await widget.locator('.chat-input').fill('nothing to recover');
    await widget.locator('.chat-input').press('Enter');

    await expect(widget.locator('.msg.error')).toContainText(/failed to connect/i);
    await expect(widget.locator('.chat-input')).toBeEnabled();
  });

  test('an adopted turn renders its progress and its Stop button works', async ({ page }) => {
    // A held-open event stream, which route.fulfill cannot express: it
    // sends one complete body and closes. Shimming window.fetch for the
    // turn endpoint only lets the test feed events in one at a time and
    // keep the stream open, which is the state the UI assertions need.
    await page.addInitScript(() => {
      const real = window.fetch.bind(window);
      let sink = null;
      window.__turn = { attached: false, stopped: false };
      window.__turnSend = (text) => sink?.enqueue(new TextEncoder().encode(text));
      window.fetch = (input, init) => {
        const url = String(typeof input === 'string' ? input : (input?.url ?? input));
        if (!url.includes('/api/chat/turn/')) return real(input, init);
        if ((init?.method || 'GET').toUpperCase() === 'DELETE') {
          window.__turn.stopped = true;
          try { sink?.close(); } catch {}
          return Promise.resolve(new Response('{"ok":true}', {
            status: 200, headers: { 'Content-Type': 'application/json' },
          }));
        }
        window.__turn.attached = true;
        const body = new ReadableStream({
          start(c) { sink = c; },
          cancel() { sink = null; },
        });
        return Promise.resolve(new Response(body, {
          status: 200, headers: { 'Content-Type': 'text/event-stream' },
        }));
      };
    });
    await page.route('**/api/chat', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'A reply is already being generated for this conversation.' }),
      });
    });

    const widget = await openChat(page);
    await newChat(widget);
    await widget.locator('.chat-input').fill('adopt the running turn');
    await widget.locator('.chat-input').press('Enter');
    await page.waitForFunction(() => window.__turn.attached === true);

    await page.evaluate(() => window.__turnSend(
      'event: status\ndata: {"phase":"tool","tool":"create_manifest","id":"sleep"}\n\n'));
    await expect(widget.locator('.status-line')).toBeVisible();

    await page.evaluate(() => window.__turnSend(
      'event: token\ndata: {"text":"Working on the card"}\n\n'));
    await expect(widget.locator('.msg.assistant.streaming')).toContainText('Working on the card');

    const stopBtn = widget.locator('button[aria-label="Stop"]');
    await expect(stopBtn).toBeVisible();
    await stopBtn.click();
    await page.waitForFunction(() => window.__turn.stopped === true);

    await expect(widget.locator('.chat-input')).toBeEnabled();
    await expect(widget.locator('button[aria-label="Send"]')).toBeVisible();
  });
});
