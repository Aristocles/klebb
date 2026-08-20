// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests-e2e/chat-drawer.spec.js
// The conversation drawer (#607, reshaped by #657): every conversation
// newest-first in a scroller, new chat lives in the panel header, switching
// loads the server transcript, rename is inline, delete needs a second tap,
// and deleting the active conversation drops to a fresh chat. Conversations
// are seeded through the real API; /api/chat is never needed here.

const { test, expect } = require('./helpers/auth-fixture');

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

// Seed conversations straight through the API and wipe whatever previous
// tests in this file left behind (the sandbox server is shared).
async function seedConversations(page, convos) {
  await page.evaluate(async (list) => {
    const existing = await (await fetch('/api/conversations')).json();
    for (const c of existing.conversations) {
      await fetch(`/api/conversations/${c.id}`, { method: 'DELETE' });
    }
    localStorage.removeItem('klebb-active-conversation');
    for (const c of list) {
      const created = await (await fetch('/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(c),
      })).json();
      // Recency order follows updated_at; keep inserts a tick apart.
      await new Promise(r => setTimeout(r, 5));
      void created;
    }
  }, convos);
}

const drawer = (widget) => widget.locator('chat-drawer');

async function openDrawer(page, widget) {
  await widget.locator('button[aria-label="Conversations"]').click();
  await expect(drawer(widget).locator('.row').first()).toBeVisible();
}

test.describe('#607 conversation drawer', () => {
  test('lists conversations newest-first with titles, switching loads the transcript', async ({ page }) => {
    await openChat(page);
    await seedConversations(page, [
      { title: 'Older chat', messages: [{ role: 'user', content: 'old q' }, { role: 'assistant', content: 'old a' }] },
      { title: 'Newer chat', messages: [{ role: 'user', content: 'new q' }, { role: 'assistant', content: 'new a' }] },
    ]);
    await page.reload();
    const widget = await openChat(page);

    await openDrawer(page, widget);
    const titles = drawer(widget).locator('.row-title');
    await expect(titles).toHaveCount(2);
    await expect(titles.first()).toHaveText('Newer chat');
    await expect(titles.last()).toHaveText('Older chat');

    await drawer(widget).locator('.row', { hasText: 'Older chat' }).click();
    await expect(widget.locator('.msg.user').last()).toContainText('old q');
    await expect(widget.locator('.msg.assistant').last()).toContainText('old a');
    const active = await page.evaluate(() => localStorage.getItem('klebb-active-conversation'));
    expect(active).toBeTruthy();

    // The active row is marked on the next open.
    await openDrawer(page, widget);
    await expect(drawer(widget).locator('.row.active .row-title')).toHaveText('Older chat');
  });

  test('new chat sits in the panel header and parks the current conversation (#657)', async ({ page }) => {
    await openChat(page);
    await seedConversations(page, [
      { title: 'Keep me', messages: [{ role: 'user', content: 'kept' }] },
    ]);
    await page.reload();
    const widget = await openChat(page);

    // The drawer must not carry one of its own any more, or the header
    // control below would be ambiguous rather than moved.
    await openDrawer(page, widget);
    await expect(drawer(widget).locator('button[aria-label="New chat"]')).toHaveCount(0);
    await drawer(widget).locator('.row', { hasText: 'Keep me' }).click();
    await expect(widget.locator('.msg.user')).toHaveCount(1);

    // Reachable straight from the header with the drawer shut: while it is
    // open the scrim covers the header, so this click would be intercepted.
    expect(await drawer(widget).evaluate(el => el.hasAttribute('open'))).toBe(false);
    await widget.locator('.chat-header button[aria-label="New chat"]').click();
    await expect(widget.locator('.msg.user')).toHaveCount(0, { timeout: 3000 });

    // The parked conversation is still there, one tap away.
    await openDrawer(page, widget);
    await expect(drawer(widget).locator('.row-title', { hasText: 'Keep me' })).toBeVisible();
  });

  test('the whole list renders and scrolls, with no show-all expander (#657)', async ({ page }) => {
    await openChat(page);
    await seedConversations(page, Array.from({ length: 12 }, (_, i) => ({
      title: `Chat ${i + 1}`, messages: [{ role: 'user', content: `m${i}` }],
    })));
    await page.reload();
    const widget = await openChat(page);

    await openDrawer(page, widget);
    await expect(drawer(widget).locator('.row')).toHaveCount(12);
    await expect(drawer(widget).locator('.show-all')).toHaveCount(0);

    // Twelve rows do not fit, so the list must be the thing that scrolls.
    // Asserting overflow first keeps the scroll assertion from passing
    // vacuously on a list short enough to fit.
    const list = drawer(widget).locator('.list');
    const overflow = await list.evaluate(el => el.scrollHeight - el.clientHeight);
    expect(overflow).toBeGreaterThan(0);
    await list.evaluate(el => { el.scrollTop = el.scrollHeight; });
    expect(await list.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
    await expect(drawer(widget).locator('.row-title').last()).toHaveText('Chat 1');
  });

  test('the drawer keeps a hamburger where the header had one, and it folds back in (#659)', async ({ page }) => {
    await openChat(page);
    await seedConversations(page, [
      { title: 'Keep me', messages: [{ role: 'user', content: 'kept' }] },
    ]);
    await page.reload();
    const widget = await openChat(page);

    const header = await widget.locator('.chat-header button[aria-label="Conversations"]').boundingBox();
    await openDrawer(page, widget);
    const burger = drawer(widget).locator('button[aria-label="Close conversations"]');

    // Same box, not merely "somewhere top-left": the point of the control is
    // that it reads as the header's icon staying put. toPass absorbs the
    // 0.2s slide-in without a fixed sleep; the drawer travels from off-screen
    // left to x=0, so it cannot transiently overshoot into alignment.
    await expect(async () => {
      const box = await burger.boundingBox();
      expect(Math.abs(box.x - header.x), 'x').toBeLessThanOrEqual(1);
      expect(Math.abs(box.y - header.y), 'y').toBeLessThanOrEqual(1);
      expect(Math.abs(box.width - header.width), 'width').toBeLessThanOrEqual(1);
      expect(Math.abs(box.height - header.height), 'height').toBeLessThanOrEqual(1);
    }).toPass({ timeout: 3000 });

    await burger.click();
    expect(await drawer(widget).evaluate(el => el.hasAttribute('open'))).toBe(false);
    // Folding the drawer away leaves the panel open, not closed.
    await expect(widget.locator('.chat-panel')).toBeVisible();
  });

  test('search finds a chat by its message text, with an excerpt (#659)', async ({ page }) => {
    await openChat(page);
    await seedConversations(page, [
      { title: 'Bloods panel', messages: [{ role: 'user', content: 'ferritin came back at 40' }] },
      { title: 'Sleep notes', messages: [{ role: 'assistant', content: 'try magnesium before bed' }] },
      { title: 'Peptide cycle', messages: [{ role: 'user', content: 'week three today' }] },
    ]);
    await page.reload();
    const widget = await openChat(page);

    const searchCalls = [];
    page.on('request', (r) => {
      if (!r.url().includes('/api/conversations/search')) return;
      searchCalls.push({ method: r.method(), url: r.url(), body: r.postData() });
    });

    await openDrawer(page, widget);
    await expect(drawer(widget).locator('.row')).toHaveCount(3);

    await drawer(widget).locator('button[aria-label="Search conversations"]').click();
    const field = drawer(widget).locator('.search-input');
    await expect(field).toBeFocused();

    // A term that appears only in the transcript, never in the title.
    await field.fill('magnesium');
    await expect(drawer(widget).locator('.row')).toHaveCount(1);
    await expect(drawer(widget).locator('.row-title')).toHaveText('Sleep notes');
    await expect(drawer(widget).locator('.row-snippet')).toContainText('magnesium before bed');

    await field.fill('bloods');
    await expect(drawer(widget).locator('.row-title')).toHaveText('Bloods panel');
    await expect(drawer(widget).locator('.row-snippet')).toHaveCount(0, 'a title hit needs no excerpt');

    await field.fill('nothing in here matches');
    await expect(drawer(widget).locator('.row')).toHaveCount(0);
    await expect(drawer(widget).locator('.empty')).toContainText('No chats match');

    await field.fill('');
    await expect(drawer(widget).locator('.row')).toHaveCount(3);

    // The needle is chat text, so it must ride in the body and never in a URL
    // a proxy would log.
    expect(searchCalls.length).toBeGreaterThan(0);
    expect(searchCalls.every(c => c.method === 'POST')).toBe(true);
    expect(searchCalls.some(c => (c.body || '').includes('magnesium'))).toBe(true);
    expect(searchCalls.some(c => c.url.includes('magnesium'))).toBe(false);
  });

  test('Escape clears the search term before it closes anything (#659)', async ({ page }) => {
    await openChat(page);
    await seedConversations(page, [
      { title: 'Bloods panel', messages: [{ role: 'user', content: 'ferritin came back at 40' }] },
      { title: 'Sleep notes', messages: [{ role: 'assistant', content: 'try magnesium before bed' }] },
    ]);
    await page.reload();
    const widget = await openChat(page);

    await openDrawer(page, widget);
    await drawer(widget).locator('button[aria-label="Search conversations"]').click();
    const field = drawer(widget).locator('.search-input');
    await field.fill('magnesium');
    await expect(drawer(widget).locator('.row')).toHaveCount(1);

    // First press: the term goes, the field and the drawer stay.
    await field.press('Escape');
    await expect(drawer(widget).locator('.row')).toHaveCount(2);
    await expect(field).toHaveValue('');
    expect(await drawer(widget).evaluate(el => el.hasAttribute('open'))).toBe(true);

    // Second press: the field goes, the drawer stays.
    await field.press('Escape');
    await expect(drawer(widget).locator('.search-input')).toHaveCount(0);
    await expect(drawer(widget).locator('.head-label')).toBeVisible();
    expect(await drawer(widget).evaluate(el => el.hasAttribute('open'))).toBe(true);

    // Third press: now the drawer goes, and the panel survives it.
    await page.keyboard.press('Escape');
    expect(await drawer(widget).evaluate(el => el.hasAttribute('open'))).toBe(false);
    await expect(widget.locator('.chat-panel')).toBeVisible();
  });

  test('rename is inline and lands on the server', async ({ page }) => {
    await openChat(page);
    await seedConversations(page, [
      { title: 'Wrong name', messages: [{ role: 'user', content: 'x' }] },
    ]);
    await page.reload();
    const widget = await openChat(page);

    await openDrawer(page, widget);
    await drawer(widget).locator('button[aria-label="Rename conversation"]').click();
    const input = drawer(widget).locator('.rename-input');
    await input.fill('Right name');
    await input.press('Enter');
    await expect(drawer(widget).locator('.row-title')).toHaveText('Right name');

    const serverTitle = await page.evaluate(async () =>
      (await (await fetch('/api/conversations')).json()).conversations[0].title);
    expect(serverTitle).toBe('Right name');
  });

  test('the drawer footer sends feedback through the real endpoint (#608)', async ({ page }) => {
    await openChat(page);
    await seedConversations(page, []);
    await page.reload();
    const widget = await openChat(page);

    await widget.locator('button[aria-label="Conversations"]').click();
    await widget.locator('.feedback-link').click();

    // Kind toggles between bug and idea; pick idea to prove it rides the
    // request, then send through the real server.
    await widget.locator('.feedback-kind', { hasText: 'Idea' }).click();
    await widget.locator('.feedback-text').fill('a dark mode for charts');
    const posted = page.waitForResponse(r =>
      r.url().includes('/api/feedback') && r.request().method() === 'POST' && r.ok());
    await widget.locator('.feedback-send').click();
    const res = await posted;
    expect(res.request().postDataJSON()).toEqual({ kind: 'feature', intent: 'a dark mode for charts' });
    await expect(widget.locator('.feedback-thanks')).toContainText(/logged/i);
  });

  test('delete needs a second tap; deleting the active conversation drops to a fresh chat', async ({ page }) => {
    await openChat(page);
    await seedConversations(page, [
      { title: 'Doomed', messages: [{ role: 'user', content: 'gone soon' }] },
    ]);
    await page.reload();
    const widget = await openChat(page);

    await openDrawer(page, widget);
    await drawer(widget).locator('.row', { hasText: 'Doomed' }).click();
    await expect(widget.locator('.msg.user')).toHaveCount(1);

    await openDrawer(page, widget);
    const del = drawer(widget).locator('button[aria-label="Delete conversation"]');
    await del.click();
    // First tap only arms; the row survives.
    await expect(drawer(widget).locator('.row-title', { hasText: 'Doomed' })).toBeVisible();
    await drawer(widget).locator('button[aria-label="Confirm delete"]').click();

    await expect(drawer(widget).locator('.row')).toHaveCount(0);
    await expect(drawer(widget).locator('.empty')).toContainText(/No conversations/);

    // The open transcript it belonged to is gone too. Escape unwinds the
    // drawer first (its centre is under the drawer, so no scrim click).
    await page.keyboard.press('Escape');
    await expect(widget.locator('.chat-panel')).toBeVisible();
    await expect(widget.locator('.msg.user')).toHaveCount(0);
    const active = await page.evaluate(() => localStorage.getItem('klebb-active-conversation'));
    expect(active).toBeNull();
  });
});
