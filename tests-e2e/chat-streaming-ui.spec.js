// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests-e2e/chat-streaming-ui.spec.js
// The streaming, conversation-backed chat client (#605): turns go out as
// streamed conversation requests, token/reply events land in the
// transcript, capped replies offer "keep going", the send button becomes
// a working stop button mid-turn, and transcripts live in conversations:
// one survives closing the panel, a reload starts a fresh chat (unless a
// reply is still being written) with the old one in the drawer, and a
// legacy history file is folded into a conversation on first load.
// /api/chat is stubbed with event-stream bodies; the conversation CRUD
// runs against the real sandbox server.

const { test, expect } = require('./helpers/auth-fixture');

const sse = (events) => events
  .map(([ev, data]) => `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`)
  .join('');

async function openChat(page) {
  await page.goto('/');
  return openPanel(page);
}

// Open the panel on the page as loaded, without navigating first.
async function openPanel(page) {
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

test.describe('#605 streaming conversation client', () => {
  test('a streamed turn: conversation request out, tokens and reply in', async ({ page }) => {
    const bodies = [];
    await page.route('**/api/chat', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      bodies.push(route.request().postDataJSON());
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: sse([
          ['status', { phase: 'thinking' }],
          ['status', { phase: 'tool', tool: 'create_manifest', id: 'sleep' }],
          ['token', { text: 'All ' }],
          ['token', { text: 'done.' }],
          ['reply', { reply: 'All **done**.' }],
          ['done', {}],
        ]),
      });
    });
    const widget = await openChat(page);
    await newChat(widget);

    await widget.locator('.chat-input').fill('set up a sleep card');
    await widget.locator('.chat-input').press('Enter');

    await expect(widget.locator('.msg.assistant').last()).toContainText('All done.');
    expect(bodies[0].stream).toBe(true);
    expect(typeof bodies[0].conversationId).toBe('string');
    expect(bodies[0].messages).toHaveLength(1);
    expect(bodies[0].messages[0].content).toBe('set up a sleep card');

    const stored = await page.evaluate(() => localStorage.getItem('klebb-active-conversation'));
    expect(stored).toBe(bodies[0].conversationId);
  });

  test('a capped reply offers keep-going, and the chip resumes the turn', async ({ page }) => {
    const bodies = [];
    await page.route('**/api/chat', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      bodies.push(route.request().postDataJSON());
      const capped = bodies.length === 1;
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: sse([
          ['reply', capped ? { reply: 'Did half of it.', capped: true } : { reply: 'Finished the rest.' }],
          ['done', {}],
        ]),
      });
    });
    const widget = await openChat(page);
    await newChat(widget);

    await widget.locator('.chat-input').fill('do lots of things');
    await widget.locator('.chat-input').press('Enter');
    await expect(widget.locator('.msg.assistant').last()).toContainText('Did half of it.');

    const chip = widget.locator('.suggestion', { hasText: 'Keep going' });
    await expect(chip).toBeVisible();
    await chip.click();

    await expect(widget.locator('.msg.assistant').last()).toContainText('Finished the rest.');
    expect(bodies[1].messages[0].content).toMatch(/keep going/i);
    await expect(widget.locator('.suggestion', { hasText: 'Keep going' })).toHaveCount(0);
  });

  test('the send button becomes a stop button that stops the turn', async ({ page }) => {
    let stopped = false;
    await page.route('**/api/chat', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      // Hold the turn open; the client stops it rather than waiting.
      await new Promise(r => setTimeout(r, 30_000));
      try { await route.fulfill({ status: 200, contentType: 'application/json', body: '{"reply":"late"}' }); } catch {}
    });
    await page.route('**/api/chat/turn/*', async (route) => {
      if (route.request().method() === 'DELETE') {
        stopped = true;
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
      }
      return route.fallback();
    });
    const widget = await openChat(page);
    await newChat(widget);

    await widget.locator('.chat-input').fill('this will take ages');
    await widget.locator('.chat-input').press('Enter');

    const stopBtn = widget.locator('button[aria-label="Stop"]');
    await expect(stopBtn).toBeVisible();
    await stopBtn.click();

    await expect(widget.locator('.chat-input')).toBeEnabled({ timeout: 2000 });
    await expect(widget.locator('.msg.error')).toHaveCount(0);
    expect(stopped).toBe(true, 'the server-side turn must be told to stop');
    await expect(widget.locator('button[aria-label="Send"]')).toBeVisible();
  });

  test('a chat survives closing the panel; a reload starts fresh and the drawer reopens it (#748)', async ({ page }) => {
    await page.route('**/api/chat', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: sse([['reply', { reply: 'Remembered.' }], ['done', {}]]),
      });
    });
    const widget = await openChat(page);
    await newChat(widget);

    const saved = page.waitForResponse(r =>
      /\/api\/conversations\/[^/]+\/messages/.test(r.url()) && r.request().method() === 'PUT' && r.ok());
    await widget.locator('.chat-input').fill('please remember this');
    await widget.locator('.chat-input').press('Enter');
    await expect(widget.locator('.msg.assistant').last()).toContainText('Remembered.');
    await saved;

    // Closing the panel drops its DOM; reopening rebuilds it from the
    // conversation still held in memory.
    await page.keyboard.press('Escape');
    await expect(widget.locator('.chat-panel')).toHaveCount(0);
    await page.getByRole('button', { name: /open chat/i }).click();
    await expect(widget.locator('.msg.assistant').last()).toContainText('Remembered.');

    // An empty transcript proves nothing until the boot read of the parked
    // conversation has landed, so wait for it.
    const bootRead = page.waitForResponse(r =>
      /\/api\/conversations\/[^/]+$/.test(new URL(r.url()).pathname) && r.request().method() === 'GET');
    await page.reload();
    const again = await openPanel(page);
    await bootRead;
    await expect(again.locator('.msg')).toHaveCount(0);

    await again.locator('button[aria-label="Conversations"]').click();
    await again.locator('chat-drawer .row').first().click();
    await expect(again.locator('.msg.user').last()).toContainText('please remember this');
    await expect(again.locator('.msg.assistant').last()).toContainText('Remembered.');
  });

  // The sandbox runs no real turn, so a running one is stood in at the two
  // endpoints the boot path reads: the conversation fetch reports
  // running, and the reattach GET replays the reply.
  async function parkRunningConversation(page, { holdFetch = null } = {}) {
    await page.goto('/');
    const id = await page.evaluate(async () => {
      const r = await fetch('/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'a slow question' }] }),
      });
      const { conversation } = await r.json();
      localStorage.setItem('klebb-active-conversation', conversation.id);
      return conversation.id;
    });
    await page.route(`**/api/conversations/${id}`, async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      if (holdFetch) await holdFetch;
      const response = await route.fetch();
      const { conversation } = await response.json();
      await route.fulfill({ response, json: { conversation: { ...conversation, running: true } } });
    });
    const turn = { reattaches: 0 };
    await page.route(`**/api/chat/turn/${id}*`, async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      turn.reattaches += 1;
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: sse([['reply', { reply: 'The slow answer.' }], ['done', {}]]),
      });
    });
    return { id, turn };
  }

  test('a reload while a reply is being written resumes that conversation (#748)', async ({ page }) => {
    const { turn } = await parkRunningConversation(page);
    await page.reload();
    const widget = await openPanel(page);
    await expect(widget.locator('.msg.user').last()).toContainText('a slow question');
    await expect(widget.locator('.msg.assistant').last()).toContainText('The slow answer.');
    expect(turn.reattaches).toBe(1);
  });

  test('a chat started before the boot read lands is not swapped for the running one (#748)', async ({ page }) => {
    let release;
    const holdFetch = new Promise(r => { release = r; });
    const { id, turn } = await parkRunningConversation(page, { holdFetch });
    await page.route('**/api/chat', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: sse([['reply', { reply: 'A fresh reply.' }], ['done', {}]]),
      });
    });
    await page.reload();
    const widget = await openPanel(page);
    await widget.locator('.chat-input').fill('a new question');
    await widget.locator('.chat-input').press('Enter');
    await expect(widget.locator('.msg.assistant').last()).toContainText('A fresh reply.');

    const bootRead = page.waitForResponse(r =>
      new URL(r.url()).pathname === `/api/conversations/${id}` && r.request().method() === 'GET');
    release();
    await bootRead;
    // A swap would reattach straight after the read; give it the chance.
    await page.waitForTimeout(500);
    expect(turn.reattaches).toBe(0);
    await expect(widget.locator('.msg.user')).toHaveCount(1);
    await expect(widget.locator('.msg.user')).toContainText('a new question');
    expect(await page.evaluate(() => localStorage.getItem('klebb-active-conversation'))).not.toBe(id);
  });

  test('a legacy history file folds into a conversation on first load', async ({ page }) => {
    // Seed the legacy transcript and make sure no conversation pointer
    // exists, the state of an instance upgrading across the cutover. This
    // load's own fold-in check must finish first, or it could import the
    // seed itself and leave the reload below nothing to show.
    const firstCheck = page.waitForResponse(r =>
      new URL(r.url()).pathname === '/api/chat/history' && r.request().method() === 'GET');
    await page.goto('/');
    await firstCheck;
    await page.evaluate(async () => {
      localStorage.removeItem('klebb-active-conversation');
      await fetch('/api/chat/history', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [
          { id: 'l1', role: 'user', content: 'old question' },
          { id: 'l2', role: 'assistant', content: 'old answer' },
        ] }),
      });
    });

    // The fold-in shows on the load that performs it; navigating again
    // would be a second load, which opens a fresh chat (#748).
    await page.reload();
    const widget = await openPanel(page);
    await expect(widget.locator('.msg.user').last()).toContainText('old question');
    await expect(widget.locator('.msg.assistant').last()).toContainText('old answer');

    expect(await page.evaluate(() => localStorage.getItem('klebb-active-conversation')))
      .toBeTruthy();
    // The clear is the step AFTER the one that rendered those messages, so the
    // render is no evidence it has landed. Poll the file itself (#714).
    await expect.poll(async () => (await page.evaluate(async () => {
      const r = await fetch('/api/chat/history', { cache: 'no-store' });
      return (await r.json())?.messages?.length;
    })), { message: 'the legacy history file was never cleared' }).toBe(0);
  });

  test('a second send while a turn runs is refused kindly', async ({ page }) => {
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

    await widget.locator('.chat-input').fill('impatient');
    await widget.locator('.chat-input').press('Enter');
    await expect(widget.locator('.msg.error')).toContainText(/still finishing/i);
  });
});
