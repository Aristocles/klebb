// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests-e2e/chat-streaming-ui.spec.js
// The streaming, conversation-backed chat client (#605): turns go out as
// streamed conversation requests, token/reply events land in the
// transcript, capped replies offer "keep going", the send button becomes
// a working stop button mid-turn, and transcripts live in conversations:
// they survive reloads through the server, and a legacy history file is
// folded into a conversation on first load. /api/chat is stubbed with
// event-stream bodies; the conversation CRUD runs against the real
// sandbox server.

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
  await widget.locator('button[aria-label="Conversations"]').click();
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

  test('the transcript survives a reload through the conversation store', async ({ page }) => {
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

    await page.reload();
    const again = await openChat(page);
    await expect(again.locator('.msg.user').last()).toContainText('please remember this');
    await expect(again.locator('.msg.assistant').last()).toContainText('Remembered.');
  });

  test('a legacy history file folds into a conversation on first load', async ({ page }) => {
    // Seed the legacy transcript and make sure no conversation pointer
    // exists, the state of an instance upgrading across the cutover.
    await page.goto('/');
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

    await page.reload();
    const widget = await openChat(page);
    await expect(widget.locator('.msg.user').last()).toContainText('old question');
    await expect(widget.locator('.msg.assistant').last()).toContainText('old answer');

    const state = await page.evaluate(async () => ({
      convo: localStorage.getItem('klebb-active-conversation'),
      legacy: await (await fetch('/api/chat/history')).json(),
    }));
    expect(state.convo).toBeTruthy();
    expect(state.legacy.messages).toHaveLength(0);
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
