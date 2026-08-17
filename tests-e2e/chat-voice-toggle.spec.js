// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests-e2e/chat-voice-toggle.spec.js
// The speak-replies toggle and the audio row (#606, #599). Reply modality
// is the toggle, for typed and mic input alike: off means text replies,
// on means every reply comes back voice-shaped with ONE play/pause
// control (never the native audio bar that produced two play arrows),
// progress, and the speed cycler relocated from the header. First mic
// use flips the toggle on once; after that it is manual and persistent.

const { test, expect } = require('./helpers/auth-fixture');

const voiceOn = (page) => page.route('**/api/voice/config', (route) => route.fulfill({
  status: 200, contentType: 'application/json',
  body: JSON.stringify({ enabled: true, backend: 'stub', voiceId: 'v' }),
}));

// Record each /api/chat body so tests can assert what modality was asked
// for; answer voice-shaped when voiceMode rode the request.
async function stubChat(page, sink) {
  await page.route('**/api/chat', async (route) => {
    const req = route.request();
    if (req.method() !== 'POST') return route.fallback();
    const body = req.postDataJSON();
    sink.push(body);
    const payload = body.voiceMode
      ? { reply: 'Spoken reply.', speak: 'Spoken reply.' }
      : { reply: 'Text reply.' };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
  });
}

const stubTts = (page) => page.route('**/api/voice/tts', (route) => route.fulfill({
  status: 200, contentType: 'application/json',
  body: JSON.stringify({ key: 'k', url: '/api/voice/tts/k', contentType: 'audio/mpeg', byteLength: 3 }),
}));

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

test.describe('#606 speak-replies toggle + audio row', () => {
  test('off by default: typed input gets a text reply and no audio row', async ({ page }) => {
    const bodies = [];
    await voiceOn(page);
    await stubChat(page, bodies);
    const widget = await openChat(page);

    const toggle = widget.locator('button[aria-label="Speak replies"]');
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');

    await widget.locator('.chat-input').fill('hello');
    await widget.locator('.chat-input').press('Enter');
    await expect(widget.locator('.msg.assistant')).toHaveText(/Text reply/);

    expect(bodies[0].voiceMode).toBeFalsy();
    await expect(widget.locator('.audio-row')).toHaveCount(0);
  });

  test('on: typed input speaks back with ONE play control and no native audio bar', async ({ page }) => {
    const bodies = [];
    await voiceOn(page);
    await stubChat(page, bodies);
    await stubTts(page);
    const widget = await openChat(page);

    await widget.locator('button[aria-label="Speak replies"]').click();
    await expect(widget.locator('button[aria-label="Speak replies"]')).toHaveAttribute('aria-pressed', 'true');

    await widget.locator('.chat-input').fill('hello');
    await widget.locator('.chat-input').press('Enter');
    await expect(widget.locator('.msg.assistant')).toHaveText(/Spoken reply/);
    expect(bodies[0].voiceMode).toBe(true);

    const row = widget.locator('.msg.assistant .audio-row');
    await expect(row).toHaveCount(1);
    await expect(row.locator('.play-btn')).toHaveCount(1);
    // The #599 regression: the native controls bar must never render in a
    // bubble beside the custom button. Two play arrows = failure.
    await expect(widget.locator('.msg.assistant audio')).toHaveCount(0);
    // The speed cycler lives in the row now, not the header.
    await expect(row.locator('.speed-chip')).toHaveText(/^1x$/);
    await expect(widget.locator('.chat-header .hdr-btn', { hasText: /^\d/ })).toHaveCount(0);
  });

  test('the toggle persists across reloads, and so does the play affordance', async ({ page }) => {
    const bodies = [];
    await voiceOn(page);
    await stubChat(page, bodies);
    await stubTts(page);
    const widget = await openChat(page);

    await widget.locator('button[aria-label="Speak replies"]').click();
    await widget.locator('.chat-input').fill('remember me');
    // The transcript now persists to the conversation (#603/#605), not
    // the legacy history file.
    const savedHistory = page.waitForResponse(r =>
      /\/api\/conversations\/[^/]+\/messages/.test(r.url()) && r.request().method() === 'PUT' && r.ok());
    await widget.locator('.chat-input').press('Enter');
    await expect(widget.locator('.msg.assistant .audio-row')).toHaveCount(1);
    await savedHistory;

    await page.reload();
    const again = await openChat(page);
    await expect(again.locator('button[aria-label="Speak replies"]')).toHaveAttribute('aria-pressed', 'true');
    // hasVoice round-tripped through the real history endpoint: the play
    // affordance survives even though the audio blob did not.
    await expect(again.locator('.msg.assistant .audio-row .play-btn')).toHaveCount(1);
  });

  test('first mic use flips the toggle on once', async ({ page }) => {
    const bodies = [];
    await voiceOn(page);
    await stubChat(page, bodies);
    await stubTts(page);
    await page.route('**/api/voice/asr', (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ text: 'from the mic', duration: 1 }),
    }));
    await page.addInitScript(() => {
      class FakeRecorder {
        constructor() { this.state = 'inactive'; this._ls = {}; this.mimeType = 'audio/webm'; }
        addEventListener(t, f) { (this._ls[t] ||= []).push(f); }
        start() { this.state = 'recording'; }
        stop() {
          this.state = 'inactive';
          (this._ls.dataavailable || []).forEach(f => f({ data: new Blob(['x'], { type: 'audio/webm' }) }));
          (this._ls.stop || []).forEach(f => f());
        }
      }
      FakeRecorder.isTypeSupported = () => true;
      window.MediaRecorder = FakeRecorder;
      navigator.mediaDevices.getUserMedia = async () => ({ getTracks: () => [] });
    });
    const widget = await openChat(page);
    // The sandbox server keeps chat history across tests in this file;
    // start from a clean transcript so counts below are unambiguous.
    await widget.locator('button[aria-label="Conversations"]').click();
  await widget.locator('button[aria-label="New chat"]').click();
    await expect(widget.locator('.msg.user')).toHaveCount(0);

    await expect(widget.locator('button[aria-label="Speak replies"]')).toHaveAttribute('aria-pressed', 'false');
    await widget.locator('button[aria-label="start recording"]').click();
    await widget.locator('button[aria-label="stop recording"]').click();

    await expect(widget.locator('.msg.user')).toHaveText(/from the mic/);
    await expect(widget.locator('.msg.assistant')).toHaveText(/Spoken reply/);
    expect(bodies[0].voiceMode).toBe(true);
    await expect(widget.locator('button[aria-label="Speak replies"]')).toHaveAttribute('aria-pressed', 'true');
    const stored = await page.evaluate(() => localStorage.getItem('klebb-speak-replies'));
    expect(stored).toBe('1');
  });

  test('mic input with the toggle off gets a text reply', async ({ page }) => {
    const bodies = [];
    await voiceOn(page);
    await stubChat(page, bodies);
    await page.route('**/api/voice/asr', (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ text: 'quiet please', duration: 1 }),
    }));
    await page.addInitScript(() => {
      localStorage.setItem('klebb-speak-replies', '0');
      class FakeRecorder {
        constructor() { this.state = 'inactive'; this._ls = {}; this.mimeType = 'audio/webm'; }
        addEventListener(t, f) { (this._ls[t] ||= []).push(f); }
        start() { this.state = 'recording'; }
        stop() {
          this.state = 'inactive';
          (this._ls.dataavailable || []).forEach(f => f({ data: new Blob(['x'], { type: 'audio/webm' }) }));
          (this._ls.stop || []).forEach(f => f());
        }
      }
      FakeRecorder.isTypeSupported = () => true;
      window.MediaRecorder = FakeRecorder;
      navigator.mediaDevices.getUserMedia = async () => ({ getTracks: () => [] });
    });
    const widget = await openChat(page);
    await widget.locator('button[aria-label="Conversations"]').click();
  await widget.locator('button[aria-label="New chat"]').click();
    await expect(widget.locator('.msg.user')).toHaveCount(0);

    await widget.locator('button[aria-label="start recording"]').click();
    await widget.locator('button[aria-label="stop recording"]').click();

    await expect(widget.locator('.msg.assistant')).toHaveText(/Text reply/);
    expect(bodies[0].voiceMode).toBeFalsy();
    await expect(widget.locator('.audio-row')).toHaveCount(0);
    await expect(widget.locator('button[aria-label="Speak replies"]')).toHaveAttribute('aria-pressed', 'false',
      { timeout: 2000 });
  });
});
