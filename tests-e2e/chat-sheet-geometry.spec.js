// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests-e2e/chat-sheet-geometry.spec.js
// The chat panel's mobile geometry (#598/#604). On a phone-sized viewport
// the panel is a true full-screen sheet whose header controls are real
// 44px targets, and it closes by button, Escape, or dragging the header
// down. The desktop panel keeps its windowed shape. Geometry is asserted
// with boundingBox, not class names: overlap and reachability are what
// broke on real phones.

const { test, expect } = require('./helpers/auth-fixture');

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };

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
  await expect(widget.locator('.chat-panel')).toBeVisible();
  return widget;
}

test.describe('#604 chat sheet geometry', () => {
  test('mobile: the panel is a full-screen sheet with 44px header targets', async ({ page }) => {
    await page.setViewportSize(PHONE);
    const widget = await openChat(page);

    const panel = await widget.locator('.chat-panel').boundingBox();
    expect(panel.width).toBeGreaterThanOrEqual(PHONE.width - 1);
    expect(panel.height).toBeGreaterThanOrEqual(PHONE.height - 1);
    expect(Math.abs(panel.y)).toBeLessThanOrEqual(1);

    for (const label of ['Close chat', 'Conversations', 'New chat']) {
      const box = await widget.locator(`button[aria-label="${label}"]`).boundingBox();
      expect(box.width, `${label} width`).toBeGreaterThanOrEqual(44);
      expect(box.height, `${label} height`).toBeGreaterThanOrEqual(44);
    }

    // The expand toggle makes no sense on a full-screen sheet.
    await expect(widget.locator('button[aria-label="Expand chat"]')).toBeHidden();

    // Reachability, not just size: the close button must actually take
    // the tap (nothing overlapping it) and close the sheet.
    await widget.locator('button[aria-label="Close chat"]').click();
    await expect(widget.locator('.chat-panel')).not.toBeVisible();
    await expect(widget.locator('.peek-bar')).toBeVisible();
  });

  test('mobile: dragging the header down closes the sheet', async ({ page }) => {
    await page.setViewportSize(PHONE);
    const widget = await openChat(page);

    const header = widget.locator('.chat-header');
    const box = await header.boundingBox();
    const x = box.x + box.width / 2;
    await page.mouse.move(x, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(x, box.y + box.height / 2 + 160, { steps: 8 });
    await page.mouse.up();

    await expect(widget.locator('.chat-panel')).not.toBeVisible();
  });

  test('mobile: a short header drag springs back instead of closing', async ({ page }) => {
    await page.setViewportSize(PHONE);
    const widget = await openChat(page);

    const header = widget.locator('.chat-header');
    const box = await header.boundingBox();
    const x = box.x + box.width / 2;
    await page.mouse.move(x, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(x, box.y + box.height / 2 + 40, { steps: 4 });
    await page.mouse.up();

    await expect(widget.locator('.chat-panel')).toBeVisible();
    const panel = await widget.locator('.chat-panel').boundingBox();
    expect(Math.abs(panel.y)).toBeLessThanOrEqual(1);
  });

  test('mobile: the page behind the sheet is scroll-locked while open', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await openChat(page);
    const state = await page.evaluate(() => ({
      flag: document.body.dataset.klebbSheetOpen || null,
      overflow: document.documentElement.style.overflow,
    }));
    expect(state.flag).toBe('1');
    expect(state.overflow).toBe('hidden');

    await page.keyboard.press('Escape');
    const after = await page.evaluate(() => ({
      flag: document.body.dataset.klebbSheetOpen || null,
      overflow: document.documentElement.style.overflow,
    }));
    expect(after.flag).toBeNull();
    expect(after.overflow).toBe('');
  });

  test('desktop: the windowed panel survives, Escape still closes', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const widget = await openChat(page);

    const panel = await widget.locator('.chat-panel').boundingBox();
    expect(panel.width).toBeLessThan(800);
    expect(panel.height).toBeLessThan(DESKTOP.height - 40);
    await expect(widget.locator('button[aria-label="Expand chat"]')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(widget.locator('.chat-panel')).not.toBeVisible();
  });
});
